import { randomBytes } from 'node:crypto';
import type { PageLike } from '@unicontext/adapter-browser';
import { silentLogger, type Logger } from '@unicontext/core';
import type { VpnDeployment } from './deployment.js';
import {
  DOWNLOAD_CLOSE,
  DOWNLOAD_OPEN,
  DOWNLOAD_READ,
  FETCH_JSON,
  SESSION_CHECK,
  call,
} from './page-scripts.js';
import { parseTimestamp, sizeToBytes } from './parse.js';

export interface FbEntry {
  name: string;
  isFile: boolean;
  sizeBytes: number | undefined;
  sizeText: string | undefined;
  modifiedAt: string | undefined;
  modifiedText: string | undefined;
}

/**
 * Result of listing one directory. Only `ok` (a 200 JSON body with at least one entry) is trusted:
 * the caller indexes it and reconciles deletions from it. `empty` (200 but no entries) is treated
 * as a flaky result, never as "the folder was emptied" (research §3.4). `forbidden` is a 403 /
 * ファイル参照エラー (permission or transient — indistinguishable). `session` means the portal
 * answered with a login page / 401 (the session is gone → auth_required).
 */
export type ListResult =
  | { status: 'ok'; httpStatus: number; entries: FbEntry[] }
  | { status: 'empty'; httpStatus: number }
  | { status: 'forbidden'; httpStatus: number; message: string | undefined }
  | { status: 'session'; httpStatus: number }
  | { status: 'error'; httpStatus: number; message: string | undefined };

export interface ListDirRequest {
  resourceId: string;
  bookmark: string;
  bmtype: number;
  /** Share-relative directory ('' = share root). */
  dir: string;
}

export interface StreamFileRequest {
  resourceId: string;
  bookmark: string;
  bmtype: number;
  /** Parent directory of the file (share-relative). */
  dir: string;
  name: string;
  maxBytes: number;
}

export type StreamFileResult =
  | { ok: true; bytes: number; contentType: string | undefined }
  | { ok: false; reason: 'tooLarge' | 'notFound' | 'session' | 'failed'; status?: number };

export interface VpnPortalClient {
  /**
   * Ask the portal whether the session is live (one same-origin GET, see probePortalSession).
   * Optional: a client that cannot says nothing, and the caller then proves nothing.
   */
  probeSession?(): Promise<boolean>;
  listDir(req: ListDirRequest): Promise<ListResult>;
  streamFile(req: StreamFileRequest, onChunk: (chunk: Uint8Array) => Promise<void>): Promise<StreamFileResult>;
}

/** fb list URL (path + query), relative to the portal origin. */
export function buildListUrl(d: VpnDeployment, req: ListDirRequest): string {
  const q = new URLSearchParams({
    t: 'p',
    v: req.resourceId,
    si: '0',
    ri: '0',
    pi: '0',
    dir: req.dir,
    bmtype: String(req.bmtype),
    bmname: req.bookmark,
    sb: 'name',
    so: 'asc',
  });
  return `${d.listPath}?${q.toString()}`;
}

/**
 * SMB download URL (`wfd.cgi`, `$value`). The exact parameter set was not captured live
 * (research §3.2); this is the Ivanti-standard shape and is only ever used for a GET.
 */
export function buildDownloadUrl(d: VpnDeployment, req: StreamFileRequest): string {
  const q = new URLSearchParams({
    t: 'p',
    v: req.resourceId,
    dir: req.dir,
    file: req.name,
    bmtype: String(req.bmtype),
    bmname: req.bookmark,
  });
  return `${d.downloadPath}?${q.toString()}`;
}

/**
 * Keeps the portal session read-only: GET/HEAD/OPTIONS pass, and the Ivanti sign-in POSTs under
 * `/dana-na/auth/` pass so the human can log in. Every other method (uploads `wu.cgi`, new folder
 * `wnf.cgi`, deletes, any xsauth-bearing POST) is aborted before it leaves the browser. Requests to
 * other hosts (a federated identity provider's sign-in form) are left alone.
 */
