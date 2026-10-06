import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { isIdOf, type Document, type DocumentChunk } from '@unicontext/canonical-model';
import {
  type DownloadableFile,
  FILE_TEXT_SOURCE_TYPE,
  type FileDownloadAdapter,
  type FileDownloadOutcome,
  type FileDownloadRequest,
  type FileTextPayload,
  type RawDeletion,
  type RawItem,
  supportsFileDownloads,
} from '@unicontext/connector-sdk';
import { errorMessage, NotFoundError, ValidationError } from '@unicontext/core';
import { chunkText, extractContent } from '@unicontext/local-files';
import { rawItemId, type RawItemRecord } from '@unicontext/database';
import type { UniContext } from './runtime.js';

/*
 * Files of class teams (Teams/SharePoint) on the student's disk.
 *
 *  - On request (CLI `unicontext files download`, REST, Web UI, MCP download_course_file): the
 *    file is downloaded through its connector (read-only at the source), kept in
 *    `<files dir>/<source>/cache/…`, text-extracted and indexed as document chunks.
 *  - Mirror (opt-in per source, `sources.<id>.mirror`): a copy of the class teams' libraries under
 *    `<root>/<course or team>/<channel folder>/<path>`, reconciled with the synced file list after
 *    each sync: new/changed files are downloaded, files that disappeared move to `<root>/.trash`.
 *
 * The file lists, versions and paths live in small JSON indexes next to the cache; nothing about a
 * download (and never a temporary download URL) is stored in the database except the extracted
 * text, which is an ordinary raw item of the source.
 */

export const MAX_DOWNLOADS_PER_REQUEST = 20;
/** Cached on-demand downloads beyond this are evicted, oldest first. */
export const DEFAULT_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export type DownloadStatus =
  'downloaded' | 'cached' | 'tooLarge' | 'notFound' | 'unsupported' | 'failed';

export interface DownloadedFileResult {
  /** Document id (document:…). */
  id: string;
  /** What was asked for (id or course path). */
  ref: string;
  title: string | undefined;
  status: DownloadStatus;
  /** Local file (absolute) when it is on disk. */
  path?: string;
  bytes?: number;
  sizeBytes?: number;
  mimeType?: string;
  modifiedAt?: string;
  /** Library-relative path at the source, e.g. "/00_講義資料/week1.pdf". */
  sourcePath?: string;
  course?: { id: string; title: string };
  /** Searchable text of this file (document chunks) after the download. */
  text?: { chunks: number; chars: number };
  /** The file is in the mirror (path points there). */
  mirrored?: boolean;
  error?: string;
}

export interface DownloadFilesReport {
  results: DownloadedFileResult[];
  downloaded: number;
  warnings: string[];
}

export interface FileStoreOptions {
  /** `<data dir>/files`. */
  filesDir: string;
  cacheMaxBytes?: number;
}

// ---------------------------------------------------------------------------------------------
// Indexes

interface CacheEntry {
  path: string;
  version: string;
  bytes: number;
  at: string;
  documentId?: string;
  mimeType?: string;
}
interface CacheIndex {
  v: 1;
  files: Record<string, CacheEntry>;
}
interface MirrorEntry {
  /** Path relative to the mirror root ('/'-separated). */
  rel: string;
  version: string;
  bytes?: number;
  at: string;
  /** Not downloaded in this version (too large for the mirror). */
  skipped?: 'tooLarge';
}
interface MirrorIndex {
  v: 1;
  root: string;
  files: Record<string, MirrorEntry>;
  lastPassAt?: string;
}

function sourceDir(filesDir: string, sourceId: string): string {
  return path.join(filesDir, safeSegment(sourceId));
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, file);
}

function loadCacheIndex(filesDir: string, sourceId: string): CacheIndex {
  const idx = readJson<CacheIndex>(path.join(sourceDir(filesDir, sourceId), 'cache.json'), {
    v: 1,
    files: {},
  });
  return idx.v === 1 && idx.files ? idx : { v: 1, files: {} };
}

function saveCacheIndex(filesDir: string, sourceId: string, idx: CacheIndex): void {
  writeJson(path.join(sourceDir(filesDir, sourceId), 'cache.json'), idx);
}

function loadMirrorIndex(filesDir: string, sourceId: string, root: string): MirrorIndex {
  const idx = readJson<MirrorIndex>(path.join(sourceDir(filesDir, sourceId), 'mirror.json'), {
    v: 1,
    root,
    files: {},
  });
  // A different root starts a new mirror; the old one is left alone.
  return idx.v === 1 && idx.files && samePath(idx.root, root) ? idx : { v: 1, root, files: {} };
}

function saveMirrorIndex(filesDir: string, sourceId: string, idx: MirrorIndex): void {
  writeJson(path.join(sourceDir(filesDir, sourceId), 'mirror.json'), idx);
}

function samePath(a: string, b: string): boolean {
  const n = (p: string): string => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return n(a) === n(b);
}

