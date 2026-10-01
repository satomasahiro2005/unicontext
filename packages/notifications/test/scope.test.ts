import type { ChangeEvent } from '@unicontext/canonical-model';
import { ManualClock } from '@unicontext/core';
import {
  createFakeConnector,
  type FakeConnectorOptions,
  type FakeDataset,
  type FakeSourceAdapter,
} from '@unicontext/connector-sdk';
import { createUniContext, type UniContext } from '@unicontext/context-engine';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDesktopSink,
  FLOOD_LIMIT,
  type NotifierLike,
  NotificationService,
} from '../src/index.js';
import { memorySink } from './helpers.js';

/** 2026-10-01 09:30 JST, the first day of the 2026 後期 term. */
const NOW = '2026-10-01T00:30:00.000Z';
const FUTURE = '2026-10-08';
const PAST = '2026-09-24';

type Courses = NonNullable<FakeDataset['courses']>;

function lcuCourse(id: string, title: string, room: string, term = '後期'): Courses[number] {
  return {
    id,
    code: id,
    title,
    year: 2026,
    term,
    room,
    enrolled: true,
    schedule: [{ day: 4, period: 2, room }],
  };
}

function lcuOptions(dataset: FakeDataset): FakeConnectorOptions {
  return {
    product: 'livecampusu',
    sourceLabel: '学務情報システム',
    authority: 'academic-system',
    // The academic system is the enrollment authority.
    capabilities: ['courses', 'enrollments', 'timetable', 'rooms'],
    dataset,
  };
}

function syllabusCourse(n: number, room?: string): Courses[number] {
  return {
    id: `syl-${n}`,
    code: `Z${String(n).padStart(4, '0')}`,
    title: `教職科目${n}`,
    year: 2026,
    term: '後期',
    ...(room ? { room, schedule: [{ day: 2, period: 3, room }] } : { schedule: [] }),
  };
}

interface World {
  uc: UniContext;
  clock: ManualClock;
  lcu: FakeSourceAdapter;
  syllabus: FakeSourceAdapter;
  sync(sourceId: 'lcu' | 'syllabus'): Promise<void>;
}

function createWorld(lcuDataset: FakeDataset, syllabusDataset: FakeDataset = {}): World {
  const clock = new ManualClock(NOW);
  const uc = createUniContext({ profile: 'shizuoka-university', clock });
  const lcu = createFakeConnector(lcuOptions(lcuDataset));
  const syllabus = createFakeConnector({
    product: 'syllabus',
    sourceLabel: 'シラバス',
    authority: 'syllabus',
    capabilities: ['courses', 'timetable', 'rooms'],
    referenceOnly: true,
    dataset: syllabusDataset,
  });
  for (const [sourceId, fake] of [
    ['lcu', lcu],
    ['syllabus', syllabus],
  ] as const)
    uc.sync.register({
      sourceId,
      adapter: fake.adapter,
      normalizer: fake.normalizer,
      metadata: fake.metadata,
    });
  return {
    uc,
    clock,
    lcu: lcu.adapter,
    syllabus: syllabus.adapter,
    async sync(sourceId) {
      await uc.sync.sync(sourceId);
    },
  };
}

function session(course: string, date: string, room: string) {
  return { id: `s-${course}-${date}`, courseId: course, date, period: 2, room };
}

let w: World | undefined;
afterEach(async () => {
  await w?.uc.close();
  w = undefined;
});

