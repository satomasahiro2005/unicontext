import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Capability, HealthStatus } from '@unicontext/canonical-model';
import type {
  AuthResult,
  DownloadableFile,
  FileDownloadAdapter,
  FileDownloadOutcome,
  FileDownloadRequest,
  FileDownloadSettings,
  InteractiveAuthAdapter,
  InteractiveLoginOptions,
  RawDeletion,
  RawItem,
  SyncInput,
  SyncResult,
} from '@unicontext/connector-sdk';
import {
  AuthRequiredError,
  type Clock,
  errorMessage,
  type Logger,
} from '@unicontext/core';
import type { ShizuokaVpnFilesConfig } from './config.js';
import { courseHintForPath, isPrefetchPath } from './courses.js';
import type { VpnDeployment, VpnRoot } from './deployment.js';
import { PRODUCT } from './metadata.js';
import {
  extensionOf,
  joinPath,
  mimeFromName,
  parentOf,
} from './parse.js';
import type { ListResult, StreamFileResult, VpnPortalClient } from './client.js';
import { FilePayloadSchema, type FilePayload } from './schemas.js';

const CAPABILITIES: Capability[] = ['materials'];

// ---------------------------------------------------------------------------------------------
// Walk state (persisted as cursor.extra)

interface FolderState {
  listedAt: string;
  status: 'ok' | 'forbidden';
  /** Child file external ids present at the last OK listing (for deletion reconciliation). */
  fileIds: string[];
  /** Child subfolder paths (relative to the root) at the last OK listing. */
  subfolders: string[];
  childFileCount: number;
}

interface RootState {
  /** Folder paths (relative to the root) still to visit, DFS order. */
  frontier: string[];
  folders: Record<string, FolderState>;
  backoff: Record<string, { failures: number; nextAttemptAt: string }>;
  seededAt: string;
}

export interface WalkState {
  version: 1;
  roots: Record<string, RootState>;
}

export function emptyState(): WalkState {
  return { version: 1, roots: {} };
}

export function loadState(extra: unknown): WalkState {
  if (extra && typeof extra === 'object' && (extra as WalkState).version === 1)
    return { version: 1, roots: { ...(extra as WalkState).roots } };
  return emptyState();
}

// ---------------------------------------------------------------------------------------------

export interface WithClient {
  <T>(
    fn: (client: VpnPortalClient) => Promise<T>,
    options?: { startUrl?: string },
  ): Promise<{ result: T } | { auth: AuthResult }>;
}

/** When a live portal session was last verified (ISO time), shared by the CLI and the daemon. */
export interface SessionMarker {
  read(): string | undefined;
  /** `undefined` forgets it (signed out, session ended). */
  write(verifiedAt: string | undefined): void;
}

/** A session verified this recently is trusted without opening the browser again. */
const RECHECK_AFTER_MS = 2 * 60_000;

export interface TeamsLikeExtract {
  (data: Uint8Array, ext: string): Promise<{ text: string; pages?: { page: number; text: string }[] }>;
}

export interface ShizuokaVpnFilesAdapterOptions {
  sourceId: string;
  config: ShizuokaVpnFilesConfig;
  deployment: VpnDeployment;
  clock: Clock;
  logger: Logger;
  timezone: string;
  profileExists: () => boolean;
  /** Another browser process has the profile open right now (default: never). */
  profileInUse?: () => boolean;
  /** Headless check against the portal itself (never prompts). Default: not verifiable. */
  verifySession?: () => Promise<AuthResult>;
  /** Default: in memory only. */
  sessionMarker?: SessionMarker;
  withClient: WithClient;
  login?: (options?: InteractiveLoginOptions) => Promise<AuthResult>;
  logout?: () => Promise<void>;
  close?: () => Promise<void>;
  /** Text extraction (default: @unicontext/local-files). */
  extract?: TeamsLikeExtract;
  random?: () => number;
}

interface Counts {
  [k: string]: number;
  roots: number;
  foldersListed: number;
  foldersForbidden: number;
  foldersEmpty: number;
  listErrors: number;
  files: number;
  filesDeleted: number;
}

interface RunOutput {
  items: RawItem[];
  deletions: RawDeletion[];
  warnings: string[];
  counts: Counts;
}

/** External id of a file / folder raw item. */
export function fileExternalId(rootKey: string, path: string): string {
  return `${rootKey}:${path}`;
}
export function folderExternalId(rootKey: string, path: string): string {
  return `${rootKey}:${path}`;
}

