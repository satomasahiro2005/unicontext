import { createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import type {
  DownloadableFile,
  FileDownloadOutcome,
  FileDownloadRequest,
  FileDownloadSettings,
} from '@unicontext/connector-sdk';
import { errorMessage, type FetchLike } from '@unicontext/core';
import type { FilesSpec } from './spec.js';

/*
 * Files of a mapped source (spec `files:`): the bytes of a document whose `url` is on an allowed
 * host. Only ever a plain HTTPS GET without cookies, tokens or redirects (read-only at the source).
 * The adapter side (describeFile / downloadFiles) lives here so every mapped adapter gets it.
 */

/** A document the caller already knows (files.ts passes the entity next to the raw item). */
export interface DocumentHint {
  url?: string | undefined;
  title?: string | undefined;
  path?: string | undefined;
  mimeType?: string | undefined;
  sizeBytes?: number | undefined;
  modifiedAt?: string | undefined;
}

export interface FileItemLike {
  sourceType: string;
  externalId: string;
  payload: unknown;
  document?: DocumentHint | undefined;
}

/** `example.com` matches that host only, `*.example.com` any subdomain (never the bare domain). */
export function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allowlist.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith('*.') ? h.endsWith(e.slice(1)) && h.length > e.length - 1 : h === e;
  });
}

/** The URL when it is https with an allowed host, no credentials in it. */
export function allowedFileUrl(raw: unknown, allowlist: readonly string[]): URL | undefined {
  if (typeof raw !== 'string') return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return undefined;
  return hostAllowed(u.hostname, allowlist) ? u : undefined;
}

export type FileFetchResult =
  | { status: 'downloaded'; bytes: number; contentType?: string }
  | { status: 'tooLarge' | 'notFound' | 'failed'; error: string };

export interface FetchFileOptions {
  allowlist: readonly string[];
  maxBytes: number;
  targetPath: string;
  fetch?: FetchLike | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * GET `url` and stream it to `targetPath` (via `<path>.part`). Refuses hosts outside the
 * allowlist, any redirect, and bodies above `maxBytes` (nothing is left on disk then).
 */
export async function fetchAllowedFile(
  url: string,
  options: FetchFileOptions,
): Promise<FileFetchResult> {
  const u = allowedFileUrl(url, options.allowlist);
  if (!u) return { status: 'failed', error: 'the file host is not allowed' };
  const doFetch: FetchLike = options.fetch ?? ((i, init) => fetch(i, init));
  const part = `${options.targetPath}.part`;
  try {
    const res = await doFetch(u.href, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      headers: { accept: '*/*' },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      return { status: 'failed', error: `redirect refused (HTTP ${res.status})` };
    }
    if (res.status === 404 || res.status === 410) {
      await res.body?.cancel().catch(() => undefined);
      return { status: 'notFound', error: `HTTP ${res.status}` };
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      return { status: 'failed', error: `HTTP ${res.status}` };
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      await res.body.cancel().catch(() => undefined);
      return { status: 'tooLarge', error: `${declared} bytes (limit ${options.maxBytes})` };
    }
    mkdirSync(path.dirname(options.targetPath), { recursive: true });
    const out = createWriteStream(part, { mode: 0o600 });
    const done = new Promise<void>((resolve, reject) => {
      out.once('error', reject);
      out.once('close', resolve);
    });
    let bytes = 0;
    let tooLarge = false;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        bytes += value.byteLength;
        if (bytes > options.maxBytes) {
          tooLarge = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', r));
      }
    } finally {
      out.end();
      await done.catch(() => undefined);
    }
    if (tooLarge) {
      rmSync(part, { force: true });
      return { status: 'tooLarge', error: `more than ${options.maxBytes} bytes` };
    }
    renameSync(part, options.targetPath);
    const contentType = res.headers.get('content-type')?.split(';')[0]?.trim();
    return { status: 'downloaded', bytes, ...(contentType ? { contentType } : {}) };
  } catch (e) {
    rmSync(part, { force: true });
    return { status: 'failed', error: errorMessage(e) };
  }
}

/** The pieces a MappedSourceAdapter wires up when its mapping has a `files:` section. */
export function createFileDownloads(
  files: FilesSpec,
  options: { fetch?: FetchLike | undefined; rawTypes: readonly string[]; label: string },
): {
  fileSourceTypes: readonly string[];
  fileTextSourceTypes: readonly string[];
  fileSettings: () => FileDownloadSettings;
  describeFile: (item: FileItemLike) => DownloadableFile | undefined;
  downloadFiles: (
    requests: readonly FileDownloadRequest[],
    opts?: { signal?: AbortSignal },
  ) => Promise<{
    results: FileDownloadOutcome[];
    items: never[];
    warnings: string[];
  }>;
} {
  const allowlist = files.hostAllowlist;
  return {
    fileSourceTypes: options.rawTypes,
    fileTextSourceTypes: [],
    fileSettings: () => ({ maxDownloadBytes: files.maxBytes }),
    describeFile: (item) => {
      const payload =
        item.payload && typeof item.payload === 'object'
          ? (item.payload as Record<string, unknown>)
          : {};
      const url = allowedFileUrl(item.document?.url ?? payload.url, allowlist);
      if (!url) return undefined;
      const fromPayload = typeof payload.filename === 'string' ? payload.filename : undefined;
      const lastSegment = decodeURIComponentSafe(url.pathname.split('/').pop() ?? '');
      const name = item.document?.title || fromPayload || lastSegment || 'file';
      const folder = (item.document?.path ?? '').split('/').filter(Boolean).slice(0, -1).join('/');
      const mediaType = typeof payload.mediaType === 'string' ? payload.mediaType : undefined;
      return {
        // One id per file, so the cache and the index never mix the files of one lesson.
        externalId: url.href,
        name,
        container: options.label,
        containerId: options.label,
        isClass: true,
        folder,
        version: url.href,
        sizeBytes: item.document?.sizeBytes,
        modifiedAt: item.document?.modifiedAt,
        mimeType: item.document?.mimeType ?? mediaType,
      };
    },
    downloadFiles: async (requests, opts = {}) => {
      const results: FileDownloadOutcome[] = [];
      for (const r of requests) {
        if (r.extractOnly) {
          results.push({ externalId: r.externalId, status: 'extracted' });
          continue;
        }
        const out = await fetchAllowedFile(r.externalId, {
          allowlist,
          maxBytes: Math.min(r.maxBytes, files.maxBytes),
          targetPath: r.targetPath,
          fetch: options.fetch,
          signal: opts.signal,
        });
        results.push(
          out.status === 'downloaded'
            ? {
                externalId: r.externalId,
                status: 'downloaded',
                bytes: out.bytes,
                version: r.externalId,
                ...(out.contentType ? { contentType: out.contentType } : {}),
              }
            : { externalId: r.externalId, status: out.status, error: out.error },
        );
      }
      return { results, items: [], warnings: [] };
    },
  };
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