describe('catalog ingest (the 30 desktop toasts of the real data)', () => {
  const catalog = (count: number, room: (n: number) => string): Courses =>
    Array.from({ length: count }, (_, n) => syllabusCourse(n + 1, room(n + 1)));

  it('catalog offerings that the student does not take never notify', async () => {
    w = createWorld({ courses: [lcuCourse('E1', '情報工学基礎', '情報1')] });
    const sink = memorySink();
    const svc = new NotificationService({ uc: w.uc, sinks: [sink] });
    svc.start();
    // Day 1: the syllabus module knows only the student's own subjects (no rooms yet).
    w.syllabus.dataset = { courses: [syllabusCourse(1)] };
    await w.sync('lcu');
    await w.sync('syllabus');
    // Day 2: the catalog is enabled — whole-faculty listing, rooms filled in, same titles repeated.
    w.syllabus.dataset = {
      courses: [
        syllabusCourse(1, '共通A101'),
        ...catalog(40, (n) => `共通B${n}`),
        // Several classes of one subject (基礎英語Ｂ): the same room change used to fire 6 times.
        ...Array.from({ length: 6 }, (_, k) => ({
          ...syllabusCourse(100 + k, '共通C1'),
          title: '基礎英語Ｂ',
        })),
      ],
    };
    await w.sync('syllabus');
    // Day 3: rooms move around in the catalog.
    w.syllabus.dataset = {
      courses: [
        syllabusCourse(1, '共通A102'),
        ...catalog(40, (n) => `共通D${n}`),
        ...Array.from({ length: 6 }, (_, k) => ({
          ...syllabusCourse(100 + k, '共通C2'),
          title: '基礎英語Ｂ',
        })),
      ],
    };
    await w.sync('syllabus');
    svc.stop();

    const catalogChanges = w.uc.sync.stores.changes.list({ sourceId: 'syllabus' });
    expect(catalogChanges.some((c) => c.changedFields.includes('room'))).toBe(true); // the bug's input
    expect(sink.sent).toEqual([]);
    expect(svc.list()).toEqual([]);
  });

  it('keeps catalog offerings out of the changes, today and week views', async () => {
    w = createWorld({ courses: [lcuCourse('E1', '情報工学基礎', '情報1')] });
    w.syllabus.dataset = { courses: [syllabusCourse(1)] };
    await w.sync('lcu');
    await w.sync('syllabus');
    w.syllabus.dataset = {
      courses: [syllabusCourse(1, '共通A101'), ...catalog(5, (n) => `B${n}`)],
    };
    w.lcu.dataset = { courses: [lcuCourse('E1', '情報工学基礎', '情報2')] };
    await w.sync('syllabus');
    await w.sync('lcu');

    const since = '2026-09-30T00:00:00.000Z';
    expect(w.uc.sync.stores.changes.list({ sourceId: 'syllabus' }).length).toBeGreaterThan(5);
    const views = [
      w.uc.context.changesSince({ since }).changes,
      w.uc.context.today().changes,
      w.uc.context.week().changes,
    ];
    for (const changes of views) {
      expect(changes.length).toBeGreaterThan(0);
      expect(changes.every((c) => c.course?.title === '情報工学基礎')).toBe(true);
    }
    // The enrolled course is listed, the 40+ catalog offerings are not.
    const all = JSON.stringify([views, w.uc.context.today().classes, w.uc.context.week().days]);
    expect(all).not.toContain('教職科目');
  });
});

describe('enrolled courses', () => {
  it('a room change of a future class of an enrolled course fires exactly one notification', async () => {
    w = createWorld({
      courses: [lcuCourse('E1', 'データベース演習', '情報1')],
      sessions: [session('E1', FUTURE, '情報1')],
    });
    const sink = memorySink();
    const svc = new NotificationService({ uc: w.uc, sinks: [sink] });
    svc.start();
    await w.sync('lcu');
    expect(sink.sent).toEqual([]);

    w.lcu.dataset.sessions = [session('E1', FUTURE, '情報3')];
    w.clock.set('2026-10-02T00:30:00.000Z');
    await w.sync('lcu');
    svc.stop();

    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]).toMatchObject({
      kind: 'room_change',
      priority: 'high',
      title: '教室変更: データベース演習',
    });
    expect(sink.sent[0]?.body).toContain('「情報1」から「情報3」に変更されました');
  });

  it('stays silent about classes that are already over', async () => {
    w = createWorld({
      courses: [lcuCourse('E1', 'データベース演習', '情報1')],
      sessions: [session('E1', PAST, '情報1')],
    });
    const sink = memorySink();
    const svc = new NotificationService({ uc: w.uc, sinks: [sink] });
    svc.start();
    await w.sync('lcu');
    w.lcu.dataset.sessions = [session('E1', PAST, '情報3')];
    await w.sync('lcu');
    svc.stop();
    expect(sink.sent).toEqual([]);
  });

  it('stays silent about an enrolled course of a term that has ended', async () => {
    w = createWorld({
      courses: [
        lcuCourse('E1', '前期の科目', '情報1', '前期'),
        lcuCourse('E2', '後期の科目', '情報1'),
      ],
    });
    const sink = memorySink();
    const svc = new NotificationService({ uc: w.uc, sinks: [sink] });
    svc.start();
    await w.sync('lcu');
    w.lcu.dataset.courses = [
      lcuCourse('E1', '前期の科目', '情報9', '前期'),
      lcuCourse('E2', '後期の科目', '情報9'),
    ];
    await w.sync('lcu');
    svc.stop();
    expect(sink.sent.map((n) => n.title)).toEqual(['教室変更: 後期の科目']);
  });

  it('fires one notification per course, kind and value per day, even for sibling offerings', async () => {
    w = createWorld({
      courses: [
        lcuCourse('E1', '基礎英語Ｂ', 'A1'),
        lcuCourse('E2', '基礎英語Ｂ', 'A1'),
        lcuCourse('E3', '基礎英語Ｂ', 'A1'),
      ],
    });
    const sink = memorySink();
    const svc = new NotificationService({ uc: w.uc, sinks: [sink] });
    svc.start();
    await w.sync('lcu');
    w.lcu.dataset.courses = [
      lcuCourse('E1', '基礎英語Ｂ', 'A2'),
      lcuCourse('E2', '基礎英語Ｂ', 'A2'),
      lcuCourse('E3', '基礎英語Ｂ', 'A2'),
    ];
    await w.sync('lcu');
    // Another value is news again; going back to a value already announced today is not.
    const rooms = (room: string): Courses =>
      ['E1', 'E2', 'E3'].map((id) => lcuCourse(id, '基礎英語Ｂ', room));
    w.lcu.dataset.courses = rooms('A3');
    await w.sync('lcu');
    w.lcu.dataset.courses = rooms('A2');
    await w.sync('lcu');
    svc.stop();
    expect(sink.sent.filter((n) => n.kind === 'room_change').map((n) => n.body)).toEqual([
      expect.stringContaining('「A2」に変更'),
      expect.stringContaining('「A3」に変更'),
    ]);
  });
});