/**
 * Walks the accessible tree of the Ivanti portal file share, metadata-only, DFS with caps, and
 * downloads files on request — all read-only through the student's signed-in session. The crawl is
 * NOT filtered by enrolled course; a failed or empty listing is never a deletion (research §3.4).
 */
export class ShizuokaVpnFilesAdapter implements InteractiveAuthAdapter, FileDownloadAdapter {
  readonly id: string;
  readonly fileSourceTypes = ['szvpn.file'] as const;
  readonly fileTextSourceTypes = ['szvpn.fileText'] as const;
  readonly version = '1.0.0';
  private healthState: HealthStatus;
  lastRunCounts: Record<string, number> = {};
  private readonly marker: SessionMarker;

  constructor(private readonly options: ShizuokaVpnFilesAdapterOptions) {
    this.id = `shizuoka-vpn-files:${options.sourceId}`;
    this.healthState = { state: 'healthy', checkedAt: options.clock.now().toISOString() };
    let mem: string | undefined;
    this.marker = options.sessionMarker ?? {
      read: () => mem,
      write: (at) => {
        mem = at;
      },
    };
  }

  capabilities(): Promise<Capability[]> {
    return Promise.resolve([...CAPABILITIES]);
  }

  private signInRequired(detail?: string): AuthResult {
    return {
      status: 'auth_required',
      message: `SSL-VPN ポータルのサインインが必要です。「unicontext login ${this.options.sourceId}」でサインインしてください。 / SSL-VPN portal sign-in required; run \`unicontext login ${this.options.sourceId}\`.${detail ? ` (${detail})` : ''}`,
    };
  }

  private verifiedAgoMs(): number | undefined {
    const at = this.marker.read();
    const t = at ? Date.parse(at) : NaN;
    return Number.isNaN(t) ? undefined : this.now().getTime() - t;
  }

  private markVerified(): void {
    this.marker.write(this.now().toISOString());
  }

  /**
   * "Signed in" only for a portal session that was actually verified: a browser profile on disk
   * proves nothing (a sign-in window that closed early leaves one behind). Never prompts.
   * - never verified, or longer ago than the portal keeps a session → auth_required, without
   *   opening a browser;
   * - verified within the last 2 minutes (a sync or login just did) → authenticated;
   * - otherwise a headless check against the portal decides.
   */
  async authenticate(): Promise<AuthResult> {
    if (!this.options.profileExists()) return this.signInRequired();
    const ago = this.verifiedAgoMs();
    const maxMs = this.options.config.browser.sessionMaxMinutes * 60_000;
    if (ago === undefined || ago < 0 || ago > maxMs) return this.signInRequired();
    if (ago <= RECHECK_AFTER_MS)
      return { status: 'authenticated', message: 'SSL-VPN portal session verified' };
    // The other UniContext process (daemon sync / CLI) is using the session right now.
    if (this.options.profileInUse?.())
      return {
        status: 'authenticated',
        message: 'SSL-VPN portal session in use by another UniContext process',
      };
    if (!this.options.verifySession) return this.signInRequired();
    const r = await this.options.verifySession();
    if (r.status === 'authenticated') {
      this.markVerified();
      return { status: 'authenticated', message: 'SSL-VPN portal session verified' };
    }
    this.marker.write(undefined);
    return this.signInRequired(r.message);
  }

  async login(options?: InteractiveLoginOptions): Promise<AuthResult> {
    if (!this.options.login) return { status: 'failed', message: 'Interactive login is not available' };
    const r = await this.options.login(options);
    if (r.status === 'authenticated') this.markVerified();
    return r;
  }

  async logout(): Promise<void> {
    this.marker.write(undefined);
    await this.options.logout?.();
  }

  health(): Promise<HealthStatus> {
    return Promise.resolve({ ...this.healthState });
  }

  async dispose(): Promise<void> {
    await this.options.close?.();
  }

  private now(): Date {
    return this.options.clock.now();
  }

  private async pause(ms: number): Promise<void> {
    if (ms <= 0) return;
    const jitter = Math.floor(ms * 0.5 * (this.options.random ?? Math.random)());
    await this.options.clock.sleep(ms + jitter);
  }

