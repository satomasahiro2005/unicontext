import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuthResult, InteractiveLoginOptions } from '@unicontext/connector-sdk';
import {
  type Clock,
  type Logger,
  resolveDataPaths,
  type SecretStore,
  secretKey,
  silentLogger,
  systemClock,
} from '@unicontext/core';
import { CookieJar } from './cookies.js';
import { playwrightDriver } from './driver.js';
import { BrowserProfileInUseError, isProfileInUse } from './profile-lock.js';
import {
  hasVisibleCredentialField,
  type InterstitialHandler,
  runInterstitials,
} from './interstitial.js';
import type {
  BrowserContextLike,
  BrowserCookie,
  BrowserDriver,
  LaunchOptions,
  LoadState,
  PageLike,
} from './types.js';

/** SecretStore entry holding the exported session cookies: "<sourceId>/browser-cookies". */
export const COOKIE_SECRET_NAME = 'browser-cookies';

export interface StoredBrowserSession {
  exportedAt: string;
  finalUrl?: string;
  cookies: BrowserCookie[];
}

/**
 * What a connector can say about the page an interactive login is waiting on. Both parts are
 * optional and only ever reach the person at the keyboard through `notify`.
 */
export interface LoginProgress {
  /** Appended to the periodic "still waiting" line, e.g. what the last session check answered. */
  detail?: string;
  /** Something the person has to do in the window, said as soon as it is seen (once per text). */
  notice?: string;
}

export interface BrowserSessionOptions {
  sourceId: string;
  /** Persistent browser profile directory (one per source). See defaultProfileDir(). */
  profileDir: string;
  secrets: SecretStore;
  driver?: BrowserDriver;
  logger?: Logger;
  clock?: Clock;
  /** First page of the login flow (e.g. the portal top page). */
  startUrl: string;
  /** Steps after opening startUrl, e.g. clicking the "SSO login" button. */
  begin?: (page: PageLike) => Promise<void>;
  /** True when the page shows the logged-in state. */
  isAuthenticated: (page: PageLike) => Promise<boolean> | boolean;
  /**
   * Interactive login only: describe the page being waited on, so a stuck post-sign-in step is
   * visible. Never fill or click anything here. Errors are ignored.
   */
  describe?: (page: PageLike) => Promise<LoginProgress | undefined> | LoginProgress | undefined;
  /** How often an interactive login says what it is waiting on (default 15 s). */
  describeIntervalMs?: number;
  /** Interstitial handlers run on every poll (never on credential/MFA pages). */
  handlers?: InterstitialHandler[];
  /**
   * URLs whose cookies are exported to the SecretStore after login. Empty = export nothing (for
   * connectors that only read through the page and must never take cookies out of the browser).
   */
  cookieUrls: string[];
  /** Extra launch options (e.g. `serviceWorkers: 'block'`, a fixed viewport). */
  launch?: Pick<LaunchOptions, 'serviceWorkers' | 'viewport'>;
  /**
   * Runs on every newly launched context before the first navigation (e.g. to install request
   * routes that keep the session read-only).
   */
  prepareContext?: (context: BrowserContextLike, info?: { headless: boolean }) => Promise<void>;
  channel?: string;
  executablePath?: string;
  /** Max wait for the human in login() (default 10 min). */
  timeoutMs?: number;
  /** Max time for a headless refresh() (default 60 s). */
  refreshTimeoutMs?: number;
  /** Poll interval while waiting for the logged-in state (default 1 s). */
  pollIntervalMs?: number;
  /**
   * Keep the service's session cookies across browser restarts (Chrome drops cookies without an
   * expiry when it closes). For services whose whole session is one such cookie, e.g. an Ivanti
   * `DSID`: the human signs in once in a visible window and the next headless run must still have
   * it. The cookie stays inside the profile (Chrome's own cookie store); nothing is exported.
   */
  keepSessionCookies?: boolean;
  /**
   * How long an interactive login waits for the profile to be released by another browser process
   * (e.g. the daemon's background sync) before giving up (default 5 min). Headless runs never wait.
   */
  profileWaitMs?: number;
  /** Profile lock probe (tests). Default: the Chrome process-singleton lock. */
  isProfileInUse?: (profileDir: string) => boolean;
}

/**
 * One queue per persistent profile directory for the whole process: Chrome cannot open a profile
 * twice, and several sources may share one profile (e.g. a university SSO profile reused by a
 * second connector), so their logins, refreshes and page sessions run one after another.
 */
const profileQueues = new Map<string, Promise<unknown>>();

