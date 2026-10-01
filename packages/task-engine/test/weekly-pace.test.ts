import {
  type CanonicalEntityInput,
  type JsonValue,
  stableId,
  type Task,
} from '@unicontext/canonical-model';
import { ManualClock, parseProfile, PolicyViolationError } from '@unicontext/core';
import { EntityStore, openDatabase, type UniContextDatabase } from '@unicontext/database';
import { ConflictResolver } from '@unicontext/provenance';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PACE_PREDICATE, TaskEngine } from '../src/index.js';

// Synthetic calendar: classes 4/11-7/26, exams 7/29-8/2 (a Monday-to-Friday week).
const profile = parseProfile(`
id: sample
academicCalendar:
  timezone: Asia/Tokyo
  periods:
    - { period: 1, start: '08:40', end: '10:10' }
    - { period: 2, start: '10:20', end: '11:50' }
  terms:
    - { id: '2030-1', name: '2030年度 前期', termCode: 前期, year: 2030, start: '2030-04-01', end: '2030-09-30', classes: { start: '2030-04-11', end: '2030-07-26' }, exams: { start: '2030-07-29', end: '2030-08-02' } }
`);

let db: UniContextDatabase;
let clock: ManualClock;
let engine: TaskEngine;
let entities: EntityStore;
let resolver: ConflictResolver;
const self = stableId('person', 'self');
const retake = stableId('courseOffering', 'lcu', 'retake');
const quiet = stableId('courseOffering', 'lcu', 'quiet');
const weekly = stableId('courseOffering', 'lcu', 'weekly');

function put(entity: CanonicalEntityInput): void {
  entities.upsert(entity, { sourceId: 'lcu' });
}

function offering(id: string, title: string, schedule: unknown[] = [], extra = {}): void {
  put({
    id,
    kind: 'courseOffering',
    title,
    academicYear: 2030,
    term: '前期',
    instructorIds: [],
    instructorNames: [],
    schedule,
    ...extra,
  } as CanonicalEntityInput);
  put({
    id: stableId('enrollment', id),
    kind: 'enrollment',
    personId: self as never,
    courseOfferingId: id as never,
    role: 'student',
    status: 'active',
  });
}

function setSlots(slots: JsonValue[]): void {
  // a later observation each time, so the newest user fact wins
  clock.set(new Date(clock.now().getTime() + 1000));
  resolver.correct({ subject: retake, predicate: PACE_PREDICATE, value: { slots } });
}

const SAT_SLOT = { dayOfWeek: 6, startTime: '10:00', endTime: '11:30' };

function weeklyTasks(courseId: string = retake): Task[] {
  return engine
    .list({ courseOfferingId: courseId })
    .filter((t) => t.taskKind === 'weekly_pace')
    .sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? ''));
}
const dues = (tasks: Task[]): (string | undefined)[] => tasks.map((t) => t.dueAt);
// Sunday 23:59 JST of the week starting Monday 2030-MM-DD
const sun = (md: string): string => `2030-${md}T14:59:00.000Z`;

beforeEach(() => {
  db = openDatabase();
  // Thursday 2030-05-02 09:00 JST: the retake course is first seen now.
  clock = new ManualClock('2030-05-02T00:00:00Z');
  entities = new EntityStore(db, { clock });
  resolver = new ConflictResolver(db, { clock });
  engine = new TaskEngine({ db, clock, timezone: 'Asia/Tokyo', profile });
  put({ id: self, kind: 'person', name: '本人', roles: ['student'], isSelf: true });
  offering(retake, '物理学（再履修）', [], { scheduleType: 'unscheduled' });
  offering(quiet, '静かな科目', [], { scheduleType: 'unscheduled' });
  offering(weekly, '時間割のある科目', [{ dayOfWeek: 1, period: 2 }]);
});
afterEach(() => db.close());

