import { stableId } from '@unicontext/canonical-model';
import { PolicyViolationError, type UniversityProfile } from '@unicontext/core';
import { describe, expect, it } from 'vitest';
import {
  assertRequestAllowed,
  createLiveCampusUNormalizer,
  LcuSession,
  LiveCampusUAdapter,
  metadata,
  noticeRowKey,
  type NoticePayload,
  OnDemandNoticePermit,
  parseNoticeList,
} from '../src/index.js';
import {
  FakeLcuServer,
  FakeStrategy,
  fastLimiter,
  fixture,
  markNoticeRead,
  newClock,
  TEST_DEPLOYMENT,
  TEST_PROFILE,
  testContext,
} from './helpers.js';

/*
 * Opening an UNREAD notice marks it read in LiveCampusU and cannot be undone. The student decided
 * that the content wins: by default a sync opens unread notices too (openUnreadNotices) and
 * UniContext keeps them unread until read there. A source that opts out (openUnreadNotices: false)
 * never opens them in a sync; the explicit on-demand path (the user asked) always may.
 */

const OPT_OUT = { openUnreadNotices: false };

const READ_ROW = 46;

function listRows(readRows: number[] = [READ_ROW]) {
  let html = fixture('lcu-renraku-list-SC_17001B00_01.html');
  for (const i of readRows) html = markNoticeRead(html, i);
  return parseNoticeList(html);
}

function unreadRow() {
  const row = listRows().find((r) => r.unread);
  if (!row) throw new Error('fixture has no unread notice');
  return row;
}

function setupAdapter(
  readRows: number[] = [READ_ROW],
  config: Record<string, unknown> = OPT_OUT,
  profile: UniversityProfile | undefined = TEST_PROFILE,
) {
  const clock = newClock();
  const server = new FakeLcuServer({ clock, readRows });
  const strategy = new FakeStrategy(server);
  const adapter = new LiveCampusUAdapter(testContext(clock, server.fetch, config, profile), {
    strategy,
  });
  return { clock, server, adapter };
}

function setupSession(readRows: number[] = [READ_ROW], openUnreadNoticesInSync = false) {
  const clock = newClock();
  const server = new FakeLcuServer({ clock, readRows });
  const session = new LcuSession({
    deployment: TEST_DEPLOYMENT,
    auth: new FakeStrategy(server),
    fetch: server.fetch,
    rateLimiter: fastLimiter(clock),
    clock,
    minRequestIntervalMs: 0,
    gradesEnabled: false,
    openUnreadNoticesInSync,
  });
  session.beginRun();
  return { server, session };
}

