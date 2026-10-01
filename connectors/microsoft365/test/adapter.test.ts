import { OAuthTokenStore, secretKey } from '@unicontext/auth';
import { AuthRequiredError } from '@unicontext/core';
import { describe, expect, it } from 'vitest';
import {
  CH_DB_GENERAL,
  CH_DB_QA,
  FakeGraph,
  fixtureValues,
  json,
  runSync,
  SELF_ID,
  setup,
  SOURCE_ID,
  TEAM_DB,
  TEAM_MISC,
  typeCount,
} from './helpers.js';

const isCalendar = (u: URL): boolean => u.pathname.endsWith('/me/calendarView/delta');
const isMessagesDelta = (u: URL): boolean => /\/channels\/.+\/messages\/delta$/.test(u.pathname);

describe('capabilities', () => {
  it('follow the enabled resources', async () => {
    const all = await setup();
    expect((await all.adapter.capabilities()).sort()).toEqual(
      ['calendar', 'courses', 'files', 'materials', 'messages'].sort(),
    );
    const some = await setup({
      config: { resources: { mail: false, drive: false, channelMessages: true } },
    });
    expect((await some.adapter.capabilities()).sort()).toEqual(
      ['announcements', 'calendar', 'courses', 'messages'].sort(),
    );
  });
});

