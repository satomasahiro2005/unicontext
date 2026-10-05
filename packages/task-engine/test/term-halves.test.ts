import {
  type CanonicalEntityInput,
  stableId,
  TERM_SLOTS_PREDICATE,
} from '@unicontext/canonical-model';
import { ManualClock, parseProfile } from '@unicontext/core';
import { EntityStore, openDatabase, type UniContextDatabase } from '@unicontext/database';
import { ConflictResolver } from '@unicontext/provenance';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PACE_PREDICATE, TaskEngine } from '../src/index.js';

// Synthetic 後期 split into halves; the boundary differs by weekday (Thursday switches first).
// 2030-10-01 is a Tuesday.
const profile = parseProfile(`
id: sample
academicCalendar:
  timezone: Asia/Tokyo
  periods:
    - { period: 1, start: '08:40', end: '10:10' }
    - { period: 2, start: '10:20', end: '11:50' }
    - { period: 3, start: '12:45', end: '14:15' }
    - { period: 4, start: '14:25', end: '15:55' }
  terms:
    - id: '2030-2'
      name: '2030年度 後期'
      termCode: 後期
      year: 2030
      start: '2030-10-01'
      end: '2031-03-31'
      classes: { start: '2030-10-01', end: '2031-01-31' }
      exams: { start: '2031-02-03', end: '2031-02-07' }
      parts:
        - name: 後期前半
          half: 前半
          start: '2030-10-01'
          end: '2030-11-25'
          weekdays:
            '1': { start: '2030-10-07', end: '2030-11-25' }
            '4': { start: '2030-10-03', end: '2030-11-14' }
        - name: 後期後半
          half: 後半
          start: '2030-11-21'
          end: '2031-02-07'
          weekdays:
            '1': { start: '2030-12-02', end: '2031-02-03' }
            '4': { start: '2030-11-21', end: '2031-02-06' }
`);

let db: UniContextDatabase;
let clock: ManualClock;
let engine: TaskEngine;
let entities: EntityStore;
const self = stableId('person', 'self');
const secondHalf = stableId('courseOffering', 'syllabus', 'second-half'); // 月1, 後半 only
const whole = stableId('courseOffering', 'lcu', 'whole'); // 木2, halves not stated
const perSlot = stableId('courseOffering', 'lcu', 'per-slot'); // 木3 both, 木4 前半 only
const firstHalf = stableId('courseOffering', 'lcu', 'first-half'); // 木1, 前半 only
const onDemand = stableId('courseOffering', 'lcu', 'on-demand'); // 時間割外, 後半 only

function put(entity: CanonicalEntityInput): void {
  entities.upsert(entity, { sourceId: 'lcu' });
}