function fileSize(p: string): number | undefined {
  try {
    const s = statSync(p);
    return s.isFile() ? s.size : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Safe local names

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** One path segment that is valid on Windows, macOS and Linux. */
export function safeSegment(name: string): string {
  let s = [...name.normalize('NFC')]
    .map((c) => (c.charCodeAt(0) < 0x20 || '<>:"/\\|?*'.includes(c) ? '_' : c))
    .join('')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!s || s === '.' || s === '..') s = '_';
  if (RESERVED.test(s)) s = `_${s}`;
  // Keep segments well under the 255-byte limit of most file systems (CJK is 3 bytes in UTF-8).
  while (Buffer.byteLength(s, 'utf8') > 180) s = s.slice(0, -1);
  return s;
}

/** A '/'-separated relative path made of safe segments. */
export function safeRelPath(...parts: string[]): string {
  return parts
    .flatMap((p) => p.split('/'))
    .filter((p) => p !== '')
    .map(safeSegment)
    .join('/');
}

function cachePathFor(
  filesDir: string,
  sourceId: string,
  externalId: string,
  name: string,
): string {
  const h = createHash('sha256').update(externalId).digest('hex').slice(0, 16);
  return path.join(sourceDir(filesDir, sourceId), 'cache', h, safeSegment(name));
}

// ---------------------------------------------------------------------------------------------
// Resolution: document / material id or "<course>/<path>"

interface FileTarget {
  documentId: string;
  ref: string;
  document: Document;
  raw: RawItemRecord;
  adapter: FileDownloadAdapter;
  info: DownloadableFile;
}

const norm = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

/**
 * Document id of a file reference: `document:…`, `material:…`, or a course path
 * `<course title>/<folder>/<file name>` (the course part matches an offering title; the rest the
 * file's library path, or just its name when that is unique in the course).
 */
export function resolveFileRef(uc: UniContext, ref: string): string {
  const r = ref.trim();
  const entities = uc.sync.stores.entities;
  if (isIdOf('document', r)) {
    if (!entities.getOfKind('document', r)) throw new NotFoundError(`file ${r}`);
    return r;
  }
  if (isIdOf('material', r)) {
    const m = entities.getOfKind('material', r);
    if (!m?.documentId) throw new NotFoundError(`file ${r}`);
    return m.documentId;
  }
  const slash = r.indexOf('/');
  if (slash <= 0 || slash === r.length - 1)
    throw new ValidationError(
      `give a document id (document:…) or "<course>/<path of the file>", not "${ref}"`,
    );
  const coursePart = norm(r.slice(0, slash));
  const filePart = r.slice(slash + 1).replace(/^\/+/, '');
  const offerings = entities.list('courseOffering');
  let courses = offerings.filter((o) => norm(o.title) === coursePart);
  if (courses.length === 0) courses = offerings.filter((o) => norm(o.title).includes(coursePart));
  if (courses.length === 0) throw new NotFoundError(`course "${r.slice(0, slash)}"`);
  const ids = new Set<string>();
  for (const c of courses) for (const id of uc.identity.expand(c.id)) ids.add(id);
  const docs = entities.list('document', { where: { courseOfferingId: [...ids] } });
  const wanted = norm(`/${filePart}`);
  let hits = docs.filter((d) => d.path !== undefined && norm(d.path) === wanted);
  if (hits.length === 0)
    hits = docs.filter((d) => d.path !== undefined && norm(d.path).endsWith(wanted));
  if (hits.length === 0) hits = docs.filter((d) => norm(d.title) === norm(filePart));
  if (hits.length === 0) throw new NotFoundError(`file "${filePart}" in ${r.slice(0, slash)}`);
  if (hits.length > 1)
    throw new ValidationError(
      `"${ref}" matches ${hits.length} files; give the folder too or use the document id`,
    );
  return hits[0]!.id;
}

function targetOf(
  uc: UniContext,
  documentId: string,
  ref: string,
): FileTarget | DownloadedFileResult {
  const stores = uc.sync.stores;
  const document = stores.entities.getOfKind('document', documentId);
  if (!document) return { id: documentId, ref, title: undefined, status: 'notFound' };
  const base = { id: documentId, ref, title: document.title };
  for (const sr of stores.sourceRefs.forEntity(documentId)) {
    if (!sr.rawItemId) continue;
    const raw = stores.raw.get(sr.rawItemId);
    if (!raw || raw.deletedAt) continue;
    let adapter;
    try {
      adapter = uc.sync.getSource(raw.sourceId).adapter;
    } catch {
      continue; // the source is not registered (connector not loaded)
    }
    if (!supportsFileDownloads(adapter) || !adapter.fileSourceTypes.includes(raw.sourceType))
      continue;
    // The document goes along: one raw item can hold several files (the text of an Ed lesson),
    // and an adapter that knows only the raw item cannot tell which one is meant.
    const info = adapter.describeFile({
      sourceType: raw.sourceType,
      externalId: raw.externalId,
      payload: raw.payload,
      document: {
        url: document.url,
        title: document.title,
        path: document.path,
        mimeType: document.mimeType,
        sizeBytes: document.sizeBytes,
        modifiedAt: document.modifiedAt,
      },
    } as Parameters<typeof adapter.describeFile>[0]);
    if (!info) continue;
    // An adapter may name a file by something other than its raw item (the file's own url): that
    // id keys the cache, so two files of one raw item never share an entry.
    return {
      documentId,
      ref,
      document,
      raw: info.externalId === raw.externalId ? raw : { ...raw, externalId: info.externalId },
      adapter,
      info,
    };
  }
  return { ...base, status: 'unsupported' };
}

function courseOf(uc: UniContext, d: Document): { id: string; title: string } | undefined {
  if (!d.courseOfferingId) return undefined;
  const ids = uc.identity.expand(d.courseOfferingId);
  // Prefer the academic system's offering the team is linked to.
  for (const id of [...ids.filter((x) => x !== d.courseOfferingId), d.courseOfferingId]) {
    const o = uc.sync.stores.entities.getOfKind('courseOffering', id);
    if (o) return { id: o.id, title: o.title };
  }
  return undefined;
}

function chunksOf(uc: UniContext, documentId: string): DocumentChunk[] {
  return uc.sync.stores.entities
    .list('documentChunk', { where: { documentId }, orderBy: 'ordinal' })
    .sort((a, b) => a.ordinal - b.ordinal);
}

function textStats(uc: UniContext, documentId: string): { chunks: number; chars: number } {
  const chunks = chunksOf(uc, documentId);
  return { chunks: chunks.length, chars: chunks.reduce((n, c) => n + c.text.length, 0) };
}

// ---------------------------------------------------------------------------------------------
// On-demand downloads

/**
 * Download files on the user's request (deduplicated, at most MAX_DOWNLOADS_PER_REQUEST). A file
 * already on disk in its current version (cache or mirror) is not downloaded again; its text is
 * extracted when the index has none yet.
 */
export async function downloadCourseFiles(
  uc: UniContext,
  refs: readonly string[],
  options: FileStoreOptions & { extract?: boolean; signal?: AbortSignal },
): Promise<DownloadFilesReport> {
  const unique = [...new Set(refs.map((x) => x.trim()).filter(Boolean))];
  if (unique.length === 0) throw new ValidationError('give at least one file');
  if (unique.length > MAX_DOWNLOADS_PER_REQUEST)
    throw new ValidationError(`at most ${MAX_DOWNLOADS_PER_REQUEST} files per request`);
  const extract = options.extract !== false;
  const results: DownloadedFileResult[] = [];
  const warnings: string[] = [];
  const bySource = new Map<
    string,
    { target: FileTarget; request: FileDownloadRequest; cached?: string; mirrored?: boolean }[]
  >();

  for (const ref of unique) {
    let documentId: string;
    try {
      documentId = resolveFileRef(uc, ref);
    } catch (e) {
      results.push({
        id: '',
        ref,
        title: undefined,
        status: 'notFound',
        error: errorMessage(e),
      });
      continue;
    }
    if (
      results.some((r) => r.id === documentId) ||
      [...bySource.values()].some((l) => l.some((x) => x.target.documentId === documentId))
    )
      continue;
    const t = targetOf(uc, documentId, ref);
    if (!('raw' in t)) {
      results.push(t);
      continue;
    }
    const sourceId = t.raw.sourceId;
    const settings = t.adapter.fileSettings();
    // Already on disk in this version: the mirror, else the cache.
    let onDisk: { path: string; mirrored: boolean } | undefined;
    if (settings.mirror?.enabled) {
      const m = loadMirrorIndex(options.filesDir, sourceId, settings.mirror.root).files[
        t.raw.externalId
      ];
      const p = m && !m.skipped ? path.join(settings.mirror.root, ...m.rel.split('/')) : undefined;
      if (m && p && m.version === t.info.version && fileSize(p) !== undefined)
        onDisk = { path: p, mirrored: true };
    }
    if (!onDisk) {
      const c = loadCacheIndex(options.filesDir, sourceId).files[t.raw.externalId];
      if (c && c.version === t.info.version && fileSize(c.path) !== undefined)
        onDisk = { path: c.path, mirrored: false };
    }
    const hasText = textStats(uc, documentId).chunks > 0;
    if (onDisk && (hasText || !extract)) {
      results.push(resultFor(uc, t, 'cached', onDisk.path, onDisk.mirrored));
      continue;
    }
    const request: FileDownloadRequest = {
      externalId: t.raw.externalId,
      payload: t.raw.payload,
      targetPath:
        onDisk?.path ?? cachePathFor(options.filesDir, sourceId, t.raw.externalId, t.info.name),
      maxBytes: settings.maxDownloadBytes,
      extract,
      ...(onDisk ? { extractOnly: true } : {}),
    };
    const list = bySource.get(sourceId) ?? [];
    list.push({
      target: t,
      request,
      ...(onDisk ? { cached: onDisk.path, mirrored: onDisk.mirrored } : {}),
    });
    bySource.set(sourceId, list);
  }

  for (const [sourceId, list] of bySource) {
    const adapter = list[0]!.target.adapter;
    let outcomes: FileDownloadOutcome[];
    try {
      const out = await adapter.downloadFiles(
        list.map((x) => x.request),
        options.signal ? { signal: options.signal } : {},
      );
      outcomes = out.results;
      warnings.push(...out.warnings);
      if (out.items.length > 0) await uc.sync.ingest(sourceId, { items: out.items });
      if (adapter.hostExtractsFileText)
        await extractFileTexts(uc, sourceId, list, outcomes, warnings);
    } catch (e) {
      for (const x of list)
        results.push({ ...resultFor(uc, x.target, 'failed'), error: errorMessage(e) });
      continue;
    }
    const idx = loadCacheIndex(options.filesDir, sourceId);
    const now = uc.clock.now().toISOString();
    const keep = new Set<string>();
    for (const x of list) {
      const o = outcomes.find((r) => r.externalId === x.request.externalId);
      if (x.cached) {
        results.push({
          ...resultFor(uc, x.target, 'cached', x.cached, x.mirrored === true),
          ...(o?.error ? { error: o.error } : {}),
        });
        continue;
      }
      if (o?.status === 'downloaded') {
        idx.files[x.request.externalId] = {
          path: x.request.targetPath,
          version: o.version ?? x.target.info.version,
          bytes: o.bytes ?? fileSize(x.request.targetPath) ?? 0,
          at: now,
          documentId: x.target.documentId,
          ...(o.contentType ? { mimeType: o.contentType } : {}),
        };
        keep.add(x.request.externalId);
        results.push(resultFor(uc, x.target, 'downloaded', x.request.targetPath, false, o.bytes));
      } else
        results.push({
          ...resultFor(
            uc,
            x.target,
            o?.status === 'tooLarge'
              ? 'tooLarge'
              : o?.status === 'notFound'
                ? 'notFound'
                : 'failed',
          ),
          ...(o?.error ? { error: o.error } : {}),
        });
    }
    evictCache(idx, options.cacheMaxBytes ?? DEFAULT_CACHE_MAX_BYTES, keep);
    saveCacheIndex(options.filesDir, sourceId, idx);
  }

  const order = new Map(unique.map((r, i) => [r, i]));
  results.sort((a, b) => (order.get(a.ref) ?? 0) - (order.get(b.ref) ?? 0));
  return {
    results,
    downloaded: results.filter((r) => r.status === 'downloaded').length,
    warnings,
  };
}

const TEXT_CHUNK_SIZE = 1200;
const TEXT_CHUNK_OVERLAP = 100;

function extensionFor(name: string, mimeType: string | undefined): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  if (m) return m[1]!.toLowerCase();
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType?.startsWith('text/plain')) return 'txt';
  return '';
}

