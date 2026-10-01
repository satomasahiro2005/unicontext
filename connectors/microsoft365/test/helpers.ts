import { readFileSync } from 'node:fs';
import { MemorySecretStore, OAuthTokenStore, secretKey, type TokenSet } from '@unicontext/auth';
import {
  instantiateConnector,
  RateLimiter,
  type RawDeletion,
  type RawItem,
  type SyncInput,
  type SyncCursor,
  type SyncResult,
} from '@unicontext/connector-sdk';
import { type Clock, type FetchLike, silentLogger, type UniversityProfile } from '@unicontext/core';
import connector, { Microsoft365Adapter } from '../src/index.js';

export const SOURCE_ID = 'm365';
export const START = '2026-10-01T00:00:00.000Z';

export const TEAM_DB = '11111111-aaaa-4bbb-8ccc-000000000001';
export const TEAM_MISC = '11111111-aaaa-4bbb-8ccc-000000000002';
export const CH_DB_GENERAL = '19:db0001generalabcdef@thread.tacv2';
export const CH_DB_QA = '19:db0002qaabcdef@thread.tacv2';
export const CH_MISC_GENERAL = '19:ms0001generalabcdef@thread.tacv2';
export const SELF_ID = 'aaaaaaaa-0000-4000-8000-0000000000aa';

export function fixture<T = { value: unknown[] }>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;
}
export const fixtureValues = (name: string): unknown[] => fixture<{ value: unknown[] }>(name).value;

