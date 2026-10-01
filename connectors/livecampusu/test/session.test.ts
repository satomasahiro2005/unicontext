import { AuthRequiredError, PolicyViolationError } from '@unicontext/core';
import { describe, expect, it } from 'vitest';
import { assertRequestAllowed, LcuSession, type PolicyContext } from '../src/index.js';
import { FakeLcuServer, FakeStrategy, fastLimiter, newClock, TEST_DEPLOYMENT } from './helpers.js';

function setup(
  opts: {
    grades?: boolean;
    minInterval?: number;
    expireAfterRequests?: number;
    readRows?: number[];
  } = {},
) {
  const clock = newClock();
  const server = new FakeLcuServer({
    clock,
    ...(opts.expireAfterRequests !== undefined
      ? { expireAfterRequests: opts.expireAfterRequests }
      : {}),
    ...(opts.readRows ? { readRows: opts.readRows } : {}),
  });
  const strategy = new FakeStrategy(server);
  const session = new LcuSession({
    deployment: TEST_DEPLOYMENT,
    auth: strategy,
    fetch: server.fetch,
    rateLimiter: fastLimiter(clock),
    clock,
    minRequestIntervalMs: opts.minInterval ?? 0,
    gradesEnabled: opts.grades ?? false,
  });
  session.beginRun();
  return { clock, server, strategy, session };
}

const POLICY: PolicyContext = { gradesEnabled: false };

describe('hard-coded request policy (denylist)', () => {
  const denied: [string, string][] = [
    ['POST', 'SC_17001B00_01/toDoIcon'],
    ['POST', 'SC_17001B00_01/readMark'],
    ['POST', 'SC_17001B00_02/addTodo'],
    ['POST', 'SC_18001B00_01/scheduleAdd'],
    ['POST', 'SC_10004B00_01/report'],
    ['POST', 'SC_18001B00_13/timeTableReport'],
    ['POST', 'SC_14002B00_03'],
    ['POST', 'SC_14002B00_03/submit'],
    ['GET', 'SC_14002B00_03'],
    ['POST', 'SC_14002B00_01/rowselect'],
    ['POST', 'SC_07002B00_01/init'],
    ['POST', 'SC_07002B00_02/regist'],
    ['POST', 'SC_18001B00_04/init'],
    ['POST', 'fileUpload/load/submit'],
    ['POST', 'SC_01003B00_13/lcuLogout'],
    ['GET', 'SC_01003B00_13/beforeLogoutProcess'],
    ['POST', 'SC_01002B00_00/importantNoticeLink'],
    ['GET', 'SC_01003B00_13/importantNoticeLink/100001'],
    ['POST', 'SC_01002B00_00/submissionInformationLink'],
    ['POST', 'webLogin'],
    ['POST', 'changeLocale'],
    ['POST', 'SC_17001B00_01/rowSelect'],
    ['GET', 'SC_17001B00_02'],
    ['POST', 'SC_13002B00_01/linkselect'],
    ['POST', 'SC_15005B00_01/gredeInformation'],
    ['GET', 'SC_10004B00_01'],
    ['POST', 'SC_10004B00_01/changeSeisekiKind'],
    ['GET', 'SC_10004B00_02'],
    ['POST', 'SC_15005B00_01/init'],
    ['GET', 'SC_17001B00_01/../SC_14002B00_03'],
    // servlet-style path parameters and encoded separators do not hide a denied screen/action
    ['POST', 'SC_14002B00_03;x=1/init'],
    ['POST', 'SC_14002B00_03%2Finit'],
    ['POST', 'SC_07002B00_01%5Cinit'],
    ['POST', 'SC_17001B00_01/toDoIcon;x=1'],
    ['POST', 'SC_17001B00_01/readMark%3Bv=1'],
  ];
  for (const [method, path] of denied) {
    it(`denies ${method} ${path}`, () => {
      expect(() => assertRequestAllowed(method, path, POLICY)).toThrow(PolicyViolationError);
    });
  }

  it('cannot be relaxed by a profile: extra screens only add to the deny set', () => {
    expect(() =>
      assertRequestAllowed('POST', 'SC_14002B00_03/init', { ...POLICY, extraDeniedScreens: [] }),
    ).toThrow(PolicyViolationError);
    expect(() =>
      assertRequestAllowed('POST', 'SC_99999X00_01/init', {
        ...POLICY,
        extraDeniedScreens: ['SC_99999X00_01'],
      }),
    ).toThrow(PolicyViolationError);
  });

  it('allows the read-only navigation the connector uses', () => {
    for (const [m, p] of [
      ['GET', ''],
      ['GET', 'SC_01002B00_00'],
      ['GET', 'SC_01002B00_00/importantNotice'],
      ['GET', 'SC_01002B00_01/submissionInformation?mode=web'],
      ['GET', 'SC_01002B00_01/warningNoticeInformation'],
      ['POST', 'SubjectInformationSearch/getClassSubjectList'],
      ['POST', 'SC_18001B00_01/init'],
      ['POST', 'SC_18001B00_01/timeTable'],
      ['POST', 'SC_18001B00_13/change'],
      ['POST', 'SC_18001B00_13/testTimeTable'],
      ['POST', 'SC_14002B00_01/search'],
      ['POST', 'SC_17001B00_02/back'],
      ['GET', 'js/common.js'],
    ] as const)
      expect(() => assertRequestAllowed(m, p, POLICY)).not.toThrow();
    expect(() =>
      assertRequestAllowed('POST', 'SC_17001B00_01/rowSelect', {
        ...POLICY,
        grant: 'notice-detail',
      }),
    ).not.toThrow();
    expect(() =>
      assertRequestAllowed('POST', 'SC_15005B00_01/gredeInformation', { gradesEnabled: true }),
    ).not.toThrow();
    // The grant is for notices only.
    expect(() =>
      assertRequestAllowed('POST', 'SC_14002B00_01/rowselect', {
        ...POLICY,
        grant: 'notice-detail',
      }),
    ).toThrow(PolicyViolationError);
  });
});

