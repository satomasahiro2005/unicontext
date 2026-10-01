import {
  createNormalizeContext,
  evaluateProductVersion,
  type RawItem,
  type SyncResult,
} from '@unicontext/connector-sdk';
import { AuthRequiredError, OfflineError } from '@unicontext/core';
import { describe, expect, it } from 'vitest';
import {
  createLiveCampusUNormalizer,
  LiveCampusUAdapter,
  metadata,
  type NoticePayload,
  TESTED_FINGERPRINT,
} from '../src/index.js';
import {
  FakeLcuServer,
  type FakeLcuOptions,
  FakeStrategy,
  fixture,
  newClock,
  TEST_DEPLOYMENT,
  TEST_PROFILE,
  testContext,
} from './helpers.js';

function setup(
  serverOptions: Partial<FakeLcuOptions> = {},
  config: Record<string, unknown> = {},
  at?: string,
) {
  const clock = newClock(at);
  const server = new FakeLcuServer({ clock, ...serverOptions });
  const strategy = new FakeStrategy(server);
  const ctx = testContext(clock, server.fetch, config);
  const adapter = new LiveCampusUAdapter(ctx, { strategy });
  return { clock, server, strategy, ctx, adapter };
}

function byType(result: SyncResult): Record<string, RawItem[]> {
  const out: Record<string, RawItem[]> = {};
  for (const it of result.items) (out[it.sourceType] ??= []).push(it);
  return out;
}

function count(result: SyncResult): Record<string, number> {
  return Object.fromEntries(Object.entries(byType(result)).map(([k, v]) => [k, v.length]));
}

const DENIED =
  /toDoIcon|readMark|addTodo|scheduleAdd|report|submit|SC_14002B00_03|SC_07002B00|lcuLogout|importantNoticeLink|SC_14002B00_01\/rowselect|linkselect|gredeInformation|SC_10004B00|SC_15005B00/i;

