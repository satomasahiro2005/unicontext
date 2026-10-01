import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChangeEvent } from '@unicontext/canonical-model';
import { createMemoryLogger } from '@unicontext/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConsoleSink, NotificationService } from '../src/index.js';
import { createSeedHarness, lcuDb, makeEvent, memorySink, type SeedHarness } from './helpers.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'uc-notif-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('seed pipeline', () => {
  let h: SeedHarness;
  beforeEach(() => {
    h = createSeedHarness();
  });
  afterEach(async () => {
    await h.uc.close();
  });

  it('stays silent during the initial sync', async () => {
    const sink = memorySink();
    const svc = new NotificationService({ uc: h.uc, sinks: [sink] });
    svc.start();
    await h.syncAll();
    expect(sink.sent).toEqual([]);
    expect(svc.list()).toEqual([]);
    svc.stop();
  });

  it('turns the day-2 changes into notifications with citations', async () => {
    const sink = memorySink();
    const svc = new NotificationService({ uc: h.uc, sinks: [sink] });
    svc.start();
    await h.syncAll();
    await h.day2();
    const byKind = Object.fromEntries(sink.sent.map((n) => [n.kind, n]));
    expect(Object.keys(byKind).sort()).toEqual([
      'conflict',
      'deadline_changed',
      'important_announcement',
    ]);

    const changed = byKind.deadline_changed;
    expect(changed?.priority).toBe('high'); // new due is 9 days away
    expect(changed?.title).toBe('締切変更: 課題1: ER図の作成');
    expect(changed?.body).toContain('「10/8 23:59」から「10/10 23:59」');
    expect(changed?.body).toContain('データベースシステム論');
    expect(changed?.citations.length).toBeGreaterThan(0);

    const conflict = byKind.conflict;
    expect(conflict?.priority).toBe('high');
    expect(conflict?.body).toContain('教室で情報が食い違っています');
    expect(conflict?.courseOfferingId).toBeDefined();

    const important = byKind.important_announcement;
    expect(important?.title).toContain('本日の教室変更');
    expect(important?.body).toContain('情報学部2号館11教室');
    expect(important?.citations.length).toBeGreaterThan(0);
    svc.stop();
  });

  it('the conflict change event and the conflict bus event produce one notification', async () => {
    const sink = memorySink();
    const svc = new NotificationService({ uc: h.uc, sinks: [sink] });
    svc.start();
    await h.syncAll();
    await h.day2();
    expect(sink.sent.filter((n) => n.kind === 'conflict')).toHaveLength(1);
    svc.stop();
  });

  it('writes console lines in the [priority] title — body format', async () => {
    const lines: string[] = [];
    const svc = new NotificationService({
      uc: h.uc,
      sinks: [createConsoleSink({ write: (l) => lines.push(l) })],
    });
    svc.start();
    await h.syncAll();
    await h.day2();
    expect(lines.some((l) => l.startsWith('[重要] 締切変更: 課題1: ER図の作成 — '))).toBe(true);
    svc.stop();
  });

  it('stop() unsubscribes from the bus and clears the timer', async () => {
    const sink = memorySink();
    const svc = new NotificationService({ uc: h.uc, sinks: [sink] });
    const listeners = h.uc.bus.listenerCount('change');
    const timers = h.clock.pending;
    svc.start();
    expect(h.uc.bus.listenerCount('change')).toBe(listeners + 1);
    expect(h.clock.pending).toBe(timers + 1);
    svc.stop();
    expect(h.uc.bus.listenerCount('change')).toBe(listeners);
    expect(h.clock.pending).toBe(timers);
    await h.syncAll();
    await h.day2();
    expect(sink.sent).toEqual([]);
  });

  it('does not repeat notifications after a restart on the same log file', async () => {
    const logFile = path.join(tmp, 'nested', 'notifications.jsonl');
    const first = memorySink();
    const svc1 = new NotificationService({ uc: h.uc, sinks: [first], logFile });
    svc1.start();
    await h.syncAll();
    const events: ChangeEvent[] = [];
    h.uc.bus.on('change', (e) => {
      events.push(e);
    });
    await h.day2();
    svc1.stop();
    expect(first.sent.length).toBe(3);

    const second = memorySink();
    const svc2 = new NotificationService({ uc: h.uc, sinks: [second], logFile });
    expect(svc2.list()).toHaveLength(3);
    for (const e of events) expect(await svc2.handleChange(e)).toEqual([]);
    expect(second.sent).toEqual([]);
    expect(readFileSync(logFile, 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('persists read state across restarts', async () => {
    const logFile = path.join(tmp, 'n.jsonl');
    const svc1 = new NotificationService({ uc: h.uc, sinks: [], logFile });
    svc1.start();
    await h.syncAll();
    await h.day2();
    svc1.stop();
    const [newest, ...rest] = svc1.list();
    expect(newest?.read).toBeUndefined();
    svc1.markRead(newest?.id ?? '');
    expect(svc1.list({ unreadOnly: true })).toHaveLength(rest.length);

    const svc2 = new NotificationService({ uc: h.uc, sinks: [], logFile });
    expect(svc2.list({ unreadOnly: true })).toHaveLength(rest.length);
    expect(svc2.list().find((n) => n.id === newest?.id)?.read).toBe(true);
    expect(svc2.unreadCount()).toBe(rest.length);
    expect(svc2.markAllRead()).toBe(rest.length);
    expect(svc2.unreadCount()).toBe(0);
  });

  it('list() filters by priority, since and limit, newest first', async () => {
    const svc = new NotificationService({ uc: h.uc, sinks: [] });
    svc.start();
    await h.syncAll();
    await h.day2();
    svc.stop();
    const all = svc.list();
    expect(all).toHaveLength(3);
    expect(svc.list({ limit: 1 })).toHaveLength(1);
    expect(svc.list({ limit: 1 })[0]?.id).toBe(all[0]?.id);
    expect(svc.list({ minPriority: 'critical' })).toEqual([]);
    expect(svc.list({ minPriority: 'high' })).toHaveLength(3);
    expect(svc.list({ since: '2999-01-01T00:00:00.000Z' })).toEqual([]);
  });

  it('minPriority at service level drops lower notifications entirely', async () => {
    const sink = memorySink();
    const svc = new NotificationService({ uc: h.uc, sinks: [sink], minPriority: 'critical' });
    svc.start();
    await h.syncAll();
    await h.day2();
    svc.stop();
    expect(sink.sent).toEqual([]);
    expect(svc.list()).toEqual([]);
  });

  it('isolates failing sinks and warns through the logger', async () => {
    const { logger, records } = createMemoryLogger();
    const good = memorySink('good');
    const bad = {
      id: 'bad',
      send(): never {
        throw new Error('boom');
      },
    };
    const rejecting = { id: 'rejecting', send: () => Promise.reject(new Error('nope')) };
    const svc = new NotificationService({ uc: h.uc, sinks: [bad, rejecting, good], logger });
    svc.start();
    await h.syncAll();
    await h.day2();
    svc.stop();
    expect(good.sent).toHaveLength(3);
    const warns = records.filter((r) => r.msg === 'notification sink failed');
    expect(warns.map((w) => w.sink)).toEqual(expect.arrayContaining(['bad', 'rejecting']));
    expect(warns).toHaveLength(6);
  });
});

describe('change rules', () => {
  let h: SeedHarness;
  let svc: NotificationService;
  beforeEach(async () => {
    h = createSeedHarness();
    await h.syncAll();
    await h.day2();
    h.clock.set('2026-10-01T00:30:00.000Z'); // 2026-10-01 09:30 JST
    svc = new NotificationService({ uc: h.uc, sinks: [] });
  });
  afterEach(async () => {
    await h.uc.close();
  });

  it('room change on a class today is critical; later in the week it is high', async () => {
    const today = h.uc.context.today().classes.find((c) => c.period === 2);
    expect(today).toBeDefined();
    const [n] = await svc.handleChange(
      makeEvent('classSession', 'x', {
        type: 'updated',
        entityId: today?.sessionId as ChangeEvent['entityId'],
        changedFields: ['room'],
        before: { room: '21教室' },
        after: { room: '11教室' },
        courseOfferingId: lcuDb,
      }),
    );
    expect(n?.kind).toBe('room_change');
    expect(n?.priority).toBe('critical');
    expect(n?.title).toBe('教室変更: データベースシステム論');
    expect(n?.body).toContain('10月1日(木)2限');
    expect(n?.body).toContain('「21教室」から「11教室」に変更されました');

    h.clock.set('2026-09-29T00:30:00.000Z'); // the same class is now two days away
    const [m] = await svc.handleChange(
      makeEvent('classSession', 'y', {
        type: 'updated',
        entityId: today?.sessionId as ChangeEvent['entityId'],
        changedFields: ['room'],
        before: { room: 'A' },
        after: { room: 'B' },
      }),
    );
    expect(m?.kind).toBe('room_change');
    expect(m?.priority).toBe('high');
  });

  it('cancelled class is critical and deduped per course and date', async () => {
    const today = h.uc.context.today().classes[0];
    const mk = (): ChangeEvent =>
      makeEvent('classSession', 'c', {
        type: 'updated',
        entityId: today?.sessionId as ChangeEvent['entityId'],
        changedFields: ['status'],
        before: { status: 'scheduled' },
        after: { status: 'cancelled' },
      });
    const [n] = await svc.handleChange(mk());
    expect(n?.kind).toBe('class_cancelled');
    expect(n?.priority).toBe('critical');
    expect(n?.title).toBe('休講: 線形代数学II');
    expect(await svc.handleChange(mk())).toEqual([]);
  });

  it('ignores room changes of sessions that are already over', async () => {
    const today = h.uc.context.today().classes[0];
    h.clock.set('2026-10-03T00:00:00.000Z');
    const out = await svc.handleChange(
      makeEvent('classSession', 'old', {
        type: 'updated',
        entityId: today?.sessionId as ChangeEvent['entityId'],
        changedFields: ['room'],
        before: { room: 'A' },
        after: { room: 'B' },
      }),
    );
    expect(out).toEqual([]);
  });

  it('room change on a course offering is high', async () => {
    const [n] = await svc.handleChange(
      makeEvent('courseOffering', 'co', {
        type: 'updated',
        entityId: lcuDb,
        changedFields: ['room'],
        before: { room: 'A' },
        after: { room: 'B' },
      }),
    );
    expect(n).toMatchObject({ kind: 'room_change', priority: 'high' });
  });

  it('new assignment is normal priority and mentions the due date', async () => {
    const [n] = await svc.handleChange(
      makeEvent('assignment', 'a1', {
        type: 'created',
        courseOfferingId: lcuDb,
        after: { title: '課題9', dueAt: '2026-10-20T23:59:00+09:00' },
      }),
    );
    expect(n).toMatchObject({
      kind: 'new_assignment',
      priority: 'normal',
      title: '新しい課題: 課題9',
    });
    expect(n?.body).toContain('10/20 23:59');
    expect(n?.body).toContain('データベースシステム論');
  });

  it('deadline_changed is critical when the new due date is within 24 hours', async () => {
    const [n] = await svc.handleChange(
      makeEvent('assignment', 'a2', {
        type: 'updated',
        changedFields: ['dueAt'],
        before: { dueAt: '2026-10-08T23:59:00+09:00' },
        after: { dueAt: '2026-10-01T23:59:00+09:00', title: '課題X' },
      }),
    );
    expect(n).toMatchObject({ kind: 'deadline_changed', priority: 'critical' });
  });

  it('exam creation is high; unrelated events are ignored', async () => {
    const [n] = await svc.handleChange(
      makeEvent('exam', 'e1', {
        type: 'created',
        courseOfferingId: lcuDb,
        after: { title: '中間試験', startsAt: '2026-11-20T10:30:00+09:00', room: '大講義室' },
      }),
    );
    expect(n).toMatchObject({ kind: 'exam_announced', priority: 'high' });
    expect(n?.body).toContain('11/20 10:30');
    expect(n?.body).toContain('大講義室');
    for (const ev of [
      makeEvent('material', 'm', { type: 'created', after: { title: 'x' } }),
      makeEvent('assignment', 'a3', { type: 'updated', changedFields: ['title'] }),
      makeEvent('assignment', 'a4', { type: 'deleted' }),
    ])
      expect(await svc.handleChange(ev)).toEqual([]);
  });

  it('announcement rules: normal course posts are ignored, university and critical are not', async () => {
    const mk = (key: string, after: Record<string, string>): ChangeEvent =>
      makeEvent('announcement', key, {
        type: 'created',
        after: { title: `お知らせ${key}`, ...after },
      });
    expect(await svc.handleChange(mk('n', { importance: 'normal', scope: 'course' }))).toEqual([]);
    const [uni] = await svc.handleChange(mk('u', { importance: 'normal', scope: 'university' }));
    expect(uni).toMatchObject({ kind: 'important_announcement', priority: 'high' });
    const [crit] = await svc.handleChange(mk('c', { importance: 'critical', scope: 'course' }));
    expect(crit?.priority).toBe('critical');
  });
});

describe('deadline scheduler', () => {
  let h: SeedHarness;
  beforeEach(async () => {
    h = createSeedHarness();
    await h.syncAll();
    await h.day2();
  });
  afterEach(async () => {
    await h.uc.close();
  });

  const only = <T extends { title: string }>(list: T[], text: string): T[] =>
    list.filter((n) => n.title.includes(text));

  it('fires once when the 24h window opens, then at 3h and 1h with rising priority', async () => {
    const sink = memorySink();
    const svc = new NotificationService({ uc: h.uc, sinks: [sink] });
    expect(only(await svc.checkDeadlines(), '課題1')).toEqual([]); // 9 days before the deadline
    h.clock.set('2026-10-10T00:30:00+09:00'); // 23.5h left on 課題1 (due 10/10 23:59)
    const first = only(await svc.checkDeadlines(), '課題1');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: 'deadline_approaching', priority: 'normal' });
    expect(first[0]?.title).toBe('締切まであと約23時間: 課題1: ER図の作成');
    expect(first[0]?.body).toContain('10/10 23:59');
    expect(first[0]?.citations.length).toBeGreaterThan(0);
    expect(only(await svc.checkDeadlines(), '課題1')).toEqual([]);

    h.clock.set('2026-10-10T21:30:00+09:00'); // 2.5h left
    expect(only(await svc.checkDeadlines(), '課題1').map((n) => n.priority)).toEqual(['high']);

    h.clock.set('2026-10-10T23:20:00+09:00'); // 39 minutes left
    const third = only(await svc.checkDeadlines(), '課題1');
    expect(third.map((n) => n.priority)).toEqual(['critical']);
    expect(third[0]?.title).toContain('39分');
    expect(only(sink.sent, '課題1')).toHaveLength(3);
  });

  it('skips submitted tasks', async () => {
    const svc = new NotificationService({ uc: h.uc, sinks: [] });
    h.clock.set('2026-10-10T00:30:00+09:00');
    const out = await svc.checkDeadlines();
    expect(out.length).toBeGreaterThan(0);
    expect(only(out, '第2回 演習課題')).toEqual([]);
  });

  it('a moved deadline fires again (dueAt is part of the dedupe key)', async () => {
    const svc = new NotificationService({ uc: h.uc, sinks: [] });
    h.clock.set('2026-10-10T00:30:00+09:00');
    expect(only(await svc.checkDeadlines(), '課題1')).toHaveLength(1);
    expect(only(await svc.checkDeadlines(), '課題1')).toEqual([]);

    const lms = h.adapters.lms;
    expect(lms).toBeDefined();
    if (!lms) return;
    lms.dataset.assignments = (lms.dataset.assignments ?? []).map((a) =>
      a.id === 'a-1'
        ? { ...a, due: '2026-10-11T00:15:00+09:00', updatedAt: '2026-10-05T00:00:00Z' }
        : a,
    );
    await h.syncAll();
    const again = only(await svc.checkDeadlines(), '課題1');
    expect(again).toHaveLength(1);
    expect(again[0]?.dedupeKey).toContain('2026-10-11T00:15:00+09:00');
  });

  it('honours custom lead times and ignores invalid ones', async () => {
    const { logger, records } = createMemoryLogger();
    const svc = new NotificationService({
      uc: h.uc,
      sinks: [],
      logger,
      deadlineLeadTimes: ['6h', 'soon'],
    });
    expect(records.some((r) => r.msg === 'ignoring invalid deadline lead time')).toBe(true);
    h.clock.set('2026-10-10T00:30:00+09:00');
    expect(only(await svc.checkDeadlines(), '課題1')).toEqual([]);
    h.clock.set('2026-10-10T18:30:00+09:00'); // 5.5h left
    expect(only(await svc.checkDeadlines(), '課題1')).toHaveLength(1);
  });

  it('is driven by the clock timer once started, and does not repeat after a restart', async () => {
    const logFile = path.join(tmp, 'd.jsonl');
    const sink = memorySink();
    const svc = new NotificationService({
      uc: h.uc,
      sinks: [sink],
      logFile,
      deadlineCheckIntervalMs: 5 * 60_000,
    });
    svc.start();
    await h.clock.advance(0);
    expect(only(sink.sent, '課題1')).toEqual([]);
    h.clock.set('2026-10-10T00:30:00+09:00');
    await h.clock.advance(5 * 60_000);
    expect(only(sink.sent, '課題1')).toHaveLength(1);
    await h.clock.advance(5 * 60_000);
    expect(only(sink.sent, '課題1')).toHaveLength(1);
    svc.stop();

    const sink2 = memorySink();
    const svc2 = new NotificationService({ uc: h.uc, sinks: [sink2], logFile });
    svc2.start();
    await h.clock.advance(0);
    expect(only(sink2.sent, '課題1')).toEqual([]);
    svc2.stop();
  });
});