  /** Enabled roots: deployment roots minus `roots.disable`, plus `roots.include`. */
  private enabledRoots(): VpnRoot[] {
    const disable = new Set(this.options.config.roots.disable);
    const out: VpnRoot[] = [];
    const seen = new Set<string>();
    for (const r of [...this.options.deployment.roots, ...this.options.config.roots.include]) {
      if (!r.enabled || disable.has(r.key) || seen.has(r.key)) continue;
      seen.add(r.key);
      out.push(r);
    }
    return out;
  }

  private get defaultRootKey(): string {
    return this.enabledRoots()[0]?.key ?? '';
  }

  async sync(input: SyncInput): Promise<SyncResult> {
    const state = loadState(input.cursor?.extra);
    let out: { result: RunOutput } | { auth: AuthResult };
    try {
      out = await this.options.withClient((client) => this.run(client, state, input));
    } catch (e) {
      if (e instanceof AuthRequiredError) {
        this.marker.write(undefined);
        this.healthState = {
          state: 'auth_required',
          checkedAt: this.now().toISOString(),
          message: e.message,
        };
      }
      throw e;
    }
    const now = this.now().toISOString();
    if ('auth' in out) {
      this.marker.write(undefined);
      this.healthState = {
        state: 'auth_required',
        checkedAt: now,
        ...(out.auth.message ? { message: out.auth.message } : {}),
      };
      throw new AuthRequiredError(out.auth.message ?? 'SSL-VPN portal sign-in required');
    }
    const r = out.result;
    this.markVerified();
    this.lastRunCounts = r.counts;
    const degraded = (r.counts.listErrors ?? 0) > 0 && (r.counts.foldersListed ?? 0) === 0;
    this.healthState = degraded
      ? { state: 'degraded', checkedAt: now, message: 'portal listing is flaky; kept last good index' }
      : { state: 'healthy', checkedAt: now, lastSuccessAt: now };
    return {
      items: r.items,
      ...(r.deletions.length ? { deletions: r.deletions } : {}),
      cursor: { extra: state as unknown as Record<string, unknown> },
      productVersion: { product: PRODUCT, version: this.options.deployment.id },
      // NEVER declare `complete`: the listing is flaky, so unseen items must not be deleted.
      ...(r.warnings.length ? { warnings: r.warnings } : {}),
    };
  }

  private rootState(state: WalkState, root: VpnRoot, mode: SyncInput['mode'], now: Date): RootState {
    const cfg = this.options.config.walk;
    let rs = state.roots[root.key];
    if (!rs) {
      rs = { frontier: [root.startDir], folders: {}, backoff: {}, seededAt: now.toISOString() };
      state.roots[root.key] = rs;
      return rs;
    }
    if (mode === 'full' || mode === 'initial') {
      rs.frontier = [root.startDir];
      rs.seededAt = now.toISOString();
      return rs;
    }
    if (rs.frontier.length === 0) {
      const sweepAgeH = (now.getTime() - new Date(rs.seededAt).getTime()) / 3_600_000;
      if (sweepAgeH >= cfg.rewalkAfterHours) {
        rs.frontier = [root.startDir];
        rs.seededAt = now.toISOString();
      } else {
        // Re-list stale folders (oldest first), bounded.
        const stale = Object.entries(rs.folders)
          .filter(
            ([, f]) =>
              f.status === 'ok' &&
              (now.getTime() - new Date(f.listedAt).getTime()) / 3_600_000 >=
                cfg.refreshFolderAfterHours,
          )
          .sort((a, b) => a[1].listedAt.localeCompare(b[1].listedAt))
          .slice(0, cfg.maxFoldersPerRun)
          .map(([p]) => p);
        rs.frontier = stale;
      }
    }
    return rs;
  }