describe('initial sync', () => {
  it('walks every resource, pages with nextLink and stores the delta links', async () => {
    const graph = new FakeGraph();
    graph.calendar = {
      pages: [fixtureValues('events.json').slice(0, 2), fixtureValues('events.json').slice(2)],
    };
    const { adapter } = await setup({ graph });
    const run = await runSync(adapter, { mode: 'initial' });

    expect(typeCount(run.items, 'graph.event')).toBe(3);
    expect(typeCount(run.items, 'graph.message')).toBe(3);
    expect(typeCount(run.items, 'graph.driveItem')).toBe(5);
    expect(typeCount(run.items, 'graph.team')).toBe(2);
    expect(typeCount(run.items, 'graph.channel')).toBe(3);
    expect(typeCount(run.items, 'graph.channelMessage')).toBe(0);
    expect(run.deletions).toEqual([]);

    // the second calendar page was fetched through @odata.nextLink
    const calendarCalls = graph.callsTo(isCalendar);
    expect(calendarCalls).toHaveLength(2);
    expect(calendarCalls[0]?.searchParams.get('startDateTime')).toBe('2026-09-01T00:00:00.000Z');
    expect(calendarCalls[0]?.searchParams.get('endDateTime')).toBe('2027-03-30T00:00:00.000Z');
    expect(calendarCalls[1]?.searchParams.get('$skiptoken')).toBe('1');

    // Prefer headers
    const calHeaders = graph.calls.find((c) => isCalendar(c.url))?.headers;
    expect(calHeaders?.get('prefer')).toContain('outlook.timezone="UTC"');
    const mailHeaders = graph.calls.find((c) => /messages\/delta/.test(c.url.pathname))?.headers;
    expect(mailHeaders?.get('prefer')).toContain('outlook.body-content-type="text"');
    expect(mailHeaders?.get('authorization')).toBe('Bearer test-access-token');

    // mail delta: $select + receivedDateTime window
    const mailUrl = graph.callsTo((u) => /messages\/delta$/.test(u.pathname))[0];
    expect(mailUrl?.pathname).toBe('/v1.0/me/mailFolders/inbox/messages/delta');
    expect(mailUrl?.searchParams.get('$select')).toContain('bodyPreview');
    expect(mailUrl?.searchParams.get('$filter')).toBe(
      'receivedDateTime ge 2026-07-03T00:00:00.000Z',
    );

    // cursor
    const extra = run.cursor?.extra as { deltaLinks: Record<string, string>; meId?: string };
    expect(Object.keys(extra.deltaLinks).sort()).toEqual(['calendar', 'drive', 'mail']);
    expect(extra.deltaLinks['calendar']).toContain('$deltatoken=');
    expect(run.cursor?.extra).toHaveProperty('calendarWindow');
    expect(JSON.parse(JSON.stringify(run.cursor))).toEqual(run.cursor);

    // full listings declare completeness
    expect([...run.complete].sort()).toEqual(
      ['graph.channel', 'graph.driveItem', 'graph.event', 'graph.message', 'graph.team'].sort(),
    );
    expect(run.warnings).toEqual([]);
  });

  it('drops pre-authenticated download URLs from drive payloads', async () => {
    const { adapter } = await setup();
    const run = await runSync(adapter, { mode: 'initial' });
    const drive = run.items.filter((i) => i.sourceType === 'graph.driveItem');
    expect(JSON.stringify(drive)).not.toContain('downloadUrl');
    expect(JSON.stringify(drive)).not.toContain('SECRET-TEMP-AUTH');
    const all = JSON.stringify(run.items);
    expect(all).not.toContain('test-access-token');
    expect(all).not.toContain('test-refresh-token');
  });

  it('splits long runs into pages with hasMore/nextPageToken and a stateless cursor', async () => {
    const graph = new FakeGraph();
    const many = Array.from({ length: 250 }, (_, i) => ({
      ...(fixtureValues('mail.json')[0] as object),
      id: `BULK-${i}`,
    }));
    graph.mail = { pages: [many.slice(0, 210), many.slice(210)] };
    const { adapter } = await setup({ graph, config: { mail: { maxItems: 5000 } } });
    const run = await runSync(adapter, { mode: 'initial' });
    expect(run.pages).toBeGreaterThan(1);
    expect(run.results[0]?.hasMore).toBe(true);
    expect(run.results[0]?.nextPageToken).toBeTruthy();
    expect(run.results[0]?.cursor).toBeUndefined();
    expect(typeCount(run.items, 'graph.message')).toBe(250);
    expect(new Set(run.items.map((i) => `${i.sourceType}/${i.externalId}`)).size).toBe(
      run.items.length,
    );
    expect(Object.keys((run.cursor?.extra as { deltaLinks: object }).deltaLinks)).toContain('mail');
  });

  it('caps mail on initial sync but still reaches the delta link', async () => {
    const { adapter } = await setup({ config: { mail: { maxItems: 2 } } });
    const run = await runSync(adapter, { mode: 'initial' });
    expect(typeCount(run.items, 'graph.message')).toBe(2);
    expect(run.warnings.join('\n')).toContain('capped at maxItems');
    expect(run.complete.has('graph.message')).toBe(false);
    expect(Object.keys((run.cursor?.extra as { deltaLinks: object }).deltaLinks)).toContain('mail');
  });

  it('honours the resources toggles and the capability filter', async () => {
    const { adapter, graph } = await setup({
      config: { resources: { calendar: false, mail: false, drive: false } },
    });
    const run = await runSync(adapter, { mode: 'initial' });
    expect(
      run.items.map((i) => i.sourceType).every((t) => t === 'graph.team' || t === 'graph.channel'),
    ).toBe(true);
    expect(graph.callsTo(isCalendar)).toHaveLength(0);

    const s2 = await setup();
    const only = await runSync(s2.adapter, { mode: 'initial', capabilities: ['calendar'] });
    expect([...new Set(only.items.map((i) => i.sourceType))]).toEqual(['graph.event']);
  });

  it('reports a warning when nothing is enabled', async () => {
    const { adapter } = await setup({
      config: { resources: { calendar: false, mail: false, drive: false, teams: false } },
    });
    const run = await runSync(adapter, { mode: 'initial' });
    expect(run.items).toEqual([]);
    expect(run.warnings.join()).toContain('no Microsoft 365 resources enabled');
  });
});