/** The text of a file on disk, cut into searchable pieces in reading order. */
async function readFileText(
  file: string,
  name: string,
  mimeType: string | undefined,
): Promise<FileTextPayload['chunks']> {
  const content = await extractContent(
    new Uint8Array(readFileSync(file)),
    extensionFor(name, mimeType),
  );
  const out: FileTextPayload['chunks'] = [];
  if (content.pages) {
    for (const p of content.pages)
      for (const text of chunkText(p.text, TEXT_CHUNK_SIZE, TEXT_CHUNK_OVERLAP))
        out.push({ text, page: p.page });
  } else if (content.slides) {
    for (const s of content.slides) {
      const body = s.notes
        ? `${s.text}

[Notes]
${s.notes}`
        : s.text;
      for (const text of chunkText(body, TEXT_CHUNK_SIZE, TEXT_CHUNK_OVERLAP))
        out.push({ text, page: s.slide, ...(s.title ? { heading: s.title } : {}) });
    }
  } else if (content.text) {
    for (const text of chunkText(content.text, TEXT_CHUNK_SIZE, TEXT_CHUNK_OVERLAP))
      out.push({ text });
  }
  return out;
}

/**
 * For an adapter that only fetches bytes (`hostExtractsFileText`): read the text of each file that
 * is on disk (just downloaded, or there already without text) and ingest it as one
 * FILE_TEXT_SOURCE_TYPE raw item per file, so search and the text excerpt see it. The outcome
 * says what was read; a file that could not be read says why instead of reporting success.
 */