describe('on-demand opening of unread notices', () => {
  it('with openUnreadNotices: false a sync never opens unread notices, whatever the budget', async () => {
    const { server, adapter } = setupAdapter();
    const result = await adapter.sync({ mode: 'initial' });
    expect(server.openedRows).toEqual([READ_ROW]);
    const unread = result.items
      .map((i) => i.payload as NoticePayload)
      .filter((p) => p.listRow?.unread);
    expect(unread.length).toBeGreaterThan(0);
    expect(unread.every((p) => p.bodyStatus === 'notOpened' && !p.detail)).toBe(true);
  });

  it('opens exactly the requested unread notice, returns its body and marks nothing else', async () => {
    const { server, adapter } = setupAdapter();
    const first = await adapter.sync({ mode: 'initial' });
    const target = unreadRow();
    const key = noticeRowKey(target);
    const previous = first.items.find((i) => i.externalId === key)?.payload;
    expect((previous as NoticePayload).bodyStatus).toBe('notOpened');
    server.detailBody = '本文です。締切は10月20日。';
    const before = server.openedRows.length;

    const out = await adapter.openAnnouncements([{ externalId: key, previousPayload: previous }], {
      acceptMarksRead: true,
    });
    expect(out.results).toEqual([{ externalId: key, status: 'opened', wasUnread: true }]);
    expect(server.openedRows.slice(before)).toEqual([target.rowIndex]);
    const p = out.items[0]?.payload as NoticePayload;
    expect(p).toMatchObject({
      key,
      bodyStatus: 'fetched',
      listRow: { unread: false },
      detail: { openedOnDemand: true, openedWhileRead: false },
      // what the sync stored is kept
      ...(previous as NoticePayload).context,
    });
    expect(p.detail?.body).toContain('締切は10月20日。');
    // Never readMark / toDoIcon; the only state change is the opening itself.
    expect(server.paths().filter((x) => /readMark|toDoIcon|todo/i.test(x))).toEqual([]);

    // The next sync keeps the body from the cache and opens nothing new.
    const opened = server.openedRows.length;
    const next = await adapter.sync({ mode: 'incremental' });
    expect(server.openedRows.length).toBe(opened);
    const again = next.items.find((i) => i.externalId === key)?.payload as NoticePayload;
    expect(again.bodyStatus).toBe('fetched');
  });

  it('requires the caller to accept that LCU marks the notice read', () => {
    const { adapter } = setupAdapter();
    expect(() =>
      adapter.openAnnouncements([{ externalId: 'n-x' }], {
        acceptMarksRead: false as unknown as true,
      }),
    ).toThrow(PolicyViolationError);
  });

  it('reports notices that are not on the list', async () => {
    const { adapter, server } = setupAdapter();
    const out = await adapter.openAnnouncements([{ externalId: 'n-0000000000000000' }], {
      acceptMarksRead: true,
    });
    expect(out.results).toEqual([{ externalId: 'n-0000000000000000', status: 'notFound' }]);
    expect(server.openedRows).toEqual([]);
  });

  it('serializes with a running sync (the sync finishes first, then the notice is opened)', async () => {
    const { adapter, server } = setupAdapter();
    const key = noticeRowKey(unreadRow());
    const [synced, opened] = await Promise.all([
      adapter.sync({ mode: 'initial' }),
      adapter.openAnnouncements([{ externalId: key }], { acceptMarksRead: true }),
    ]);
    expect(server.maxInflight).toBe(1);
    // The sync saw the notice still unread and did not open it; the on-demand call did.
    expect(
      (synced.items.find((i) => i.externalId === key)?.payload as NoticePayload).bodyStatus,
    ).toBe('notOpened');
    expect(opened.results[0]).toMatchObject({ status: 'opened', wasUnread: true });
    expect(server.openedRows).toEqual([READ_ROW, unreadRow().rowIndex]);
  });
});