describe('incremental sync', () => {
  it('uses the stored delta links and turns @removed / deleted into deletions', async () => {
    const { adapter, graph } = await setup();
    const first = await runSync(adapter, { mode: 'initial' });
    const stored = first.cursor?.extra as { deltaLinks: Record<string, string> };
    graph.calls = [];

    const second = await runSync(adapter, { mode: 'incremental', cursor: first.cursor ?? {} });
    // delta requests go to the stored links
    const calendarCall = graph.callsTo(isCalendar);
    expect(calendarCall).toHaveLength(1);
    expect(calendarCall[0]?.toString()).toBe(stored.deltaLinks['calendar']);
    expect(graph.callsTo((u) => u.pathname.endsWith('/me/drive/root/delta'))[0]?.toString()).toBe(
      stored.deltaLinks['drive'],
    );

    expect(second.deletions).toEqual(
      expect.arrayContaining([
        { sourceType: 'graph.event', externalId: 'EVT-HOLIDAY-1012' },
        { sourceType: 'graph.message', externalId: 'MSG-0001' },
        { sourceType: 'graph.driveItem', externalId: 'ITEM-DOCX' },
      ]),
    );
    expect(second.deletions).toHaveLength(3);
    // changed items come through, with their update time
    const event = second.items.find((i) => i.sourceType === 'graph.event');
    expect(event?.externalId).toBe('EVT-DB-1005');
    expect(event?.sourceUpdatedAt).toBe('2026-10-01T05:00:00.0000000Z');
    expect(typeCount(second.items, 'graph.message')).toBe(1);

    // delta resources no longer claim completeness; the team list still does
    expect([...second.complete].sort()).toEqual(['graph.channel', 'graph.team']);
    // new delta links replaced the old ones
    const next = second.cursor?.extra as { deltaLinks: Record<string, string> };
    expect(next.deltaLinks['calendar']).toContain('calendar-next');
  });

  it('mode "full" ignores stored delta links', async () => {
    const { adapter, graph } = await setup();
    const first = await runSync(adapter, { mode: 'initial' });
    graph.calls = [];
    const full = await runSync(adapter, { mode: 'full', cursor: first.cursor ?? {} });
    expect(graph.callsTo(isCalendar)[0]?.searchParams.has('$deltatoken')).toBe(false);
    expect(graph.callsTo(isCalendar)[0]?.searchParams.has('startDateTime')).toBe(true);
    expect(typeCount(full.items, 'graph.event')).toBe(3);
    expect(full.complete.has('graph.event')).toBe(true);
  });

  it('restarts a resource whose delta token expired (HTTP 410)', async () => {
    const { adapter, graph } = await setup();
    const first = await runSync(adapter, { mode: 'initial' });
    graph.override(
      (u) => isCalendar(u) && u.searchParams.has('$deltatoken'),
      () => json({ error: { code: 'syncStateNotFound', message: 'gone' } }, 410),
      1,
    );
    const second = await runSync(adapter, { mode: 'incremental', cursor: first.cursor ?? {} });
    expect(second.warnings.join()).toContain('restarting');
    expect(typeCount(second.items, 'graph.event')).toBe(3);
    expect(second.complete.has('graph.event')).toBe(true);
  });

  it('re-baselines the calendar window when it is about to run out', async () => {
    const { adapter, graph, clock } = await setup();
    const first = await runSync(adapter, { mode: 'initial' });
    await clock.sleep(160 * 86_400_000);
    graph.calls = [];
    await runSync(adapter, { mode: 'incremental', cursor: first.cursor ?? {} });
    expect(graph.callsTo(isCalendar)[0]?.searchParams.has('startDateTime')).toBe(true);
  });
});

describe('rate limiting', () => {
  it('waits for Retry-After on 429 and then succeeds', async () => {
    const { adapter, graph, clock } = await setup({
      config: { resources: { calendar: false, mail: false, drive: false } },
    });
    graph.override(
      (u) => u.pathname.endsWith('/me/joinedTeams'),
      () => json({ error: { code: 'TooManyRequests' } }, 429, { 'retry-after': '7' }),
      1,
    );
    const run = await runSync(adapter, { mode: 'initial' });
    expect(typeCount(run.items, 'graph.team')).toBe(2);
    expect(clock.sleeps).toContain(7000);
    expect(graph.callsTo((u) => u.pathname.endsWith('/me/joinedTeams'))).toHaveLength(2);
  });
});

