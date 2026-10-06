import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Capability, HealthStatus } from '@unicontext/canonical-model';
import type {
  AuthResult,
  CredentialSecret,
  DownloadableFile,
  FileDownloadAdapter,
  FileDownloadOutcome,
  FileDownloadRequest,
  FileDownloadSettings,
  InteractiveAuthAdapter,
  InteractiveLoginOptions,
  RawDeletion,
  RawItem,
  SavedCredentialsAdapter,
  SyncInput,
  SyncResult,
} from '@unicontext/connector-sdk';
import { AuthRequiredError, type Clock, errorMessage, type Logger } from '@unicontext/core';
import { type AutoSignInResult, CREDENTIAL_SECRETS } from './auto-login.js';
import type { ShizuokaVpnFilesConfig } from './config.js';
import { academicYear, courseHintForPath, isPrefetchPath } from './courses.js';
import type { VpnDeployment, VpnRoot } from './deployment.js';
import { PRODUCT } from './metadata.js';
import { extensionOf, joinPath, mimeFromName, parentOf } from './parse.js';
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
  /** One-time state migrations already applied (see {@link migrateState}). */
  migrated?: number;
}

/** Latest one-time migration (1: clear the backoff a never-listed root got from a dead session). */
const STATE_MIGRATION = 1;

/** A failing folder stays on the frontier for this many failures, then waits for its parent. */
const MAX_DEFERRED_FAILURES = 3;

/** A root that was never listed OK keeps a short backoff, so it is retried soon (30 min). */
const NEVER_LISTED_BACKOFF_CAP_MS = 30 * 60_000;

/**
 * Should a folder that could not be listed stay on the frontier? Not a forbidden placeholder (a
 * 403 the first time it was seen) and not one that failed too often (it waits for its parent's
 * next listing); a root that was never listed OK always stays (its backoff is capped at 30 min).
 */
function retryableFolder(rs: RootState, root: VpnRoot, path: string): boolean {
  if (path === root.startDir && !hasOkFolder(rs)) return true;
  return (
    rs.folders[path]?.status !== 'forbidden' &&
    (rs.backoff[path]?.failures ?? 0) <= MAX_DEFERRED_FAILURES
  );
}

export function emptyState(): WalkState {
  return { version: 1, roots: {}, migrated: STATE_MIGRATION };
}

const hasOkFolder = (rs: RootState): boolean =>
  Object.values(rs.folders ?? {}).some((f) => f.status === 'ok');

/**
 * One-time repairs of a persisted walk state. 1: a sync that ran while the portal session was gone
 * (a 404 root page, a login redirect) recorded a backoff for the root folder and left an empty
 * frontier, so a root that was never listed stayed unlisted for hours after the student signed in
 * again. Such a root (no OK listing) gets its root backoff cleared; a root the portal answered with
 * a real 403 (the forbidden placeholder) keeps it.
 */
function migrateState(state: WalkState): void {
  if ((state.migrated ?? 0) >= 1) return;
  for (const [key, rs] of Object.entries(state.roots)) {
    if (!rs || hasOkFolder(rs)) continue;
    const backoff: RootState['backoff'] = {};
    for (const [path, b] of Object.entries(rs.backoff ?? {}))
      if (rs.folders?.[path]?.status === 'forbidden') backoff[path] = b;
    state.roots[key] = { ...rs, backoff };
  }
  state.migrated = STATE_MIGRATION;
}

export function loadState(extra: unknown): WalkState {
  if (extra && typeof extra === 'object' && (extra as WalkState).version === 1) {
    const e = extra as WalkState;
    const state: WalkState = {
      version: 1,
      roots: { ...e.roots },
      ...(e.migrated !== undefined ? { migrated: e.migrated } : {}),
    };
    migrateState(state);
    return state;
  }
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
  /** `undefined` forgets it (signed out, session ended), including the sign-in time. */
  write(verifiedAt: string | undefined): void;
  /**
   * When the current session was signed in (a manual or automatic sign-in): the portal ends it
   * `sessionMaxMinutes` later whatever happens (Ivanti `DSmaxTimeout`). Optional for old stores.
   */
  readSignedInAt?(): string | undefined;
  /** Record a fresh sign-in (also counts as a verification). */
  writeSignedInAt?(at: string): void;
}