describe('origin of the change', () => {
  it('the first ingest of an enrolled source never notifies', async () => {
    w = createWorld({
      courses: [lcuCourse('E1', 'データベース演習', '情報1')],
      sessions: [session('E1', FUTURE, '情報1')],
    });
    const sink = memorySink();
    const svc = new NotificationService({ uc: w.uc, sinks: [sink] });
    svc.start();
    await w.sync('lcu');
    svc.stop();
    expect(sink.sent).toEqual([]);
    expect(svc.list()).toEqual([]);
  });

  it('initial, reprocess and reclassified events are dropped; a genuine sync event is kept', async () => {
    w = createWorld({
      courses: [lcuCourse('E1', 'データベース演習', '情報1')],
      sessions: [session('E1', FUTURE, '情報1')],
    });
    await w.sync('lcu');
    const seen: ChangeEvent[] = [];
    w.uc.bus.on('change', (e) => {
      seen.push(e);
    });
    w.lcu.dataset.sessions = [session('E1', FUTURE, '情報3')];
    await w.sync('lcu');
    const ev = seen.find((e) => e.entityKind === 'classSession');
    expect(ev).toBeDefined();
    if (!ev) return;

    for (const origin of ['initial', 'reprocess'] as const) {
      const svc = new NotificationService({ uc: w.uc, sinks: [] });
      expect(await svc.handleChange({ ...ev, origin })).toEqual([]);
      expect(await svc.handleSettled({ sourceId: 'lcu', origin, count: 1 })).toEqual([]);
      expect(svc.list()).toEqual([]);
    }
    const svc = new NotificationService({ uc: w.uc, sinks: [] });
    expect(await svc.handleChange({ ...ev, origin: 'sync' })).toEqual([]); // held until settled
    const out = await svc.handleSettled({ sourceId: 'lcu', origin: 'sync', count: 1 });
    expect(out.map((n) => n.kind)).toEqual(['room_change']);
  });
});

describe('flood guard', () => {
  function toaster(): { notifier: NotifierLike; toasts: { title: string; message: string }[] } {
    const toasts: { title: string; message: string }[] = [];
    return {
      toasts,
      notifier: {
        notify(options, callback) {
          toasts.push({ title: options.title, message: options.message });
          callback?.(null);
          return undefined;
        },
      },
    };
  }

  async function run(changed: number): Promise<{
    toasts: { title: string; message: string }[];
    logged: number;
    console: number;
  }> {
    const ids = Array.from({ length: changed }, (_, i) => `E${i}`);
    w = createWorld({
      courses: ids.map((id, i) => lcuCourse(id, `科目${i}`, '情報1')),
      sessions: ids.map((id) => session(id, FUTURE, '情報1')),
    });
    const { notifier, toasts } = toaster();
    const desktop = await createDesktopSink({ load: () => Promise.resolve(notifier) });
    const other = memorySink('console');
    const svc = new NotificationService({
      uc: w.uc,
      sinks: desktop ? [desktop, other] : [other],
    });
    svc.start();
    await w.sync('lcu');
    w.lcu.dataset.sessions = ids.map((id) => session(id, FUTURE, '情報3'));
    await w.sync('lcu');
    svc.stop();
    return {
      toasts,
      logged: svc.list().filter((n) => n.kind === 'room_change').length,
      console: other.sent.length,
    };
  }

  it('shows a few notifications one by one', async () => {
    const r = await run(FLOOD_LIMIT);
    expect(r.toasts).toHaveLength(FLOOD_LIMIT);
    expect(r.toasts[0]?.title).toContain('教室変更');
  });

  it('collapses more than three desktop toasts of one sync run into one summary', async () => {
    const r = await run(12);
    expect(r.toasts).toEqual([{ title: 'UniContext', message: '変更が12件あります' }]);
    // The details are still in the log and reach the other sinks.
    expect(r.logged).toBe(12);
    expect(r.console).toBe(12);
  });
});