describe('Teams channel messages', () => {
  it('requests ChannelMessage.Read.All only when enabled', async () => {
    const off = await setup();
    const on = await setup({ config: { resources: { channelMessages: true } } });
    const { resolveScopes } = await import('../src/index.js');
    expect(resolveScopes(off.instance.context.config)).not.toContain('ChannelMessage.Read.All');
    expect(resolveScopes(on.instance.context.config)).toContain('ChannelMessage.Read.All');
  });

  it('walks channel delta, records the own user id and per-channel delta links', async () => {
    const { adapter, graph } = await setup({ config: { resources: { channelMessages: true } } });
    const run = await runSync(adapter, { mode: 'initial' });
    const messages = run.items.filter((i) => i.sourceType === 'graph.channelMessage');
    expect(messages).toHaveLength(5);
    expect(messages[0]?.externalId).toBe(`${TEAM_DB}/${CH_DB_GENERAL}/1759300000001`);
    expect(messages[0]?.payload).toMatchObject({
      _context: { teamId: TEAM_DB, channelId: CH_DB_GENERAL, selfUserId: SELF_ID },
    });
    const channels = run.items.filter((i) => i.sourceType === 'graph.channel');
    expect(channels.map((c) => c.payload)).toContainEqual(
      expect.objectContaining({ _context: { teamId: TEAM_MISC } }),
    );
    const extra = run.cursor?.extra as { deltaLinks: Record<string, string>; meId: string };
    expect(extra.meId).toBe(SELF_ID);
    expect(Object.keys(extra.deltaLinks)).toContain(`channelMessages/${TEAM_DB}/${CH_DB_GENERAL}`);
    expect(Object.keys(extra.deltaLinks)).toContain(`channelMessages/${TEAM_DB}/${CH_DB_QA}`);

    graph.calls = [];
    const second = await runSync(adapter, { mode: 'incremental', cursor: run.cursor ?? {} });
    expect(graph.callsTo((u) => u.pathname === '/v1.0/me')).toHaveLength(0);
    const deleted = second.deletions.find((d) => d.sourceType === 'graph.channelMessage');
    expect(deleted?.externalId).toBe(`${TEAM_DB}/${CH_DB_GENERAL}/1759300000002`);
    expect(second.items.filter((i) => i.sourceType === 'graph.channelMessage')).toHaveLength(1);
    expect(graph.callsTo(isMessagesDelta).length).toBe(3);
  });

  it('falls back to /messages + replies when delta is not available', async () => {
    const graph = new FakeGraph();
    graph.override(
      (u) => isMessagesDelta(u) && u.pathname.includes(encodeURIComponent(CH_DB_GENERAL)),
      () => json({ error: { code: 'BadRequest', message: 'delta not supported' } }, 400),
    );
    const { adapter } = await setup({ graph, config: { resources: { channelMessages: true } } });
    const run = await runSync(adapter, { mode: 'initial' });
    const ids = run.items
      .filter((i) => i.sourceType === 'graph.channelMessage')
      .map((i) => i.externalId.split('/').pop())
      .sort();
    // top-level posts (1, 2, 4, 5) + the reply (3) fetched via /replies
    expect(ids).toEqual([
      '1759300000001',
      '1759300000002',
      '1759300000003',
      '1759300000004',
      '1759300000005',
    ]);
    const extra = run.cursor?.extra as { deltaLinks: Record<string, string> };
    expect(Object.keys(extra.deltaLinks)).not.toContain(
      `channelMessages/${TEAM_DB}/${CH_DB_GENERAL}`,
    );
  });

  it('a 403 on channel messages is a warning, not a failure', async () => {
    const graph = new FakeGraph();
    graph.override(
      (u) => isMessagesDelta(u),
      () =>
        json(
          {
            error: {
              code: 'Forbidden',
              message: 'Missing scope permissions on the request. ChannelMessage.Read.All',
            },
          },
          403,
        ),
    );
    const { adapter } = await setup({ graph, config: { resources: { channelMessages: true } } });
    const run = await runSync(adapter, { mode: 'initial' });
    expect(typeCount(run.items, 'graph.event')).toBe(3);
    expect(typeCount(run.items, 'graph.team')).toBe(2);
    expect(typeCount(run.items, 'graph.channelMessage')).toBe(0);
    expect(run.warnings.length).toBe(3);
    expect(run.warnings[0]).toContain('Skipped channel messages');
    expect(run.warnings[0]).toContain('403');
    const health = await adapter.health();
    expect(health.state).toBe('degraded');
    expect(health.message).toContain('channel messages');
    // teams/channels are still complete
    expect(run.complete.has('graph.channel')).toBe(true);
  });
});