function offering(
  id: string,
  schedule: { dayOfWeek: number; period: number }[],
  extra: Record<string, unknown> = {},
): void {
  put({
    id,
    kind: 'courseOffering',
    title: `科目 ${id.slice(-4)}`,
    academicYear: 2030,
    term: '後期',
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

const courses = (date: string): string[] =>
  engine.schedule.sessionsOn(date).map((s) => `${s.courseOfferingId}#${s.period ?? ''}`);

beforeEach(() => {
  db = openDatabase();
  clock = new ManualClock('2030-10-07T00:00:00Z');
  entities = new EntityStore(db, { clock });
  engine = new TaskEngine({ db, clock, timezone: 'Asia/Tokyo', profile });
  put({ id: self, kind: 'person', name: '本人', roles: ['student'], isSelf: true });
  offering(secondHalf, [{ dayOfWeek: 1, period: 1 }], { termParts: ['後半'] });
  offering(whole, [{ dayOfWeek: 4, period: 2 }]);
  // The syllabus says 後半, but the academic system's per-slot text (term_slots) wins.
  offering(
    perSlot,
    [
      { dayOfWeek: 4, period: 3 },
      { dayOfWeek: 4, period: 4 },
    ],
    { termParts: ['後半'] },
  );
  offering(firstHalf, [{ dayOfWeek: 4, period: 1 }], { termParts: ['前半'] });
  offering(onDemand, [], { scheduleType: 'unscheduled', termParts: ['後半'] });
  const resolver = new ConflictResolver(db, { clock });
  resolver.correct({
    subject: perSlot,
    predicate: TERM_SLOTS_PREDICATE,
    value: {
      slots: [
        { half: '前半', dayOfWeek: 4, period: 3 },
        { half: '前半', dayOfWeek: 4, period: 4 },
        { half: '後半', dayOfWeek: 4, period: 3 },
      ],
    },
  });
});
afterEach(() => db.close());

describe('ClassSchedule: half-term courses (前半 / 後半)', () => {
  it('resolves the halves from term_slots facts first, then the offering', () => {
    const byId = new Map<string, ReturnType<typeof engine.schedule.enrolledOfferings>[number]>(
      engine.schedule.enrolledOfferings().map((e) => [e.offering.id, e]),
    );
    const label = (id: string) => {
      const e = byId.get(id);
      return e ? engine.schedule.termPartLabelOf(e) : 'missing';
    };
    expect(label(secondHalf)).toBe('後期後半');
    expect(label(firstHalf)).toBe('後期前半');
    expect(label(whole)).toBeUndefined();
    expect(label(perSlot)).toBe('後期（前半・後半）');
    expect(byId.get(perSlot)?.termParts).toMatchObject({
      via: 'term_slots',
      slots: [
        { dayOfWeek: 4, period: 3, halves: ['前半', '後半'] },
        { dayOfWeek: 4, period: 4, halves: ['前半'] },
      ],
    });
  });

  it('a 後半-only course has no classes in 前半, including the switch-over week of its weekday', () => {
    expect(courses('2030-10-07')).toEqual([]); // Monday, 前半
    // Other courses meet in 前半, so Monday is just a day without classes.
    expect(engine.schedule.noClassesReason('2030-10-07')).toBeUndefined();
    // Monday's 8th class is still 前半 even though Thursday already switched (11/21).
    expect(courses('2030-11-25')).toEqual([]);
    expect(courses('2030-12-02')).toEqual([`${secondHalf}#1`]);
  });

  it('explains an empty 前半 when every registered course is a 後半 course', () => {
    for (const id of [whole, perSlot, firstHalf])
      put({
        id: stableId('enrollment', id),
        kind: 'enrollment',
        personId: self as never,
        courseOfferingId: id as never,
        role: 'student',
        status: 'dropped',
      });
    expect(engine.schedule.noClassesReason('2030-10-10')).toBe(
      '後期前半に授業のある科目は登録されていません',
    );
    // In the switch-over weeks some weekdays are already in 後半: no blanket statement.
    expect(engine.schedule.noClassesReason('2030-11-24')).toBeUndefined();
  });

  it('Thursday switches on its own boundary, per slot', () => {
    expect(courses('2030-11-14')).toEqual([
      `${firstHalf}#1`,
      `${whole}#2`,
      `${perSlot}#3`,
      `${perSlot}#4`,
    ]);
    // 11/21: Thursday's first 後半 class. 前半-only courses and slots are gone.
    expect(courses('2030-11-21')).toEqual([`${whole}#2`, `${perSlot}#3`]);
    expect(courses('2031-01-30')).toEqual([`${whole}#2`, `${perSlot}#3`]);
  });

  it('reports the half of a date and the switch-over weeks', () => {
    expect(engine.schedule.currentHalf('2030-10-10')).toMatchObject({
      half: '前半',
      label: '後期前半',
      switchover: false,
    });
    expect(engine.schedule.currentHalf('2030-11-21')).toMatchObject({
      half: '後半',
      label: '後期後半',
      switchover: true,
    });
    expect(engine.schedule.currentHalf('2030-11-25')).toMatchObject({
      half: '前半',
      switchover: true,
    });
    expect(engine.schedule.currentHalf('2031-03-01')).toBeUndefined();
  });

  it('self-study of a 後半-only 時間割外 course runs only in 後半', () => {
    new ConflictResolver(db, { clock }).correct({
      subject: onDemand,
      predicate: PACE_PREDICATE,
      value: { slots: [{ dayOfWeek: 6, startTime: '10:00', endTime: '11:30' }] },
    });
    expect(engine.schedule.sessionsOn('2030-10-12')).toEqual([]);
    expect(engine.schedule.sessionsOn('2030-12-07')).toEqual([
      expect.objectContaining({ courseOfferingId: onDemand, sessionKind: 'self_study' }),
    ]);
    // Weekly 「今週分」 tasks too: none in 前半, from the 後半 weeks on.
    const weekly = () =>
      engine.list({ courseOfferingId: onDemand }).filter((t) => t.taskKind === 'weekly_pace');
    clock.set('2030-10-16T00:00:00Z');
    engine.derive();
    expect(weekly()).toEqual([]);
    clock.set('2030-12-04T00:00:00Z');
    engine.derive();
    expect(weekly().map((t) => t.dueAt)).toContain('2030-12-08T14:59:00.000Z');
  });
});