describe('derive(): weekly 今週分 tasks for offerings without a weekly class', () => {
  it('needs pace slots or activity, and never applies to regular offerings', () => {
    clock.set('2030-05-09T00:00:00Z');
    engine.derive();
    expect(weeklyTasks(retake)).toEqual([]);
    expect(weeklyTasks(quiet)).toEqual([]);
    expect(weeklyTasks(weekly)).toEqual([]);

    setSlots([SAT_SLOT]);
    // a regular offering with activity still gets none
    put({
      id: stableId('announcement', 'w'),
      kind: 'announcement',
      courseOfferingId: weekly as never,
      title: '連絡',
      body: '',
      publishedAt: '2030-05-08T00:00:00Z',
      importance: 'normal',
      scope: 'course',
    });
    engine.derive();
    expect(weeklyTasks(retake)).toHaveLength(2);
    expect(weeklyTasks(weekly)).toEqual([]);
  });

  it('activity (an announcement) is enough without slots', () => {
    put({
      id: stableId('announcement', 'q'),
      kind: 'announcement',
      courseOfferingId: quiet as never,
      title: '連絡',
      body: '',
      publishedAt: '2030-05-02T00:00:00Z',
      importance: 'normal',
      scope: 'course',
    });
    clock.set('2030-05-09T00:00:00Z');
    engine.derive();
    expect(weeklyTasks(quiet)).toHaveLength(2);
  });

  it('creates the current week and earlier weeks, but only weeks ending after the offering was first seen', () => {
    setSlots([SAT_SLOT]);
    clock.set('2030-05-09T00:00:00Z'); // week of Mon 5/6; first seen Thu 5/2
    const report = engine.derive();
    const tasks = weeklyTasks();
    // 4/22-4/28 ended before it was first seen: not backfilled; 4/29-5/5 ended after
    expect(dues(tasks)).toEqual([sun('05-05'), sun('05-12')]);
    expect(report.created).toBeGreaterThanOrEqual(2);
    expect(tasks[0]).toMatchObject({
      id: stableId('task', 'weekly_pace', retake, '2030-04-29'),
      title: '物理学（再履修） 今週分',
      courseOfferingId: retake,
      createdBy: 'system',
      origin: 'inferred',
      taskKind: 'weekly_pace',
      status: 'pending',
      statusSetBy: 'system',
    });
    // the title does not change for past weeks
    expect(tasks[1]?.title).toBe(tasks[0]?.title);
  });

  it('keeps a 3-week window: older weekly tasks stay as they are, nothing new for finished weeks', () => {
    setSlots([SAT_SLOT]);
    clock.set('2030-05-09T00:00:00Z');
    engine.derive();
    const old = weeklyTasks()[0] as Task;

    clock.set('2030-05-23T00:00:00Z'); // week of Mon 5/20: window is 5/6, 5/13, 5/20
    const report = engine.derive();
    expect(dues(weeklyTasks())).toEqual([sun('05-05'), sun('05-12'), sun('05-19'), sun('05-26')]);
    expect(report.cancelled).toBe(0);
    expect(engine.get(old.id)).toMatchObject({ status: 'pending', statusSetBy: 'system' });
    expect(weeklyTasks().every((t) => t.status !== 'cancelled')).toBe(true);
  });

  it('only weeks overlapping the class weeks through the exam period', () => {
    // an offering first seen before the term: its weeks are limited by the term alone
    clock.set('2030-04-01T00:00:00Z');
    const early = stableId('courseOffering', 'lcu', 'early');
    offering(early, '早く登録した科目', [], { scheduleType: 'unscheduled' });
    put({
      id: stableId('announcement', 'e'),
      kind: 'announcement',
      courseOfferingId: early as never,
      title: '連絡',
      body: '',
      publishedAt: '2030-04-01T00:00:00Z',
      importance: 'normal',
      scope: 'course',
    });
    clock.set('2030-08-07T00:00:00Z'); // Wed 8/7: window 7/22, 7/29, 8/5
    engine.derive();
    // 7/22-7/28 (classes) and 7/29-8/4 (exams until 8/2) count; 8/5 is after the exam period
    expect(dues(weeklyTasks(early))).toEqual([sun('07-28'), sun('08-04')]);
  });

  it('no weeks after the term', () => {
    setSlots([SAT_SLOT]);
    clock.set('2031-01-10T00:00:00Z');
    engine.derive();
    expect(weeklyTasks()).toEqual([]);
  });

  it('notes list what is new that week and what is still not submitted', () => {
    setSlots([SAT_SLOT]);
    put({
      id: stableId('announcement', 'a'),
      kind: 'announcement',
      courseOfferingId: retake as never,
      title: '第3回の連絡',
      body: '',
      publishedAt: '2030-05-08T03:00:00Z',
      importance: 'normal',
      scope: 'course',
    });
    put({
      id: stableId('announcement', 'old'),
      kind: 'announcement',
      courseOfferingId: retake as never,
      title: '先週のお知らせ',
      body: '',
      publishedAt: '2030-05-01T03:00:00Z',
      importance: 'normal',
      scope: 'course',
    });
    put({
      id: stableId('material', 'm'),
      kind: 'material',
      courseOfferingId: retake as never,
      title: '第3回スライド',
      materialKind: 'slides',
      publishedAt: '2030-05-09T01:00:00Z',
    });
    put({
      id: stableId('assignment', 'new'),
      kind: 'assignment',
      courseOfferingId: retake as never,
      title: 'レポート2',
      availableFrom: '2030-05-07T00:00:00Z',
      dueAt: '2030-05-20T14:59:00Z',
    });
    put({
      id: stableId('assignment', 'pending'),
      kind: 'assignment',
      courseOfferingId: retake as never,
      title: 'レポート1',
      availableFrom: '2030-05-01T00:00:00Z',
      dueAt: '2030-05-15T14:59:00Z',
    });
    put({
      id: stableId('assignment', 'done'),
      kind: 'assignment',
      courseOfferingId: retake as never,
      title: '提出済みのレポート',
      availableFrom: '2030-05-01T00:00:00Z',
      dueAt: '2030-05-15T14:59:00Z',
    });
    clock.set('2030-05-09T00:00:00Z');
    engine.derive();
    engine.setStatus(stableId('task', 'assignment', stableId('assignment', 'done')), 'submitted', {
      actor: 'user',
    });
    engine.derive();

    const current = weeklyTasks().find((t) => t.dueAt === sun('05-12')) as Task;
    expect(current.notes?.split('\n')).toEqual([
      '新着: お知らせ「第3回の連絡」、資料「第3回スライド」、課題「レポート2」',
      '未提出: 課題「レポート1」（5/15 23:59締切）',
    ]);
    // the previous week lists what was new then, and still owed work due from then on
    const previous = weeklyTasks().find((t) => t.dueAt === sun('05-05')) as Task;
    const [fresh, owed] = (previous.notes ?? '').split('\n');
    expect(fresh).toContain('お知らせ「先週のお知らせ」');
    expect(fresh).toContain('課題「レポート1」');
    expect(fresh).toContain('課題「提出済みのレポート」');
    expect(fresh).not.toContain('レポート2');
    expect(owed).toBe('未提出: 課題「レポート2」（5/20 23:59締切）');
  });

  it('a week without news has no notes', () => {
    setSlots([SAT_SLOT]);
    clock.set('2030-05-09T00:00:00Z');
    engine.derive();
    expect(weeklyTasks().map((t) => t.notes)).toEqual([undefined, undefined]);
  });

  it('keeps the status the student set; derive() does not reset or cancel it', () => {
    setSlots([SAT_SLOT]);
    clock.set('2030-05-09T00:00:00Z');
    engine.derive();
    const [past] = weeklyTasks() as [Task, Task];
    const done = engine.setStatus(past.id, 'completed', { actor: 'user', note: '終わった' });
    expect(done).toMatchObject({ status: 'completed', statusSetBy: 'user' });
    engine.derive();
    expect(engine.get(past.id)).toMatchObject({
      status: 'completed',
      statusSetBy: 'user',
      notes: '終わった',
    });

    // the offering stops qualifying: the sweep cancels untouched tasks only
    setSlots([]);
    engine.derive();
    const after = weeklyTasks();
    expect(after.find((t) => t.id === past.id)?.status).toBe('completed');
    expect(after.filter((t) => t.id !== past.id).map((t) => t.status)).toEqual(['cancelled']);
    // and it comes back when the slot returns
    setSlots([SAT_SLOT]);
    engine.derive();
    expect(weeklyTasks().map((t) => t.status)).toEqual(['completed', 'pending']);
  });

  it('the AI cannot complete a weekly task (§19)', () => {
    setSlots([SAT_SLOT]);
    clock.set('2030-05-09T00:00:00Z');
    engine.derive();
    const [task] = weeklyTasks() as [Task];
    expect(() => engine.setStatus(task.id, 'completed', { actor: 'ai' })).toThrow(
      PolicyViolationError,
    );
    expect(() => engine.setStatus(task.id, 'submitted', { actor: 'ai' })).toThrow(
      PolicyViolationError,
    );
    expect(engine.get(task.id)?.status).toBe('pending');
  });

  it('paceStatusOf: falling behind escalates week by week; completing the last week clears it', () => {
    setSlots([SAT_SLOT]);
    clock.set('2030-05-09T00:00:00Z');
    engine.derive();
    expect(engine.paceStatusOf(retake)).toEqual({ behindWeeks: 1, unsubmitted: 0 });

    clock.set('2030-05-16T00:00:00Z'); // 5/13 is the current week; 5/6 and 4/29 are past
    engine.derive();
    expect(engine.paceStatusOf(retake).behindWeeks).toBe(2);

    clock.set('2030-05-23T00:00:00Z');
    engine.derive();
    expect(engine.paceStatusOf(retake).behindWeeks).toBe(3);

    const lastWeek = weeklyTasks().find((t) => t.dueAt === sun('05-19')) as Task;
    engine.setStatus(lastWeek.id, 'completed', { actor: 'user' });
    expect(engine.paceStatusOf(retake)).toEqual({
      behindWeeks: 0,
      unsubmitted: 0,
      lastCompletedWeek: '2030-05-13',
    });
  });
});
