import { existsSync } from 'node:fs';
import {
  type BrowserCookie,
  type BrowserDriver,
  BrowserSession,
  type BrowserSessionOptions,
  CookieJar,
  defaultProfileDir,
  type PageLike,
  shibbolethConsentHandler,
} from '@unicontext/adapter-browser';
import type { AuthResult, InteractiveLoginOptions } from '@unicontext/connector-sdk';
import {
  type Clock,
  type Logger,
  type SecretStore,
  silentLogger,
  stableStringify,
  systemClock,
} from '@unicontext/core';
import type { LcuAuthStrategy, LcuCookieJar } from '../core/auth.js';
import { type LcuDeploymentProfile, relativeLcuPath } from '../core/deployment.js';
import { screenIdFromUrl } from '../core/html.js';

/** The part of adapter-browser's BrowserSession this strategy uses (tests may fake it). */
export interface BrowserSessionLike {
  login(options?: InteractiveLoginOptions): Promise<AuthResult>;
  refresh(signal?: AbortSignal): Promise<AuthResult>;
  hasStoredSession(): Promise<boolean>;
  jar(): Promise<CookieJar>;
  saveCookies(cookies: BrowserCookie[]): Promise<void>;
  clear(options?: { profile?: boolean }): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserSsoStrategyOptions {
  sourceId: string;
  deployment: LcuDeploymentProfile;
  secrets: SecretStore;
  logger?: Logger | undefined;
  clock?: Clock | undefined;
  /** Connector cache dir; the persistent profile is `<cacheDir>/browser-profile`. */
  cacheDir?: string | undefined;
  browser?:
    | {
        channel?: string | undefined;
        executablePath?: string | undefined;
        profileDir?: string | undefined;
        loginTimeoutMs?: number | undefined;
        refreshTimeoutMs?: number | undefined;
      }
    | undefined;
  /** Playwright driver override (tests: adapter-browser's FakeBrowserDriver). */
  driver?: BrowserDriver | undefined;
  /** Session factory override (tests). */
  createSession?: ((options: BrowserSessionOptions) => BrowserSessionLike) | undefined;
}

/** Screens served without login (syllabus SC_06*, public notices SC_90*). */
const PUBLIC_SCREEN = /^SC_(06|90)/;

/** True when the page is a logged-in LCU screen (under the base path, logged-in screen id). */
export function isLoggedInPage(deployment: LcuDeploymentProfile, url: string): boolean {
  const rel = relativeLcuPath(deployment, url);
  if (rel === undefined) return false;
  const screen = screenIdFromUrl(`/${rel}`);
  if (screen === undefined) return false;
  if (deployment.auth.loggedInScreenIds.includes(screen)) return true;
  // Any other LCU screen except the login screen also means the session is live
  // (home variants differ per deployment, and SSO may land on a deep link).
  return (
    screen !== deployment.auth.loginScreenId &&
    !PUBLIC_SCREEN.test(screen) &&
    !/error/i.test(rel)
  );
}

/**
 * `browser-sso` (profile auth `saml` / `entra` / `browser-sso`): a human logs in once in a visible
 * browser (Shibboleth → Entra ID + MFA); the persistent profile keeps the IdP session so later
 * refreshes run headless. The LCU session cookies (JSESSIONID, path /lcu-web) are exported to the
 * SecretStore by adapter-browser — never to the database — and replayed over plain HTTP.
 */
export class BrowserSsoStrategy implements LcuAuthStrategy {
  readonly id = 'browser-sso';
  readonly profileDir: string;
  private readonly session: BrowserSessionLike;
  private readonly logger: Logger;
  private loadedCookies: string | undefined;
  /** Bumped by logout() and login(): jars handed out before them must never be written back. */
  private generation = 0;
  private readonly jarGeneration = new WeakMap<object, number>();

