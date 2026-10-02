import { createHttpClient, type HttpClient, type RateLimiter } from '@unicontext/connector-sdk';
import {
  AuthRequiredError,
  type Clock,
  ConnectorError,
  type FetchLike,
  type Logger,
  PolicyViolationError,
  silentLogger,
  systemClock,
} from '@unicontext/core';
import type { LcuAuthStrategy, LcuCookieJar } from './auth.js';
import { type LcuDeploymentProfile, lcuUrl, relativeLcuPath } from './deployment.js';
import {
  classifyPage,
  extractTokens,
  loadHtml,
  type PageTokens,
  screenIdFromUrl,
  stripJsessionid,
} from './html.js';
import { noticeAttachmentLoadPath, parseNoticeList } from './parsers/notices.js';
import { assertRequestAllowed, type PolicyGrant } from './policy.js';

/** The session is gone (login screen, error screen, CSRF failure, idle timeout, IdP redirect). */
export class SessionLostError extends ConnectorError {
  readonly reason: string;
  constructor(reason: string) {
    super(`LiveCampusU session lost: ${reason}`, { details: { reason } });
    this.reason = reason;
  }
}

/**
 * The session was re-established (re-auth + bootstrap) in the middle of a step. Navigation state
 * (current screen, row indexes) is gone, so the caller must restart the step from its menu entry.
 */
export class SessionRestartedError extends ConnectorError {
  constructor(reason: string) {
    super(`LiveCampusU session was re-established after: ${reason}`, { details: { reason } });
  }
}

export interface LcuPage {
  /** Final URL (after redirects, without `;jsessionid=`). */
  url: string;
  /** Path relative to the base URL. */
  path: string;
  screenId: string | undefined;
  html: string;
  status: number;
  /** Set on notice list pages: proofs for openNoticeDetail() must carry this version. */
  noticeListVersion?: number;
}

/**
 * Proof that a notice row is READ, built from the latest list page. The session re-checks it
 * against its own parse of that page before opening the detail (opening marks a notice read).
 */
export interface NoticeReadProof {
  rowIndex: number;
  unread: boolean;
  listVersion: number;
}

export type FormFields = readonly (readonly [string, string])[] | Readonly<Record<string, string>>;

export interface LcuSessionOptions {
  deployment: LcuDeploymentProfile;
  auth: LcuAuthStrategy;
  fetch?: FetchLike | undefined;
  rateLimiter?: RateLimiter | undefined;
  clock?: Clock | undefined;
  logger?: Logger | undefined;
  /** Minimum gap between two requests (politeness, on top of the rate limiter). Default 1000. */
  minRequestIntervalMs?: number | undefined;
  /** Grade screens are refused unless true (opt-in). */
  gradesEnabled?: boolean | undefined;
  /** Re-authentication attempts per sync run. Default 1. */
  maxReauthPerRun?: number | undefined;
  userAgent?: string | undefined;
}

const MAX_REDIRECTS = 10;

/**
 * Plain-HTTP session against LCU-Web (research §1.4/§1.5):
 * - strictly ONE request in flight: every operation goes through a promise-chain queue;
 * - every fetch goes through the source RateLimiter (createHttpClient) plus a minimum interval;
 * - `redirect: 'manual'` — PRG 302s are followed here so cookies are updated on every hop;
 * - `_csrf` / `_TRANSACTION_TOKEN` are taken from the LATEST HTML response and sent with the
 *   next form POST; JSON POSTs send `X-CSRF-TOKEN` and `_csrf` in the body;
 * - session loss (login screen, error screen, CSRF failure, 401/403, IdP redirect, idle timeout)
 *   triggers ONE re-authentication through the strategy per run, then AuthRequiredError;
 * - the hard-coded request policy (policy.ts) is enforced before any fetch.
 */
export class LcuSession {
  private readonly d: LcuDeploymentProfile;
  private readonly auth: LcuAuthStrategy;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly http: HttpClient;
  private readonly minInterval: number;
  private readonly gradesEnabled: boolean;
  private readonly maxReauth: number;
  private readonly idleMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private jar: LcuCookieJar | undefined;
  private tokens: PageTokens = {};
  private current: LcuPage | undefined;
  private lastActivityMs: number | undefined;
  private lastFetchMs: number | undefined;
  private noticeRows = new Map<number, boolean>();
  private listVersion = 0;
  private reauthLeft: number;
  private signal: AbortSignal | undefined;
  readonly stats = { requests: 0, reauths: 0 };

