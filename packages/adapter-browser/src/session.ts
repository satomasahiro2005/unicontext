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
  PageLike,
} from './types.js';

/** SecretStore entry holding the exported session cookies: "<sourceId>/browser-cookies". */
export const COOKIE_SECRET_NAME = 'browser-cookies';

export interface StoredBrowserSession {
  exportedAt: string;
  finalUrl?: string;
  cookies: BrowserCookie[];
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
  prepareContext?: (context: BrowserContextLike) => Promise<void>;
  channel?: string;
  executablePath?: string;
  /** Max wait for the human in login() (default 10 min). */
  timeoutMs?: number;
  /** Max time for a headless refresh() (default 60 s). */
  refreshTimeoutMs?: number;
  /** Poll interval while waiting for the logged-in state (default 1 s). */
  pollIntervalMs?: number;
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
      }),
    );
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

  private async openContext(headless: boolean): Promise<BrowserContextLike> {
    if (this.context && this.contextHeadless === headless) return this.context;
    await this.closeContext();
    await mkdir(this.options.profileDir, { recursive: true });
    this.context = await this.driver.launchPersistentContext(this.options.profileDir, {
      headless,
      ...(this.options.channel ? { channel: this.options.channel } : {}),
      ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
      ...(this.options.launch ?? {}),
    });
    this.contextHeadless = headless;
    if (this.options.prepareContext) await this.options.prepareContext(this.context);
    return this.context;
  }

  private async closeContext(): Promise<void> {
    const ctx = this.context;
    this.context = undefined;
    this.contextHeadless = undefined;
    if (ctx) {
      try {
        await ctx.close();
      } catch (e) {
        this.logger.debug('browser close failed', { error: String(e) });
      }
    }
  }

  private async run(opts: {
    headless: boolean;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<AuthResult> {
    const label = opts.headless ? 'refresh' : 'login';
    let result: AuthResult;
    try {
      const context = await this.openContext(opts.headless);
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
    opts: { headless: boolean; timeoutMs: number; signal?: AbortSignal },
  ): Promise<AuthResult> {
    const deadline = this.clock.now().getTime() + opts.timeoutMs;
    const poll = this.options.pollIntervalMs ?? 1000;
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
      if (this.clock.now().getTime() >= deadline)
        return opts.headless
          ? { status: 'auth_required', message: this.loginRequiredMessage('refresh timed out') }
          : { status: 'failed', message: 'Timed out waiting for the login to finish' };
      await this.clock.sleep(poll, opts.signal);
    }
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
    options: { headless?: boolean; url?: string } = {},
  ): Promise<{ result: T } | { auth: AuthResult }> {
    return this.serial(() => this.withPageNow(fn, options));
  }

  private async withPageNow<T>(
    fn: (page: PageLike, context: BrowserContextLike) => Promise<T>,
    options: { headless?: boolean; url?: string },
  ): Promise<{ result: T } | { auth: AuthResult }> {
    const headless = options.headless ?? true;
    try {
      const context = await this.openContext(headless);
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(options.url ?? this.options.startUrl, { waitUntil: 'load' });
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
        if (options.url) await page.goto(options.url, { waitUntil: 'load' });
      }
      return { result: await fn(page, context) };
    } finally {
      await this.closeContext();
    }
  }

  async close(): Promise<void> {
    await this.closeContext();
  }
  // close() deliberately bypasses the queue: dispose must be able to end a stuck login.
}

function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}