async function extractFileTexts(
  uc: UniContext,
  sourceId: string,
  list: readonly { target: FileTarget; request: FileDownloadRequest }[],
  outcomes: FileDownloadOutcome[],
  warnings: string[],
): Promise<void> {
  const items: RawItem[] = [];
  for (const x of list) {
    const o = outcomes.find((r) => r.externalId === x.request.externalId);
    if (!x.request.extract || !o || (o.status !== 'downloaded' && o.status !== 'extracted'))
      continue;
    const { info, documentId } = x.target;
    try {
      const chunks = await readFileText(x.request.targetPath, info.name, info.mimeType);
      if (chunks.length === 0) {
        o.text = { chars: 0, pages: 0 };
        continue;
      }
      // cited like the document itself (Ed Lessons, not the source's default label)
      const cite = uc.sync.stores.sourceRefs
        .forEntity(documentId)
        .find((r) => r.sourceLabel || r.url);
      const payload: FileTextPayload = {
        documentId,
        name: info.name,
        version: o.version ?? info.version,
        ...(cite
          ? {
              ref: {
                authority: cite.authority,
                ...(cite.sourceLabel ? { sourceLabel: cite.sourceLabel } : {}),
                ...(cite.url ? { url: cite.url } : {}),
              },
            }
          : {}),
        chunks,
      };
      items.push({
        sourceType: FILE_TEXT_SOURCE_TYPE,
        externalId: x.request.externalId,
        payload,
      });
      o.text = {
        chars: chunks.reduce((n, c) => n + c.text.length, 0),
        pages: new Set(chunks.map((c) => c.page).filter((p) => p !== undefined)).size,
      };
    } catch (e) {
      const msg = `text of ${info.name}: ${errorMessage(e)}`;
      warnings.push(msg);
      if (x.request.extractOnly) {
        o.status = 'failed';
        o.error = msg;
      }
    }
  }
  if (items.length > 0) await uc.sync.ingest(sourceId, { items });
}