  constructor(private readonly options: BrowserSsoStrategyOptions) {
    const d = options.deployment;
    const clock = options.clock ?? systemClock;
    this.logger = options.logger ?? silentLogger;
    this.profileDir =
      options.browser?.profileDir ?? defaultProfileDir(options.sourceId, options.cacheDir);
    const pattern = d.auth.idpSsoPathPattern ? new RegExp(d.auth.idpSsoPathPattern) : undefined;
    const sessionOptions: BrowserSessionOptions = {
      sourceId: options.sourceId,
      profileDir: this.profileDir,
      secrets: options.secrets,
      logger: this.logger,
      clock,
      startUrl: d.baseUrl,
      begin: (page) => startSso(page, d.auth.ssoStartSelector, clock),
      isAuthenticated: (page) => isLoggedInPage(d, page.url()),
      handlers: [
        shibbolethConsentHandler({
          hosts: d.auth.idpHosts,
          ...(pattern ? { ssoPathPattern: pattern } : {}),
          remember: true,
        }),
      ],
      cookieUrls: [d.baseUrl],
      ...(options.driver ? { driver: options.driver } : {}),
      ...(options.browser?.channel ? { channel: options.browser.channel } : {}),
      ...(options.browser?.executablePath
        ? { executablePath: options.browser.executablePath }
        : {}),
      ...(options.browser?.loginTimeoutMs ? { timeoutMs: options.browser.loginTimeoutMs } : {}),
      ...(options.browser?.refreshTimeoutMs
        ? { refreshTimeoutMs: options.browser.refreshTimeoutMs }
        : {}),
    };
    this.session = options.createSession
      ? options.createSession(sessionOptions)
      : new BrowserSession(sessionOptions);
  }

  async authenticate(): Promise<AuthResult> {
    if (await this.session.hasStoredSession())
      return { status: 'authenticated', message: 'Stored LiveCampusU browser session' };
    // A human logged in before (persistent profile exists): try the headless SSO once.
    if (existsSync(this.profileDir)) {
      const r = await this.session.refresh();
      if (r.status === 'authenticated') return r;
    }
    return {
      status: 'auth_required',
      message: `LiveCampusU login required. Run \`unicontext login ${this.options.sourceId}\` and sign in (SSO + MFA) in the browser window.`,
    };
  }

  async login(options?: InteractiveLoginOptions): Promise<AuthResult> {
    const r = await this.session.login(options);
    // The human's login exported fresh cookies: a sync still holding an older jar must not
    // overwrite them with its (now superseded) session when it finishes.
    if (r.status === 'authenticated') this.generation++;
    return r;
  }

  async cookies(): Promise<LcuCookieJar | undefined> {
    const gen = this.generation;
    if (!(await this.session.hasStoredSession())) return undefined;
    const jar = await this.session.jar();
    if (gen !== this.generation) return undefined; // logged out while reading
    this.loadedCookies = stableStringify(jar.toBrowserCookies());
    this.jarGeneration.set(jar, gen);
    return jar;
  }

  async reauthenticate(signal?: AbortSignal): Promise<boolean> {
    const r = await this.session.refresh(signal);
    if (r.status !== 'authenticated')
      this.logger.info('LiveCampusU headless SSO refresh did not succeed', { status: r.status });
    return r.status === 'authenticated';
  }

  async persist(jar: LcuCookieJar): Promise<void> {
    if (!(jar instanceof CookieJar)) return;
    // A sync that was running when the user logged out must not write its cookies back (that
    // would silently log the user in again).
    if (this.jarGeneration.get(jar) !== this.generation) return;
    const cookies = jar.toBrowserCookies();
    const serialized = stableStringify(cookies);
    if (serialized === this.loadedCookies) return;
    await this.session.saveCookies(cookies);
    this.loadedCookies = serialized;
  }

  /** Local logout: forget exported cookies and the persistent profile (no server call). */
  async logout(): Promise<void> {
    this.generation++;
    this.loadedCookies = undefined;
    await this.session.clear({ profile: true });
  }

  dispose(): Promise<void> {
    return this.session.close();
  }
}

/** Click the SSO start button and wait until the login screen is gone (max ~15 s). */
async function startSso(page: PageLike, selector: string, clock: Clock): Promise<void> {
  const button = page.locator(selector);
  if ((await button.count()) === 0) return;
  await button.first().click({ timeout: 15_000 });
  try {
    await page.waitForLoadState('load', { timeout: 15_000 });
  } catch {
    // keep polling below
  }
  for (let i = 0; i < 60; i++) {
    if (page.isClosed() || (await page.locator(selector).count()) === 0) return;
    await clock.sleep(250);
  }
}
