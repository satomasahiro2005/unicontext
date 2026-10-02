import { stableId } from '@unicontext/canonical-model';
import { PolicyViolationError } from '@unicontext/core';
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
  testContext,
} from './helpers.js';

/*
 * Opening an UNREAD notice marks it read in LiveCampusU and cannot be undone, so a sync never
 * does it. Only the explicit on-demand path (the user asked for these notices) may.
 */

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

function setupAdapter(readRows: number[] = [READ_ROW]) {
  const clock = newClock();
  const server = new FakeLcuServer({ clock, readRows });
  const strategy = new FakeStrategy(server);
  const adapter = new LiveCampusUAdapter(testContext(clock, server.fetch), { strategy });
  return { clock, server, adapter };
}

function setupSession(readRows: number[] = [READ_ROW]) {
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
  });
  session.beginRun();
  return { server, session };
}

describe('on-demand opening of unread notices', () => {
  it('a sync never opens unread notices, whatever the detail budget', async () => {
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

  it('is refused while a sync runs, even with a permit', async () => {
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