/** A session verified this recently is trusted without opening the browser again. */
const RECHECK_AFTER_MS = 2 * 60_000;

export interface TeamsLikeExtract {
  (
    data: Uint8Array,
    ext: string,
  ): Promise<{ text: string; pages?: { page: number; text: string }[] }>;
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
  /**
   * One rate-limited automatic sign-in with the credentials the student saved in the OS keychain
   * (see auto-login.ts). `undefined` when there are none (or it is turned off). Never prompts.
   */
  autoSignIn?: () => Promise<AutoSignInResult | undefined>;
  /** The credentials were saved again (or deleted): forget the whole automatic sign-in history. */
  resetAutoSignIn?: () => void;
  /**
   * The student signed in by hand: lift the stops a working account explains, but NOT one whose
   * cause may be the saved password (wrong password, lock-out, an unrecognised answer).
   */
  manualSignInSucceeded?: () => void;
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
  /**
   * The portal answered at least one request in a way only a live session gives (a list that was
   * OK, empty or forbidden — not a login redirect, not a transport error).
   */
  proved: boolean;
  /** List requests made (whatever they answered). */
  requests: number;
  /** The portal dropped the session in the middle (a login redirect): the run stopped there. */
  sessionLost: boolean;
}

/** A sync that keeps going over several pages while the session window lasts. */
interface Sweep {
  token: string;
  state: WalkState;
  /** List requests made by the earlier pages of this sync. */
  requests: number;
  /** An automatic sign-in was already tried in this sync. */
  autoTried: boolean;
}

/** A file that is not cached yet needs the live portal (the index itself never does). */
const downloadNeedsSignInMessage = (sourceId: string): string =>
  `このファイルはまだ UniContext に保存されていないため、SSL-VPN ポータルから取る必要がありますが、サインインが切れています。「unicontext login ${sourceId}」でサインインしてください（フォルダの一覧と検索はローカルの索引から使えます）。 / This file is not cached yet and the SSL-VPN portal session has ended; run \`unicontext login ${sourceId}\` (browsing and searching the index still work).`;