describe('LcuSession.openNoticeOnDemand', () => {
  async function onList(session: LcuSession) {
    await session.bootstrap();
    const list = await session.open('SC_17001B00_01');
    return list.noticeListVersion ?? -1;
  }

  it('the sync path (openNoticeDetail) still refuses unread rows', async () => {
    const { server, session } = setupSession();
    const listVersion = await onList(session);
    const row = unreadRow();
    const before = server.log.length;
    expect(() =>
      session.openNoticeDetail({ rowIndex: row.rowIndex, unread: true, listVersion }),
    ).toThrow(PolicyViolationError);
    await expect(
      session.openNoticeDetail({ rowIndex: row.rowIndex, unread: false, listVersion }),
    ).rejects.toThrow(/unread/);
    expect(server.log.length).toBe(before);
  });

  it('is refused while a sync runs, even with a permit, unless the session allows it', async () => {
    const { server, session } = setupSession();
    const listVersion = await onList(session);
    const row = unreadRow();
    const key = noticeRowKey(row);
    const before = server.log.length;
    await expect(
      session.duringSync(() =>
        session.openNoticeOnDemand(
          { rowIndex: row.rowIndex, unread: true, listVersion, key },
          OnDemandNoticePermit.forKeys([key]),
        ),
      ),
    ).rejects.toThrow(/during a sync/);
    expect(server.log.length).toBe(before);
    expect(server.openedRows).toEqual([]);

    // openUnreadNoticesInSync: a sync may open the unread notices it holds a permit for, only those.
    const allowed = setupSession([READ_ROW], true);
    const v = await onList(allowed.session);
    await expect(
      allowed.session.duringSync(() =>
        allowed.session.openNoticeOnDemand(
          { rowIndex: row.rowIndex, unread: true, listVersion: v, key },
          OnDemandNoticePermit.forKeys(['n-0000000000000000']),
        ),
      ),
    ).rejects.toThrow(PolicyViolationError);
    expect(allowed.server.openedRows).toEqual([]);
    await allowed.session.duringSync(() =>
      allowed.session.openNoticeOnDemand(
        { rowIndex: row.rowIndex, unread: true, listVersion: v, key },
        OnDemandNoticePermit.forKeys([key]),
      ),
    );
    expect(allowed.server.openedRows).toEqual([row.rowIndex]);
  });

  it('a permit opens only its own notice, once', async () => {
    const { server, session } = setupSession([]);
    let listVersion = await onList(session);
    const unread = listRows([]).filter((r) => r.unread);
    const [a, b] = unread;
    if (!a || !b) throw new Error('fixture needs two unread notices');
    const permit = OnDemandNoticePermit.forKeys([noticeRowKey(a)]);
    // Another unread notice with this permit: refused before any request.
    await expect(
      session.openNoticeOnDemand(
        { rowIndex: b.rowIndex, unread: true, listVersion, key: noticeRowKey(b) },
        permit,
      ),
    ).rejects.toThrow(PolicyViolationError);
    // A proof whose key does not match the row: refused.
    await expect(
      session.openNoticeOnDemand(
        { rowIndex: b.rowIndex, unread: true, listVersion, key: noticeRowKey(a) },
        permit,
      ),
    ).rejects.toThrow(/not the requested notice/);
    expect(server.openedRows).toEqual([]);
    await session.openNoticeOnDemand(
      { rowIndex: a.rowIndex, unread: true, listVersion, key: noticeRowKey(a) },
      permit,
    );
    expect(server.openedRows).toEqual([a.rowIndex]);
    // Used up: back on the list, the same permit cannot open another unread notice.
    await session.post('SC_17001B00_02/back');
    listVersion = (await session.open('SC_17001B00_01')).noticeListVersion ?? -1;
    await expect(
      session.openNoticeOnDemand(
        { rowIndex: b.rowIndex, unread: true, listVersion, key: noticeRowKey(b) },
        permit,
      ),
    ).rejects.toThrow(PolicyViolationError);
  });

  it('the on-demand grant opens the detail screen but never allows readMark', () => {
    const g = { gradesEnabled: false, grant: 'notice-detail-on-demand' as const };
    expect(() => assertRequestAllowed('POST', 'SC_17001B00_01/rowSelect', g)).not.toThrow();
    expect(() => assertRequestAllowed('GET', 'SC_17001B00_02', g)).not.toThrow();
    for (const p of [
      'SC_17001B00_01/readMark',
      'SC_17001B00_02/readMark',
      'SC_17001B00_01/toDoIcon',
    ])
      expect(() => assertRequestAllowed('POST', p, g)).toThrow(PolicyViolationError);
    expect(() => assertRequestAllowed('POST', 'SC_14002B00_01/rowSelect', g)).toThrow(
      PolicyViolationError,
    );
  });
});

