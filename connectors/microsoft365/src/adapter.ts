import {
  authorizeWithPkce,
  type OAuthClientConfig,
  OAuthTokenStore,
  secretKey,
  type TokenSet,
} from '@unicontext/auth';
import type { Capability, HealthStatus } from '@unicontext/canonical-model';
import {
  type AuthResult,
  type ConnectorContext,
  createHttpClient,
  type HttpClient,
  type InteractiveAuthAdapter,
  type InteractiveLoginOptions,
  type RawDeletion,
  type RawItem,
  type SyncInput,
  type SyncResult,
} from '@unicontext/connector-sdk';
import {
  AuthRequiredError,
  ConfigError,
  ConnectorError,
  type FetchLike,
  OfflineError,
} from '@unicontext/core';
import { z } from 'zod';
import { buildOAuthConfig, type Microsoft365Config } from './config.js';
import {
  CONSENT_MESSAGE,
  describeError,
  isConsentBlockedError,
  isGraphDeniedText,
  MISSING_CLIENT_ID_MESSAGE,
} from './consent.js';

/* The Graph adapter: delegated OAuth (Authorization Code + PKCE) and delta queries (§24, §25). */

const PAGE_ITEMS = 200;
const MAX_REQUESTS_PER_PAGE = 8;

type TaskKind = 'calendar' | 'mail' | 'drive' | 'teams' | 'channels' | 'messages';

const TaskSchema = z.object({
  kind: z.enum(['calendar', 'mail', 'drive', 'teams', 'channels', 'messages']),
  teamId: z.string().optional(),
  channelId: z.string().optional(),
});
type Task = z.infer<typeof TaskSchema>;

/** State carried in `nextPageToken` between the pages of one run (the engine re-sends the old cursor). */
const WalkSchema = z.object({
  v: z.literal(1),
  queue: z.array(TaskSchema),
  cur: z
    .object({
      task: TaskSchema,
      link: z.string(),
      count: z.number(),
      /** A stored delta link was used (so no `complete` declaration, no item cap). */
      usedPrior: z.boolean(),
      /** Delta not available: walking /messages instead. */
      fallback: z.boolean().optional(),
      /** The fallback walk still has to fetch replies of these message ids. */
      replyQueue: z.array(z.string()).optional(),
    })
    .optional(),
  links: z.record(z.string(), z.string()),
  meId: z.string().optional(),
  win: z.object({ start: z.string(), end: z.string(), createdAt: z.string() }).optional(),
  complete: z.array(z.string()),
  blocked: z.array(z.string()),
  teamsListed: z.boolean(),
  chanTeams: z.array(z.string()),
  chans: z.array(z.string()),
  ok: z.number(),
  denied: z.number(),
  skipped: z.number(),
  skippedLabels: z.array(z.string()),
});
type Walk = z.infer<typeof WalkSchema>;

interface Cursor {
  deltaLinks: Record<string, string>;
  meId: string | undefined;
  win: { start: string; end: string; createdAt: string } | undefined;
}

function readCursor(input: SyncInput): Cursor {
  const extra = input.cursor?.extra ?? {};
  const links: Record<string, string> = {};
  const raw = extra['deltaLinks'];
  if (raw && typeof raw === 'object')
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') links[k] = v;
  const win = z
    .object({ start: z.string(), end: z.string(), createdAt: z.string() })
    .safeParse(extra['calendarWindow']);
  return {
    deltaLinks: input.mode === 'full' ? {} : links,
    meId: typeof extra['meId'] === 'string' ? extra['meId'] : undefined,
    win: win.success ? win.data : undefined,
  };
}

const enc = encodeURIComponent;
const query = (params: [string, string][]): string =>
  params.map(([k, v]) => `${k}=${enc(v)}`).join('&');

