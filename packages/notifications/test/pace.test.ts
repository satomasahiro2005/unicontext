import { type CanonicalEntityInput, stableId } from '@unicontext/canonical-model';
import { createUniContext, setPaceSlots, type UniContext } from '@unicontext/context-engine';
import { ManualClock, parseProfile } from '@unicontext/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NOTIFICATION_KINDS, NotificationSchema, NotificationService } from '../src/index.js';
import { memorySink } from './helpers.js';

const profile = parseProfile(`
id: sample
academicCalendar:
  timezone: Asia/Tokyo
  terms:
    - { id: '2030-1', name: '2030年度 前期', termCode: 前期, year: 2030, start: '2030-04-01', end: '2030-09-30', classes: { start: '2030-04-11', end: '2030-07-26' }, exams: { start: '2030-07-29', end: '2030-08-02' } }
`);

let uc: UniContext;
let clock: ManualClock;
const self = stableId('person', 'self');
const retake = stableId('courseOffering', 'lcu', 'retake');

function put(entity: CanonicalEntityInput): void {
  uc.sync.stores.entities.upsert(entity, { sourceId: 'lcu' });
}

beforeEach(() => {
  clock = new ManualClock('2030-05-02T00:00:00Z'); // Thu 5/2: the course is first seen
  uc = createUniContext({ profile, clock });
  put({ id: self, kind: 'person', name: '本人', roles: ['student'], isSelf: true });
  put({
    id: retake,
    kind: 'courseOffering',
    title: '物理学（再履修）',
    academicYear: 2030,
    term: '前期',
    instructorIds: [],
    instructorNames: [],
    schedule: [],
    scheduleType: 'unscheduled',
  } as CanonicalEntityInput);
  put({
    id: stableId('enrollment', retake),
    kind: 'enrollment',
    personId: self as never,
    courseOfferingId: retake as never,
    role: 'student',
    status: 'active',
  });
  setPaceSlots(uc, { id: retake }, ['土 10:00-11:30']);
});
afterEach(async () => {
  await uc.close();
});

const paceOnly = <T extends { kind: string }>(list: T[]): T[] =>
  list.filter((n) => n.kind === 'pace_behind');

describe('pace_behind notifications', () => {
  it('is a known kind', () => {
    expect(NOTIFICATION_KINDS).toContain('pace_behind');
    expect(
      NotificationSchema.safeParse({
        id: 'n',
        kind: 'pace_behind',
        priority: 'high',
        title: 't',
        body: 'b',
        createdAt: '2030-05-09T00:00:00.000Z',
        dedupeKey: 'k',
      }).success,
    ).toBe(true);
  });

  it('fires once at 1 week behind (high) and escalates once per level (critical)', async () => {
    const sink = memorySink();
    const svc = new NotificationService({ uc, sinks: [sink] });

    clock.set('2030-05-09T00:00:00Z'); // week of 5/6: last week (4/29) is not done
    uc.tasks.derive();
    const first = paceOnly(await svc.checkDeadlines());
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      kind: 'pace_behind',
      priority: 'high',
      title: '物理学（再履修） 先週分が未完了',
      courseOfferingId: retake,
      dedupeKey: `pace_behind:${retake}:2030-05-06:1`,
    });
    expect(first[0]?.body).toContain('自習時間: 土 10:00-11:30');
    // same level, same week: nothing more (also on later ticks of the same day)
    expect(paceOnly(await svc.checkDeadlines())).toEqual([]);
    clock.set('2030-05-10T00:00:00Z');
    expect(paceOnly(await svc.checkDeadlines())).toEqual([]);

    clock.set('2030-05-16T00:00:00Z'); // 2 weeks behind
    uc.tasks.derive();
    const second = paceOnly(await svc.checkDeadlines());
    expect(second.map((n) => [n.priority, n.title, n.dedupeKey])).toEqual([
      ['critical', '物理学（再履修） 2週分遅れています', `pace_behind:${retake}:2030-05-13:2`],
    ]);
    expect(paceOnly(await svc.checkDeadlines())).toEqual([]);

    clock.set('2030-05-23T00:00:00Z'); // 3 weeks behind
    uc.tasks.derive();
    expect(paceOnly(await svc.checkDeadlines()).map((n) => n.priority)).toEqual(['critical']);
    expect(paceOnly(sink.sent)).toHaveLength(3);
  });

  it('is quiet when the weekly tasks are done or the student is on track', async () => {
    const svc = new NotificationService({ uc, sinks: [] });
    clock.set('2030-05-09T00:00:00Z');
    uc.tasks.derive();
    const last = uc.tasks
      .list({ courseOfferingId: retake })
      .find((t) => t.taskKind === 'weekly_pace' && t.dueAt === '2030-05-05T14:59:00.000Z');
    uc.tasks.setStatus(last?.id ?? '', 'completed', { actor: 'user' });
    expect(paceOnly(await svc.checkDeadlines())).toEqual([]);
    expect(uc.context.pacing()).toEqual([]);
  });
});
