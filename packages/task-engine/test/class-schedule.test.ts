import { type CanonicalEntityInput, stableId } from '@unicontext/canonical-model';
import { ManualClock, parseProfile } from '@unicontext/core';
import { EntityStore, openDatabase, type UniContextDatabase } from '@unicontext/database';
import { ConflictResolver } from '@unicontext/provenance';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PACE_PREDICATE, TaskEngine } from '../src/index.js';

// Synthetic university calendar and courses.
const profile = parseProfile(`
id: sample
academicCalendar:
  timezone: Asia/Tokyo
  periods:
    - { period: 1, start: '08:40', end: '10:10' }
    - { period: 2, start: '10:20', end: '11:50' }
    - { period: 3, start: '12:45', end: '14:15' }
  terms:
    - { id: '2030-1', name: '2030年度 前期', termCode: 前期, year: 2030, start: '2030-04-01', end: '2030-09-30', classes: { start: '2030-04-11', end: '2030-07-26' }, exams: { start: '2030-07-29', end: '2030-08-02' } }
    - { id: '2030-2', name: '2030年度 後期', termCode: 後期, year: 2030, start: '2030-10-01', end: '2031-03-31', classes: { start: '2030-10-01', end: '2031-01-31' } }
  noClassDays:
    - { date: '2030-05-16', note: 学園祭 }
`);

let db: UniContextDatabase;
let clock: ManualClock;
let engine: TaskEngine;
let entities: EntityStore;
const self = stableId('person', 'self');
const spring = stableId('courseOffering', 'lcu', 'spring');
const autumn = stableId('courseOffering', 'lcu', 'autumn');
const retake = stableId('courseOffering', 'lcu', 'retake');
const other = stableId('courseOffering', 'syllabus', 'other-class');

function put(entity: CanonicalEntityInput): void {
  entities.upsert(entity, { sourceId: 'lcu' });
}

function offering(
  id: string,
  term: string,
  schedule: { dayOfWeek: number; period: number; room?: string }[],
  extra: Record<string, unknown> = {},
): void {
  put({
    id,
    kind: 'courseOffering',
    title: `科目 ${id.slice(-4)}`,
    academicYear: 2030,
    term,
    instructorIds: [],
    instructorNames: [],
    schedule,
    ...extra,
  } as CanonicalEntityInput);
}

function enroll(id: string): void {
  put({
    id: stableId('enrollment', id),
    kind: 'enrollment',
    personId: self as never,
    courseOfferingId: id as never,
    role: 'student',
    status: 'active',
  });
}

beforeEach(() => {
  db = openDatabase();
  clock = new ManualClock('2030-05-09T00:00:00Z'); // Thu 2030-05-09 09:00 JST
  entities = new EntityStore(db, { clock });
  engine = new TaskEngine({ db, clock, timezone: 'Asia/Tokyo', profile });
  put({ id: self, kind: 'person', name: '本人', roles: ['student'], isSelf: true });
  offering(spring, '前期', [{ dayOfWeek: 4, period: 2, room: 'A101' }]);
  offering(autumn, '後期', [{ dayOfWeek: 4, period: 3, room: 'B201' }]);
  offering(retake, '前期', [], { scheduleType: 'unscheduled', room: 'C301' });
  // Another class of a subject (from a public syllabus) the student is not registered in.
  offering(other, '前期', [{ dayOfWeek: 4, period: 1 }]);
  enroll(spring);
  enroll(autumn);
  enroll(retake);
});
afterEach(() => db.close());

