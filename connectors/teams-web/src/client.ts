import { randomBytes } from 'node:crypto';
import { hasVisibleCredentialField, type PageLike } from '@unicontext/adapter-browser';
import {
  AuthRequiredError,
  type Clock,
  ConnectorError,
  type Logger,
  RateLimitedError,
  silentLogger,
} from '@unicontext/core';
import {
  CLIENT_READY,
  call,
  DOWNLOAD_CLOSE,
  DOWNLOAD_OPEN,
  DOWNLOAD_READ,
  DRIVE_DELTA,
  NAVIGATE_HASH,
  READ_CONVERSATIONS,
  READ_REPLY_CHAINS,
  SCROLL_TO_END,
} from './page-scripts.js';
import { ASSIGNMENTS_APP_ID } from './parse.js';

// ---------------------------------------------------------------------------------------------
// What the adapter needs from the Teams web client (fakeable in tests)

export interface ConversationRow {
  id: string;
  teamId?: string | null;
  lastMessageTimeUtc?: number | null;
  threadProperties: Record<string, unknown>;
}

export interface ClientConversations {
  userId: string | undefined;
  tenantId: string | undefined;
  spaces: ConversationRow[];
  topics: ConversationRow[];
}

export interface ReplyChainRow {
  replyChainId: string;
  latestDeliveryTime: number | string | null;
  messages: Record<string, unknown>[];
}

export interface ChannelTarget {
  channelId: string;
  channelName: string;
  groupId: string;
  tenantId: string | undefined;
}

export interface DriveDeltaResult {
  items: Record<string, unknown>[];
  deltaLink: string | undefined;
  /** SharePoint answered 410: the delta link expired, list everything again. */
  resync?: boolean;
  /** Stopped at the page limit; the next run continues with a fresh listing. */
  truncated?: boolean;
}

export interface TeamsWebClient {
  /** Boot the client; throws AuthRequiredError when Microsoft asks for a sign-in. */
  open(): Promise<{ version: string }>;
  conversations(): Promise<ClientConversations>;
  /** Open a channel through its deep link and let the client load (and scroll) its posts. */
  openChannel(
    target: ChannelTarget,
    options: { scrollPages: number; settleMs: number },
  ): Promise<{ fetched: boolean }>;
  replyChains(conversationId: string): Promise<ReplyChainRow[]>;
  /** Open the Assignments (課題) app; every `edu/me/work` item it received, all tabs. */
  assignments(): Promise<{ items: Record<string, unknown>[]; complete: boolean }>;
  driveDelta(siteUrl: string, deltaLink: string | undefined): Promise<DriveDeltaResult>;
  /**
   * Stream one file's content from a page on the team site (same-origin GET with the page's own
   * session). `onChunk` receives the bytes in order (awaited: back-pressure).
   */
  streamFile(
    request: StreamFileRequest,
    onChunk: (chunk: Uint8Array) => Promise<void>,
  ): Promise<StreamFileResult>;
}

export interface StreamFileRequest {
  siteUrl: string;
  itemId: string;
  /** SharePoint UniqueId (from the eTag) for the classic-REST fallback. */
  uniqueId?: string;
  maxBytes: number;
}

export type StreamFileResult =
  | { ok: true; bytes: number; contentType: string | undefined }
  | { ok: false; reason: 'tooLarge' | 'notFound' | 'failed'; status?: number };