/** Claims of an id token (unverified: only used to show the account name, never for trust). */
export function idTokenAccount(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const payload = idToken.split('.')[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    for (const key of ['preferred_username', 'upn', 'email', 'name']) {
      const v = claims[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  } catch {
    /* not a JWT */
  }
  return undefined;
}

function stripDownloadUrls<T extends object>(item: T): T {
  const copy: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  delete copy['@microsoft.graph.downloadUrl'];
  delete copy['@content.downloadUrl'];
  return copy as T;
}

type GraphItem = Record<string, unknown> & { id?: string };

interface GraphErrorBody {
  error?: { code?: string; message?: string };
}

const RESOURCE_CAPABILITIES: Record<string, Capability[]> = {
  calendar: ['calendar'],
  mail: ['messages'],
  drive: ['files', 'materials'],
  teams: ['courses'],
  channelMessages: ['announcements', 'messages'],
};

export interface Microsoft365AdapterOptions {
  /** Override how the login URL is opened (tests). */
  openBrowser?: (url: string) => Promise<void> | void;
}

export class Microsoft365Adapter implements InteractiveAuthAdapter {
  readonly id = 'microsoft365';
  readonly version = '1.0.0';

  private readonly tokens: OAuthTokenStore;
  private readonly fetchFn: FetchLike;
  private readonly http: HttpClient;
  private readonly graph: string;
  private account: string | undefined;
  /** Set when the tenant blocked consent; cleared by the next successful login/sync. */
  private consentBlocked = false;
  private lastWarnings: string[] = [];
  private lastSuccessAt: string | undefined;
  private runWarnings: string[] = [];

  constructor(
    private readonly ctx: ConnectorContext<Microsoft365Config>,
    private readonly options: Microsoft365AdapterOptions = {},
  ) {
    this.tokens = new OAuthTokenStore(ctx.secrets, secretKey(ctx.sourceId, 'oauth'), ctx.clock);
    this.fetchFn = ctx.fetch ?? ((input, init) => fetch(input, init));
    this.graph = ctx.config.graphBaseUrl.replace(/\/+$/, '');
    this.http = createHttpClient({
      fetch: this.fetchFn,
      rateLimiter: ctx.rateLimiter,
      clock: ctx.clock,
      headers: async () => ({ authorization: `Bearer ${await this.accessToken()}` }),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Auth

  private async accessToken(): Promise<string> {
    try {
      return await this.tokens.getAccessToken(buildOAuthConfig(this.ctx.config, this.ctx.profile), {
        fetch: this.fetchFn,
      });
    } catch (e) {
      // The token endpoint being unreachable is "offline", not "signed out".
      if (
        e instanceof TypeError ||
        /fetch failed|ENOTFOUND|ECONNRE|ETIMEDOUT/i.test(describeError(e))
      )
        throw new OfflineError('Token endpoint unreachable', { cause: e });
      throw e;
    }
  }

  private authFailure(error: unknown): AuthResult {
    if (isConsentBlockedError(error)) {
      this.consentBlocked = true;
      return { status: 'auth_required', message: CONSENT_MESSAGE };
    }
    return {
      status: 'auth_required',
      message:
        'Microsoft 365: サインインが必要です（期限切れ・取り消し）。ログインし直してください。 / Sign-in required (expired or revoked); log in again.',
    };
  }

  /** Non-interactive: tokens present (or refreshable) → authenticated; otherwise auth_required. */
  async authenticate(): Promise<AuthResult> {
    if (!this.ctx.config.clientId)
      return { status: 'auth_required', message: MISSING_CLIENT_ID_MESSAGE };
    const tokens = await this.tokens.load();
    if (!tokens) {
      return {
        status: 'auth_required',
        message:
          'Microsoft 365: 未ログインです（unicontext login で認証）。 / Not signed in; run the interactive login.',
      };
    }
    try {
      await this.accessToken();
    } catch (e) {
      if (e instanceof OfflineError) {
        // Cannot refresh right now, but the credentials exist: let sync() report the network error.
        return this.authenticatedResult(tokens, 'offline: token refresh postponed');
      }
      if (e instanceof AuthRequiredError || e instanceof ConfigError) return this.authFailure(e);
      return { status: 'failed', message: describeError(e).slice(0, 300) };
    }
    return this.authenticatedResult((await this.tokens.load()) ?? tokens);
  }

  private authenticatedResult(tokens: TokenSet, message?: string): AuthResult {
    const account = idTokenAccount(tokens.idToken) ?? this.account;
    return {
      status: 'authenticated',
      ...(account ? { account } : {}),
      ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
      ...(message ? { message } : {}),
    };
  }

  async login(options: InteractiveLoginOptions = {}): Promise<AuthResult> {
    let oauth: OAuthClientConfig;
    try {
      oauth = buildOAuthConfig(this.ctx.config, this.ctx.profile);
    } catch (e) {
      return { status: 'failed', message: e instanceof Error ? e.message : String(e) };
    }
    const open = options.openBrowser ?? this.options.openBrowser;
    const hint = options.loginHint ?? this.ctx.config.loginHint;
    try {
      const flow = authorizeWithPkce(oauth, {
        fetch: this.fetchFn,
        clock: this.ctx.clock,
        ...(open ? { openBrowser: async (url: string) => void (await open(url)) } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(hint ? { loginHint: hint } : {}),
      });
      const tokens = await raceAbort(flow, options.signal);
      await this.tokens.save(tokens);
      this.consentBlocked = false;
      return this.authenticatedResult(tokens);
    } catch (e) {
      const text = describeError(e);
      if (isConsentBlockedError(e)) {
        this.consentBlocked = true;
        return { status: 'auth_required', message: CONSENT_MESSAGE };
      }
      if (/timed out/i.test(text)) {
        return {
          status: 'auth_required',
          message: `ログインが完了しませんでした。ブラウザに「管理者の承認が必要」と表示された場合は ${CONSENT_MESSAGE} / Login did not complete. If the browser showed "Need admin approval": ${CONSENT_MESSAGE}`,
        };
      }
      return { status: 'failed', message: text.slice(0, 300) };
    }
  }

  async logout(): Promise<void> {
    await this.tokens.clear();
    this.account = undefined;
  }

  // -------------------------------------------------------------------------------------------
  // Capabilities / health

  capabilities(): Promise<Capability[]> {
    const r = this.ctx.config.resources;
    const caps = new Set<Capability>();
    for (const key of Object.keys(RESOURCE_CAPABILITIES) as (keyof typeof r)[])
      if (r[key]) for (const c of RESOURCE_CAPABILITIES[key] ?? []) caps.add(c);
    return Promise.resolve([...caps]);
  }

  async health(): Promise<HealthStatus> {
    const checkedAt = this.ctx.clock.now().toISOString();
    const base = this.lastSuccessAt ? { lastSuccessAt: this.lastSuccessAt } : {};
    const auth = await this.authenticate();
    if (auth.status === 'auth_required')
      return {
        state: 'auth_required',
        checkedAt,
        ...(auth.message ? { message: auth.message } : {}),
        ...base,
      };
    if (auth.status === 'failed')
      return {
        state: 'failed',
        checkedAt,
        ...(auth.message ? { message: auth.message } : {}),
        ...base,
      };
    if (this.consentBlocked)
      return { state: 'auth_required', checkedAt, message: CONSENT_MESSAGE, ...base };
    if (this.lastWarnings.length > 0)
      return {
        state: 'degraded',
        checkedAt,
        message: `Skipped resources: ${this.lastWarnings.slice(0, 3).join('; ')}`.slice(0, 500),
        ...base,
      };
    return { state: 'healthy', checkedAt, ...base };
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  // -------------------------------------------------------------------------------------------
  // Sync

  private enabledKinds(input: SyncInput): TaskKind[] {
    const r = this.ctx.config.resources;
    const wanted = (resource: keyof typeof r): boolean => {
      if (!r[resource]) return false;
      if (!input.capabilities) return true;
      return (RESOURCE_CAPABILITIES[resource] ?? []).some((c) => input.capabilities?.includes(c));
    };
    const kinds: TaskKind[] = [];
    if (wanted('calendar')) kinds.push('calendar');
    if (wanted('mail')) kinds.push('mail');
    if (wanted('drive')) kinds.push('drive');
    if (wanted('teams')) kinds.push('teams');
    return kinds;
  }

  private initialWalk(input: SyncInput, cursor: Cursor): Walk {
    return {
      v: 1,
      queue: this.enabledKinds(input).map((kind) => ({ kind })),
      links: {},
      ...(cursor.meId ? { meId: cursor.meId } : {}),
      complete: [],
      blocked: [],
      teamsListed: false,
      chanTeams: [],
      chans: [],
      ok: 0,
      denied: 0,
      skipped: 0,
      skippedLabels: [],
    };
  }

  private decodeToken(token: string): Walk {
    try {
      return WalkSchema.parse(JSON.parse(token));
    } catch (e) {
      throw new ConnectorError('Invalid Microsoft 365 page token', { cause: e });
    }
  }

  async sync(input: SyncInput): Promise<SyncResult> {
    const cursor = readCursor(input);
    const walk = input.pageToken
      ? this.decodeToken(input.pageToken)
      : this.initialWalk(input, cursor);
    if (!input.pageToken) {
      this.runWarnings = [];
      if (this.enabledKinds(input).length === 0)
        return {
          items: [],
          cursor: { extra: this.cursorExtra(walk, cursor) },
          warnings: ['no Microsoft 365 resources enabled'],
        };
    }
    const out = {
      items: [] as RawItem[],
      deletions: [] as RawDeletion[],
      warnings: [] as string[],
    };
    try {
      if (!input.pageToken && !walk.meId && this.needsMe())
        await this.fetchMe(walk, out, input.signal);
      let requests = 0;
      while (out.items.length < PAGE_ITEMS && requests < MAX_REQUESTS_PER_PAGE) {
        if (!walk.cur) {
          const task = walk.queue.shift();
          if (!task) break;
          this.startTask(walk, task, cursor);
        }
        requests++;
        await this.step(walk, cursor, out, input.signal);
      }
    } catch (e) {
      if (e instanceof AuthRequiredError && isConsentBlockedError(e)) {
        this.consentBlocked = true;
        throw new AuthRequiredError(CONSENT_MESSAGE, { cause: e });
      }
      throw e;
    }
    this.runWarnings.push(...out.warnings);
    const finished = !walk.cur && walk.queue.length === 0;
    if (!finished) {
      return {
        items: out.items,
        deletions: out.deletions,
        hasMore: true,
        nextPageToken: JSON.stringify(walk),
        ...(out.warnings.length ? { warnings: out.warnings } : {}),
      };
    }
    return this.finish(walk, cursor, out);
  }

  private needsMe(): boolean {
    return this.ctx.config.resources.channelMessages || this.account === undefined;
  }

  private async fetchMe(
    walk: Walk,
    out: { warnings: string[] },
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await this.http.request(
      `${this.graph}/me?${query([['$select', 'id,userPrincipalName,displayName']])}`,
      {
        ...(signal ? { signal } : {}),
      },
    );
    if (!res.ok) {
      out.warnings.push(`Could not read /me (HTTP ${res.status}); own posts cannot be told apart`);
      return;
    }
    const me = (await res.json()) as { id?: string; userPrincipalName?: string };
    if (typeof me.id === 'string') walk.meId = me.id;
    if (typeof me.userPrincipalName === 'string') this.account = me.userPrincipalName;
  }

  private finish(
    walk: Walk,
    cursor: Cursor,
    out: { items: RawItem[]; deletions: RawDeletion[]; warnings: string[] },
  ): SyncResult {
    if (walk.ok === 0 && walk.skipped > 0) {
      this.lastWarnings = [...walk.skippedLabels];
      if (walk.denied > 0) {
        this.consentBlocked = true;
        throw new AuthRequiredError(CONSENT_MESSAGE);
      }
      throw new ConnectorError(
        `All Microsoft 365 resources failed: ${walk.skippedLabels.join('; ')}`,
      );
    }
    this.consentBlocked = false;
    this.lastWarnings = [...walk.skippedLabels];
    this.lastSuccessAt = this.ctx.clock.now().toISOString();
    const blocked = new Set(walk.blocked);
    const complete = new Set(walk.complete.filter((t) => !blocked.has(t)));
    if (walk.teamsListed && !blocked.has('graph.channel')) complete.add('graph.channel');
    return {
      items: out.items,
      deletions: out.deletions,
      cursor: { extra: this.cursorExtra(walk, cursor) },
      hasMore: false,
      ...(complete.size > 0 ? { complete: { sourceTypes: [...complete] } } : {}),
      ...(out.warnings.length ? { warnings: out.warnings } : {}),
    };
  }

  /** Delta links of this run, plus prior ones for resources that were skipped this time. */
  private cursorExtra(walk: Walk, cursor: Cursor): Record<string, unknown> {
    const r = this.ctx.config.resources;
    const links: Record<string, string> = {};
    for (const [key, link] of Object.entries(cursor.deltaLinks)) {
      if (key === 'calendar' || key === 'mail' || key === 'drive') {
        if (r[key]) links[key] = link;
      } else if (key.startsWith('channelMessages/')) {
        const [, teamId, channelId] = key.split('/');
        if (!r.channelMessages || !teamId || !channelId) continue;
        if (!walk.chanTeams.includes(teamId) || walk.chans.includes(`${teamId}/${channelId}`))
          links[key] = link;
      }
    }
    Object.assign(links, walk.links);
    const win = walk.win ?? cursor.win;
    const meId = walk.meId ?? cursor.meId;
    return {
      deltaLinks: links,
      ...(meId ? { meId } : {}),
      ...(win ? { calendarWindow: win } : {}),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Walking one resource

  private deltaKey(task: Task): string {
    return task.kind === 'messages'
      ? `channelMessages/${task.teamId}/${task.channelId}`
      : task.kind;
  }

  private label(task: Task): string {
    switch (task.kind) {
      case 'channels':
        return `channels of team ${task.teamId}`;
      case 'messages':
        return `channel messages ${task.teamId}/${task.channelId}`;
      default:
        return task.kind;
    }
  }

  private startTask(walk: Walk, task: Task, cursor: Cursor): void {
    const cfg = this.ctx.config;
    const now = this.ctx.clock.now();
    const prior = cursor.deltaLinks[this.deltaKey(task)];
    let link: string;
    let usedPrior = false;
    switch (task.kind) {
      case 'calendar': {
        const win = cursor.win;
        const age = win ? now.getTime() - new Date(win.createdAt).getTime() : Infinity;
        const horizon = win ? new Date(win.end).getTime() - now.getTime() : 0;
        // A delta link is bound to its window: re-baseline when the window gets stale.
        if (prior && win && age < 14 * 86_400_000 && horizon > 30 * 86_400_000) {
          link = prior;
          usedPrior = true;
          walk.win = win;
        } else {
          const start = new Date(now.getTime() - cfg.calendar.pastDays * 86_400_000).toISOString();
          const end = new Date(now.getTime() + cfg.calendar.futureDays * 86_400_000).toISOString();
          walk.win = { start, end, createdAt: now.toISOString() };
          link = `${this.graph}/me/calendarView/delta?${query([
            ['startDateTime', start],
            ['endDateTime', end],
          ])}`;
        }
        break;
      }
      case 'mail': {
        if (prior) {
          link = prior;
          usedPrior = true;
        } else {
          const since = new Date(now.getTime() - cfg.mail.pastDays * 86_400_000).toISOString();
          link = `${this.graph}/me/mailFolders/${enc(cfg.mail.folder)}/messages/delta?${query([
            [
              '$select',
              'id,subject,from,toRecipients,receivedDateTime,sentDateTime,lastModifiedDateTime,bodyPreview,body,conversationId,webLink,isRead,isDraft,importance,hasAttachments',
            ],
            ['$filter', `receivedDateTime ge ${since}`],
          ])}`;
        }
        break;
      }
      case 'drive':
        link = prior ?? `${this.graph}/me/drive/root/delta`;
        usedPrior = prior !== undefined;
        break;
      case 'teams':
        link = `${this.graph}/me/joinedTeams`;
        break;
      case 'channels':
        link = `${this.graph}/teams/${enc(task.teamId ?? '')}/channels`;
        break;
      case 'messages':
        link =
          prior ??
          `${this.graph}/teams/${enc(task.teamId ?? '')}/channels/${enc(task.channelId ?? '')}/messages/delta`;
        usedPrior = prior !== undefined;
        break;
    }
    walk.cur = { task, link, count: 0, usedPrior };
  }

  private headersFor(task: Task): Record<string, string> {
    if (task.kind === 'calendar') return { prefer: 'outlook.timezone="UTC", odata.maxpagesize=50' };
    if (task.kind === 'mail')
      return { prefer: 'outlook.body-content-type="text", odata.maxpagesize=100' };
    return {};
  }

  private skip(
    walk: Walk,
    task: Task,
    out: { warnings: string[] },
    reason: string,
    denied: boolean,
    blockedTypes: string[],
  ): void {
    const label = `${this.label(task)}: ${reason}`;
    out.warnings.push(`Skipped ${label}`);
    walk.skipped++;
    walk.skippedLabels.push(label);
    if (denied) walk.denied++;
    for (const t of blockedTypes) if (!walk.blocked.includes(t)) walk.blocked.push(t);
    walk.cur = undefined;
  }

  private async step(
    walk: Walk,
    cursor: Cursor,
    out: { items: RawItem[]; deletions: RawDeletion[]; warnings: string[] },
    signal?: AbortSignal,
  ): Promise<void> {
    const cur = walk.cur;
    if (!cur) return;
    const task = cur.task;
    const blockedTypes = blockedTypesFor(task);
    const res = await this.http.request(cur.link, {
      headers: this.headersFor(task),
      ...(signal ? { signal } : {}),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as GraphErrorBody;
      const code = body.error?.code ?? '';
      const message = body.error?.message ?? '';
      // Expired/invalid delta token: start that resource over once.
      if ((res.status === 410 || res.status === 400) && cur.usedPrior) {
        out.warnings.push(
          `Delta token for ${this.label(task)} was rejected (HTTP ${res.status}); restarting`,
        );
        const fresh: Cursor = { ...cursor, deltaLinks: { ...cursor.deltaLinks }, win: undefined };
        delete fresh.deltaLinks[this.deltaKey(task)];
        this.startTask(walk, task, fresh);
        return;
      }
      if (task.kind === 'messages' && !cur.fallback && [400, 404, 405, 501].includes(res.status)) {
        // Delta not offered for this channel: fall back to a plain listing (+ replies).
        walk.cur = {
          task,
          link: `${this.graph}/teams/${enc(task.teamId ?? '')}/channels/${enc(task.channelId ?? '')}/messages?$top=50`,
          count: 0,
          usedPrior: false,
          fallback: true,
        };
        return;
      }
      const denied = res.status === 403 && isGraphDeniedText(`${code} ${message}`);
      const hint = denied ? ' (permission not granted; tenant admin consent may be required)' : '';
      this.skip(
        walk,
        task,
        out,
        `HTTP ${res.status} ${code}${hint}`.trim(),
        denied || res.status === 403,
        blockedTypes,
      );
      return;
    }

    const page = (await res.json()) as {
      value?: GraphItem[];
      '@odata.nextLink'?: string;
      '@odata.deltaLink'?: string;
    };
    for (const item of page.value ?? []) this.emit(walk, cur, task, item, out);

    const next = page['@odata.nextLink'];
    if (next) {
      cur.link = next;
      return;
    }
    if (cur.fallback && task.kind === 'messages') {
      // Replies of the listed top-level messages, one request per message.
      const ids = cur.replyQueue ?? [];
      if (ids.length > 0) {
        const id = ids.shift() as string;
        cur.link = `${this.graph}/teams/${enc(task.teamId ?? '')}/channels/${enc(task.channelId ?? '')}/messages/${enc(id)}/replies`;
        cur.replyQueue = ids;
        return;
      }
    }
    this.completeTask(walk, cur, task, page['@odata.deltaLink']);
  }

  private completeTask(
    walk: Walk,
    cur: NonNullable<Walk['cur']>,
    task: Task,
    deltaLink: string | undefined,
  ): void {
    walk.ok++;
    switch (task.kind) {
      case 'calendar':
      case 'mail':
      case 'drive': {
        if (deltaLink) walk.links[task.kind] = deltaLink;
        const type = { calendar: 'graph.event', mail: 'graph.message', drive: 'graph.driveItem' }[
          task.kind
        ];
        if (!cur.usedPrior && !walk.blocked.includes(type)) walk.complete.push(type);
        break;
      }
      case 'teams':
        walk.teamsListed = true;
        walk.complete.push('graph.team');
        break;
      case 'channels':
        if (task.teamId) walk.chanTeams.push(task.teamId);
        break;
      case 'messages':
        if (deltaLink) walk.links[this.deltaKey(task)] = deltaLink;
        break;
    }
    walk.cur = undefined;
  }

  private emit(
    walk: Walk,
    cur: NonNullable<Walk['cur']>,
    task: Task,
    item: GraphItem,
    out: { items: RawItem[]; deletions: RawDeletion[]; warnings: string[] },
  ): void {
    const id = typeof item.id === 'string' ? item.id : undefined;
    if (!id) return;
    const removed = '@removed' in item;
    switch (task.kind) {
      case 'calendar':
        if (removed) out.deletions.push({ sourceType: 'graph.event', externalId: id });
        else
          out.items.push({
            sourceType: 'graph.event',
            externalId: id,
            payload: item,
            ...updated(item),
          });
        break;
      case 'mail':
        if (removed) {
          out.deletions.push({ sourceType: 'graph.message', externalId: id });
        } else if (!cur.usedPrior && cur.count >= this.ctx.config.mail.maxItems) {
          this.capped(walk, 'graph.message', 'mail', out);
        } else {
          cur.count++;
          out.items.push({
            sourceType: 'graph.message',
            externalId: id,
            payload: item,
            ...updated(item),
          });
        }
        break;
      case 'drive':
        if (removed || item['deleted']) {
          out.deletions.push({ sourceType: 'graph.driveItem', externalId: id });
        } else if (!cur.usedPrior && cur.count >= this.ctx.config.drive.maxItems) {
          this.capped(walk, 'graph.driveItem', 'drive', out);
        } else {
          cur.count++;
          out.items.push({
            sourceType: 'graph.driveItem',
            externalId: id,
            payload: stripDownloadUrls(item),
            ...updated(item),
          });
        }
        break;
      case 'teams':
        out.items.push({
          sourceType: 'graph.team',
          externalId: id,
          payload: item,
          ...updated(item),
        });
        walk.queue.push({ kind: 'channels', teamId: id });
        break;
      case 'channels': {
        const teamId = task.teamId ?? '';
        out.items.push({
          sourceType: 'graph.channel',
          externalId: `${teamId}/${id}`,
          payload: { ...item, _context: { teamId } },
          ...updated(item),
        });
        walk.chans.push(`${teamId}/${id}`);
        if (this.ctx.config.resources.channelMessages)
          walk.queue.push({ kind: 'messages', teamId, channelId: id });
        break;
      }
      case 'messages': {
        const teamId = task.teamId ?? '';
        const channelId = task.channelId ?? '';
        const externalId = `${teamId}/${channelId}/${id}`;
        if (removed || item['deletedDateTime']) {
          out.deletions.push({ sourceType: 'graph.channelMessage', externalId });
          break;
        }
        out.items.push({
          sourceType: 'graph.channelMessage',
          externalId,
          payload: {
            ...item,
            _context: { teamId, channelId, ...(walk.meId ? { selfUserId: walk.meId } : {}) },
          },
          ...updated(item),
        });
        if (cur.fallback && !item['replyToId']) cur.replyQueue = [...(cur.replyQueue ?? []), id];
        break;
      }
    }
  }

  private capped(walk: Walk, type: string, label: string, out: { warnings: string[] }): void {
    if (walk.blocked.includes(type)) return;
    walk.blocked.push(type);
    out.warnings.push(
      `${label}: initial sync capped at maxItems; older items are not stored (raise ${label}.maxItems or narrow the window)`,
    );
    walk.skippedLabels.push(`${label}: capped at maxItems`);
  }
}

function blockedTypesFor(task: Task): string[] {
  switch (task.kind) {
    case 'calendar':
      return ['graph.event'];
    case 'mail':
      return ['graph.message'];
    case 'drive':
      return ['graph.driveItem'];
    case 'teams':
      return ['graph.team', 'graph.channel'];
    case 'channels':
      return ['graph.channel'];
    case 'messages':
      return [];
  }
}

function updated(item: GraphItem): { sourceUpdatedAt?: string } {
  const v = item['lastModifiedDateTime'] ?? item['createdDateTime'];
  return typeof v === 'string' ? { sourceUpdatedAt: v } : {};
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), {
      once: true,
    });
    promise.then(resolve, reject);
  });
}