function resultFor(
  uc: UniContext,
  t: FileTarget,
  status: DownloadStatus,
  localPath?: string,
  mirrored = false,
  bytes?: number,
): DownloadedFileResult {
  const d = t.document;
  const course = courseOf(uc, d);
  const onDisk = status === 'downloaded' || status === 'cached';
  const size = localPath ? fileSize(localPath) : undefined;
  return {
    id: t.documentId,
    ref: t.ref,
    title: d.title,
    status,
    ...(onDisk && localPath ? { path: localPath } : {}),
    ...(onDisk && (bytes ?? size) !== undefined ? { bytes: bytes ?? size } : {}),
    ...(d.sizeBytes !== undefined ? { sizeBytes: d.sizeBytes } : {}),
    ...(d.mimeType ? { mimeType: d.mimeType } : {}),
    ...(d.modifiedAt ? { modifiedAt: d.modifiedAt } : {}),
    ...(d.path ? { sourcePath: d.path } : {}),
    ...(course ? { course } : {}),
    ...(onDisk ? { text: textStats(uc, t.documentId) } : {}),
    ...(mirrored ? { mirrored: true } : {}),
  };
}

function evictCache(idx: CacheIndex, maxBytes: number, keep: Set<string>): void {
  let total = Object.values(idx.files).reduce((n, e) => n + e.bytes, 0);
  const oldest = Object.entries(idx.files).sort((a, b) => a[1].at.localeCompare(b[1].at));
  for (const [key, e] of oldest) {
    if (total <= maxBytes) break;
    if (keep.has(key)) continue;
    rmSync(path.dirname(e.path), { recursive: true, force: true });
    delete idx.files[key];
    total -= e.bytes;
  }
}

/**
 * The local copy of a file that is on disk in its current version (mirror first, then cache), for
 * serving it (REST content, the remote file link). Undefined when it is not on disk.
 */
export function localFile(
  uc: UniContext,
  documentId: string,
  options: FileStoreOptions,
): { path: string; name: string; mimeType: string | undefined; bytes: number } | undefined {
  const t = targetOf(uc, documentId, documentId);
  if (!('raw' in t)) return undefined;
  const sourceId = t.raw.sourceId;
  const mirror = t.adapter.fileSettings().mirror;
  const candidates: string[] = [];
  if (mirror?.enabled) {
    const m = loadMirrorIndex(options.filesDir, sourceId, mirror.root).files[t.raw.externalId];
    if (m && !m.skipped && m.version === t.info.version)
      candidates.push(path.join(mirror.root, ...m.rel.split('/')));
  }
  const c = loadCacheIndex(options.filesDir, sourceId).files[t.raw.externalId];
  if (c && c.version === t.info.version) candidates.push(c.path);
  for (const p of candidates) {
    const bytes = fileSize(p);
    if (bytes !== undefined)
      return { path: p, name: t.info.name, mimeType: t.info.mimeType ?? c?.mimeType, bytes };
  }
  return undefined;
}

/** Some registered source can fetch this document's bytes (downloadCourseFiles would try). */
export function canDownloadFile(uc: UniContext, documentId: string): boolean {
  return 'raw' in targetOf(uc, documentId, documentId);
}

// ---------------------------------------------------------------------------------------------
// Text excerpt (MCP)

export interface FileTextExcerpt {
  text: string;
  truncated: boolean;
  chunks: number;
  totalChars: number;
}