describe('UniContext: announcements open (end to end through the connector)', () => {
  it('fetches the body, LCU marks it read, UniContext keeps it unread until read there', async () => {
    const { createUniContext, openAnnouncements } =
      await import('../../../packages/context-engine/src/index.js');
    const clock = newClock();
    const server = new FakeLcuServer({ clock, readRows: [READ_ROW] });
    const adapter = new LiveCampusUAdapter(testContext(clock, server.fetch, OPT_OUT), {
      strategy: new FakeStrategy(server),
    });
    const uc = createUniContext({ clock });
    try {
      uc.sync.register({
        sourceId: 'livecampusu',
        adapter,
        normalizer: createLiveCampusUNormalizer({ deployment: TEST_DEPLOYMENT }),
        metadata,
      });
      expect((await uc.sync.sync('livecampusu')).ok).toBe(true);
      const key = noticeRowKey(unreadRow());
      const id = stableId('announcement', 'livecampusu', key);
      const before = uc.context.getAnnouncement(id);
      expect(before).toMatchObject({
        read: false,
        unread: true,
        bodyStatus: 'notOpened',
        body: '',
      });
      expect(uc.context.unopenedAnnouncements().map((a) => a.id)).toContain(id);

      server.detailBody = 'オンデマンドで取得した本文。';
      const report = await openAnnouncements(uc, [id]);
      expect(report).toMatchObject({ opened: 1, markedReadAtSource: 1 });
      const after = uc.context.getAnnouncement(id);
      expect(after).toMatchObject({ read: true, unread: true, bodyStatus: 'fetched' });
      expect(after?.body).toContain('オンデマンドで取得した本文。');
      expect(uc.context.listAnnouncements({ unreadOnly: true }).map((a) => a.id)).toContain(id);

      // Already fetched: nothing is opened again.
      const opened = server.openedRows.length;
      expect((await openAnnouncements(uc, [id])).results[0]?.status).toBe('alreadyFetched');
      expect(server.openedRows.length).toBe(opened);

      // Read in UniContext (never touches LCU).
      const requests = server.log.length;
      expect(uc.context.setAnnouncementRead(id, true).unread).toBe(false);
      expect(server.log.length).toBe(requests);
      expect(uc.context.listAnnouncements({ unreadOnly: true }).map((a) => a.id)).not.toContain(id);

      // The next scheduled sync keeps the body and opens no unread notice.
      const openedBefore = [...server.openedRows];
      expect((await uc.sync.sync('livecampusu')).ok).toBe(true);
      expect(server.openedRows).toEqual(openedBefore);
      expect(uc.context.getAnnouncement(id)?.body).toContain('オンデマンドで取得した本文。');
    } finally {
      await uc.close();
    }
  });
});