export function routeDecision(method: string, url: string, portalOrigin: string): 'continue' | 'abort' {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return 'continue';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'abort';
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return 'continue';
  let origin: string;
  try {
    origin = new URL(portalOrigin).origin;
  } catch {
    origin = portalOrigin;
  }
  // Not the portal (e.g. the IdP sign-in host): leave it alone.
  if (u.origin !== origin) return 'continue';
  // On the portal only the sign-in endpoints may take a non-GET.
  if (/^\/dana-na\/auth\//i.test(u.pathname)) return 'continue';
  return 'abort';
}

interface PwRequest {
  method(): string;
  url(): string;
}
interface PwRoute {
  request(): PwRequest;
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}
interface PwContext {
  route(pattern: string, handler: (route: PwRoute) => unknown): Promise<void>;
}

export interface ReadOnlyRouteOptions {
  /** True while a person is signing in (a visible window): blocked requests are then logged at info. */
  interactive?: () => boolean;
  /** Told about every blocked request (method and path only). */
  onBlocked?: (method: string, path: string) => void;
}

/** Install the read-only route on a freshly launched context (before the first navigation). */
export async function installReadOnlyRoute(
  context: unknown,
  portalOrigin: string,
  logger: Logger = silentLogger,
  options: ReadOnlyRouteOptions = {},
): Promise<void> {
  const ctx = context as PwContext;
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    if (routeDecision(req.method(), req.url(), portalOrigin) === 'continue') return route.continue();
    // Method and path only: a query can carry tokens.
    const path = pathWithoutQuery(req.url());
    const fields = { method: req.method(), path };
    if (options.interactive?.()) logger.info('blocked non-read request during sign-in', fields);
    else logger.debug('blocked non-read request', fields);
    options.onBlocked?.(req.method(), path);
    return route.abort('blockedbyclient');
  });
}

function pathWithoutQuery(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

const FORBIDDEN_HINT = /ファイル参照エラー|参照エラー|access|denied|forbidden/i;

function hasEntries(body: unknown): FbEntry[] | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const files = (body as { files?: unknown }).files;
  if (!Array.isArray(files)) return undefined;
  const out: FbEntry[] = [];
  for (const raw of files) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name : undefined;
    if (!name || name === '.' || name === '..') continue;
    const isFile = /^y/i.test(String(e.isFile ?? ''));
    const sizeText = e.size === undefined ? undefined : String(e.size);
    const modifiedText = typeof e.timestamp === 'string' ? e.timestamp.trim() : undefined;
    out.push({
      name,
      isFile,
      sizeBytes: sizeToBytes(e.size as string | number | undefined),
      sizeText,
      modifiedAt: parseTimestamp(modifiedText),
      modifiedText,
    });
  }
  return out;
}

interface Evaluable {
  evaluate(expression: string): Promise<unknown>;
}

/** Any page of the portal host (a same-origin fetch works from it, whatever its path). */
export function onPortalHost(deployment: VpnDeployment, url: string): boolean {
  try {
    return new URL(url).host === new URL(deployment.origin).host;
  } catch {
    return false;
  }
}

/** What one in-page session check saw (see SESSION_CHECK). */
export interface SessionCheck {
  live: boolean;
  status?: number;
  ctype?: string;
  redirected?: boolean;
  finalPath?: string;
  error?: string;
}

export interface PortalProbe {
  live: boolean;
  /** Which probe answered "live" (undefined when none did). */
  via?: 'landing-page' | 'list-shares' | 'list';
  /** Every check made, in order, with its label. */
  checks: { probe: string; check: SessionCheck }[];
}

/**
 * Ask the portal itself, from the page, whether the session is live: the landing-page JSON first
 * and, only when that answered 200 without a redirect but not with JSON, a second probe (the
 * share list, then the list of the first root) that only a signed-in session answers with JSON
 * files/shares. Same-origin GETs only; a bounced landing-page stops at one request.
 */
export async function probePortalSession(
  page: PageLike,
  deployment: VpnDeployment,
): Promise<PortalProbe> {
  const checks: PortalProbe['checks'] = [];
  if (!onPortalHost(deployment, page.url())) return { live: false, checks };
  const root = deployment.roots.find((r) => r.enabled) ?? deployment.roots[0];
  const probes: { label: 'landing-page' | 'list-shares' | 'list'; url: string; anyKey?: string[] }[] = [
    { label: 'landing-page', url: deployment.sessionCheckPath },
    { label: 'list-shares', url: deployment.listSharesPath, anyKey: ['shares', 'files'] },
  ];
  if (root)
    probes.push({
      label: 'list',
      url: buildListUrl(deployment, {
        resourceId: root.resourceId,
        bookmark: root.bookmark,
        bmtype: root.bmtype,
        dir: root.startDir,
      }),
      anyKey: ['files'],
    });
  for (const p of probes) {
    const check = ((await (page as unknown as Evaluable).evaluate(
      call(SESSION_CHECK, { url: p.url, ...(p.anyKey ? { anyKey: p.anyKey } : {}) }),
    )) ?? { live: false }) as SessionCheck;
    checks.push({ probe: p.label, check });
    if (check.live === true) return { live: true, via: p.label, checks };
    // The fallbacks exist for landing-page answering 200 HTML without a redirect. A redirect (to
    // the sign-in area or the root), a 404 or a network error means signed out: asking again would
    // only add traffic and follow the sign-in redirect while the student is still typing.
    if (p.label === 'landing-page' && !(check.status === 200 && check.redirected !== true)) break;
  }
  return { live: false, checks };
}