/**
 * The extracted text of a file, in order, with page/slide markers (`[p.3]`, `[スライド 3]`),
 * cut at `maxChars`. Overlapping chunk starts are not deduplicated (chunks overlap ~100 chars).
 */
export function fileTextExcerpt(
  uc: UniContext,
  documentId: string,
  maxChars: number,
): FileTextExcerpt {
  const d = uc.sync.stores.entities.getOfKind('document', documentId);
  const chunks = chunksOf(uc, documentId);
  const slides =
    /\.(pptx?|key|odp)$/i.test(d?.title ?? '') || /presentation/i.test(d?.mimeType ?? '');
  let out = '';
  let lastPage: number | undefined;
  let truncated = false;
  const totalChars = chunks.reduce((n, c) => n + c.text.length, 0);
  for (const c of chunks) {
    let piece = '';
    if (c.page !== undefined && c.page !== lastPage) {
      piece += `${out ? '\n\n' : ''}[${slides ? `スライド ${c.page}` : `p.${c.page}`}]\n`;
      lastPage = c.page;
    } else if (out) piece += '\n';
    piece += c.text;
    if (out.length + piece.length > maxChars) {
      out += piece.slice(0, Math.max(0, maxChars - out.length));
      truncated = true;
      break;
    }
    out += piece;
  }
  return { text: out, truncated, chunks: chunks.length, totalChars };
}

// ---------------------------------------------------------------------------------------------
// Mirror

export interface MirrorSourceReport {
  sourceId: string;
  root: string;
  enabled: boolean;
  /** Files that belong in the mirror (after the course filter). */
  wanted: number;
  /** In the mirror in their current version after this pass. */
  present: number;
  downloaded: number;
  renamed: number;
  trashed: number;
  skippedTooLarge: number;
  failed: number;
  /** Still to download (cap per pass reached). */
  remaining: number;
  textExtracted: number;
  bytesDownloaded: number;
  trashPurged: number;
  orphanTextsRemoved: number;
}

export interface MirrorReport {
  sources: MirrorSourceReport[];
  warnings: string[];
}

const mirrorRuns = new Map<string, Promise<MirrorSourceReport | undefined>>();

/**
 * One mirror pass for every source that has the mirror enabled (or the one named). Passes of the
 * same source never overlap (a second request joins the running pass).
 */
export async function mirrorFiles(
  uc: UniContext,
  options: FileStoreOptions & { sourceId?: string; signal?: AbortSignal },
): Promise<MirrorReport> {
  const report: MirrorReport = { sources: [], warnings: [] };
  for (const src of uc.sync.sources()) {
    if (options.sourceId && src.sourceId !== options.sourceId) continue;
    const adapter = src.adapter;
    if (!supportsFileDownloads(adapter)) continue;
    const mirror = adapter.fileSettings().mirror;
    if (!mirror?.enabled) {
      if (options.sourceId)
        report.sources.push({
          ...emptyMirrorReport(src.sourceId, mirror?.root ?? ''),
          enabled: false,
        });
      continue;
    }
    let run = mirrorRuns.get(src.sourceId);
    if (!run) {
      run = mirrorSource(uc, src.sourceId, adapter, options, report.warnings).finally(() =>
        mirrorRuns.delete(src.sourceId),
      );
      mirrorRuns.set(src.sourceId, run);
    }
    try {
      const r = await run;
      if (r) report.sources.push(r);
    } catch (e) {
      report.warnings.push(`${src.sourceId}: ${errorMessage(e)}`);
    }
  }
  return report;
}

function emptyMirrorReport(sourceId: string, root: string): MirrorSourceReport {
  return {
    sourceId,
    root,
    enabled: true,
    wanted: 0,
    present: 0,
    downloaded: 0,
    renamed: 0,
    trashed: 0,
    skippedTooLarge: 0,
    failed: 0,
    remaining: 0,
    textExtracted: 0,
    bytesDownloaded: 0,
    trashPurged: 0,
    orphanTextsRemoved: 0,
  };
}

interface WantedFile {
  raw: RawItemRecord;
  info: DownloadableFile;
  rel: string;
}