  constructor(options: LcuSessionOptions) {
    this.d = options.deployment;
    this.auth = options.auth;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? silentLogger;
    this.minInterval = options.minRequestIntervalMs ?? 1000;
    this.gradesEnabled = options.gradesEnabled ?? false;
    this.maxReauth = options.maxReauthPerRun ?? 1;
    this.reauthLeft = this.maxReauth;
    this.idleMs = this.d.idleTimeoutMinutes * 60_000;
    this.http = createHttpClient({
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
      ...(options.userAgent ? { userAgent: options.userAgent } : {}),
      clock: this.clock,
    });
  }

  /** Reset the per-run re-auth budget (called at the start of each sync). */
  beginRun(signal?: AbortSignal): void {
    this.reauthLeft = this.maxReauth;
    this.signal = signal;
  }

  get currentScreen(): string | undefined {
    return this.current?.screenId;
  }

  /** Copy of the tokens taken from the latest HTML response (tests / diagnostics). */
  currentTokens(): PageTokens {
    return { ...this.tokens };
  }

  get lastActivity(): Date | undefined {
    return this.lastActivityMs === undefined ? undefined : new Date(this.lastActivityMs);
  }

  /** Forget the in-memory session state (cookies are re-read from the strategy next time). */
  reset(): void {
    this.jar = undefined;
    this.tokens = {};
    this.current = undefined;
    this.lastActivityMs = undefined;
    this.noticeRows.clear();
  }

  /** Persist rotated cookies through the strategy (e.g. a new JSESSIONID). */
  async persistCookies(): Promise<void> {
    if (this.jar && this.auth.persist) await this.auth.persist(this.jar);
  }

  // ---------------------------------------------------------------- public operations

  /** GET the landing screen (fresh tokens, version fingerprint). Re-authenticates if needed. */
  bootstrap(): Promise<LcuPage> {
    return this.run('bootstrap', () => this.bootstrapInternal());
  }

  /** Menu navigation: POST `<screen>/<menuInit>` with the current tokens → 302 → GET. */
  open(screenId: string): Promise<LcuPage> {
    return this.post(`${screenId}/${this.d.actions.menuInit}`);
  }

  /** Form POST of an action with the latest tokens; follows the PRG redirect. */
  post(path: string, fields: FormFields = []): Promise<LcuPage> {
    this.check('POST', path);
    return this.run('op', () => this.pageRequest('POST', path, { form: fields }));
  }

  /** GET an HTML screen. */
  getPage(path: string): Promise<LcuPage> {
    this.check('GET', path);
    return this.run('op', () => this.pageRequest('GET', path, {}));
  }

  /** GET a JSON endpoint (`$.ajaxGetJSON`: no extra headers). */
  getJson(path: string): Promise<unknown> {
    this.check('GET', path);
    return this.run('op', () => this.jsonRequest('GET', path, undefined));
  }

  /** POST a JSON endpoint (`$.ajaxPostJSON`: X-CSRF-TOKEN header + `_csrf` in the body). */
  postJson(path: string, body: Record<string, unknown> = {}): Promise<unknown> {
    this.check('POST', path);
    return this.run('op', () => this.jsonRequest('POST', path, body));
  }

  /** GET a static file (version fingerprint). */
  getBytes(path: string): Promise<Uint8Array> {
    this.check('GET', path);
    return this.run('op', async () => {
      const { res } = await this.fetchFollow('GET', path, {});
      if (!res.ok) throw new ConnectorError(`HTTP ${res.status} for ${path}`);
      this.touch();
      return new Uint8Array(await res.arrayBuffer());
    });
  }