describe('LcuSession', () => {
  it('refuses denylisted calls before any fetch happens', async () => {
    const { server, session } = setup();
    const calls: (() => unknown)[] = [
      () => session.post('SC_17001B00_01/toDoIcon'),
      () => session.post('SC_17001B00_01/readMark'),
      () => session.post('SC_17001B00_02/addTodo'),
      () => session.post('SC_18001B00_01/scheduleAdd'),
      () => session.post('SC_10004B00_01/report'),
      () => session.open('SC_14002B00_03'),
      () => session.post('SC_14002B00_03/submit'),
      () => session.open('SC_07002B00_01'),
      () => session.postJson('fileUpload/load/submit', {}),
      () => session.post('SC_01003B00_13/lcuLogout'),
      () => session.getPage('SC_01002B00_00/importantNoticeLink'),
      () => session.post('SC_17001B00_01/rowSelect', { rowIndex: '0' }),
      () => session.getPage('SC_17001B00_02'),
      () => session.post('SC_14002B00_01/rowselect', { rowIndex: '0' }),
      () => session.open('SC_10004B00_01'),
      () => session.post('SC_15005B00_01/gredeInformation'),
    ];
    for (const call of calls) expect(call).toThrow(PolicyViolationError);
    expect(server.log).toHaveLength(0);
  });

  it('bootstraps, follows PRG redirects and carries the latest tokens', async () => {
    const { server, session } = setup();
    await session.bootstrap();
    const tokensAfterLanding = session.currentTokens();
    expect(tokensAfterLanding).toEqual({ csrf: server.csrf, transactionToken: server.tx });
    const page = await session.open('SC_18001B00_01');
    expect(page.screenId).toBe('SC_18001B00_01');
    await session.post('SC_18001B00_01/timeTable');
    await session.post('SC_18001B00_13/change', [['selectSemesterTermCode', '1']]);
    const posts = server.requests((r) => r.method === 'POST');
    expect(posts.map((p) => p.path)).toEqual([
      'SC_18001B00_01/init',
      'SC_18001B00_01/timeTable',
      'SC_18001B00_13/change',
    ]);
    // Each POST carried the tokens of the HTML response right before it.
    expect(posts.map((p) => [p.csrf, p.tx])).toEqual([
      ['csrf-1', 'tx-1'],
      ['csrf-2', 'tx-2'],
      ['csrf-3', 'tx-3'],
    ]);
    expect(server.paths()).toEqual([
      'GET SC_01002B00_00',
      'POST SC_18001B00_01/init',
      'GET SC_18001B00_01',
      'POST SC_18001B00_01/timeTable',
      'GET SC_18001B00_13',
      'POST SC_18001B00_13/change',
      'GET SC_18001B00_13',
    ]);
    expect(session.currentScreen).toBe('SC_18001B00_13');
  });

  it('sends X-CSRF-TOKEN and _csrf on JSON POSTs', async () => {
    const { server, session } = setup();
    await session.bootstrap();
    const csrf = server.csrf;
    const res = await session.postJson('SubjectInformationSearch/getClassSubjectList', {
      startYear: '2026',
      startSemester: '1',
    });
    expect(Array.isArray(res)).toBe(true);
    const last = server.log.at(-1);
    expect(last?.headerCsrf).toBe(csrf);
    expect(last?.csrf).toBe(csrf);
  });

  it('never sends a request outside the deployment base URL', async () => {
    const { server, session } = setup();
    await session.bootstrap();
    const before = server.log.length;
    await expect(session.getPage('https://attacker.example/SC_01002B00_00')).rejects.toThrow(
      PolicyViolationError,
    );
    expect(server.log).toHaveLength(before);
  });

  it('handles ;jsessionid= in redirect locations', async () => {
    const { server, session } = setup();
    await session.bootstrap();
    await session.open('SC_14002B00_01');
    const page = await session.post('SC_14002B00_01/search', [['title', '']]);
    expect(page.screenId).toBe('SC_14002B00_01');
    expect(page.url).not.toContain('jsessionid');
    expect(server.log.at(-1)?.path).toBe('SC_14002B00_01');
  });

  it('serializes concurrent callers: never two requests in flight', async () => {
    const { server, session } = setup();
    await session.bootstrap();
    const results = await Promise.all([
      session.getJson('SC_01002B00_00/importantNotice'),
      session.getJson('SC_01002B00_01/warningNoticeInformation'),
      session.open('SC_18001B00_01'),
      session.getJson('SC_01002B00_01/submissionInformation?mode=web'),
      session.open('SC_17001B00_01'),
    ]);
    expect(results).toHaveLength(5);
    expect(server.maxInflight).toBe(1);
    expect(server.paths().slice(1)).toEqual([
      'GET SC_01002B00_00/importantNotice',
      'GET SC_01002B00_01/warningNoticeInformation',
      'POST SC_18001B00_01/init',
      'GET SC_18001B00_01',
      'GET SC_01002B00_01/submissionInformation?mode=web',
      'POST SC_17001B00_01/init',
      'GET SC_17001B00_01',
    ]);
    // The second menu POST used the tokens of the scheduler page, not stale ones.
    expect(server.requests((r) => r.method === 'POST').every((r) => r.tx !== undefined)).toBe(true);
  });

  it('keeps a minimum interval between requests', async () => {
    const { clock, server, session } = setup({ minInterval: 1000 });
    await session.bootstrap();
    const p = session.getJson('SC_01002B00_00/importantNotice');
    await new Promise((r) => setTimeout(r, 10));
    expect(server.log).toHaveLength(1);
    await clock.advance(1000);
    await p;
    expect(server.log).toHaveLength(2);
    expect((server.log[1]?.at ?? 0) - (server.log[0]?.at ?? 0)).toBeGreaterThanOrEqual(1000);
  });

  it('re-authenticates once after the 60-minute idle timeout (before using the dead session)', async () => {
    const { clock, server, strategy, session } = setup();
    await session.bootstrap();
    await clock.advance(61 * 60_000);
    session.beginRun();
    const page = await session.bootstrap();
    expect(page.screenId).toBe('SC_01002B00_00');
    expect(strategy.reauthCalls).toBe(1);
    // No request was sent with the idle (dead) session.
    expect(server.log.filter((r) => r.session === 'S1')).toHaveLength(1);
    expect(server.log.at(-1)?.session).toBe('S2');
  });

  it('detects a server-side session loss (login screen) and asks the caller to restart the step', async () => {
    const { server, strategy, session } = setup();
    await session.bootstrap();
    server.invalidate();
    await expect(session.open('SC_18001B00_01')).rejects.toThrow(/re-established/);
    expect(strategy.reauthCalls).toBe(1);
    // After the restart the step works on the new session.
    const page = await session.open('SC_18001B00_01');
    expect(page.screenId).toBe('SC_18001B00_01');
  });

  it('treats a stale-token error screen as session loss', async () => {
    const { server, strategy, session } = setup();
    await session.bootstrap();
    server.tx = 'rotated-elsewhere'; // e.g. the user clicked in another tab
    await expect(session.open('SC_18001B00_01')).rejects.toThrow(/re-established/);
    expect(strategy.reauthCalls).toBe(1);
  });

  it('throws AuthRequiredError when the re-authentication fails', async () => {
    const { server, strategy, session } = setup();
    await session.bootstrap();
    server.invalidate();
    strategy.reauthOk = false;
    await expect(session.open('SC_18001B00_01')).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('allows only one re-authentication per run', async () => {
    const { server, strategy, session } = setup();
    await session.bootstrap();
    server.invalidate();
    await expect(session.open('SC_18001B00_01')).rejects.toThrow(/re-established/);
    server.invalidate();
    await expect(session.open('SC_18001B00_01')).rejects.toBeInstanceOf(AuthRequiredError);
    expect(strategy.reauthCalls).toBe(1);
  });

  it('throws AuthRequiredError without a stored session when refresh fails', async () => {
    const { strategy, session } = setup();
    strategy.hasSession = false;
    strategy.reauthOk = false;
    await expect(session.bootstrap()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('opens notice details only for rows the list shows as read', async () => {
    const { server, session } = setup({ readRows: [46] });
    await session.bootstrap();
    const list = await session.open('SC_17001B00_01');
    const version = list.noticeListVersion ?? -1;
    // Unread row: refused synchronously.
    expect(() =>
      session.openNoticeDetail({ rowIndex: 0, unread: true, listVersion: version }),
    ).toThrow(PolicyViolationError);
    // A forged proof (claims read) for a row the session saw as unread: refused in the queue.
    await expect(
      session.openNoticeDetail({ rowIndex: 0, unread: false, listVersion: version }),
    ).rejects.toBeInstanceOf(PolicyViolationError);
    // Unknown row and stale list version: refused.
    await expect(
      session.openNoticeDetail({ rowIndex: 7, unread: false, listVersion: version }),
    ).rejects.toBeInstanceOf(PolicyViolationError);
    await expect(
      session.openNoticeDetail({ rowIndex: 46, unread: false, listVersion: version - 1 }),
    ).rejects.toBeInstanceOf(PolicyViolationError);
    expect(server.openedRows).toEqual([]);
    // The read row opens.
    const detail = await session.openNoticeDetail({
      rowIndex: 46,
      unread: false,
      listVersion: version,
    });
    expect(detail.screenId).toBe('SC_17001B00_02');
    expect(server.openedRows).toEqual([46]);
    // Not on the list any more: refused until we go back.
    await expect(
      session.openNoticeDetail({ rowIndex: 46, unread: false, listVersion: version }),
    ).rejects.toBeInstanceOf(PolicyViolationError);
    const back = await session.post('SC_17001B00_02/back');
    expect(back.screenId).toBe('SC_17001B00_01');
    expect(server.paths().filter((p) => p.includes('rowSelect'))).toEqual([
      'POST SC_17001B00_01/rowSelect',
    ]);
  });

  it('refuses grade screens unless grades are enabled', async () => {
    const off = setup();
    expect(() => off.session.open('SC_15005B00_01')).toThrow(PolicyViolationError);
    const on = setup({ grades: true });
    await on.session.bootstrap();
    await on.session.open('SC_15005B00_01');
    const page = await on.session.post('SC_15005B00_01/gredeInformation');
    expect(page.screenId).toBe('SC_10004B00_01');
  });
});