/** `landing-page 200→/dana-na/auth/welcome.cgi text/html · list-shares 404`: what the checks saw. */
export function describeChecks(checks: PortalProbe['checks']): string {
  return checks
    .map(({ probe, check }) => {
      if (check.error) return `${probe} ${check.error}`;
      const ctype = check.ctype ? (check.ctype.split(';')[0] ?? '').trim() : '';
      const hop = check.redirected && check.finalPath ? `→${check.finalPath}` : '';
      return `${probe} ${check.status ?? '?'}${hop}${check.live || !ctype ? '' : ` ${ctype}`}`;
    })
    .join(' · ');
}

/** Portal client driven inside the signed-in page (same-origin GET only, read-only). */
export class PlaywrightVpnClient implements VpnPortalClient {
  private readonly page: Evaluable;
  private readonly pageLike: PageLike;
  private readonly logger: Logger;

  constructor(
    page: PageLike,
    private readonly deployment: VpnDeployment,
    logger: Logger = silentLogger,
  ) {
    this.page = page as unknown as Evaluable;
    this.pageLike = page;
    this.logger = logger;
  }

  async probeSession(): Promise<boolean> {
    return (await probePortalSession(this.pageLike, this.deployment)).live;
  }

  async listDir(req: ListDirRequest): Promise<ListResult> {
    const url = buildListUrl(this.deployment, req);
    const r = (await this.page.evaluate(call(FETCH_JSON, { url }))) as {
      ok?: boolean;
      error?: string;
      status?: number;
      html?: boolean;
      parse?: boolean;
      session?: boolean;
      snippet?: string;
      body?: unknown;
    };
    const http = r.status ?? 0;
    // Redirected to the sign-in area / portal root: the session is gone (never a 403 or a flake).
    if (r.session) return { status: 'session', httpStatus: http };
    if (r.error === 'cross-origin' || r.error === 'network')
      return { status: 'error', httpStatus: http, message: r.error };
    if (r.ok && r.body !== undefined) {
      const entries = hasEntries(r.body);
      if (entries === undefined) return { status: 'error', httpStatus: http, message: 'no files array' };
      return entries.length > 0
        ? { status: 'ok', httpStatus: http, entries }
        : { status: 'empty', httpStatus: http };
    }
    if (r.html || http === 401 || http === 302)
      return { status: 'session', httpStatus: http };
    if (http === 403 || FORBIDDEN_HINT.test(r.snippet ?? ''))
      return { status: 'forbidden', httpStatus: http, message: r.snippet };
    return { status: 'error', httpStatus: http, message: r.snippet };
  }

  async streamFile(
    req: StreamFileRequest,
    onChunk: (chunk: Uint8Array) => Promise<void>,
  ): Promise<StreamFileResult> {
    const url = buildDownloadUrl(this.deployment, req);
    const key = randomBytes(12).toString('hex');
    const opened = (await this.page.evaluate(
      call(DOWNLOAD_OPEN, { url, maxBytes: req.maxBytes, key }),
    )) as { ok?: boolean; error?: string; status?: number; contentType?: string };
    if (!opened.ok) {
      const status = opened.status ?? 0;
      if (opened.error === 'too large') return { ok: false, reason: 'tooLarge', status };
      if (opened.error === 'html' || status === 401) return { ok: false, reason: 'session', status };
      if (status === 404) return { ok: false, reason: 'notFound', status };
      return { ok: false, reason: 'failed', status };
    }
    let bytes = 0;
    try {
      for (;;) {
        const r = (await this.page.evaluate(call(DOWNLOAD_READ, { key, maxChunk: 1024 * 1024 }))) as {
          base64?: string;
          done?: boolean;
          error?: string;
        };
        if (r.error === 'too large') return { ok: false, reason: 'tooLarge' };
        if (r.error || r.base64 === undefined) return { ok: false, reason: 'failed' };
        const chunk = Buffer.from(r.base64, 'base64');
        bytes += chunk.byteLength;
        if (bytes > req.maxBytes) return { ok: false, reason: 'tooLarge' };
        if (chunk.byteLength > 0) await onChunk(new Uint8Array(chunk));
        if (r.done) break;
      }
    } finally {
      await this.page.evaluate(call(DOWNLOAD_CLOSE, { key })).catch(() => undefined);
    }
    this.logger.debug('vpn download complete', { bytes });
    return { ok: true, bytes, contentType: opened.contentType || undefined };
  }
}