const sessionExpiredMessage = (sourceId: string): string =>
  `SSL-VPN ポータルのセッションが切れました。「unicontext login ${sourceId}」で再度サインインしてください。 / SSL-VPN portal session expired; run \`unicontext login ${sourceId}\`.`;

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
export class ShizuokaVpnFilesAdapter
  implements InteractiveAuthAdapter, FileDownloadAdapter, SavedCredentialsAdapter
{
  readonly id: string;
  readonly fileSourceTypes = ['szvpn.file'] as const;
  readonly fileTextSourceTypes = ['szvpn.fileText'] as const;
  readonly version = '1.0.0';
  private healthState: HealthStatus;
  lastRunCounts: Record<string, number> = {};
  private readonly marker: SessionMarker;
  /** The sync in progress over several pages (see {@link Sweep}). */
  private sweep: Sweep | undefined;

  constructor(private readonly options: ShizuokaVpnFilesAdapterOptions) {
    this.id = `shizuoka-vpn-files:${options.sourceId}`;
    this.healthState = { state: 'healthy', checkedAt: options.clock.now().toISOString() };
    let mem: string | undefined;
    let signedIn: string | undefined;
    this.marker = options.sessionMarker ?? {
      read: () => mem,
      write: (at) => {
        mem = at;
        if (at === undefined) signedIn = undefined;
      },
      readSignedInAt: () => signedIn,
      writeSignedInAt: (at) => {
        mem = at;
        signedIn = at;
      },
    };
  }

  capabilities(): Promise<Capability[]> {
    return Promise.resolve([...CAPABILITIES]);
  }

  credentialSecrets(): CredentialSecret[] {
    return CREDENTIAL_SECRETS.map((c) => ({ ...c }));
  }

  credentialsChanged(): void {
    this.options.resetAutoSignIn?.();
  }

  private signInRequired(detail?: string): AuthResult {
    return {
      status: 'auth_required',
      message: `SSL-VPN ポータルのサインインが必要です。「unicontext login ${this.options.sourceId}」でサインインしてください。 / SSL-VPN portal sign-in required; run \`unicontext login ${this.options.sourceId}\`.${detail ? ` (${detail})` : ''}`,
    };
  }

  /**
   * The session is gone: sign in again with the saved credentials when the student chose that
   * (rate-limited, see auto-login.ts), else auth_required. Never prompts.
   */
  private async signInAgain(detail?: string): Promise<AuthResult> {
    const auto = await this.options.autoSignIn?.();
    if (auto?.status === 'authenticated') {
      // Only a form actually submitted and confirmed starts a new session window. A session that
      // was already live has an unknown start (the portal may end it any minute): verified only.
      if (auto.fresh === true) this.markSignedIn();
      else this.markVerified();
      return { status: 'authenticated', ...(auto.message ? { message: auto.message } : {}) };
    }
    return this.signInRequired(auto?.message ?? detail);
  }

  private verifiedAgoMs(): number | undefined {
    const at = this.marker.read();
    const t = at ? Date.parse(at) : NaN;
    return Number.isNaN(t) ? undefined : this.now().getTime() - t;
  }

  /** No verification on record, or one older than {@link RECHECK_AFTER_MS}. */
  private verificationStale(): boolean {
    const ago = this.verifiedAgoMs();
    return ago === undefined || ago < 0 || ago > RECHECK_AFTER_MS;
  }

  private markVerified(): void {
    this.marker.write(this.now().toISOString());
  }

  private markSignedIn(): void {
    const now = this.now().toISOString();
    if (this.marker.writeSignedInAt) this.marker.writeSignedInAt(now);
    else this.marker.write(now);
  }

  /**
   * Until when the current session can be used for a long walk: its sign-in time plus the portal's
   * hard cap (`sessionMaxMinutes`, Ivanti DSmaxTimeout) minus a margin. Unknown sign-in time (a
   * session verified but not signed in by this UniContext) → undefined: one page per sync.
   */
  private sessionDeadline(): Date | undefined {
    const at = this.marker.readSignedInAt?.();
    const t = at ? Date.parse(at) : NaN;
    if (Number.isNaN(t)) return undefined;
    const b = this.options.config.browser;
    const w = this.options.config.walk;
    return new Date(t + (b.sessionMaxMinutes - w.sessionMarginMinutes) * 60_000);
  }

  /**
   * "Signed in" only for a portal session that was actually verified: a browser profile on disk
   * proves nothing (a sign-in window that closed early leaves one behind). Never prompts.
   * - never verified, or longer ago than the portal keeps a session → sign in again with the saved
   *   credentials if the student stored them, else auth_required, without opening a browser;
   * - verified within the last 2 minutes (a sync or login just did) → authenticated;
   * - otherwise a headless check against the portal decides.
   */
  async authenticate(): Promise<AuthResult> {
    if (!this.options.profileExists()) return this.signInAgain();
    const ago = this.verifiedAgoMs();
    const maxMs = this.options.config.browser.sessionMaxMinutes * 60_000;
    if (ago === undefined || ago < 0 || ago > maxMs) return this.signInAgain();
    if (ago <= RECHECK_AFTER_MS)
      return { status: 'authenticated', message: 'SSL-VPN portal session verified' };
    // The other UniContext process (daemon sync / CLI) is using the session right now.
    if (this.options.profileInUse?.())
      return {
        status: 'authenticated',
        message: 'SSL-VPN portal session in use by another UniContext process',
      };
    if (!this.options.verifySession) return this.signInAgain();
    const r = await this.options.verifySession();
    if (r.status === 'authenticated') {
      this.markVerified();
      return { status: 'authenticated', message: 'SSL-VPN portal session verified' };
    }
    this.marker.write(undefined);
    return this.signInAgain(r.message);
  }

  async login(options?: InteractiveLoginOptions): Promise<AuthResult> {
    if (!this.options.login)
      return { status: 'failed', message: 'Interactive login is not available' };
    const r = await this.options.login(options);
    if (r.status === 'authenticated') {
      this.markSignedIn();
      // The student signed in by hand: a stopped automatic sign-in may try again, unless the
      // saved password itself may be wrong (only saving it again lifts that).
      this.options.manualSignInSucceeded?.();
    }
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

  /** One page of the walk in one browser session. A lost session is returned, not thrown. */
  private async runPage(
    state: WalkState,
    input: SyncInput,
  ): Promise<{ result: RunOutput } | { auth: AuthResult }> {
    try {
      return await this.options.withClient(async (client) => {
        const r = await this.run(client, state, input);
        // A run that asked the portal nothing proves nothing: when the last verification is
        // stale, ask once (one same-origin GET) instead of refreshing the marker blindly.
        if (!r.proved && !r.sessionLost && this.verificationStale())
          r.proved = (await client.probeSession?.()) === true;
        return r;
      });
    } catch (e) {
      if (e instanceof AuthRequiredError)
        return { auth: { status: 'auth_required', message: e.message } };
      throw e;
    }
  }

  /** Is there a folder the walk could list right now (not waiting out a backoff)? */
  private pendingWork(state: WalkState): boolean {
    const now = this.now().getTime();
    for (const root of this.enabledRoots()) {
      const rs = state.roots[root.key];
      if (!rs) return true;
      for (const p of rs.frontier) {
        const bo = rs.backoff[p];
        if (!bo || new Date(bo.nextAttemptAt).getTime() <= now) return true;
      }
    }
    return false;
  }

  private sessionGone(message: string): void {
    this.marker.write(undefined);
    this.healthState = { state: 'auth_required', checkedAt: this.now().toISOString(), message };
  }

  /**
   * One page of the walk (`maxFoldersPerRun` folders). Right after a sign-in whose time is known,
   * the sync keeps going page after page (the engine stores each page as it arrives) until the
   * tree is indexed, `maxFoldersPerSession`, or the session window closes. A session that drops
   * in the middle is signed in again with the saved credentials when the student stored them;
   * otherwise the pages already listed are kept (never a deletion) and the next run says
   * auth_required. A session lost before anything was listed fails the run with auth_required.
   */
  async sync(input: SyncInput): Promise<SyncResult> {
    const cont = input.pageToken && this.sweep?.token === input.pageToken ? this.sweep : undefined;
    this.sweep = undefined;
    const state = cont ? cont.state : loadState(input.cursor?.extra);
    // Later pages continue the same walk: never re-seed the frontier.
    const pageInput: SyncInput = cont ? { ...input, mode: 'incremental' } : input;
    let autoTried = cont?.autoTried ?? false;

    // A continuation page that starts after the session window: nothing more this sync.
    const windowEnd = this.sessionDeadline();
    if (cont && (windowEnd === undefined || this.now().getTime() >= windowEnd.getTime()))
      return {
        items: [],
        cursor: { extra: state as unknown as Record<string, unknown> },
        productVersion: { product: PRODUCT, version: this.options.deployment.id },
      };

    // A page that throws (another process holds the browser profile, the browser crashed) puts
    // the walk state back as it was before that page, so a saved cursor never claims a folder
    // whose items were not returned.
    const page = async (
      inp: SyncInput,
    ): Promise<{ result: RunOutput } | { auth: AuthResult } | { thrown: unknown }> => {
      const before = structuredClone(state);
      try {
        return await this.runPage(state, inp);
      } catch (e) {
        state.roots = before.roots;
        if (before.migrated !== undefined) state.migrated = before.migrated;
        return { thrown: e };
      }
    };
    let out = await page(pageInput);
    const lost = (o: typeof out): boolean => 'auth' in o || ('result' in o && o.result.sessionLost);
    const progressed = (o: typeof out): boolean =>
      'result' in o && (o.result.items.length > 0 || o.result.deletions.length > 0);
    let partial: RunOutput | undefined;
    let autoMessage: string | undefined;
    if (lost(out) && !autoTried && this.options.autoSignIn) {
      autoTried = true;
      const again = await this.signInAgain();
      if (again.status === 'authenticated') {
        // What this page listed before the drop is merged with the rest of the page.
        if (progressed(out)) partial = (out as { result: RunOutput }).result;
        out = await page({ ...pageInput, mode: 'incremental' });
      } else autoMessage = again.message;
    }

    // What this sync already listed (earlier pages, or this page before the session dropped) is
    // kept: once a page has been returned or this one progressed, nothing here throws (the
    // engine saves the cursor only after the last page; a throw would discard the earlier ones).
    const keepGoing = cont !== undefined || partial !== undefined;
    if ('thrown' in out) {
      if (!keepGoing) throw out.thrown;
      const why = errorMessage(out.thrown);
      this.healthState = {
        state: 'degraded',
        checkedAt: this.now().toISOString(),
        message: `walk stopped: ${why}`,
      };
      return this.stoppedPage(state, partial, [
        `SSL-VPN: the walk stopped (${why}); the folders listed so far are kept and the next sync continues from there.`,
      ]);
    }
    if ('auth' in out) {
      const message =
        autoMessage ?? out.auth.message ?? sessionExpiredMessage(this.options.sourceId);
      this.sessionGone(message);
      if (!keepGoing) throw new AuthRequiredError(message);
      return this.stoppedPage(state, partial, [
        `SSL-VPN portal session ended during the walk; the folders listed so far are kept. Sign in again to continue. (${message})`,
      ]);
    }
    if (partial) out = { result: mergeRuns(partial, out.result) };

    const now = this.now().toISOString();
    if (out.result.sessionLost && !progressed(out) && !cont) {
      const message = autoMessage ?? sessionExpiredMessage(this.options.sourceId);
      this.sessionGone(message);
      throw new AuthRequiredError(message);
    }
    const r = out.result;
    const warnings = [...r.warnings];
    if (r.sessionLost) {
      // Keep what was listed (cursor included); the next run asks for a sign-in.
      this.sessionGone(sessionExpiredMessage(this.options.sourceId));
      warnings.push(
        'SSL-VPN portal session ended during the walk; the folders listed so far are kept. Sign in again to continue.',
      );
    } else if (r.proved) this.markVerified();
    this.lastRunCounts = r.counts;
    if (!r.sessionLost) {
      const degraded = (r.counts.listErrors ?? 0) > 0 && (r.counts.foldersListed ?? 0) === 0;
      this.healthState = degraded
        ? {
            state: 'degraded',
            checkedAt: now,
            message: 'portal listing is flaky; kept last good index',
          }
        : { state: 'healthy', checkedAt: now, lastSuccessAt: now };
    }

    const requests = (cont?.requests ?? 0) + r.requests;
    const deadline = this.sessionDeadline();
    const more =
      !r.sessionLost &&
      r.requests > 0 &&
      !input.signal?.aborted &&
      deadline !== undefined &&
      this.now().getTime() < deadline.getTime() &&
      requests < this.options.config.walk.maxFoldersPerSession &&
      this.pendingWork(state);
    let nextPageToken: string | undefined;
    if (more) {
      nextPageToken = `sweep:${requests}:${this.now().getTime()}`;
      this.sweep = { token: nextPageToken, state, requests, autoTried };
    }
    return {
      items: r.items,
      ...(r.deletions.length ? { deletions: r.deletions } : {}),
      cursor: { extra: state as unknown as Record<string, unknown> },
      productVersion: { product: PRODUCT, version: this.options.deployment.id },
      ...(nextPageToken ? { hasMore: true, nextPageToken } : {}),
      // NEVER declare `complete`: the listing is flaky, so unseen items must not be deleted.
      ...(warnings.length ? { warnings } : {}),
    };
  }

  /**
   * The last page of a sync whose walk could not go on (the session ended, the browser failed)
   * after something was already listed: the progress is saved (cursor), nothing more this sync.
   */
  private stoppedPage(
    state: WalkState,
    partial: RunOutput | undefined,
    warnings: string[],
  ): SyncResult {
    if (partial) this.lastRunCounts = partial.counts;
    return {
      items: partial?.items ?? [],
      ...(partial?.deletions.length ? { deletions: partial.deletions } : {}),
      cursor: { extra: state as unknown as Record<string, unknown> },
      productVersion: { product: PRODUCT, version: this.options.deployment.id },
      warnings: [...(partial?.warnings ?? []), ...warnings],
    };
  }

  private rootState(
    state: WalkState,
    root: VpnRoot,
    mode: SyncInput['mode'],
    now: Date,
  ): RootState {
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
    if (rs.frontier.length === 0 && !hasOkFolder(rs)) {
      // Never listed OK (a dead session, a 404 root page, a flaky 403): do not wait for the
      // re-walk interval, try the root again as soon as its backoff allows (the walk loop skips it
      // until then). The backoff of a never-listed root is capped at 30 minutes.
      const cap = now.getTime() + NEVER_LISTED_BACKOFF_CAP_MS;
      for (const b of Object.values(rs.backoff))
        if (new Date(b.nextAttemptAt).getTime() > cap)
          b.nextAttemptAt = new Date(cap).toISOString();
      rs.frontier = [root.startDir];
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
    let proved = false;
    let filesTotal = 0;
    for (const rs of Object.values(state.roots))
      for (const f of Object.values(rs.folders)) filesTotal += f.childFileCount;

    let budget = cfg.walk.maxFoldersPerRun;
    let requests = 0;
    // Inside a known sign-in window: stop at its end. A run that starts after it (the portal kept
    // the session longer than assumed) still lists its one page, as before.
    const windowEnd = this.sessionDeadline()?.getTime();
    const deadline = windowEnd !== undefined && windowEnd > now.getTime() ? windowEnd : undefined;
    let sessionLost = false;
    for (const root of roots) {
      if (budget <= 0 || sessionLost) break;
      const rs = this.rootState(state, root, input.mode, now);
      const visited = new Set<string>();
      // Folders skipped for now (waiting out a backoff, or already tried in this run) stay on the
      // frontier, so a flaky folder is retried later instead of being forgotten until its parent
      // is listed again; a forbidden placeholder or a folder that failed too often is dropped
      // (as before), so the re-walk and refresh of an otherwise finished tree still happen.
      const deferred: string[] = [];
      const retryable = (p: string): boolean => retryableFolder(rs, root, p);
      while (budget > 0 && rs.frontier.length > 0) {
        if (input.signal?.aborted) break;
        // Never start a request past the session window (a page of slow retries could).
        if (deadline !== undefined && this.now().getTime() >= deadline) break;
        const path = rs.frontier.shift()!;
        if (visited.has(path)) {
          if (retryable(path)) deferred.push(path);
          continue;
        }
        const depth = path === '' ? 0 : path.split('/').length;
        if (depth > cfg.walk.maxDepth) continue;
        const bo = rs.backoff[path];
        if (bo && new Date(bo.nextAttemptAt).getTime() > now.getTime()) {
          if (retryable(path)) deferred.push(path);
          continue;
        }
        if (filesTotal >= cfg.walk.maxFilesTotal) {
          rs.frontier.unshift(path);
          warnings.push('file index cap reached; stopping the walk');
          break;
        }
        visited.add(path);
        budget--;
        requests++;
        const result = await this.listWithRetry(client, root, path);
        // A `session` result means the portal dropped us to a login page: stop here, change
        // nothing for this folder (never a deletion) and let the caller decide.
        if (result.status === 'session') {
          rs.frontier.unshift(path);
          sessionLost = true;
          break;
        }
        if (result.status === 'ok' || result.status === 'empty' || result.status === 'forbidden')
          proved = true;
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
      for (const p of deferred) if (!rs.frontier.includes(p)) rs.frontier.push(p);
    }
    return { items, deletions, warnings, counts, proved, requests, sessionLost };
  }

  /** List one folder, retrying transient failures (flaky 403 / empty 200) within the run. */
  private async listWithRetry(
    client: VpnPortalClient,
    root: VpnRoot,
    path: string,
  ): Promise<ListResult> {
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
    acc: Pick<RunOutput, 'items' | 'deletions' | 'warnings' | 'counts'>,
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
        hasOkFolder(rs) ? 6 * 3_600_000 : NEVER_LISTED_BACKOFF_CAP_MS,
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
        acc.items.push(this.folderItem(root, path, depth, nowIso, 'forbidden', [], result.message));
      }
      // Re-visit later (push to the end of the frontier) unless it is a forbidden placeholder or
      // failed too often; a never-listed root is always retried (its backoff is capped).
      if (retryableFolder(rs, root, path) && !rs.frontier.includes(path)) rs.frontier.push(path);
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
          acc.deletions.push({
            sourceType: 'szvpn.folder',
            externalId: folderExternalId(root.key, oldSub),
          });
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
    children: {
      name: string;
      isFile: boolean;
      path: string;
      sizeBytes?: number;
      modifiedAt?: string;
    }[],
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
    e: {
      name: string;
      sizeBytes: number | undefined;
      sizeText: string | undefined;
      modifiedAt: string | undefined;
      modifiedText: string | undefined;
    },
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
      prefetch: isPrefetchPath(cfg, path, academicYear(this.now(), this.options.timezone)),
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

  describeFile(item: {
    sourceType: string;
    externalId: string;
    payload: unknown;
  }): DownloadableFile | undefined {
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
      const attempt = async (): Promise<{ result: void } | { auth: AuthResult }> => {
        try {
          return await this.options.withClient((client) =>
            this.downloadAll(client, downloads, results, warnings, options.signal),
          );
        } catch (e) {
          if (e instanceof AuthRequiredError)
            return { auth: { status: 'auth_required', message: e.message } };
          throw e;
        }
      };
      let out = await attempt();
      let reason: string | undefined;
      if ('auth' in out) {
        this.marker.write(undefined);
        // Sign in again with the saved credentials (rate-limited), then try once more.
        const again = await this.signInAgain();
        if (again.status === 'authenticated') {
          for (const d of downloads) results.delete(d.req.externalId);
          out = await attempt();
        } else reason = again.message;
      }
      if ('auth' in out) {
        this.marker.write(undefined);
        throw new AuthRequiredError(
          `${downloadNeedsSignInMessage(this.options.sourceId)}${reason ? ` (${reason})` : ''}`,
        );
      }
      // Only bytes that arrived prove the session (a 404 or a size refusal may be any page).
      if ([...results.values()].some((o) => o.status === 'downloaded')) this.markVerified();
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
        (r) =>
          results.get(r.externalId) ?? {
            externalId: r.externalId,
            status: 'failed',
            error: 'not processed',
          },
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
        results.set(req.externalId, {
          externalId: req.externalId,
          status: 'failed',
          error: 'aborted',
        });
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
    let last: FileDownloadOutcome = {
      externalId: req.externalId,
      status: 'failed',
      version: p.version,
    };
    for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
      const o = await this.downloadOne(client, req, p);
      if (o.status === 'downloaded' || o.status === 'notFound' || o.status === 'tooLarge') return o;
      last = o;
      if (attempt < cfg.maxRetries) {
        warnings.push(
          `${p.name}: download attempt ${attempt + 1} failed (${o.error ?? o.status}); retrying`,
        );
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
      if (r.reason === 'session')
        throw new AuthRequiredError(downloadNeedsSignInMessage(this.options.sourceId));
      return {
        externalId: req.externalId,
        status:
          r.reason === 'tooLarge' ? 'tooLarge' : r.reason === 'notFound' ? 'notFound' : 'failed',
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

/** Two runs of one page (before and after an automatic sign-in) as one. */
function mergeRuns(a: RunOutput, b: RunOutput): RunOutput {
  const counts: Counts = { ...a.counts };
  for (const [k, v] of Object.entries(b.counts))
    counts[k] = k === 'roots' ? v : (counts[k] ?? 0) + v;
  return {
    items: [...a.items, ...b.items],
    deletions: [...a.deletions, ...b.deletions],
    warnings: [...a.warnings, ...b.warnings],
    counts,
    proved: a.proved || b.proved,
    requests: a.requests + b.requests,
    sessionLost: b.sessionLost,
  };
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
