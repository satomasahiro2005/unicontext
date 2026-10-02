import { stableId, type CanonicalEntityInput } from '@unicontext/canonical-model';
import { ManualClock } from '@unicontext/core';
import { EntityStore } from '@unicontext/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUniContext, getView, type UniContext } from '../src/index.js';

// Synthetic data on the real Shizuoka calendar: 2026 前期 ended 2026-09-30, 後期 started 2026-10-01.
const clock = new ManualClock('2026-10-02T01:00:00Z'); // 2026-10-02 10:00 JST
const SRC = 'teams-web';
const id = (kind: 'courseOffering' | 'assignment' | 'submission', n: string) =>
  stableId(kind, SRC, n);

let uc: UniContext;
let store: EntityStore;

const put = (input: CanonicalEntityInput) => store.upsert(input, { sourceId: SRC });

function team(key: string, extra: Record<string, unknown>): string {
  const courseId = id('courseOffering', key);
  put({
    id: courseId,
    kind: 'courseOffering',
    title: `チーム ${key}`,
    instructorIds: [],
    instructorNames: [],
    schedule: [],
    extra: { platform: 'teams', teamName: `チーム ${key}` },
    ...extra,
  } as CanonicalEntityInput);
  return courseId;
}

function work(key: string, course: string | undefined, dueAt: string | undefined, status?: string) {
  const assignmentId = id('assignment', key);
  put({
    id: assignmentId,
    kind: 'assignment',
    title: `課題 ${key}`,
    ...(course ? { courseOfferingId: course } : {}),
    ...(dueAt ? { dueAt } : {}),
    extra: { platform: 'teams-assignments' },
  } as CanonicalEntityInput);
  if (status)
    put({
      id: id('submission', key),
      kind: 'submission',
      assignmentId,
      status,
      extra: { platform: 'teams-assignments', teamsStatus: 'working' },
    } as CanonicalEntityInput);
  return assignmentId;
}

let team2024: string;
let team2026Spring: string;
let team2026Autumn: string;

beforeEach(() => {
  uc = createUniContext({ profile: 'shizuoka-university', clock });
  store = new EntityStore(uc.db, { clock });
  team2024 = team('t2024', { academicYear: 2024 });
  team2026Spring = team('t2026s', { academicYear: 2026, term: '前期' });
  team2026Autumn = team('t2026a', { academicYear: 2026, term: '後期' });
  work('old-2024', team2024, '2025-01-20T14:59:00Z', 'not_submitted');
  work('old-2024-undated', team2024, undefined);
  work('spring-late', team2026Spring, '2026-09-20T14:59:00Z', 'not_submitted');
  work('spring-this-week', team2026Spring, '2026-09-29T14:59:00Z', 'not_submitted');
  work('autumn-overdue', team2026Autumn, '2026-10-01T10:00:00Z', 'not_submitted');
  work('autumn-ahead', team2026Autumn, '2026-10-04T14:59:00Z', 'not_submitted');
  uc.tasks.derive();
});
afterEach(() => uc.db.close());

const titles = (items: { title: string }[]): string[] => items.map((i) => i.title).sort();

describe('assignments of terms that have ended', () => {
  it('are classified and left out of every open view', () => {
    const deadline = getView(uc.context, 'deadline', { days: 30 });
    expect(titles(deadline.overdue)).toEqual(['課題 autumn-overdue']);
    expect(titles(deadline.upcoming)).toEqual(['課題 autumn-ahead']);
    expect(deadline.overdue[0]?.overdue).toBe(true);

    const today = getView(uc.context, 'today');
    expect(titles(today.deadlines)).toEqual(['課題 autumn-ahead', '課題 autumn-overdue']);
    expect(titles(today.tasks)).toEqual(['課題 autumn-ahead', '課題 autumn-overdue']);

    const week = getView(uc.context, 'week');
    expect(titles(week.deadlines)).toEqual(['課題 autumn-ahead', '課題 autumn-overdue']);

    const byTitle = new Map(uc.tasks.list().map((t) => [t.title, t.status]));
    expect(byTitle.get('課題 old-2024')).toBe('expired_past_term');
    expect(byTitle.get('課題 old-2024-undated')).toBe('expired_past_term');
    expect(byTitle.get('課題 spring-late')).toBe('expired_past_term');
    expect(byTitle.get('課題 autumn-overdue')).toBe('pending');
  });

  it('stay in the course history with the source submission status unchanged', () => {
    const course = getView(uc.context, 'course', { courseOfferingId: team2026Spring });
    expect(course.assignments.map((a) => [a.title, a.status])).toEqual([
      ['課題 spring-this-week', 'not_submitted'],
      ['課題 spring-late', 'not_submitted'],
    ]);
    expect(course.deadlines).toEqual([]);
    const old = getView(uc.context, 'course', { courseOfferingId: team2024 });
    expect(titles(old.assignments)).toEqual(['課題 old-2024', '課題 old-2024-undated']);
    expect(old.assignments.map((a) => a.status)).toEqual(['not_submitted', undefined]);
  });

  it('stay out even when the source still shows a due date ahead (nothing to notify about)', () => {
    work('spring-ahead', team2026Spring, '2026-10-03T14:59:00Z', 'not_submitted');
    uc.tasks.derive();
    const { overdue, upcoming } = uc.context.deadline({ days: 400 });
    expect(titles([...overdue, ...upcoming])).toEqual(['課題 autumn-ahead', '課題 autumn-overdue']);
  });
});