describe('sync opens unread notices (openUnreadNotices, default on)', () => {
  it('opens unread notices too, with body and attachments, and never readMark', async () => {
    const { server, adapter } = setupAdapter([], {});
    expect(adapter.openUnreadNotices).toBe(true);
    server.detailBody = '講義資料を掲載しました。';
    const result = await adapter.sync({ mode: 'initial' });
    const rows = listRows([]);
    expect([...server.openedRows].sort((a, b) => a - b)).toEqual(
      rows.map((r) => r.rowIndex).sort((a, b) => a - b),
    );
    const listed = result.items
      .map((i) => i.payload as NoticePayload)
      .filter((p) => p.listRow !== undefined);
    expect(listed.length).toBe(rows.length);
    for (const p of listed) {
      expect(p.bodyStatus).toBe('fetched');
      expect(p.detail?.openedWhileRead).toBe(false);
      expect(p.detail?.body).toContain('講義資料を掲載しました。');
    }
    // The clip row's attachment list is read while its detail is open.
    expect(server.paths().filter((x) => /fileUpload/.test(x))).toEqual([
      'POST fileUpload/load/fi02',
    ]);
    expect(server.paths().filter((x) => /readMark|toDoIcon|todo/i.test(x))).toEqual([]);

    // The next sync opens nothing again; the notice stays "opened by UniContext".
    const opened = server.openedRows.length;
    const next = await adapter.sync({ mode: 'incremental', cursor: result.cursor });
    expect(server.openedRows.length).toBe(opened);
    const again = next.items
      .map((i) => i.payload as NoticePayload)
      .filter((p) => p.listRow !== undefined);
    expect(again.every((p) => p.listRow?.unread === false)).toBe(true);
    expect(again.every((p) => p.detail?.openedWhileRead === false)).toBe(true);
  });

  it('course-linked and high-importance first; the other unread ones within maxUnreadNoticesPerRun', async () => {
    // Row 46: course-linked room change (priority). Row 0: university survey (not priority).
    const a = setupAdapter([], { maxUnreadNoticesPerRun: 0 });
    const r1 = await a.adapter.sync({ mode: 'initial' });
    expect(a.server.openedRows).toEqual([46]);
    const survey = (r: typeof r1) =>
      r.items
        .map((i) => i.payload as NoticePayload)
        .find((p) => p.important?.contactSeq === '100001');
    // Left for a later sync: pending, not notOpened.
    expect(survey(r1)?.bodyStatus).toBe('pending');

    const b = setupAdapter([], { maxUnreadNoticesPerRun: 1 });
    const r2 = await b.adapter.sync({ mode: 'initial' });
    expect(b.server.openedRows).toEqual([46, 0]);
    expect(survey(r2)?.bodyStatus).toBe('fetched');
  });

  it('a profile can opt out (products.livecampusu.openUnreadNotices: false); source config wins', async () => {
    const products = TEST_PROFILE.products as Record<string, Record<string, unknown>>;
    const profile = {
      ...TEST_PROFILE,
      products: { ...products, livecampusu: { ...products.livecampusu, openUnreadNotices: false } },
    } as UniversityProfile;
    const off = setupAdapter([READ_ROW], {}, profile);
    expect(off.adapter.openUnreadNotices).toBe(false);
    const r = await off.adapter.sync({ mode: 'initial' });
    expect(off.server.openedRows).toEqual([READ_ROW]);
    const unread = r.items.map((i) => i.payload as NoticePayload).filter((p) => p.listRow?.unread);
    expect(unread.every((p) => p.bodyStatus === 'notOpened')).toBe(true);

    const on = setupAdapter([READ_ROW], { openUnreadNotices: true }, profile);
    expect(on.adapter.openUnreadNotices).toBe(true);
  });

  it('UniContext keeps a notice the sync opened unread until the student reads it there', async () => {
    const { createUniContext } = await import('../../../packages/context-engine/src/index.js');
    const clock = newClock();
    const server = new FakeLcuServer({ clock, readRows: [READ_ROW] });
    const adapter = new LiveCampusUAdapter(testContext(clock, server.fetch), {
      strategy: new FakeStrategy(server),
    });
    const uc = createUniContext({ clock });
    try {
      uc.sync.register({
        sourceId: 'livecampusu',
        adapter,
        normalizer: createLiveCampusUNormalizer({ deployment: TEST_DEPLOYMENT }),
        metadata,
      });
      server.detailBody = '同期で取得した本文。';
      expect((await uc.sync.sync('livecampusu')).ok).toBe(true);
      const key = noticeRowKey(unreadRow());
      const id = stableId('announcement', 'livecampusu', key);
      expect(uc.context.getAnnouncement(id)).toMatchObject({
        unread: true,
        bodyStatus: 'fetched',
      });
      expect(uc.context.getAnnouncement(id)?.body).toContain('同期で取得した本文。');
      // A notice the student had already read in LCU stays read.
      const readId = stableId(
        'announcement',
        'livecampusu',
        noticeRowKey(listRows().find((r) => r.rowIndex === READ_ROW) ?? unreadRow()),
      );
      expect(uc.context.getAnnouncement(readId)?.unread).toBe(false);

      // Next sync: LCU now lists it as read, UniContext still shows it unread.
      expect((await uc.sync.sync('livecampusu')).ok).toBe(true);
      expect(uc.context.getAnnouncement(id)).toMatchObject({ read: true, unread: true });
      expect(uc.context.listAnnouncements({ unreadOnly: true }).map((a) => a.id)).toContain(id);
      expect(uc.context.unopenedAnnouncements().map((a) => a.id)).not.toContain(id);

      // Read in UniContext (never touches LCU).
      const requests = server.log.length;
      expect(uc.context.setAnnouncementRead(id, true).unread).toBe(false);
      expect(server.log.length).toBe(requests);
      expect((await uc.sync.sync('livecampusu')).ok).toBe(true);
      expect(uc.context.getAnnouncement(id)?.unread).toBe(false);
    } finally {
      await uc.close();
    }
  });
});