  private async run(
    client: VpnPortalClient,
    state: WalkState,
    input: SyncInput,
  ): Promise<RunOutput> {
    const cfg = this.options.config;
    const now = this.now();
    const nowIso = now.toISOString();
    const items: RawItem[] = [];
    const deletions: RawDeletion[] = [];
    const warnings: string[] = [];
    const counts: Counts = {
      roots: 0,
      foldersListed: 0,
      foldersForbidden: 0,
      foldersEmpty: 0,
      listErrors: 0,
      files: 0,
      filesDeleted: 0,
    };
    const roots = this.enabledRoots();
    counts.roots = roots.length;
    let filesTotal = 0;
    for (const rs of Object.values(state.roots))
      for (const f of Object.values(rs.folders)) filesTotal += f.childFileCount;

    let budget = cfg.walk.maxFoldersPerRun;
    for (const root of roots) {
      if (budget <= 0) break;
      const rs = this.rootState(state, root, input.mode, now);
      const visited = new Set<string>();
      while (budget > 0 && rs.frontier.length > 0) {
        if (input.signal?.aborted) break;
        const path = rs.frontier.shift()!;
        if (visited.has(path)) continue;
        visited.add(path);
        const depth = path === '' ? 0 : path.split('/').length;
        if (depth > cfg.walk.maxDepth) continue;
        const bo = rs.backoff[path];
        if (bo && new Date(bo.nextAttemptAt).getTime() > now.getTime()) continue;
        if (filesTotal >= cfg.walk.maxFilesTotal) {
          warnings.push('file index cap reached; stopping the walk');
          break;
        }
        budget--;
        const result = await this.listWithRetry(client, root, path);
        // A `session` result means the portal dropped us to a login page: abort with
        // auth_required and make NO changes at all (never a deletion).
        if (result.status === 'session')
          throw new AuthRequiredError(
            `SSL-VPN ポータルのセッションが切れました。「unicontext login ${this.options.sourceId}」で再度サインインしてください。 / SSL-VPN portal session expired; run \`unicontext login ${this.options.sourceId}\`.`,
          );
        this.applyListing(
          root,
          path,
          depth,
          result,
          rs,
          { items, deletions, warnings, counts },
          nowIso,
        );
        if (result.status === 'ok') filesTotal += result.entries.filter((e) => e.isFile).length;
        await this.pause(cfg.walk.requestDelayMs);
      }
    }
    return { items, deletions, warnings, counts };
  }