  /**
   * Open the detail of a notice the list shows as READ. Refused (PolicyViolationError, before any
   * request) for unread rows, stale proofs, or when the current screen is not the notice list.
   */
  openNoticeDetail(proof: NoticeReadProof): Promise<LcuPage> {
    if (proof.unread !== false)
      throw new PolicyViolationError(
        'Refusing to open an unread notice: opening it would mark it as read',
        { details: { rowIndex: proof.rowIndex } },
      );
    const path = this.d.actions.noticeRowSelect;
    this.check('POST', path, 'notice-detail');
    return this.run('op', async () => {
      if (this.current?.screenId !== this.d.screens.noticeList)
        throw new PolicyViolationError('Notice detail requested while not on the notice list');
      if (proof.listVersion !== this.listVersion)
        throw new PolicyViolationError('Stale notice read-state proof (the list was reloaded)');
      const unread = this.noticeRows.get(proof.rowIndex);
      if (unread !== false)
        throw new PolicyViolationError(
          unread === undefined
            ? `Notice row ${proof.rowIndex} is not on the current list`
            : 'Refusing to open an unread notice: opening it would mark it as read',
        );
      return this.pageRequest('POST', path, {
        form: [
          [this.d.actions.rowIndexField, String(proof.rowIndex)],
          ['viewRowIndexArray', ''],
        ],
        grant: 'notice-detail',
      });
    });
  }

  /**
   * Attachment list of the notice detail that is currently open: the same read-only
   * `POST fileUpload/load/<id>` (X-CSRF-TOKEN, empty body) the detail screen makes on every view.
   * Returns undefined when the page has no file widget. Refused unless the current screen is the
   * notice detail (which is only ever opened for READ notices).
   */
  loadNoticeAttachments(): Promise<unknown> {
    return this.run('op', async () => {
      const page = this.current;
      if (page?.screenId !== this.d.screens.noticeDetail)
        throw new PolicyViolationError('Attachment list requested while not on a notice detail');
      const path = noticeAttachmentLoadPath(page.html);
      if (!path) return undefined;
      this.check('POST', path, 'notice-attachments');
      return this.jsonRequest('POST', path, undefined, { grant: 'notice-attachments' });
    });
  }

  // ---------------------------------------------------------------- internals

  private check(method: string, path: string, grant?: PolicyGrant): void {
    assertRequestAllowed(method, path, {
      gradesEnabled: this.gradesEnabled,
      grant,
      extraDeniedScreens: [this.d.screens.assignmentSubmit],
      noticeListScreen: this.d.screens.noticeList,
      noticeDetailScreen: this.d.screens.noticeDetail,
      gradeScreens: [
        this.d.screens.grades,
        this.d.screens.gradeDashboard,
        ...(this.d.screens.creditRequirements ? [this.d.screens.creditRequirements] : []),
      ],
    });
  }

  /** Policy check of an absolute URL: it must be under the base URL, then the path rules apply. */
  private checkUrl(method: string, url: string, grant?: PolicyGrant): void {
    const rel = relativeLcuPath(this.d, url);
    if (rel === undefined)
      throw new PolicyViolationError(
        `LiveCampusU request blocked: ${new URL(url).host} is outside the deployment base URL`,
      );
    this.check(method, rel, grant);
  }