/** The files that belong in the mirror and where (relative to the root). */
function mirrorPlan(
  uc: UniContext,
  sourceId: string,
  adapter: FileDownloadAdapter,
  courses: 'all' | 'linked',
): Map<string, WantedFile> {
  const stores = uc.sync.stores;
  const files: { raw: RawItemRecord; info: DownloadableFile; dir: string }[] = [];
  const dirOwners = new Map<string, Set<string>>();
  const teamLabel = new Map<string, string>();
  for (const raw of stores.raw.list({ sourceId, sourceTypes: [...adapter.fileSourceTypes] })) {
    const info = adapter.describeFile(raw);
    if (!info?.isClass) continue;
    const doc = stores.sourceRefs
      .byRawItem(raw.id)
      .map((r) => (r.entityId ? stores.entities.getOfKind('document', r.entityId) : undefined))
      .find((d) => d !== undefined);
    const offeringId = doc?.courseOfferingId;
    const linked = offeringId
      ? uc.identity.expand(offeringId).filter((id) => id !== offeringId)
      : [];
    if (courses === 'linked' && linked.length === 0) continue;
    let dir = info.container;
    if (linked.length > 0) {
      const title = linked
        .map((id) => stores.entities.getOfKind('courseOffering', id)?.title)
        .find((t) => t !== undefined);
      if (title) dir = title;
    }
    teamLabel.set(info.containerId, info.container);
    const owners = dirOwners.get(dir) ?? new Set<string>();
    owners.add(info.containerId);
    dirOwners.set(dir, owners);
    files.push({ raw, info, dir });
  }
  const wanted = new Map<string, WantedFile>();
  for (const f of files) {
    // Two teams under one course title (e.g. a retake): keep them apart by team name.
    const dir =
      (dirOwners.get(f.dir)?.size ?? 0) > 1
        ? `${f.dir} (${teamLabel.get(f.info.containerId)})`
        : f.dir;
    wanted.set(f.raw.externalId, {
      raw: f.raw,
      info: f.info,
      rel: safeRelPath(dir, f.info.folder, f.info.name),
    });
  }
  return wanted;
}

function localDate(uc: UniContext): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: uc.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(uc.clock.now());
}

function moveFile(from: string, to: string): void {
  mkdirSync(path.dirname(to), { recursive: true });
  let target = to;
  for (let i = 1; existsSync(target); i++) {
    const ext = path.extname(to);
    target = `${to.slice(0, to.length - ext.length)} (${i})${ext}`;
  }
  renameSync(from, target);
}

function pruneEmptyDirs(root: string, dir: string): void {
  let d = dir;
  while (samePath(path.dirname(d), d) === false && !samePath(d, root) && d.startsWith(root)) {
    try {
      if (readdirSync(d).length > 0) return;
      rmSync(d, { recursive: false, force: true });
    } catch {
      return;
    }
    d = path.dirname(d);
  }
}

async function mirrorSource(
  uc: UniContext,
  sourceId: string,
  adapter: FileDownloadAdapter,
  options: FileStoreOptions & { signal?: AbortSignal },
  warnings: string[],
): Promise<MirrorSourceReport> {
  const settings = adapter.fileSettings().mirror!;
  const root = path.resolve(settings.root);
  const r = emptyMirrorReport(sourceId, root);
  mkdirSync(root, { recursive: true });
  const idx = loadMirrorIndex(options.filesDir, sourceId, root);
  const wanted = mirrorPlan(uc, sourceId, adapter, settings.courses);
  r.wanted = wanted.size;
  const abs = (rel: string): string => path.join(root, ...rel.split('/'));
  const trashDir = path.join(root, '.trash', localDate(uc));
  const now = uc.clock.now().toISOString();
  const toTrash = (rel: string): void => {
    const p = abs(rel);
    if (fileSize(p) === undefined) return;
    moveFile(p, path.join(trashDir, ...rel.split('/')));
    pruneEmptyDirs(root, path.dirname(p));
    r.trashed++;
  };

  // 1. Gone from the library (deleted, or its course is no longer mirrored): to the trash.
  for (const [key, e] of Object.entries(idx.files))
    if (!wanted.has(key)) {
      if (!e.skipped) toTrash(e.rel);
      delete idx.files[key];
    }
  // 2. Moved or renamed at the source, same content: move locally.
  for (const [key, w] of wanted) {
    const e = idx.files[key];
    if (!e || e.skipped || e.version !== w.info.version || e.rel === w.rel) continue;
    const from = abs(e.rel);
    if (fileSize(from) === undefined) continue;
    moveFile(from, abs(w.rel));
    pruneEmptyDirs(root, path.dirname(from));
    e.rel = w.rel;
    r.renamed++;
  }
  saveMirrorIndex(options.filesDir, sourceId, idx);

  // 3. New or changed (or missing locally): download, newest first, capped per pass.
  const queue = [...wanted.values()]
    .filter((w) => {
      const e = idx.files[w.raw.externalId];
      if (!e || e.version !== w.info.version) return true;
      if (e.skipped) return false;
      return fileSize(abs(e.rel)) === undefined;
    })
    .sort((a, b) => (b.info.modifiedAt ?? '').localeCompare(a.info.modifiedAt ?? ''));
  const batch = queue.slice(0, settings.maxFilesPerPass);
  r.remaining = queue.length - batch.length;
  const requests: FileDownloadRequest[] = [];
  for (const w of batch) {
    const e = idx.files[w.raw.externalId];
    // A changed file: keep the previous version in the trash (it may hold the student's notes).
    if (e && !e.skipped && e.version !== w.info.version) toTrash(e.rel);
    if ((w.info.sizeBytes ?? 0) > settings.maxFileBytes) {
      idx.files[w.raw.externalId] = {
        rel: w.rel,
        version: w.info.version,
        at: now,
        skipped: 'tooLarge',
      };
      r.skippedTooLarge++;
      continue;
    }
    requests.push({
      externalId: w.raw.externalId,
      payload: w.raw.payload,
      targetPath: abs(w.rel),
      maxBytes: settings.maxFileBytes,
      extract: true,
    });
  }
  if (requests.length > 0) {
    try {
      const out = await adapter.downloadFiles(
        requests,
        options.signal ? { signal: options.signal } : {},
      );
      warnings.push(...out.warnings.map((w) => `${sourceId}: ${w}`));
      for (const o of out.results) {
        const w = wanted.get(o.externalId);
        if (!w) continue;
        if (o.status === 'downloaded') {
          idx.files[o.externalId] = {
            rel: w.rel,
            version: o.version ?? w.info.version,
            bytes: o.bytes ?? 0,
            at: now,
          };
          r.downloaded++;
          r.bytesDownloaded += o.bytes ?? 0;
          if (o.text) r.textExtracted++;
        } else if (o.status === 'tooLarge') {
          idx.files[o.externalId] = {
            rel: w.rel,
            version: w.info.version,
            at: now,
            skipped: 'tooLarge',
          };
          r.skippedTooLarge++;
        } else r.failed++;
      }
      saveMirrorIndex(options.filesDir, sourceId, idx);
      if (out.items.length > 0) await uc.sync.ingest(sourceId, { items: out.items });
    } catch (e) {
      r.failed += requests.length;
      warnings.push(`${sourceId}: mirror downloads failed: ${errorMessage(e)}`);
    }
  }

  // 4. Housekeeping: old trash, and extracted texts whose file is gone.
  r.trashPurged = purgeTrash(
    path.join(root, '.trash'),
    settings.trashRetentionDays,
    uc.clock.now(),
  );
  r.orphanTextsRemoved = await removeOrphanTexts(uc, sourceId, adapter);
  r.present = Object.entries(idx.files).filter(
    ([k, e]) =>
      !e.skipped && wanted.get(k)?.info.version === e.version && fileSize(abs(e.rel)) !== undefined,
  ).length;
  idx.lastPassAt = now;
  saveMirrorIndex(options.filesDir, sourceId, idx);
  return r;
}