  /** List one folder, retrying transient failures (flaky 403 / empty 200) within the run. */
  private async listWithRetry(client: VpnPortalClient, root: VpnRoot, path: string): Promise<ListResult> {
    const cfg = this.options.config.walk;
    let last: ListResult = { status: 'error', httpStatus: 0, message: 'not attempted' };
    for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
      // `path` is share-relative (the fb `dir` value); the frontier is seeded with root.startDir.
      last = await client.listDir({
        resourceId: root.resourceId,
        bookmark: root.bookmark,
        bmtype: root.bmtype,
        dir: path,
      });
      if (last.status === 'ok' || last.status === 'session') return last;
      if (attempt < cfg.maxRetries) await this.pause(cfg.retryBaseMs * 2 ** attempt);
    }
    return last;
  }

  private applyListing(
    root: VpnRoot,
    path: string,
    depth: number,
    result: ListResult,
    rs: RootState,
    acc: RunOutput,
    nowIso: string,
  ): void {
    if (result.status !== 'ok') {
      // Untrusted: keep the last good listing (do not emit the folder), set backoff, never delete.
      if (result.status === 'empty') acc.counts.foldersEmpty++;
      else if (result.status === 'forbidden') acc.counts.foldersForbidden++;
      else acc.counts.listErrors++;
      const prev = rs.backoff[path]?.failures ?? 0;
      const backoffMs = Math.min(
        this.options.config.walk.retryBaseMs * 2 ** prev,
        6 * 3_600_000,
      );
      rs.backoff[path] = {
        failures: prev + 1,
        nextAttemptAt: new Date(this.now().getTime() + backoffMs).toISOString(),
      };
      const known = rs.folders[path];
      if (!known && result.status === 'forbidden') {
        // Never seen OK: record a forbidden placeholder so the folder is at least visible.
        rs.folders[path] = {
          listedAt: nowIso,
          status: 'forbidden',
          fileIds: [],
          subfolders: [],
          childFileCount: 0,
        };
        acc.items.push(
          this.folderItem(root, path, depth, nowIso, 'forbidden', [], result.message),
        );
      }
      // Re-visit later: push to the end of the frontier.
      if (!rs.frontier.includes(path)) rs.frontier.push(path);
      return;
    }

    // Trusted OK listing.
    acc.counts.foldersListed++;
    delete rs.backoff[path];
    const cfg = this.options.config;
    const course = courseHintForPath(cfg, root.key, path, this.defaultRootKey);
    const children: {
      name: string;
      isFile: boolean;
      path: string;
      sizeBytes?: number;
      modifiedAt?: string;
    }[] = [];
    const newFileIds: string[] = [];
    const newSubfolders: string[] = [];
    for (const e of result.entries) {
      const childPath = joinPath(path, e.name);
      if (e.isFile) {
        const extId = fileExternalId(root.key, childPath);
        newFileIds.push(extId);
        children.push({
          name: e.name,
          isFile: true,
          path: childPath,
          ...(e.sizeBytes !== undefined ? { sizeBytes: e.sizeBytes } : {}),
          ...(e.modifiedAt ? { modifiedAt: e.modifiedAt } : {}),
        });
        acc.items.push(this.fileItem(root, path, childPath, e, nowIso));
        acc.counts.files++;
      } else {
        newSubfolders.push(childPath);
        children.push({ name: e.name, isFile: false, path: childPath });
        if (!rs.folders[childPath] && !rs.frontier.includes(childPath))
          rs.frontier.unshift(childPath); // DFS
      }
    }

    // Reconcile deletions against the previous OK listing of this folder only.
    const prev = rs.folders[path];
    if (prev) {
      const present = new Set(newFileIds);
      for (const old of prev.fileIds)
        if (!present.has(old)) {
          acc.deletions.push({ sourceType: 'szvpn.file', externalId: old });
          acc.counts.filesDeleted++;
        }
      const presentSub = new Set(newSubfolders);
      for (const oldSub of prev.subfolders)
        if (!presentSub.has(oldSub)) {
          acc.deletions.push({ sourceType: 'szvpn.folder', externalId: folderExternalId(root.key, oldSub) });
          delete rs.folders[oldSub];
        }
    }

    rs.folders[path] = {
      listedAt: nowIso,
      status: 'ok',
      fileIds: newFileIds,
      subfolders: newSubfolders,
      childFileCount: newFileIds.length,
    };
    acc.items.push(this.folderItem(root, path, depth, nowIso, 'ok', children, undefined, course));
  }

  private label(root: VpnRoot, path: string): string {
    const segs = path ? path.split('/') : [];
    return [root.label, ...segs].join(' / ');
  }

  private folderItem(
    root: VpnRoot,
    path: string,
    depth: number,
    nowIso: string,
    status: 'ok' | 'forbidden',
    children: { name: string; isFile: boolean; path: string; sizeBytes?: number; modifiedAt?: string }[],
    accessError?: string,
    course?: ReturnType<typeof courseHintForPath>,
  ): RawItem {
    const name = path ? (path.split('/').pop() ?? '') : '';
    return {
      sourceType: 'szvpn.folder',
      externalId: folderExternalId(root.key, path),
      payload: {
        root: root.key,
        path,
        name,
        ...(path ? { parent: parentOf(path) } : {}),
        label: this.label(root, path),
        resourceId: root.resourceId,
        bookmark: root.bookmark,
        dir: path,
        listedAt: nowIso,
        status,
        ...(accessError ? { accessError } : {}),
        childFileCount: children.filter((c) => c.isFile).length,
        childFolderCount: children.filter((c) => !c.isFile).length,
        depth,
        children,
        course: course ?? null,
      },
    };
  }

  private fileItem(
    root: VpnRoot,
    parent: string,
    path: string,
    e: { name: string; sizeBytes: number | undefined; sizeText: string | undefined; modifiedAt: string | undefined; modifiedText: string | undefined },
    nowIso: string,
  ): RawItem {
    const cfg = this.options.config;
    const course = courseHintForPath(cfg, root.key, path, this.defaultRootKey);
    const version = `${e.modifiedText ?? ''}|${e.sizeBytes ?? ''}`;
    const payload: FilePayload = {
      root: root.key,
      parent,
      path,
      name: e.name,
      label: this.label(root, path),
      ...(e.sizeBytes !== undefined ? { sizeBytes: e.sizeBytes } : {}),
      ...(e.sizeText ? { sizeText: e.sizeText } : {}),
      ...(e.modifiedAt ? { modifiedAt: e.modifiedAt } : {}),
      ...(e.modifiedText ? { modifiedText: e.modifiedText } : {}),
      ...(mimeFromName(e.name) ? { mimeType: mimeFromName(e.name) } : {}),
      resourceId: root.resourceId,
      bookmark: root.bookmark,
      dir: parent,
      version,
      listedAt: nowIso,
      course: course ?? null,
      prefetch: isPrefetchPath(cfg, path),
    };
    return {
      sourceType: 'szvpn.file',
      externalId: fileExternalId(root.key, path),
      payload,
      ...(e.modifiedAt ? { sourceUpdatedAt: e.modifiedAt } : {}),
    };
  }

  // -------------------------------------------------------------------------------------------
  // On-demand downloads and the opt-in mirror (FileDownloadAdapter)

  fileSettings(): FileDownloadSettings {
    const cfg = this.options.config;
    const mb = (n: number): number => Math.round(n * 1024 * 1024);
    return {
      maxDownloadBytes: mb(cfg.files.maxDownloadMB),
      mirror: {
        enabled: cfg.mirror.enabled,
        root: expandHome(cfg.mirror.root),
        courses: cfg.mirror.courses,
        maxFileBytes: mb(cfg.mirror.maxFileMB),
        maxFilesPerPass: cfg.mirror.maxFilesPerPass,
        trashRetentionDays: cfg.mirror.trashRetentionDays,
      },
    };
  }

  describeFile(item: { sourceType: string; externalId: string; payload: unknown }): DownloadableFile | undefined {
    if (item.sourceType !== 'szvpn.file') return undefined;
    const r = FilePayloadSchema.safeParse(item.payload);
    if (!r.success) return undefined;
    const p = r.data;
    return {
      externalId: item.externalId,
      name: p.name,
      container: rootLabelOf(this.options.deployment, p.root),
      containerId: p.root,
      // "isClass" gates the opt-in mirror: a course-linked folder, or one marked for prefetch.
      isClass: p.course !== null || p.prefetch,
      folder: p.parent,
      version: p.version,
      sizeBytes: p.sizeBytes,
      modifiedAt: p.modifiedAt,
      mimeType: p.mimeType,
    };
  }

  async downloadFiles(
    requests: readonly FileDownloadRequest[],
    options: { signal?: AbortSignal } = {},
  ): Promise<{ results: FileDownloadOutcome[]; items: RawItem[]; warnings: string[] }> {
    const cfg = this.options.config.files;
    const results = new Map<string, FileDownloadOutcome>();
    const items: RawItem[] = [];
    const warnings: string[] = [];
    const jobs: { req: FileDownloadRequest; p: FilePayload }[] = [];
    for (const req of requests) {
      const r = FilePayloadSchema.safeParse(req.payload);
      if (!r.success) {
        results.set(req.externalId, { externalId: req.externalId, status: 'notFound' });
        continue;
      }
      const p = r.data;
      if (!req.extractOnly && p.sizeBytes !== undefined && p.sizeBytes > req.maxBytes) {
        results.set(req.externalId, {
          externalId: req.externalId,
          status: 'tooLarge',
          bytes: p.sizeBytes,
          version: p.version,
        });
        continue;
      }
      jobs.push({ req, p });
    }

    const downloads = jobs.filter((j) => !j.req.extractOnly);
    if (downloads.length > 0) {
      let out: { result: void } | { auth: AuthResult };
      try {
        out = await this.options.withClient((client) =>
          this.downloadAll(client, downloads, results, warnings, options.signal),
        );
      } catch (e) {
        if (e instanceof AuthRequiredError) this.marker.write(undefined);
        throw e;
      }
      if ('auth' in out) {
        this.marker.write(undefined);
        throw new AuthRequiredError(out.auth.message ?? 'SSL-VPN portal sign-in required');
      }
      this.markVerified();
    }

    const extract = this.options.extract ?? defaultExtract;
    for (const { req, p } of jobs) {
      const prev = results.get(req.externalId);
      if (!req.extractOnly && prev?.status !== 'downloaded') continue;
      const outcome: FileDownloadOutcome = prev ?? {
        externalId: req.externalId,
        status: 'extracted',
        version: p.version,
      };
      const ext = extensionOf(p.name);
      if (req.extract && cfg.extractExtensions.includes(ext)) {
        try {
          const size = (await stat(req.targetPath)).size;
          if (size <= cfg.maxExtractBytes) {
            const content = await extract(new Uint8Array(await readFile(req.targetPath)), ext);
            if (content.text.trim()) {
              items.push({
                sourceType: 'szvpn.fileText',
                externalId: req.externalId,
                payload: {
                  externalId: req.externalId,
                  path: p.path,
                  name: p.name,
                  version: p.version,
                  text: content.text,
                  ...(content.pages?.length ? { pages: content.pages } : {}),
                },
              });
              outcome.text = { chars: content.text.length, pages: content.pages?.length ?? 0 };
            }
          } else warnings.push(`${p.name}: too large for text extraction`);
        } catch (e) {
          warnings.push(`text of ${p.name}: ${errorMessage(e)}`);
          if (req.extractOnly) outcome.error = errorMessage(e);
        }
      }
      results.set(req.externalId, outcome);
    }
    return {
      results: requests.map(
        (r) => results.get(r.externalId) ?? { externalId: r.externalId, status: 'failed', error: 'not processed' },
      ),
      items,
      warnings,
    };
  }

  private async downloadAll(
    client: VpnPortalClient,
    downloads: { req: FileDownloadRequest; p: FilePayload }[],
    results: Map<string, FileDownloadOutcome>,
    warnings: string[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const cfg = this.options.config.files;
    for (const [i, { req, p }] of downloads.entries()) {
      if (signal?.aborted) {
        results.set(req.externalId, { externalId: req.externalId, status: 'failed', error: 'aborted' });
        continue;
      }
      results.set(req.externalId, await this.downloadOneWithRetry(client, req, p, warnings));
      if (i < downloads.length - 1) await this.pause(cfg.downloadDelayMs);
    }
  }

  private async downloadOneWithRetry(
    client: VpnPortalClient,
    req: FileDownloadRequest,
    p: FilePayload,
    warnings: string[],
  ): Promise<FileDownloadOutcome> {
    const cfg = this.options.config.files;
    let last: FileDownloadOutcome = { externalId: req.externalId, status: 'failed', version: p.version };
    for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
      const o = await this.downloadOne(client, req, p);
      if (o.status === 'downloaded' || o.status === 'notFound' || o.status === 'tooLarge') return o;
      last = o;
      if (attempt < cfg.maxRetries) {
        warnings.push(`${p.name}: download attempt ${attempt + 1} failed (${o.error ?? o.status}); retrying`);
        await this.pause(cfg.downloadDelayMs * 2 ** attempt);
      }
    }
    return last;
  }

  private async downloadOne(
    client: VpnPortalClient,
    req: FileDownloadRequest,
    p: FilePayload,
  ): Promise<FileDownloadOutcome> {
    await mkdir(dirname(req.targetPath), { recursive: true });
    const part = `${req.targetPath}.part`;
    const handle = await open(part, 'w');
    let r: StreamFileResult;
    try {
      r = await client.streamFile(
        {
          resourceId: p.resourceId,
          bookmark: p.bookmark,
          bmtype: 1,
          dir: p.dir,
          name: p.name,
          maxBytes: req.maxBytes,
        },
        async (chunk) => {
          await handle.write(chunk);
        },
      );
    } catch (e) {
      await handle.close();
      await rm(part, { force: true });
      throw e;
    }
    await handle.close();
    if (!r.ok) {
      await rm(part, { force: true });
      if (r.reason === 'session') throw new AuthRequiredError('SSL-VPN portal sign-in required');
      return {
        externalId: req.externalId,
        status: r.reason === 'tooLarge' ? 'tooLarge' : r.reason === 'notFound' ? 'notFound' : 'failed',
        version: p.version,
        ...(r.status ? { error: `HTTP ${r.status}` } : {}),
      };
    }
    await rename(part, req.targetPath);
    return {
      externalId: req.externalId,
      status: 'downloaded',
      bytes: r.bytes,
      version: p.version,
      ...(r.contentType ? { contentType: r.contentType } : {}),
    };
  }
}

function rootLabelOf(deployment: VpnDeployment, rootKey: string): string {
  return deployment.roots.find((r) => r.key === rootKey)?.label ?? rootKey;
}

async function defaultExtract(
  data: Uint8Array,
  ext: string,
): Promise<{ text: string; pages?: { page: number; text: string }[] }> {
  const { extractContent } = await import('@unicontext/local-files');
  const c = await extractContent(data, ext);
  if (c.pages?.length) return { text: c.pages.map((p) => p.text).join('\n\n'), pages: c.pages };
  if (c.slides?.length)
    return {
      text: c.slides.map((s) => [s.title, s.text, s.notes].filter(Boolean).join('\n')).join('\n\n'),
      pages: c.slides.map((s) => ({
        page: s.slide,
        text: [s.title, s.text, s.notes].filter(Boolean).join('\n'),
      })),
    };
  return { text: c.text ?? '' };
}

/** `~` / `~/…` → the home directory. */
export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (/^~[\\/]/.test(path)) return join(homedir(), path.slice(2));
  return path;
}