  /** Serial queue: one operation (incl. its redirects) at a time, in call order. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private run<T>(kind: 'bootstrap' | 'op', fn: () => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      try {
        await this.ensureReady(kind);
        return await fn();
      } catch (e) {
        if (!(e instanceof SessionLostError)) throw e;
        this.logger.info('LiveCampusU session lost; re-authenticating', { reason: e.reason });
        await this.recover(e.reason);
        if (kind === 'bootstrap' && this.current) return this.current as T;
        throw new SessionRestartedError(e.reason);
      }
    });
  }

  private async ensureReady(kind: 'bootstrap' | 'op'): Promise<void> {
    const now = this.clock.now().getTime();
    if (this.lastActivityMs !== undefined && now - this.lastActivityMs >= this.idleMs) {
      this.lastActivityMs = undefined;
      this.current = undefined;
      throw new SessionLostError(`idle for more than ${this.d.idleTimeoutMinutes} minutes`);
    }
    if (!this.jar) {
      this.jar = await this.auth.cookies();
      if (!this.jar) throw new SessionLostError('no stored session');
    }
    if (kind === 'op' && !this.current) await this.bootstrapInternal();
  }

  private async recover(reason: string): Promise<void> {
    this.current = undefined;
    this.tokens = {};
    this.noticeRows.clear();
    this.lastActivityMs = undefined;
    if (this.reauthLeft <= 0)
      throw new AuthRequiredError(
        `LiveCampusU session lost (${reason}) again after re-authentication. Run \`unicontext login\` for this source.`,
      );
    this.reauthLeft--;
    this.stats.reauths++;
    const ok = await this.auth.reauthenticate(this.signal);
    if (!ok)
      throw new AuthRequiredError(
        `LiveCampusU session expired (${reason}) and the non-interactive SSO refresh failed. Run \`unicontext login\` for this source.`,
      );
    this.jar = await this.auth.cookies();
    if (!this.jar)
      throw new AuthRequiredError('LiveCampusU re-authentication produced no session cookies');
    try {
      await this.bootstrapInternal();
    } catch (e) {
      if (e instanceof SessionLostError)
        throw new AuthRequiredError(
          `LiveCampusU session not usable after re-authentication (${e.reason}). Run \`unicontext login\` for this source.`,
        );
      throw e;
    }
  }

  private bootstrapInternal(): Promise<LcuPage> {
    return this.pageRequest('GET', this.d.screens.landing, {});
  }

  private touch(): void {
    this.lastActivityMs = this.clock.now().getTime();
  }

  private async pace(): Promise<void> {
    if (this.minInterval <= 0 || this.lastFetchMs === undefined) return;
    const wait = this.lastFetchMs + this.minInterval - this.clock.now().getTime();
    if (wait > 0) await this.clock.sleep(wait, this.signal);
  }

  private formBody(fields: FormFields): string {
    const params = new URLSearchParams();
    if (this.tokens.csrf) params.append('_csrf', this.tokens.csrf);
    if (this.tokens.transactionToken)
      params.append('_TRANSACTION_TOKEN', this.tokens.transactionToken);
    const entries: (readonly [string, string])[] = Array.isArray(fields)
      ? [...(fields as readonly (readonly [string, string])[])]
      : Object.entries(fields as Readonly<Record<string, string>>);
    for (const [k, v] of entries) {
      if (k === '_csrf' || k === '_TRANSACTION_TOKEN') continue;
      params.append(k, v);
    }
    return params.toString();
  }

  /** One fetch through the rate limiter with cookies; network/401 mapping by createHttpClient. */
  private async fetchOnce(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
  ): Promise<Response> {
    await this.pace();
    const h: Record<string, string> = { 'accept-language': 'ja,en;q=0.5', ...headers };
    const cookie = this.jar?.header(url);
    if (cookie) h.cookie = cookie;
    if (this.current?.url && !h.referer) h.referer = this.current.url;
    this.stats.requests++;
    try {
      return await this.http.request(url, {
        method,
        headers: h,
        redirect: 'manual',
        ...(body !== undefined ? { body } : {}),
        ...(this.signal ? { signal: this.signal } : {}),
      });
    } catch (e) {
      if (e instanceof AuthRequiredError) throw new SessionLostError('HTTP 401');
      throw e;
    } finally {
      this.lastFetchMs = this.clock.now().getTime();
    }
  }

  /** Request + manual redirect following (cookies updated and policy checked on every hop). */
  private async fetchFollow(
    method: string,
    path: string,
    opts: { body?: string; headers?: Record<string, string>; grant?: PolicyGrant },
  ): Promise<{ res: Response; url: string }> {
    let url = lcuUrl(this.d, path);
    let m = method;
    let body = opts.body;
    let headers = opts.headers ?? {};
    // The first hop too (covers internal requests such as the bootstrap GET, and resolves the
    // path the way fetch will, so `..` or an absolute URL cannot slip past the string check).
    this.checkUrl(m, url, opts.grant);
    for (let hop = 0; ; hop++) {
      const res = await this.fetchOnce(m, url, headers, body);
      const setCookie = res.headers.getSetCookie();
      if (setCookie.length && this.jar) this.jar.update(url, setCookie);
      if (res.status === 403) throw new SessionLostError('HTTP 403 (CSRF/session rejected)');
      if (![301, 302, 303, 307, 308].includes(res.status)) return { res, url };
      if (hop >= MAX_REDIRECTS) throw new ConnectorError('Too many redirects from LiveCampusU');
      const location = res.headers.get('location');
      if (!location)
        throw new ConnectorError(
          `Redirect without Location from ${relativeLcuPath(this.d, url) ?? url}`,
        );
      const stripped = stripJsessionid(new URL(location, url).toString());
      if (stripped.jsessionid && this.jar && !this.jar.get('JSESSIONID', stripped.url)) {
        const basePath = new URL(this.d.baseUrl).pathname.replace(/\/$/, '') || '/';
        this.jar.update(stripped.url, [
          `JSESSIONID=${stripped.jsessionid}; Path=${basePath}; Secure; HttpOnly`,
        ]);
      }
      const next = relativeLcuPath(this.d, stripped.url);
      if (next === undefined) {
        const host = new URL(stripped.url).host;
        throw new SessionLostError(`redirected to ${host} (SSO required)`);
      }
      const nextMethod = res.status === 307 || res.status === 308 ? m : 'GET';
      // Every hop obeys the policy (a redirect to a denied screen is never followed).
      this.check(nextMethod, next, opts.grant);
      url = stripped.url;
      if (nextMethod === 'GET') {
        body = undefined;
        headers = {};
      }
      m = nextMethod;
    }
  }