function purgeTrash(trashRoot: string, days: number, now: Date): number {
  let purged = 0;
  let entries: string[];
  try {
    entries = readdirSync(trashRoot);
  } catch {
    return 0;
  }
  const cutoff = now.getTime() - days * 86_400_000;
  for (const name of entries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    const t = Date.parse(`${name}T00:00:00Z`);
    if (Number.isFinite(t) && t + 86_400_000 < cutoff) {
      rmSync(path.join(trashRoot, name), { recursive: true, force: true });
      purged++;
    }
  }
  return purged;
}

/** Extracted texts (the adapter's text raw items) whose file item is deleted or gone. */
export async function removeOrphanTexts(
  uc: UniContext,
  sourceId: string,
  adapter: FileDownloadAdapter,
): Promise<number> {
  const raw = uc.sync.stores.raw;
  const textTypes = new Set(adapter.fileTextSourceTypes);
  if (textTypes.size === 0) return 0;
  const deletions: RawDeletion[] = [];
  for (const t of raw.list({ sourceId, sourceTypes: [...textTypes] })) {
    const alive = adapter.fileSourceTypes.some((ft) => {
      const f = raw.get(rawItemId(sourceId, ft, t.externalId));
      return f !== undefined && !f.deletedAt;
    });
    if (!alive) deletions.push({ sourceType: t.sourceType, externalId: t.externalId });
  }
  if (deletions.length > 0) await uc.sync.ingest(sourceId, { items: [], deletions });
  return deletions.length;
}

export interface MirrorStatusItem {
  sourceId: string;
  enabled: boolean;
  root: string;
  /** Files in the mirror (index). */
  files: number;
  /** Files left out in their current version (too large). */
  skipped: number;
  lastPassAt?: string;
}

/** Mirror status without running a pass (counts from the index). */
export function mirrorStatus(uc: UniContext, options: FileStoreOptions): MirrorStatusItem[] {
  const out: MirrorStatusItem[] = [];
  for (const src of uc.sync.sources()) {
    if (!supportsFileDownloads(src.adapter)) continue;
    const m = src.adapter.fileSettings().mirror;
    if (!m) continue;
    const idx = loadMirrorIndex(options.filesDir, src.sourceId, path.resolve(m.root));
    const entries = Object.values(idx.files);
    out.push({
      sourceId: src.sourceId,
      enabled: m.enabled,
      root: path.resolve(m.root),
      files: entries.filter((e) => !e.skipped).length,
      skipped: entries.filter((e) => e.skipped).length,
      ...(idx.lastPassAt ? { lastPassAt: idx.lastPassAt } : {}),
    });
  }
  return out;
}