/** Clock whose sleep() advances time instantly (so Retry-After waits are visible but free). */
export class AutoClock implements Clock {
  private t: number;
  readonly sleeps: number[] = [];
  private nextId = 1;
  constructor(start: string = START) {
    this.t = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  setTimeout(): ReturnType<Clock['setTimeout']> {
    return { id: this.nextId++ };
  }
  clearTimeout(): void {}
  sleep(ms: number): Promise<void> {
    this.t += ms;
    this.sleeps.push(ms);
    return Promise.resolve();
  }
}

export function fakeJwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc(claims)}.signature`;
}

export const ID_TOKEN = fakeJwt({
  preferred_username: 'test.hanako.26@example.ac.jp',
  tid: 'tenant',
});

export async function seedTokens(
  secrets: MemorySecretStore,
  clock: Clock,
  options: { expired?: boolean; refreshToken?: string | null } = {},
): Promise<void> {
  const store = new OAuthTokenStore(secrets, secretKey(SOURCE_ID, 'oauth'), clock);
  const offset = options.expired ? -3_600_000 : 3_600_000;
  const tokens: TokenSet = {
    accessToken: 'test-access-token',
    tokenType: 'Bearer',
    idToken: ID_TOKEN,
    scope: 'User.Read Calendars.Read',
    expiresAt: new Date(clock.now().getTime() + offset).toISOString(),
    ...(options.refreshToken === null
      ? {}
      : { refreshToken: options.refreshToken ?? 'test-refresh-token' }),
  };
  await store.save(tokens);
}

interface Override {
  match: (url: URL) => boolean;
  respond: () => Response;
  times: number;
}

interface DeltaSet {
  pages: unknown[][];
  incremental?: unknown[];
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const GRAPH = 'https://graph.microsoft.com/v1.0';

/** A tiny in-memory Microsoft Graph + token endpoint. */
export class FakeGraph {
  calls: { url: URL; headers: Headers; method: string }[] = [];
  tokenCalls: URLSearchParams[] = [];
  validTokens = new Set(['test-access-token', 'refreshed-access-token']);
  tokenHandler: (body: URLSearchParams) => Response = () =>
    json({
      access_token: 'refreshed-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'refreshed-refresh-token',
      id_token: ID_TOKEN,
      scope: 'User.Read Calendars.Read',
    });

  calendar: DeltaSet = {
    pages: [fixtureValues('events.json')],
    incremental: fixtureValues('events-incremental.json'),
  };
  mail: DeltaSet = {
    pages: [fixtureValues('mail.json')],
    incremental: fixtureValues('mail-incremental.json'),
  };
  drive: DeltaSet = {
    pages: [fixtureValues('drive.json')],
    incremental: fixtureValues('drive-incremental.json'),
  };
  teams: unknown[] = fixtureValues('teams.json');
  channels: Record<string, unknown[]> = {
    [TEAM_DB]: fixtureValues('channels-db.json'),
    [TEAM_MISC]: fixtureValues('channels-misc.json'),
  };
  /** Delta sets by channel id. */
  messages: Record<string, DeltaSet> = {
    [CH_DB_GENERAL]: {
      pages: [fixtureValues('channel-messages.json')],
      incremental: fixtureValues('channel-messages-incremental.json'),
    },
    [CH_DB_QA]: { pages: [[]], incremental: [] },
    [CH_MISC_GENERAL]: { pages: [[]], incremental: [] },
  };
  private overrides: Override[] = [];

  fetch: FetchLike = (input, init) => Promise.resolve(this.handle(input, init));

  /** Answer matching requests with `respond()` (`times` times, default forever). */
  override(match: (url: URL) => boolean, respond: () => Response, times = Infinity): void {
    this.overrides.push({ match, respond, times });
  }

  callsTo(predicate: (url: URL) => boolean): URL[] {
    return this.calls.filter((c) => predicate(c.url)).map((c) => c.url);
  }

  private delta(path: string, set: DeltaSet, url: URL): Response {
    const q = url.searchParams;
    const base = `${url.origin}${url.pathname}`;
    if (q.has('$deltatoken'))
      return json({
        value: set.incremental ?? [],
        '@odata.deltaLink': `${base}?$deltatoken=${encodeURIComponent(`${path}-next`)}`,
      });
    const idx = Number(q.get('$skiptoken') ?? 0);
    const page = set.pages[idx] ?? [];
    const last = idx >= set.pages.length - 1;
    return json({
      value: page,
      ...(last
        ? { '@odata.deltaLink': `${base}?$deltatoken=${encodeURIComponent(`${path}-1`)}` }
        : { '@odata.nextLink': `${base}?$skiptoken=${idx + 1}` }),
    });
  }

  private handle(input: string, init?: RequestInit): Response {
    const url = new URL(input);
    const headers = new Headers(init?.headers);
    if (
      url.hostname === 'login.microsoftonline.com' &&
      url.pathname.endsWith('/oauth2/v2.0/token')
    ) {
      const params = new URLSearchParams(String(init?.body ?? ''));
      this.tokenCalls.push(params);
      return this.tokenHandler(params);
    }
    this.calls.push({ url, headers, method: init?.method ?? 'GET' });
    const auth = headers.get('authorization') ?? '';
    if (!auth.startsWith('Bearer ') || !this.validTokens.has(auth.slice(7)))
      return json(
        { error: { code: 'InvalidAuthenticationToken', message: 'Access token is empty.' } },
        401,
      );
    for (const o of this.overrides) {
      if (o.times > 0 && o.match(url)) {
        o.times--;
        return o.respond();
      }
    }
    const path = url.pathname.replace(/^\/v1\.0/, '');
    if (path === '/me') return json(fixture('me.json'));
    if (path === '/me/calendarView/delta') return this.delta('calendar', this.calendar, url);
    if (/^\/me\/mailFolders\/[^/]+\/messages\/delta$/.test(path))
      return this.delta('mail', this.mail, url);
    if (path === '/me/drive/root/delta') return this.delta('drive', this.drive, url);
    if (path === '/me/joinedTeams') return json({ value: this.teams });
    let m = /^\/teams\/([^/]+)\/channels$/.exec(path);
    if (m) return json({ value: this.channels[decodeURIComponent(m[1] ?? '')] ?? [] });
    m = /^\/teams\/([^/]+)\/channels\/([^/]+)\/messages\/delta$/.exec(path);
    if (m) {
      const cid = decodeURIComponent(m[2] ?? '');
      const set = this.messages[cid];
      return set
        ? this.delta(`messages-${cid}`, set, url)
        : json({ error: { code: 'NotFound' } }, 404);
    }
    m = /^\/teams\/([^/]+)\/channels\/([^/]+)\/messages$/.exec(path);
    if (m)
      return json({
        value: (this.messages[decodeURIComponent(m[2] ?? '')]?.pages[0] ?? []).filter(
          (x) => !(x as { replyToId?: string }).replyToId,
        ),
      });
    m = /^\/teams\/([^/]+)\/channels\/([^/]+)\/messages\/([^/]+)\/replies$/.exec(path);
    if (m)
      return json({ value: m[3] === '1759300000002' ? fixtureValues('channel-replies.json') : [] });
    return json({ error: { code: 'NotFound', message: `no route for ${path}` } }, 404);
  }
}

export interface SetupOptions {
  config?: Record<string, unknown>;
  graph?: FakeGraph;
  profile?: UniversityProfile;
  seed?: false | { expired?: boolean; refreshToken?: string | null };
  clock?: AutoClock;
}

export async function setup(options: SetupOptions = {}) {
  const graph = options.graph ?? new FakeGraph();
  const clock = options.clock ?? new AutoClock();
  const secrets = new MemorySecretStore();
  if (options.seed !== false) await seedTokens(secrets, clock, options.seed ?? {});
  const rateLimiter = new RateLimiter({
    capacity: 1000,
    refillPerSecond: 1000,
    maxRetries: 3,
    baseDelayMs: 1,
    jitter: 'none',
    clock,
  });
  const instance = instantiateConnector(connector, {
    sourceId: SOURCE_ID,
    config: { clientId: 'test-client-id', ...(options.config ?? {}) },
    secrets,
    clock,
    rateLimiter,
    logger: silentLogger,
    fetch: graph.fetch,
    ...(options.profile ? { profile: options.profile } : {}),
  });
  return {
    graph,
    clock,
    secrets,
    instance,
    adapter: instance.adapter as Microsoft365Adapter,
    normalizer: instance.normalizer,
  };
}

export interface RunResult {
  items: RawItem[];
  deletions: RawDeletion[];
  warnings: string[];
  pages: number;
  cursor: SyncCursor | undefined;
  complete: Set<string>;
  results: SyncResult[];
}

export async function runSync(
  adapter: { sync(input: SyncInput): Promise<SyncResult> },
  input: Omit<SyncInput, 'pageToken'>,
): Promise<RunResult> {
  const out: RunResult = {
    items: [],
    deletions: [],
    warnings: [],
    pages: 0,
    cursor: undefined,
    complete: new Set(),
    results: [],
  };
  let pageToken: string | undefined;
  do {
    const res = await adapter.sync({ ...input, ...(pageToken ? { pageToken } : {}) });
    out.pages++;
    out.results.push(res);
    out.items.push(...res.items);
    out.deletions.push(...(res.deletions ?? []));
    out.warnings.push(...(res.warnings ?? []));
    for (const t of res.complete?.sourceTypes ?? []) out.complete.add(t);
    if (res.cursor) out.cursor = res.cursor;
    pageToken = res.hasMore ? res.nextPageToken : undefined;
    if (out.pages > 100) throw new Error('too many pages');
  } while (pageToken);
  return out;
}

export const GRAPH_BASE = GRAPH;
export const typeCount = (items: RawItem[], type: string): number =>
  items.filter((i) => i.sourceType === type).length;