describe('failures', () => {
  it('a 403 on one core resource skips it and keeps going', async () => {
    const graph = new FakeGraph();
    graph.override(
      (u) => u.pathname.endsWith('/me/drive/root/delta'),
      () =>
        json(
          JSON.parse(
            JSON.stringify({
              error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' },
            }),
          ),
          403,
        ),
    );
    const { adapter } = await setup({ graph });
    const run = await runSync(adapter, { mode: 'initial' });
    expect(typeCount(run.items, 'graph.driveItem')).toBe(0);
    expect(typeCount(run.items, 'graph.event')).toBe(3);
    expect(run.warnings.join()).toContain('Skipped drive');
    expect(run.complete.has('graph.driveItem')).toBe(false);
    expect((await adapter.health()).state).toBe('degraded');
  });

  it('keeps the previous delta link of a skipped resource', async () => {
    const graph = new FakeGraph();
    const { adapter } = await setup({ graph });
    const first = await runSync(adapter, { mode: 'initial' });
    graph.override(
      (u) => isCalendar(u),
      () => json({ error: { code: 'ErrorAccessDenied', message: 'denied' } }, 403),
    );
    const second = await runSync(adapter, { mode: 'incremental', cursor: first.cursor ?? {} });
    const before = (first.cursor?.extra as { deltaLinks: Record<string, string> }).deltaLinks;
    const after = (second.cursor?.extra as { deltaLinks: Record<string, string> }).deltaLinks;
    expect(after['calendar']).toBe(before['calendar']);
    expect(after['mail']).toContain('mail-next');
  });

  it('403 everywhere means consent is missing: AuthRequiredError with the admin-consent message', async () => {
    const graph = new FakeGraph();
    graph.override(
      (u) => u.pathname !== '/v1.0/me',
      () =>
        json(
          {
            error: {
              code: 'Authorization_RequestDenied',
              message: 'Insufficient privileges to complete the operation.',
            },
          },
          403,
        ),
    );
    const { adapter } = await setup({ graph });
    const err = await runSync(adapter, { mode: 'initial' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthRequiredError);
    expect((err as Error).message).toContain('管理者');
    expect((err as Error).message).toContain('admin consent');
    expect((await adapter.health()).state).toBe('auth_required');
  });

  it('a Graph 401 surfaces as AuthRequiredError', async () => {
    const graph = new FakeGraph();
    graph.validTokens.clear();
    const { adapter } = await setup({ graph });
    await expect(runSync(adapter, { mode: 'initial' })).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('rejects a corrupt page token', async () => {
    const { adapter } = await setup();
    await expect(adapter.sync({ mode: 'initial', pageToken: 'nonsense' })).rejects.toThrow(
      /page token/,
    );
  });
});

describe('authenticate / health', () => {
  it('is authenticated when tokens exist, reporting the account from the id token', async () => {
    const { adapter } = await setup();
    const res = await adapter.authenticate();
    expect(res.status).toBe('authenticated');
    expect(res.account).toBe('test.hanako.26@example.ac.jp');
    expect(JSON.stringify(res)).not.toContain('test-access-token');
    expect((await adapter.health()).state).toBe('healthy');
  });

  it('is auth_required without tokens, without network access', async () => {
    const { adapter, graph } = await setup({ seed: false });
    const res = await adapter.authenticate();
    expect(res.status).toBe('auth_required');
    expect(graph.calls).toHaveLength(0);
    expect((await adapter.health()).state).toBe('auth_required');
  });

  it('is auth_required without a clientId', async () => {
    const { adapter } = await setup({ config: { clientId: undefined } });
    const res = await adapter.authenticate();
    expect(res.status).toBe('auth_required');
    expect(res.message).toContain('clientId');
  });

  it('refreshes an expired access token with the refresh token', async () => {
    const { adapter, graph, secrets } = await setup({ seed: { expired: true } });
    const res = await adapter.authenticate();
    expect(res.status).toBe('authenticated');
    expect(graph.tokenCalls).toHaveLength(1);
    expect(graph.tokenCalls[0]?.get('grant_type')).toBe('refresh_token');
    expect(graph.tokenCalls[0]?.get('refresh_token')).toBe('test-refresh-token');
    expect(graph.tokenCalls[0]?.get('client_id')).toBe('test-client-id');
    // the refreshed tokens went to the secret store, and are used for Graph calls
    expect(await secrets.get(secretKey(SOURCE_ID, 'oauth'))).toContain('refreshed-access-token');
    const run = await runSync(adapter, { mode: 'initial' });
    expect(
      graph.calls.every((c) => c.headers.get('authorization') === 'Bearer refreshed-access-token'),
    ).toBe(true);
    expect(run.items.length).toBeGreaterThan(0);
  });

  it('is auth_required when the refresh token is gone', async () => {
    const { adapter } = await setup({ seed: { expired: true, refreshToken: null } });
    expect((await adapter.authenticate()).status).toBe('auth_required');
  });

  it('consent blocked while refreshing (AADSTS65001) → auth_required with the admin-consent message', async () => {
    const graph = new FakeGraph();
    graph.tokenHandler = () =>
      json(
        {
          error: 'invalid_grant',
          error_description:
            'AADSTS65001: The user or administrator has not consented to use the application with ID ... Send an interactive authorization request for this user and resource.',
        },
        400,
      );
    const { adapter } = await setup({ graph, seed: { expired: true } });
    const res = await adapter.authenticate();
    expect(res.status).toBe('auth_required');
    expect(res.message).toContain('テナント管理者の同意');
    expect(res.message).toContain('Outlook on the web');
    const health = await adapter.health();
    expect(health.state).toBe('auth_required');
    expect(health.message).toContain('Teams web');
    // sync() reports the same thing
    const err = await runSync(adapter, { mode: 'initial' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthRequiredError);
    expect((err as Error).message).toContain('admin consent');
  });

  it('other refresh failures are auth_required with a plain sign-in message', async () => {
    const graph = new FakeGraph();
    graph.tokenHandler = () =>
      json(
        {
          error: 'invalid_grant',
          error_description: 'AADSTS700082: The refresh token has expired due to inactivity.',
        },
        400,
      );
    const { adapter } = await setup({ graph, seed: { expired: true } });
    const res = await adapter.authenticate();
    expect(res.status).toBe('auth_required');
    expect(res.message).not.toContain('管理者の同意');
  });

  it('offline during refresh keeps credentials and defers to sync()', async () => {
    const graph = new FakeGraph();
    const { adapter } = await setup({ graph, seed: { expired: true } });
    graph.tokenHandler = () => {
      throw new TypeError('fetch failed');
    };
    const res = await adapter.authenticate();
    expect(res.status).toBe('authenticated');
    expect(res.message).toContain('offline');
  });

  it('token store is keyed by source id', async () => {
    const { secrets, clock } = await setup();
    const store = new OAuthTokenStore(secrets, secretKey(SOURCE_ID, 'oauth'), clock);
    expect((await store.load())?.accessToken).toBe('test-access-token');
  });
});