describe('ClassSchedule: weekly sessions from the timetable and the academic calendar', () => {
  it('generates the current term classes of registered courses only, with period times', () => {
    const s = engine.schedule.sessionsOn('2030-05-09');
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({
      courseOfferingId: spring,
      date: '2030-05-09',
      period: 2,
      startsAt: '2030-05-09T01:20:00.000Z',
      endsAt: '2030-05-09T02:50:00.000Z',
      room: 'A101',
      status: 'scheduled',
      sessionKind: 'class',
    });
  });

  it('nothing outside the class weeks, on no-class days or for 後期 courses in 前期', () => {
    expect(engine.schedule.sessionsOn('2030-04-04')).toEqual([]); // before 授業開始
    expect(engine.schedule.sessionsOn('2030-08-01')).toEqual([]); // exams
    expect(engine.schedule.noClassesReason('2030-08-01')).toBe('2030年度 前期の定期試験期間');
    expect(engine.schedule.sessionsOn('2030-05-16')).toEqual([]);
    expect(engine.schedule.noClassesReason('2030-05-16')).toBe('学園祭');
    // A source calendar holiday (all-day, category Holiday) also stops classes.
    put({
      id: stableId('calendarEvent', 'h'),
      kind: 'calendarEvent',
      title: '祝日',
      startsAt: '2030-05-22T15:00:00.000Z',
      allDay: true,
      category: 'Holiday',
    });
    expect(engine.schedule.sessionsOn('2030-05-23')).toEqual([]);
    // 後期 starts on 10/1 for the 後期 course only.
    expect(engine.schedule.sessionsOn('2030-10-03').map((x) => x.courseOfferingId)).toEqual([
      autumn,
    ]);
  });

  it('says why a new term is empty before registration', () => {
    entities.softDelete(stableId('enrollment', autumn));
    expect(engine.schedule.sessionsOn('2030-10-03')).toEqual([]);
    expect(engine.schedule.noClassesReason('2030-10-03')).toBe(
      '2030年度 後期に登録した科目はまだありません',
    );
  });

  it('時間割外 offerings get no class sessions, even with a linked syllabus timetable', () => {
    const all = engine.schedule.sessionsBetween('2030-04-01', '2030-08-01');
    expect(all.some((x) => x.courseOfferingId === retake)).toBe(false);
    expect(engine.schedule.scheduleTypeOf([retake])).toBe('unscheduled');
  });

  it('stored sessions (休講 with a period, whole-day room change) override generated ones', () => {
    put({
      id: stableId('classSession', 'cancel'),
      kind: 'classSession',
      courseOfferingId: spring as never,
      date: '2030-05-23',
      period: 2,
      status: 'cancelled',
      note: '休講',
    });
    put({
      id: stableId('classSession', 'room'),
      kind: 'classSession',
      courseOfferingId: spring as never,
      date: '2030-05-30',
      room: 'Z999',
      status: 'changed',
      note: '教室変更',
    });
    const cancelled = engine.schedule.sessionsOn('2030-05-23');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({
      id: stableId('classSession', 'cancel'),
      status: 'cancelled',
    });
    const moved = engine.schedule.sessionsOn('2030-05-30');
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({
      id: stableId('classSession', 'room'),
      period: 2,
      startsAt: '2030-05-30T01:20:00.000Z',
      room: 'Z999',
      status: 'changed',
    });
  });

  it("the student's pace slot adds weekly self-study sessions for a 時間割外 course", () => {
    // Stored the way `unicontext correct` / pace set stores user input (origin user, §74).
    new ConflictResolver(db, { clock }).correct({
      subject: retake,
      predicate: PACE_PREDICATE,
      value: { slots: [{ dayOfWeek: 6, startTime: '10:00', endTime: '11:30' }] },
    });
    const sat = engine.schedule.sessionsOn('2030-05-11');
    expect(sat).toEqual([
      expect.objectContaining({
        courseOfferingId: retake,
        sessionKind: 'self_study',
        startsAt: '2030-05-11T01:00:00.000Z',
        endsAt: '2030-05-11T02:30:00.000Z',
        note: '自習',
      }),
    ]);
    // nextClassAt ignores self-study.
    expect(engine.nextClassAt(retake, new Date('2030-05-09T00:00:00Z'))).toBeUndefined();
    expect(engine.nextClassAt(spring, new Date('2030-05-09T03:00:00Z'))?.toISOString()).toBe(
      '2030-05-23T01:20:00.000Z',
    );
  });
});