/** Read a whole (small) file into memory through `streamFile`; undefined when it was not read. */
export async function readFileBytes(
  client: TeamsWebClient,
  request: StreamFileRequest,
): Promise<Uint8Array | undefined> {
  const parts: Uint8Array[] = [];
  const r = await client.streamFile(request, (chunk) => {
    parts.push(chunk);
    return Promise.resolve();
  });
  return r.ok ? new Uint8Array(Buffer.concat(parts)) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Read-only request policy

/** POSTs the client makes that only read (lookups, token exchange, batched reads). */
export const READ_ONLY_POSTS: readonly RegExp[] = [
  /\/api\/authsvc\/v\d(\.\d)?\/authz/,
  /\/v1\/skypetokenauth\b/,
  /\/v1\/[^/]+\/aadtokenauth\b/,
  /\/batch\/posts\b/,
  /\/beta\/users\/fetch(ShortProfile|featuresettings)?\b/i,
  /\/beta\/users\/(effectivePolicies|useraggregatesettings|groupsSettings)\b/i,
  /\/users\/apps\/(aggregatedEntitlements|eligibilities|batchedDefinitions)\b/i,
  /\/presence\/getpresence\/?$/,
];

const AUTH_HOSTS =
  /(^|\.)(login\.microsoftonline\.com|login\.live\.com|login\.windows\.net|msauth\.net|msftauth\.net)$/i;
/** Microsoft service hosts: here only the read-only POSTs above may leave the browser. */
const SERVICE_HOSTS =
  /(^|\.)(cloud\.microsoft|microsoft\.com|microsoftonline\.com|sharepoint\.com|skype\.com|office\.com|office\.net|office365\.com|outlook\.com|onenote\.com|live\.com|trouter\.io)$/i;

/**
 * Keeps the session read-only: GET/HEAD/OPTIONS pass, sign-in traffic passes, and on Microsoft
 * service hosts only the read-only POSTs above pass. Everything else there (marking read,
 * presence, posting, reacting, joining, turning in, telemetry) is aborted before it leaves the
 * browser. Other hosts (a federated identity provider's sign-in form) are left alone.
 */
export function routeDecision(method: string, url: string): 'continue' | 'abort' {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return 'continue';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'abort';
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return 'continue';
  if (AUTH_HOSTS.test(u.hostname)) return 'continue';
  // SharePoint's sign-in form post (the SSO hand-back), nothing else on SharePoint.
  if (/\.sharepoint\.com$/i.test(u.hostname) && /^\/_forms\/default\.aspx$/i.test(u.pathname))
    return 'continue';
  if (!SERVICE_HOSTS.test(u.hostname)) return 'continue';
  if (m === 'POST' && READ_ONLY_POSTS.some((re) => re.test(u.pathname))) return 'continue';
  return 'abort';
}

// ---------------------------------------------------------------------------------------------
// Structural views of the Playwright objects used here

interface PwRequest {
  method(): string;
  url(): string;
  resourceType(): string;
}
interface PwRoute {
  request(): PwRequest;
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
  fallback(): Promise<void>;
}
interface PwResponse {
  url(): string;
  status(): number;
  request(): PwRequest;
  json(): Promise<unknown>;
}
interface PwLocator {
  count(): Promise<number>;
  first(): PwLocator;
  nth(i: number): PwLocator;
  click(options?: { timeout?: number }): Promise<void>;
}
interface PwFrame {
  url(): string;
  evaluate(expression: string): Promise<unknown>;
  locator(selector: string): PwLocator;
}
interface PwPage {
  url(): string;
  waitForLoadState(
    state?: 'load' | 'domcontentloaded',
    options?: { timeout?: number },
  ): Promise<void>;
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  locator(selector: string): PwLocator;
  frames(): PwFrame[];
  mouse: {
    move(x: number, y: number): Promise<void>;
    wheel(dx: number, dy: number): Promise<void>;
  };
  route(pattern: string, handler: (route: PwRoute) => unknown): Promise<void>;
  isClosed(): boolean;
  close(): Promise<void>;
}
export interface PwContext {
  route(pattern: string, handler: (route: PwRoute) => unknown): Promise<void>;
  on(event: 'response', listener: (response: PwResponse) => void): void;
  off(event: 'response', listener: (response: PwResponse) => void): void;
  newPage(): Promise<PwPage>;
}

/** Install the read-only route on a freshly launched context (before the first navigation). */
export async function installReadOnlyRoute(
  context: unknown,
  logger: Logger = silentLogger,
): Promise<void> {
  const ctx = context as PwContext;
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    if (routeDecision(req.method(), req.url()) === 'continue') return route.continue();
    logger.debug('blocked non-read request', { method: req.method(), host: hostOf(req.url()) });
    return route.abort('blockedbyclient');
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------------------------

const EDU_WORK = /^https:\/\/[^/]*assignments[^/]*\/api\/v1\.0\/edu\/me\/work\b/i;
const POSTS = /\/containers\/([^/?]+)\/posts\b/;

export interface PlaywrightClientOptions {
  clientUrl: string;
  bootTimeoutMs: number;
  clock: Clock;
  logger?: Logger;
}

/** The official Teams web client driven read-only in the UniContext browser profile. */
export class PlaywrightTeamsClient implements TeamsWebClient {
  private readonly page: PwPage;
  private readonly context: PwContext;
  private readonly logger: Logger;
  private readonly postsSeen = new Set<string>();
  private readonly work: { filter: string; nextLink: boolean; items: Record<string, unknown>[] }[] =
    [];
  private sharepoint: PwPage | undefined;
  private readonly onResponse = (r: PwResponse): void => {
    const url = r.url();
    const posts = POSTS.exec(url);
    if (posts?.[1]) this.postsSeen.add(decodeURIComponent(posts[1]));
    if (EDU_WORK.test(url) && r.request().method() === 'GET' && r.status() === 200) {
      const filter = new URL(url).searchParams.get('$filter') ?? '';
      r.json()
        .then((body) => {
          const b = body as { value?: unknown; '@odata.nextLink'?: unknown };
          this.work.push({
            filter,
            nextLink: typeof b['@odata.nextLink'] === 'string',
            items: Array.isArray(b.value) ? (b.value as Record<string, unknown>[]) : [],
          });
        })
        .catch(() => undefined);
    }
  };

  constructor(
    page: PageLike,
    context: unknown,
    private readonly options: PlaywrightClientOptions,
  ) {
    this.page = page as unknown as PwPage;
    this.context = context as PwContext;
    this.logger = options.logger ?? silentLogger;
    this.context.on('response', this.onResponse);
  }

  private get origin(): string {
    return this.options.clientUrl.replace(/\/+$/, '');
  }

  private async sleep(ms: number): Promise<void> {
    await this.options.clock.sleep(ms);
  }

  private async ready(): Promise<boolean> {
    const r = (await this.page.evaluate(call(CLIENT_READY)).catch(() => undefined)) as
      { ready?: boolean } | undefined;
    return r?.ready === true;
  }

  async open(): Promise<{ version: string }> {
    const onClient = hostOf(this.page.url()) === new URL(this.origin).host;
    if (!onClient || !(await this.ready()))
      await this.page.goto(`${this.origin}/_#/`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
    const deadline = this.options.clock.now().getTime() + this.options.bootTimeoutMs;
    let onLoginSince: number | undefined;
    for (;;) {
      const host = hostOf(this.page.url());
      if (AUTH_HOSTS.test(host)) {
        onLoginSince ??= this.options.clock.now().getTime();
        // Silent SSO passes through the sign-in host; a visible form (or a long stay) needs a human.
        if (
          (await hasVisibleCredentialField(this.page as unknown as PageLike)) ||
          (await this.page.locator('#tilesHolder, [data-test-id="accountList"]').count()) > 0 ||
          this.options.clock.now().getTime() - onLoginSince > 25_000
        )
          throw new AuthRequiredError(
            'Microsoft のサインインが必要です。「unicontext login teams-web」でサインインしてください。 / Microsoft sign-in required; run `unicontext login teams-web`.',
          );
      } else {
        onLoginSince = undefined;
        const r = (await this.page.evaluate(call(CLIENT_READY)).catch(() => undefined)) as
          { ready?: boolean } | undefined;
        if (r?.ready) break;
      }
      if (this.options.clock.now().getTime() > deadline)
        throw new ConnectorError('The Teams web client did not finish loading in time');
      await this.sleep(1000);
    }
    // Let the client apply its incremental team/channel update before reading the cache.
    await this.sleep(4000);
    return { version: 'v2' };
  }

  async conversations(): Promise<ClientConversations> {
    const r = (await this.page.evaluate(call(READ_CONVERSATIONS))) as
      ClientConversations | undefined;
    if (!r) throw new ConnectorError('The Teams client cache (conversations) is not available');
    return r;
  }

  async openChannel(
    target: ChannelTarget,
    options: { scrollPages: number; settleMs: number },
  ): Promise<{ fetched: boolean }> {
    const q = new URLSearchParams({
      groupId: target.groupId,
      ...(target.tenantId ? { tenantId: target.tenantId } : {}),
    });
    const path = `/l/channel/${encodeURIComponent(target.channelId)}/${encodeURIComponent(target.channelName)}?${q.toString()}`;
    this.postsSeen.delete(target.channelId);
    await this.page.evaluate(call(NAVIGATE_HASH, path));
    // A channel the client has cached may not be fetched again: wait for its posts response a
    // little, then give the client time to write what it received to its cache.
    const until = this.options.clock.now().getTime() + options.settleMs * 2;
    while (!this.postsSeen.has(target.channelId) && this.options.clock.now().getTime() < until)
      await this.sleep(500);
    await this.sleep(Math.round(options.settleMs / 2));
    for (let i = 0; i < options.scrollPages; i++) {
      await this.page.mouse.move(700, 500);
      await this.page.mouse.wheel(0, -6000);
      await this.sleep(1500);
    }
    return { fetched: this.postsSeen.has(target.channelId) };
  }

  async replyChains(conversationId: string): Promise<ReplyChainRow[]> {
    const r = await this.page.evaluate(call(READ_REPLY_CHAINS, conversationId));
    return Array.isArray(r) ? (r as ReplyChainRow[]) : [];
  }

  private assignmentsFrame(): PwFrame | undefined {
    return this.page.frames().find((f) => /assignments\.[^/]*\/(classes|\?|$)/.test(f.url()));
  }

  async assignments(): Promise<{ items: Record<string, unknown>[]; complete: boolean }> {
    this.work.length = 0;
    const button = this.page
      .locator(`button[data-tid="${ASSIGNMENTS_APP_ID}"], button[id="${ASSIGNMENTS_APP_ID}"]`)
      .first();
    if ((await button.count()) === 0) {
      this.logger.info('Assignments app button not found');
      return { items: [], complete: false };
    }
    await button.click({ timeout: 15_000 });
    let frame: PwFrame | undefined;
    for (let i = 0; i < 40 && !(frame && this.work.length > 0); i++) {
      frame ??= this.assignmentsFrame();
      await this.sleep(500);
    }
    if (!frame) return { items: [], complete: false };
    await this.sleep(3000);
    // Tabs: 今後の予定 / 期限を経過 / 完了 — by position, so the UI language does not matter.
    const tabs = frame.locator('[role="tab"]');
    const tabCount = await tabs.count();
    for (let t = 0; t < Math.min(tabCount, 3); t++) {
      if (t > 0) {
        await tabs.nth(t).click({ timeout: 10_000 });
        await this.sleep(3000);
      }
      // Page through the list: scroll until no new responses arrive.
      for (let round = 0; round < 15; round++) {
        const before = this.work.length;
        await frame.evaluate(call(SCROLL_TO_END));
        await this.sleep(2000);
        if (this.work.length === before) break;
      }
    }
    const byId = new Map<string, Record<string, unknown>>();
    for (const w of this.work)
      for (const item of w.items) if (typeof item.id === 'string') byId.set(item.id, item);
    const lastByFilter = new Map<string, boolean>();
    for (const w of this.work) lastByFilter.set(w.filter, w.nextLink);
    const complete =
      tabCount >= 3 && lastByFilter.size >= 3 && [...lastByFilter.values()].every((x) => !x);
    return { items: [...byId.values()], complete };
  }

  private async sharepointPage(siteUrl: string): Promise<PwPage> {
    const origin = new URL(siteUrl).origin;
    if (this.sharepoint && !this.sharepoint.isClosed() && this.sharepoint.url().startsWith(origin))
      return this.sharepoint;
    // A download session starts on the site itself (withClient `url`): use that page.
    if (!this.sharepoint && this.page.url().startsWith(origin)) {
      this.sharepoint = this.page;
      await this.page
        .waitForLoadState('domcontentloaded', { timeout: 60_000 })
        .catch(() => undefined);
      return this.page;
    }
    if (!this.sharepoint || this.sharepoint.isClosed()) {
      this.sharepoint = await this.context.newPage();
      // Data only: skip images, fonts and media on the SharePoint page.
      await this.sharepoint.route('**/*', (route) =>
        ['image', 'font', 'media'].includes(route.request().resourceType())
          ? route.abort()
          : route.fallback(),
      );
    }
    const page = this.sharepoint;
    await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const deadline = this.options.clock.now().getTime() + 45_000;
    while (!page.url().startsWith(origin)) {
      if (
        AUTH_HOSTS.test(hostOf(page.url())) &&
        (await hasVisibleCredentialField(page as unknown as PageLike))
      )
        throw new AuthRequiredError(
          'SharePoint のサインインが必要です / SharePoint sign-in required',
        );
      if (this.options.clock.now().getTime() > deadline)
        throw new AuthRequiredError('SharePoint did not finish the sign-in');
      await this.sleep(1000);
    }
    return page;
  }

  async driveDelta(siteUrl: string, deltaLink: string | undefined): Promise<DriveDeltaResult> {
    const page = await this.sharepointPage(siteUrl);
    const r = (await page.evaluate(call(DRIVE_DELTA, { siteUrl, deltaLink, maxPages: 50 }))) as {
      items?: Record<string, unknown>[];
      deltaLink?: string;
      truncated?: boolean;
      error?: string;
      status?: number;
      retryAfter?: string | null;
    };
    if (r.error) {
      if (r.status === 410) return { items: [], deltaLink: undefined, resync: true };
      if (r.status === 401 || r.status === 403)
        throw new AuthRequiredError(`SharePoint answered ${r.status}`);
      if (r.status === 429 || r.status === 503) {
        const sec = Number(r.retryAfter ?? '60');
        throw new RateLimitedError('SharePoint is throttling', {
          retryAfterMs: (Number.isFinite(sec) ? sec : 60) * 1000,
        });
      }
      throw new ConnectorError(`SharePoint delta failed (${r.error} ${r.status ?? ''})`);
    }
    return {
      items: r.items ?? [],
      deltaLink: r.deltaLink,
      ...(r.truncated ? { truncated: true } : {}),
    };
  }

  async streamFile(
    request: StreamFileRequest,
    onChunk: (chunk: Uint8Array) => Promise<void>,
  ): Promise<StreamFileResult> {
    const page = await this.sharepointPage(request.siteUrl);
    const key = randomBytes(12).toString('hex');
    const opened = (await page.evaluate(
      call(DOWNLOAD_OPEN, {
        siteUrl: request.siteUrl,
        itemId: request.itemId,
        uniqueId: request.uniqueId ?? null,
        maxBytes: request.maxBytes,
        key,
      }),
    )) as {
      ok?: boolean;
      error?: string;
      status?: number;
      retryAfter?: string | null;
      contentType?: string;
    };
    if (!opened.ok) {
      if (opened.error === 'too large') return { ok: false, reason: 'tooLarge' };
      const status = opened.status ?? 0;
      if (status === 429 || status === 503) {
        const sec = Number(opened.retryAfter ?? '60');
        throw new RateLimitedError('SharePoint is throttling', {
          retryAfterMs: (Number.isFinite(sec) ? sec : 60) * 1000,
        });
      }
      if (status === 401) throw new AuthRequiredError('SharePoint answered 401');
      return { ok: false, reason: status === 404 ? 'notFound' : 'failed', status };
    }
    let bytes = 0;
    try {
      for (;;) {
        const r = (await page.evaluate(call(DOWNLOAD_READ, { key, maxChunk: 1024 * 1024 }))) as {
          base64?: string;
          done?: boolean;
          error?: string;
        };
        if (r.error === 'too large') return { ok: false, reason: 'tooLarge' };
        if (r.error || r.base64 === undefined) return { ok: false, reason: 'failed' };
        const chunk = Buffer.from(r.base64, 'base64');
        bytes += chunk.byteLength;
        if (bytes > request.maxBytes) return { ok: false, reason: 'tooLarge' };
        if (chunk.byteLength > 0) await onChunk(new Uint8Array(chunk));
        if (r.done) break;
      }
    } finally {
      await page.evaluate(call(DOWNLOAD_CLOSE, { key })).catch(() => undefined);
    }
    return { ok: true, bytes, contentType: opened.contentType || undefined };
  }

  async close(): Promise<void> {
    this.context.off('response', this.onResponse);
    if (this.sharepoint && !this.sharepoint.isClosed()) await this.sharepoint.close();
  }
}
