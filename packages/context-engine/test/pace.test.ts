import { type CanonicalEntityInput, stableId } from '@unicontext/canonical-model';
import { ManualClock, NotFoundError, parseProfile, ValidationError } from '@unicontext/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUniContext, setPaceSlots, type UniContext } from '../src/index.js';

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

let uc: UniContext;
let clock: ManualClock;
const self = stableId('person', 'self');
const retake = stableId('courseOffering', 'lcu', 'retake');
const intensive = stableId('courseOffering', 'lcu', 'intensive');
const regular = stableId('courseOffering', 'lcu', 'regular');

function put(entity: CanonicalEntityInput): void {
  uc.sync.stores.entities.upsert(entity, { sourceId: 'lcu' });
}

function offering(id: string, title: string, schedule: unknown[], extra = {}): void {
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

const SLOT = '土 10:00-11:30';
const tick = (): void => clock.set(new Date(clock.now().getTime() + 1000));

beforeEach(() => {
  clock = new ManualClock('2030-05-02T00:00:00Z'); // Thu 5/2, first seen
  uc = createUniContext({ profile, clock });
  put({ id: self, kind: 'person', name: '本人', roles: ['student'], isSelf: true });
  offering(retake, '物理学（再履修）', [], { scheduleType: 'unscheduled' });
  offering(intensive, '集中講義A', [], { scheduleType: 'intensive' });
  offering(regular, '線形代数', [{ dayOfWeek: 1, period: 2 }]);
});
afterEach(async () => {
  await uc.close();
});

describe('setPaceSlots', () => {
  it('stores a user fact, derives the weekly tasks and clears with []', () => {
    clock.set('2030-05-09T00:00:00Z');
    const { slots, fact } = setPaceSlots(uc, { id: retake }, [SLOT, '水2限']);
    expect(fact.origin).toBe('user');
    expect(slots.map((s) => s.dayOfWeek)).toEqual([3, 6]);
    expect(uc.tasks.schedule.paceSlots([retake]).map((s) => s.period)).toEqual([2, undefined]);
    expect(uc.tasks.list().filter((t) => t.taskKind === 'weekly_pace')).toHaveLength(2);
    tick();
    setPaceSlots(uc, { id: retake }, []);
    expect(uc.tasks.schedule.paceSlots([retake])).toEqual([]);
    expect(
      uc.tasks.list().filter((t) => t.taskKind === 'weekly_pace' && t.status !== 'cancelled'),
    ).toHaveLength(0);
  });

  it('accepts slot objects and refuses unreadable input or unknown courses', () => {
    setPaceSlots(uc, { id: retake }, [{ dayOfWeek: 6, startTime: '10:00', endTime: '11:30' }]);
    expect(uc.tasks.schedule.paceSlots([retake])).toHaveLength(1);
    expect(() => setPaceSlots(uc, { id: retake }, ['いつか'])).toThrow(ValidationError);
    expect(() => setPaceSlots(uc, { id: retake }, [{ dayOfWeek: 9, period: 1 }])).toThrow(
      ValidationError,
    );
    expect(() => setPaceSlots(uc, { id: retake }, [{ dayOfWeek: 1 }])).toThrow(ValidationError);
    expect(() => setPaceSlots(uc, { id: 'courseOffering:nope' }, [SLOT])).toThrow(NotFoundError);
    // a refused call stores nothing
    expect(uc.tasks.schedule.paceSlots([retake])).toHaveLength(1);
  });
});

describe('pacing: today(), paceOverview() and admin()', () => {
  it('lists enrolled unscheduled / intensive courses without slots in admin()', () => {
    const list = uc.context.admin().unscheduledWithoutPace;
    expect(list.map((x) => [x.course.title, x.scheduleType]).sort()).toEqual([
      ['物理学（再履修）', 'unscheduled'],
      ['集中講義A', 'intensive'],
    ]);
    setPaceSlots(uc, { id: retake }, [SLOT]);
    expect(uc.context.admin().unscheduledWithoutPace.map((x) => x.course.title)).toEqual([
      '集中講義A',
    ]);
  });

  it('paceOverview: enrolled courses of the term with their slots and this week', () => {
    clock.set('2030-05-09T00:00:00Z');
    setPaceSlots(uc, { id: retake }, [SLOT]);
    const { courses } = uc.context.paceOverview();
    expect(courses.map((c) => `${c.course.title}:${c.scheduleType}`).sort()).toEqual(
      ['物理学（再履修）:unscheduled', '線形代数:regular', '集中講義A:intensive'].sort(),
    );
    const row = courses.find((c) => c.course.id === retake);
    expect(row?.slots.map((s) => s.text)).toEqual([SLOT]);
    expect(row?.thisWeek).toMatchObject({ status: 'pending', dueAt: '2030-05-12T14:59:00.000Z' });
    expect(row?.behindWeeks).toBe(1);
    const other = courses.find((c) => c.course.id === regular);
    expect(other?.slots).toEqual([]);
    expect(other?.thisWeek).toBeUndefined();
  });

  it('paceOverview also lists a course outside the current term that has slots', () => {
    const other = stableId('courseOffering', 'lcu', 'autumn');
    put({
      id: other,
      kind: 'courseOffering',
      title: '来期の科目',
      academicYear: 2030,
      term: '後期',
      instructorIds: [],
      instructorNames: [],
      schedule: [],
      scheduleType: 'unscheduled',
    } as CanonicalEntityInput);
    expect(uc.context.paceOverview().courses.map((c) => c.course.title)).not.toContain(
      '来期の科目',
    );
    setPaceSlots(uc, { id: other }, [SLOT]);
    const row = uc.context.paceOverview().courses.find((c) => c.course.title === '来期の科目');
    expect(row).toMatchObject({ scheduleType: 'unscheduled', enrolled: false });
    expect(row?.slots.map((s) => s.text)).toEqual([SLOT]);
  });

  it('today().pacing escalates with the weeks behind and is empty when on track', () => {
    setPaceSlots(uc, { id: retake }, [SLOT]);
    clock.set('2030-05-07T00:00:00Z'); // Tue 5/7, first week only
    uc.tasks.derive();
    expect(uc.context.today().pacing.map((p) => p.message)).toEqual([
      '物理学（再履修） 先週分が未完了',
    ]);

    clock.set('2030-05-14T00:00:00Z');
    uc.tasks.derive();
    const [two] = uc.context.today().pacing;
    expect(two).toMatchObject({
      behindWeeks: 2,
      unsubmitted: 0,
      slots: [SLOT],
      message: '物理学（再履修） 2週分遅れています',
    });
    expect(two?.course.id).toBe(retake);
    expect(uc.context.tomorrow()).not.toHaveProperty('pacing');

    // completing last week's task clears it
    const last = uc.tasks
      .list({ courseOfferingId: retake })
      .find((t) => t.taskKind === 'weekly_pace' && t.dueAt === '2030-05-12T14:59:00.000Z');
    uc.tasks.setStatus(last?.id ?? '', 'completed', { actor: 'user' });
    expect(uc.context.today().pacing).toEqual([]);
  });

  it('a past-due open assignment is reported on its own', () => {
    put({
      id: stableId('assignment', 'late'),
      kind: 'assignment',
      courseOfferingId: intensive as never,
      title: 'レポート',
      dueAt: '2030-05-01T14:59:00Z',
    });
    clock.set('2030-05-03T00:00:00Z');
    uc.tasks.derive();
    expect(uc.context.today().pacing).toMatchObject([
      { behindWeeks: 0, unsubmitted: 1, message: '集中講義A 未提出の課題 1件' },
    ]);
  });

  it('weekly tasks appear in the deadline and task lists like other tasks', () => {
    setPaceSlots(uc, { id: retake }, [SLOT]);
    clock.set('2030-05-09T00:00:00Z');
    uc.tasks.derive();
    const week = uc.context.week();
    const item = week.deadlines.find((d) => d.kind === 'weekly_pace');
    expect(item).toMatchObject({ title: '物理学（再履修） 今週分', status: 'pending' });
    expect(uc.context.course(retake).paceSlots.map((s) => s.text)).toEqual([SLOT]);
  });
});