describe('LiveCampusUAdapter.sync (fake LCU server)', () => {
  it('runs a full initial sync over JSON + HTML screens', async () => {
    const { server, strategy, adapter } = setup({ readRows: [46] });
    expect(adapter.deployment.baseUrl).toBe('https://lcu.example.ac.jp/lcu-web/');
    const result = await adapter.sync({ mode: 'initial' });
    expect(count(result)).toEqual({
      'lcu.warningNotice': 1,
      'lcu.course': 8,
      'lcu.assignment': 4,
      'lcu.calendarEvent': 3,
      'lcu.exam': 2,
      'lcu.attendance': 2,
      'lcu.notice': 7,
    });
    expect(result.warnings).toBeUndefined();
    expect(result.hasMore).toBe(false);
    expect(result.complete?.sourceTypes.sort()).toEqual(
      [
        'lcu.course',
        'lcu.assignment',
        'lcu.exam',
        'lcu.submissionInfo',
        'lcu.warningNotice',
        'lcu.notice',
        'lcu.attendance',
        'lcu.grade',
      ].sort(),
    );
    expect(result.productVersion).toEqual({ product: 'livecampusu', version: TESTED_FINGERPRINT });
    expect(evaluateProductVersion(metadata, result.productVersion?.version).state).toBe('healthy');
    // Strictly serial, never a denylisted request, no re-auth needed (tokens always fresh).
    expect(server.maxInflight).toBe(1);
    expect(server.paths().filter((p) => DENIED.test(p))).toEqual([]);
    expect(strategy.reauthCalls).toBe(0);
    // Only the READ notice (row 46) was opened; the unread one never.
    expect(server.openedRows).toEqual([46]);
    expect(server.paths().filter((p) => /rowSelect/.test(p))).toEqual([
      'POST SC_17001B00_01/rowSelect',
    ]);
    expect(strategy.persisted).toEqual(['S1']);
    // Credentials never end up in payloads.
    expect(JSON.stringify(result.items)).not.toMatch(/JSESSIONID|csrf-|tx-|S1\b/);
  });

  it('merges importantNotice JSON and list rows into one notice per contact', async () => {
    const { adapter } = setup({ readRows: [46] });
    const result = await adapter.sync({ mode: 'initial' });
    const notices = byType(result)['lcu.notice']?.map((i) => i.payload as NoticePayload) ?? [];
    const room = notices.find((n) => n.kind === 'roomChange');
    expect(room?.important?.contactSeq).toBe('100003');
    expect(room?.listRow?.subjectKey?.subjectCode).toBe('77401220');
    expect(room?.context.offeringKey).toBe('2026-77401220-61');
    expect(room?.detail?.body).toContain('（本文）');
    const survey = notices.find((n) => n.important?.contactSeq === '100001');
    expect(survey?.listRow?.unread).toBe(true);
    expect(survey?.detail).toBeUndefined();
    // importantNotice-only items are matched to offerings by title when unambiguous.
    const modeling = notices.find((n) => n.important?.contactSeq === '100004');
    expect(modeling?.context.offeringKey).toBe('2026-77451100-61');
  });

  it('builds courses from the timetable and getClassSubjectList', async () => {
    const { adapter } = setup();
    const result = await adapter.sync({ mode: 'initial' });
    const courses = byType(result)['lcu.course'] ?? [];
    const sec = courses.find((c) => c.externalId === '2026-77351100-61')?.payload as Record<
      string,
      unknown
    >;
    expect(sec).toMatchObject({
      title: '情報セキュリティと法制度',
      className: '1クラス',
      semesterCode: '1',
      termName: '前期',
      timetable: { room: '共通講義棟２１', slots: [{ week: 5, period: 1 }] },
    });
    const intro = courses.find((c) => c.externalId === '2026-77301020-RW')?.payload as Record<
      string,
      unknown
    >;
    expect(intro).toMatchObject({ title: 'コンピュータ入門', className: '再履修（情）１' });
    expect(intro.timetable).toBeUndefined();
  });

  it('incremental sync fetches details only for read notices whose row changed', async () => {
    const first = setup({ readRows: [46] });
    const r1 = await first.adapter.sync({ mode: 'initial' });
    expect(first.server.openedRows).toEqual([46]);
    // Same adapter, nothing changed: no detail request at all.
    const r2 = await first.adapter.sync({ mode: 'incremental', cursor: r1.cursor });
    expect(first.server.openedRows).toEqual([46]);
    const kept = (byType(r2)['lcu.notice'] ?? [])
      .map((i) => i.payload as NoticePayload)
      .find((n) => n.kind === 'roomChange');
    expect(kept?.detail?.body).toContain('（本文）');

    // A fresh adapter (e.g. after a restart) is seeded from the cursor.
    const { server, strategy, ctx } = first;
    const adapter2 = new LiveCampusUAdapter(ctx, { strategy });
    server.readRows.add(0); // the user read the survey notice in the browser
    const r3 = await adapter2.sync({ mode: 'incremental', cursor: r2.cursor });
    expect(server.openedRows).toEqual([46, 0]);
    const notices = (byType(r3)['lcu.notice'] ?? []).map((i) => i.payload as NoticePayload);
    expect(notices.filter((n) => n.detail).length).toBe(2);
  });

  it('respects maxNoticeDetailsPerRun and noticeDetails: false', async () => {
    const a = setup({ readRows: [0, 46] }, { maxNoticeDetailsPerRun: 1 });
    await a.adapter.sync({ mode: 'initial' });
    expect(a.server.openedRows).toEqual([0]); // newest first
    const b = setup({ readRows: [0, 46] }, { noticeDetails: false });
    await b.adapter.sync({ mode: 'initial' });
    expect(b.server.openedRows).toEqual([]);
  });

  it('re-authenticates after the idle timeout between runs', async () => {
    const { clock, server, strategy, adapter } = setup();
    await adapter.sync({ mode: 'initial' });
    await clock.advance(61 * 60_000);
    const r = await adapter.sync({ mode: 'incremental' });
    expect(strategy.reauthCalls).toBe(1);
    expect(r.items.length).toBeGreaterThan(20);
    expect(server.log.at(-1)?.session).toBe('S2');
    expect(strategy.persisted.at(-1)).toBe('S2');
  });

  it('recovers from a session expiring mid-run (step restarts once)', async () => {
    const { server, strategy, adapter } = setup({ expireAfterRequests: 12 });
    const r = await adapter.sync({ mode: 'initial' });
    expect(strategy.reauthCalls).toBe(1);
    expect(count(r)['lcu.course']).toBe(8);
    expect(count(r)['lcu.notice']).toBe(7);
    expect(r.warnings).toBeUndefined();
    expect(server.maxInflight).toBe(1);
  });

  it('throws AuthRequiredError (health auth_required) when re-authentication fails', async () => {
    const { server, strategy, adapter } = setup();
    server.invalidate();
    strategy.reauthOk = false;
    await expect(adapter.sync({ mode: 'initial' })).rejects.toBeInstanceOf(AuthRequiredError);
    expect((await adapter.health()).state).toBe('auth_required');
  });

  it('keeps grades off by default and syncs them only when enabled', async () => {
    const off = setup();
    const r = await off.adapter.sync({ mode: 'initial' });
    expect(off.server.paths().some((p) => /SC_15005B00|SC_10004B00|grede/i.test(p))).toBe(false);
    expect(r.complete?.sourceTypes).toContain('lcu.grade');
    expect(await off.adapter.capabilities()).not.toContain('grades');

    const on = setup({}, { grades: true });
    await on.adapter.sync({ mode: 'initial' });
    expect(on.server.paths()).toContain('POST SC_15005B00_01/gredeInformation');
    expect(await on.adapter.capabilities()).toContain('grades');
  });

  it('reports an unknown product version (→ degraded) and checks common.js only when needed', async () => {
    const landing = fixture('lcu-home-SC_01002B00_00.synthetic.html').replace(
      'jquery/v3.5.1/jquery-3.5.1.min.js',
      'jquery/v3.7.1/jquery-3.7.1.min.js',
    );
    const { server, adapter } = setup({ landingHtml: landing, commonJs: 'y'.repeat(30000) });
    const r = await adapter.sync({ mode: 'initial' });
    const version = r.productVersion?.version ?? '';
    expect(version).toMatch(
      /^lcu-web\+jq3\.7\.1\+jqui1\.12\.1\+dt1\.10\.20\+dz5\.7\.0\+modaal0\.4\.4\+commonjs-30000-[0-9a-f]{8}$/,
    );
    const ev = evaluateProductVersion(metadata, version);
    expect(ev.state).toBe('degraded');
    expect(await adapter.detectProductVersion()).toEqual({ product: 'livecampusu', version });
    expect(server.paths().filter((p) => p === 'GET js/common.js')).toHaveLength(1);
    await adapter.sync({ mode: 'incremental', cursor: r.cursor });
    expect(server.paths().filter((p) => p === 'GET js/common.js')).toHaveLength(1);
  });

  it('known fingerprint + matching common.js size → tested version', async () => {
    const { server, adapter } = setup();
    const r = await adapter.sync({ mode: 'initial' });
    expect(r.productVersion?.version).toBe(TESTED_FINGERPRINT);
    expect(server.paths().filter((p) => p === 'GET js/common.js')).toHaveLength(1);
  });

  it('detects schema drift on a modified importantNotice payload', async () => {
    const changed = [
      {
        contactDate: '2026/09/29',
        contactSeq: '200001',
        contactTime: '09:00',
        contactTypeCode: 'U05',
        contactTypeTitle: '学内連絡',
        importanceCategory: 1, // number instead of string
        subjectClassSemesterWeekHour: '',
        // targetDate removed
        title: '新しい形のお知らせ',
        attachmentCount: '2', // new field
      },
    ];
    const { adapter, ctx } = setup({ importantNotice: changed });
    const r = await adapter.sync({ mode: 'initial' });
    const item = r.items.find(
      (i) =>
        i.sourceType === 'lcu.notice' &&
        (i.payload as NoticePayload).important?.contactSeq === '200001',
    );
    expect(item).toBeDefined();
    const normalizer = createLiveCampusUNormalizer({ deployment: adapter.deployment });
    const nctx = createNormalizeContext({
      sourceId: ctx.sourceId,
      sourceSystem: 'livecampusu',
      profile: TEST_PROFILE,
    });
    const out = await normalizer.normalize(
      {
        id: 'raw:1',
        sourceId: ctx.sourceId,
        sourceType: item?.sourceType ?? '',
        externalId: item?.externalId ?? '',
        payload: item?.payload,
        fetchedAt: '2026-10-01T03:00:00.000Z',
        sourceUpdatedAt: undefined,
        contentHash: 'x',
      },
      nctx,
    );
    expect(out.drift).toEqual(
      expect.arrayContaining([
        { path: 'important.attachmentCount', kind: 'unknown' },
        { path: 'important.importanceCategory', kind: 'type_mismatch' },
        { path: 'important.targetDate', kind: 'missing' },
      ]),
    );
  });

  it('skips the sync during the nightly maintenance window', async () => {
    const { server, adapter } = setup(
      {},
      { maintenanceWindow: '01:00-06:00' },
      '2026-09-30T17:30:00.000Z',
    );
    await expect(adapter.sync({ mode: 'initial' })).rejects.toBeInstanceOf(OfflineError);
    expect(server.log).toHaveLength(0);
    const h = await adapter.health();
    expect(h.state).toBe('offline');
    expect(h.message).toMatch(/maintenance/);
  });

  it('a failing step degrades to a warning without marking its types complete', async () => {
    const { server, adapter } = setup();
    const orig = server.fetch;
    server.fetch = async (input, init) => {
      if (String(input).endsWith('SC_13002B00_01')) return new Response('boom', { status: 404 });
      return orig(input, init);
    };
    const adapter2 = new LiveCampusUAdapter(testContext(server.clock, server.fetch), {
      strategy: new FakeStrategy(server),
    });
    void adapter;
    const r = await adapter2.sync({ mode: 'initial' });
    expect(r.warnings?.some((w) => w.startsWith('attendance:'))).toBe(true);
    expect(r.complete?.sourceTypes).not.toContain('lcu.attendance');
    expect(r.complete?.sourceTypes).toContain('lcu.notice');
  });

  it('login/logout delegate to the strategy', async () => {
    const { strategy, adapter } = setup();
    expect((await adapter.login()).status).toBe('authenticated');
    expect(strategy.loginCalls).toBe(1);
    await adapter.logout();
    expect((await adapter.authenticate()).status).toBe('auth_required');
  });

  it('uses the deployment from the profile and config overrides', () => {
    const { adapter } = setup();
    expect(adapter.deployment.screens).toEqual(TEST_DEPLOYMENT.screens);
    expect(adapter.strategyKind).toBe('browser-sso');
  });
});