  private async pageRequest(
    method: 'GET' | 'POST',
    path: string,
    opts: { form?: FormFields; grant?: PolicyGrant },
  ): Promise<LcuPage> {
    const headers: Record<string, string> = { accept: 'text/html,application/xhtml+xml' };
    let body: string | undefined;
    if (method === 'POST') {
      headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
      body = this.formBody(opts.form ?? []);
    }
    const { res, url } = await this.fetchFollow(method, path, {
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(opts.grant ? { grant: opts.grant } : {}),
    });
    const html = await res.text();
    const $ = loadHtml(html);
    const cls = classifyPage($, {
      loginFormId: this.d.auth.loginFormId,
      ssoStartSelector: this.d.auth.ssoStartSelector,
    });
    if (cls.kind !== 'ok') throw new SessionLostError(cls.reason ?? cls.kind);
    if (!res.ok)
      throw new ConnectorError(`HTTP ${res.status} for ${relativeLcuPath(this.d, url) ?? url}`);
    const tokens = extractTokens($);
    if (tokens.csrf) this.tokens.csrf = tokens.csrf;
    if (tokens.transactionToken) this.tokens.transactionToken = tokens.transactionToken;
    this.touch();
    const screenId = screenIdFromUrl(url);
    const page: LcuPage = {
      url,
      path: relativeLcuPath(this.d, url) ?? '',
      screenId,
      html,
      status: res.status,
    };
    if (screenId === this.d.screens.noticeList) {
      this.noticeRows = new Map(parseNoticeList(html).map((r) => [r.rowIndex, r.unread]));
      this.listVersion++;
      page.noticeListVersion = this.listVersion;
    }
    this.current = page;
    return page;
  }

  private async jsonRequest(
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
    opts: { grant?: PolicyGrant } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: 'application/json, text/javascript, */*; q=0.01',
      'x-requested-with': 'XMLHttpRequest',
    };
    let payload: string | undefined;
    if (method === 'POST') {
      if (!this.tokens.csrf) throw new SessionLostError('no CSRF token for a JSON POST');
      headers['x-csrf-token'] = this.tokens.csrf;
      if (body !== undefined) {
        headers['content-type'] = 'application/json;charset=utf-8';
        payload = JSON.stringify({ ...body, _csrf: this.tokens.csrf });
      } else payload = ''; // jQuery $.ajax({type: 'POST'}) without data
    }
    const { res, url } = await this.fetchFollow(method, path, {
      headers,
      ...(payload !== undefined ? { body: payload } : {}),
      ...(opts.grant ? { grant: opts.grant } : {}),
    });
    const text = await res.text();
    const type = res.headers.get('content-type') ?? '';
    if (/html/i.test(type) || /^\s*</.test(text)) {
      const cls = classifyPage(text, {
        loginFormId: this.d.auth.loginFormId,
        ssoStartSelector: this.d.auth.ssoStartSelector,
      });
      throw new SessionLostError(
        cls.kind === 'ok' ? 'HTML instead of JSON' : (cls.reason ?? cls.kind),
      );
    }
    if (!res.ok)
      throw new ConnectorError(`HTTP ${res.status} for ${relativeLcuPath(this.d, url) ?? url}`);
    this.touch();
    try {
      return text.trim() === '' ? null : (JSON.parse(text) as unknown);
    } catch (e) {
      throw new ConnectorError(`Invalid JSON from ${relativeLcuPath(this.d, url) ?? url}`, {
        cause: e,
      });
    }
  }
}