function queueKey(dir: string): string {
  const resolved = dir.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** `<data dir>/cache/<sourceId>/browser-profile`, or under the connector's cacheDir. */
export function defaultProfileDir(sourceId: string, cacheDir?: string): string {
  return cacheDir
    ? join(cacheDir, 'browser-profile')
    : join(resolveDataPaths().cache, sourceId, 'browser-profile');
}

/**
 * Human-in-the-loop browser session (§31). The human logs in once in a visible browser (SSO, MFA);
 * the persistent profile keeps the IdP session, so later `refresh()` calls can re-establish the
 * service session headlessly. After each successful login the service cookies are exported to the
 * SecretStore (never the database, §32) for plain-HTTP replay by connectors.
 */
export class BrowserSession {
  private readonly driver: BrowserDriver;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly handlers: InterstitialHandler[];
  private context: BrowserContextLike | undefined;
  private contextHeadless: boolean | undefined;
  /** The running/queued login or refresh (callers of the same kind share it). */
  private inFlight: { headless: boolean; promise: Promise<AuthResult> } | undefined;
  /**
   * Serial queue over everything that opens, closes or reads the persistent profile (login,
   * refresh, withPage, clear): one browser context per profile at a time, so a scheduled sync can
   * never close the window a human is logging in with, and logout cannot race a cookie export.
   */
  lastResult: AuthResult | undefined;

  constructor(private readonly options: BrowserSessionOptions) {
    this.driver = options.driver ?? playwrightDriver();
    this.logger = (options.logger ?? silentLogger).child({ component: 'browser-session' });
    this.clock = options.clock ?? systemClock;
    this.handlers = options.handlers ?? [];
  }

  get sourceId(): string {
    return this.options.sourceId;
  }

  private get secretName(): string {
    return secretKey(this.options.sourceId, COOKIE_SECRET_NAME);
  }

  /** Interactive login: opens a visible browser and waits for the human (SSO + MFA). */
  login(options: InteractiveLoginOptions = {}): Promise<AuthResult> {
    return this.exclusive(false, () =>
      this.run({
        headless: false,
        timeoutMs: options.timeoutMs ?? this.options.timeoutMs ?? 10 * 60_000,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.notify ? { notify: options.notify } : {}),
      }),
    );
  }

  /** True when another browser process has this source's profile open right now. */
  profileInUse(): boolean {
    if (this.context) return false; // our own browser
    return (this.options.isProfileInUse ?? isProfileInUse)(this.options.profileDir);
  }

  /**
   * Another process (the daemon's sync, a second CLI) has the profile open. Headless runs fail
   * right away with an accurate error; an interactive login waits for it, saying so.
   */
  private async awaitProfile(
    headless: boolean,
    opts: { signal?: AbortSignal; notify?: (message: string) => void } = {},
  ): Promise<void> {
    if (!this.profileInUse()) return;
    if (headless) throw new BrowserProfileInUseError(this.options.profileDir);
    const waitMs = this.options.profileWaitMs ?? 5 * 60_000;
    const deadline = this.clock.now().getTime() + waitMs;
    opts.notify?.(
      `別の処理（UniContext デーモンの同期など）がこのソースのブラウザを使っています。終わるまで待ちます（最大${Math.ceil(waitMs / 60_000)}分）… / Waiting for another process to release the browser profile…`,
    );
    this.logger.info('waiting for the browser profile to be released', {
      profileDir: this.options.profileDir,
    });
    while (this.profileInUse()) {
      if (opts.signal?.aborted || this.clock.now().getTime() >= deadline)
        throw new BrowserProfileInUseError(this.options.profileDir);
      await this.clock.sleep(this.options.pollIntervalMs ?? 1000, opts.signal);
    }
  }

  /**
   * Headless re-login through the persistent profile. Never prompts: if the flow reaches a
   * credential/MFA page or does not finish in time, the result is `auth_required`.
   */
  refresh(signal?: AbortSignal): Promise<AuthResult> {
    return this.exclusive(true, () =>
      this.run({
        headless: true,
        timeoutMs: this.options.refreshTimeoutMs ?? 60_000,
        ...(signal ? { signal } : {}),
      }),
    );
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const key = queueKey(this.options.profileDir);
    const prev = profileQueues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    profileQueues.set(key, tail);
    void tail.then(() => {
      if (profileQueues.get(key) === tail) profileQueues.delete(key);
    });
    return next;
  }

  /**
   * A refresh joins whatever login/refresh is already pending (a human login also yields fresh
   * cookies); a login joins only a pending login, and otherwise queues behind a running refresh
   * instead of being answered with the headless refresh's `auth_required`.
   */
  private exclusive(headless: boolean, fn: () => Promise<AuthResult>): Promise<AuthResult> {
    const pending = this.inFlight;
    if (pending && (headless || !pending.headless)) return pending.promise;
    const entry = { headless, promise: undefined as unknown as Promise<AuthResult> };
    entry.promise = this.serial(fn).finally(() => {
      if (this.inFlight === entry) this.inFlight = undefined;
    });
    this.inFlight = entry;
    return entry.promise;
  }

  private async openContext(
    headless: boolean,
    wait: { signal?: AbortSignal; notify?: (message: string) => void } = {},
  ): Promise<BrowserContextLike> {
    if (this.context && this.contextHeadless === headless) return this.context;
    await this.closeContext();
    await this.awaitProfile(headless, wait);
    await mkdir(this.options.profileDir, { recursive: true });
    this.context = await this.driver.launchPersistentContext(this.options.profileDir, {
      headless,
      ...(this.options.channel ? { channel: this.options.channel } : {}),
      ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
      ...(this.options.launch ?? {}),
      // "Continue where you left off" is what makes Chrome keep cookies without an expiry.
      ...(this.options.keepSessionCookies ? { args: ['--restore-last-session'] } : {}),
    });
    this.contextHeadless = headless;
    if (this.options.prepareContext) await this.options.prepareContext(this.context, { headless });
    return this.context;
  }

  private async closeContext(): Promise<void> {
    const ctx = this.context;
    this.context = undefined;
    this.contextHeadless = undefined;
    if (ctx) {
      if (this.options.keepSessionCookies) await this.tidyForRestore(ctx);
      try {
        await ctx.close();
      } catch (e) {
        this.logger.debug('browser close failed', { error: String(e) });
      }
    }
  }

  /**
   * With session restore on, Chrome reopens (and reloads) the tabs that were open when it closed.
   * Leave a single blank tab so the next launch neither re-requests a service page nor piles up
   * tabs.
   */
  private async tidyForRestore(ctx: BrowserContextLike): Promise<void> {
    try {
      const pages = ctx.pages().filter((p) => !p.isClosed());
      for (const extra of pages.slice(1)) await extra.close?.();
      const first = pages[0];
      if (first && first.url() !== 'about:blank')
        await first.goto('about:blank', { waitUntil: 'commit', timeout: 5_000 });
    } catch (e) {
      this.logger.debug('tidying tabs before close failed', { error: String(e) });
    }
  }

  private async run(opts: {
    headless: boolean;
    timeoutMs: number;
    signal?: AbortSignal;
    notify?: (message: string) => void;
  }): Promise<AuthResult> {
    const label = opts.headless ? 'refresh' : 'login';
    let result: AuthResult;
    try {
      const context = await this.openContext(opts.headless, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.notify ? { notify: opts.notify } : {}),
      });
      // "Continue where you left off" brings back every tab of the last window; an interactive login
      // keeps exactly one so the person is not left among stale sign-in pages.
      if (!opts.headless) await this.closeRestoredTabs(context);
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(this.options.startUrl, { waitUntil: 'load' });
      if (this.options.begin && !(await this.safeIsAuthenticated(page))) {
        try {
          await this.options.begin(page);
        } catch (e) {
          this.logger.debug('begin step failed; continuing to poll', { error: String(e) });
        }
      }
      result = await this.waitForLogin(context, opts);
    } catch (e) {
      result = {
        status: opts.headless ? 'auth_required' : 'failed',
        message: `Browser ${label} failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    } finally {
      await this.closeContext();
    }
    this.lastResult = result;
    this.logger.info(`browser ${label} finished`, { status: result.status });
    return result;
  }

  /** Close every open tab but the first (a restored session's leftovers). */
  private async closeRestoredTabs(context: BrowserContextLike): Promise<void> {
    const pages = context.pages().filter((p) => !p.isClosed());
    for (const extra of pages.slice(1)) {
      try {
        await extra.close?.();
      } catch (e) {
        this.logger.debug('closing a restored tab failed', { error: String(e) });
      }
    }
  }

  private async safeIsAuthenticated(page: PageLike): Promise<boolean> {
    if (page.isClosed()) return false;
    try {
      return await this.options.isAuthenticated(page);
    } catch {
      return false;
    }
  }

  private async waitForLogin(
    context: BrowserContextLike,
    opts: {
      headless: boolean;
      timeoutMs: number;
      signal?: AbortSignal;
      notify?: (message: string) => void;
    },
  ): Promise<AuthResult> {
    const deadline = this.clock.now().getTime() + opts.timeoutMs;
    const poll = this.options.pollIntervalMs ?? 1000;
    const progress = !opts.headless && opts.notify ? this.progressReporter(opts.notify) : undefined;
    for (;;) {
      if (opts.signal?.aborted) return { status: 'failed', message: 'Login aborted' };
      const pages = context.pages().filter((p) => !p.isClosed());
      if (pages.length === 0)
        return { status: 'failed', message: 'The browser window was closed before login finished' };
      for (const page of pages) {
        if (await this.safeIsAuthenticated(page)) {
          await this.exportCookies(context, page.url());
          return {
            status: 'authenticated',
            message: 'Browser session established',
          };
        }
      }
      for (const page of pages) {
        const run = await runInterstitials(page, this.handlers, { logger: this.logger });
        if (run.needsHuman && opts.headless)
          return { status: 'auth_required', message: this.loginRequiredMessage(run.needsHuman) };
      }
      if (opts.headless) {
        for (const page of pages) {
          if (await hasVisibleCredentialField(page))
            return {
              status: 'auth_required',
              message: this.loginRequiredMessage('the identity provider asks for credentials/MFA'),
            };
        }
      }
      if (progress) await progress(pages);
      if (this.clock.now().getTime() >= deadline)
        return opts.headless
          ? { status: 'auth_required', message: this.loginRequiredMessage('refresh timed out') }
          : { status: 'failed', message: 'Timed out waiting for the login to finish' };
      await this.clock.sleep(poll, opts.signal);
    }
  }

  /**
   * Interactive login: tell the person what the window is stuck on. A notice from `describe`
   * (something to press) is said once as soon as it appears; otherwise, every `describeIntervalMs`
   * the tab paths (never queries) and the connector's detail. Quiet on a page that asks for
   * credentials: the person is typing there.
   */
  private progressReporter(
    notify: (message: string) => void,
  ): (pages: PageLike[]) => Promise<void> {
    const describe = this.options.describe;
    const every = this.options.describeIntervalMs ?? 15_000;
    let nextAt = this.clock.now().getTime() + every;
    const said = new Set<string>();
    return async (pages) => {
      const details: string[] = [];
      const notices: string[] = [];
      const paths: string[] = [];
      for (const page of pages) {
        paths.push(pathOnly(page.url()));
        if (!describe) continue;
        try {
          const p = await describe(page);
          if (p?.detail) details.push(p.detail);
          if (p?.notice) notices.push(p.notice);
        } catch (e) {
          this.logger.debug('describing the login page failed', { error: String(e) });
        }
      }
      const current = new Set(notices);
      for (const n of notices)
        if (!said.has(n)) {
          said.add(n);
          notify(n);
        }
      for (const n of [...said]) if (!current.has(n)) said.delete(n);
      if (this.clock.now().getTime() < nextAt) return;
      nextAt = this.clock.now().getTime() + every;
      if (notices.length > 0) return; // the notice is the message
      for (const page of pages) if (await hasVisibleCredentialField(page)) return;
      const detail = [...new Set(details)].join('、');
      notify(
        `サインイン後の確認待ち: ${[...new Set(paths)].join(', ')}${detail ? `（${detail}）` : ''}`,
      );
    };
  }

  private loginRequiredMessage(reason: string): string {
    return `Login required (${reason}). Run \`unicontext login ${this.options.sourceId}\` and sign in in the browser window.`;
  }

  private async exportCookies(context: BrowserContextLike, finalUrl: string): Promise<void> {
    // Never call cookies([]) — Playwright treats an empty list as "all cookies".
    if (this.options.cookieUrls.length === 0) return;
    const cookies = await context.cookies(this.options.cookieUrls);
    const stored: StoredBrowserSession = {
      exportedAt: this.clock.now().toISOString(),
      finalUrl: stripQuery(finalUrl),
      cookies,
    };
    await this.options.secrets.set(this.secretName, JSON.stringify(stored));
  }

  /** The last exported session (cookie values included — keep in memory only). */
  async stored(): Promise<StoredBrowserSession | undefined> {
    const raw = await this.options.secrets.get(this.secretName);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as StoredBrowserSession;
      return Array.isArray(parsed.cookies) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async storedCookies(): Promise<BrowserCookie[] | undefined> {
    return (await this.stored())?.cookies;
  }

  async hasStoredSession(): Promise<boolean> {
    const cookies = await this.storedCookies();
    if (!cookies || cookies.length === 0) return false;
    const now = this.clock.now().getTime() / 1000;
    return cookies.some((c) => c.expires === -1 || c.expires > now);
  }

  /** Cookie jar seeded with the exported cookies. */
  async jar(): Promise<CookieJar> {
    return CookieJar.fromBrowserCookies((await this.storedCookies()) ?? [], () =>
      this.clock.now().getTime(),
    );
  }

  async cookieHeader(url: string): Promise<string | undefined> {
    const header = (await this.jar()).header(url);
    return header || undefined;
  }

  /** Replace the exported cookies (e.g. after the service rotated its session cookie). */
  async saveCookies(cookies: BrowserCookie[]): Promise<void> {
    const prev = await this.stored();
    await this.options.secrets.set(
      this.secretName,
      JSON.stringify({ ...prev, exportedAt: this.clock.now().toISOString(), cookies }),
    );
  }

  /**
   * Forget the session: exported cookies always; the persistent profile (IdP/SSO cookies) only
   * with `{profile: true}`.
   */
  async clear(options: { profile?: boolean } = {}): Promise<void> {
    // Closing the context first ends a running login/refresh/withPage quickly (its pages are
    // gone); the actual deletion then runs after it, so nothing re-exports cookies afterwards.
    await this.closeContext();
    await this.serial(async () => {
      await this.closeContext();
      await this.options.secrets.delete(this.secretName);
      if (options.profile) await rm(this.options.profileDir, { recursive: true, force: true });
    });
  }

  /**
   * Run `fn` with an authenticated page (headless by default) — for scraping sources that have no
   * usable HTTP API (§31). Returns undefined when the session cannot be established.
   */
  withPage<T>(
    fn: (page: PageLike, context: BrowserContextLike) => Promise<T>,
    options: {
      headless?: boolean;
      url?: string;
      /**
       * When the first navigation counts as done (default `load`). `commit` for pages behind a
       * slow SSO redirect chain: the login poll then waits until `isAuthenticated` holds.
       */
      waitUntil?: LoadState | 'commit';
    } = {},
  ): Promise<{ result: T } | { auth: AuthResult }> {
    return this.serial(() => this.withPageNow(fn, options));
  }

  private async withPageNow<T>(
    fn: (page: PageLike, context: BrowserContextLike) => Promise<T>,
    options: { headless?: boolean; url?: string; waitUntil?: LoadState | 'commit' },
  ): Promise<{ result: T } | { auth: AuthResult }> {
    const headless = options.headless ?? true;
    const waitUntil = options.waitUntil ?? 'load';
    try {
      const context = await this.openContext(headless);
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(options.url ?? this.options.startUrl, { waitUntil });
      if (!(await this.safeIsAuthenticated(page))) {
        if (this.options.begin) {
          try {
            await this.options.begin(page);
          } catch {
            // fall through to polling
          }
        }
        const auth = await this.waitForLogin(context, {
          headless,
          timeoutMs: this.options.refreshTimeoutMs ?? 60_000,
        });
        if (auth.status !== 'authenticated') return { auth };
        if (options.url) await page.goto(options.url, { waitUntil });
      }
      return { result: await fn(page, context) };
    } finally {
      await this.closeContext();
    }
  }

  /**
   * Run `fn` on a headless page opened at `url`, with no sign-in check and no login polling: for a
   * connector that signs in by itself with credentials the student stored (it classifies the pages
   * on its own and never touches OTP/MFA fields). Queued like every other use of the profile; a
   * profile held by another process fails at once (BrowserProfileInUseError).
   */
  withHeadlessPage<T>(
    fn: (page: PageLike, context: BrowserContextLike) => Promise<T>,
    options: { url: string; waitUntil?: LoadState | 'commit' },
  ): Promise<T> {
    return this.serial(async () => {
      try {
        const context = await this.openContext(true);
        const page = context.pages()[0] ?? (await context.newPage());
        await page.goto(options.url, { waitUntil: options.waitUntil ?? 'load' });
        return await fn(page, context);
      } finally {
        await this.closeContext();
      }
    });
  }

  async close(): Promise<void> {
    await this.closeContext();
  }
  // close() deliberately bypasses the queue: dispose must be able to end a stuck login.
}

/** The path of a URL, without query or fragment ('' when it is not a URL). */
function pathOnly(url: string): string {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return url === 'about:blank' ? url : '';
  }
}

function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}
