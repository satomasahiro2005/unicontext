import { type CanonicalEntityInput, type JsonValue, stableId } from '@unicontext/canonical-model';
import { ManualClock, parseProfile, PolicyViolationError } from '@unicontext/core';
import {
  EntityStore,
  openDatabase,
  SourceReferenceStore,
  type UniContextDatabase,
} from '@unicontext/database';
import { ConflictResolver, factId } from '@unicontext/provenance';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaskEngine } from '../src/index.js';

// Synthetic calendar: the 2030 前期 term has ended on 2030-10-02, the 2030 後期 term is current.
const profile = parseProfile(`
id: sample
academicCalendar:
  timezone: Asia/Tokyo
  terms:
    - { id: '2030-1', name: '2030年度 前期', termCode: 前期, year: 2030, start: '2030-04-01', end: '2030-09-30', classes: { start: '2030-04-11', end: '2030-07-26' } }
    - { id: '2030-2', name: '2030年度 後期', termCode: 後期, year: 2030, start: '2030-10-01', end: '2031-03-31', classes: { start: '2030-10-01', end: '2031-01-31' } }
`);

let db: UniContextDatabase;
let clock: ManualClock;
let engine: TaskEngine;
let resolver: ConflictResolver;

function put(
  entity: CanonicalEntityInput,
  authority = 'submission-system',
  facts: Record<string, JsonValue> = {},
): void {
  new EntityStore(db, { clock }).upsert(entity, { sourceId: 'x' });
  const ref = new SourceReferenceStore(db).upsert({
    id: stableId('sourceReference', entity.id),
    sourceSystem: 'x',
    authority,
    sourceItemId: entity.id,
    retrievedAt: '2030-10-01T00:00:00Z',
    entityId: entity.id,
  });
  for (const [predicate, value] of Object.entries(facts)) {
    resolver.facts.put({
      id: factId(ref.id, entity.id, predicate, value),
      subject: entity.id,
      predicate,
      value,
      origin: 'authoritative',
      confidence: 1,
      observedAt: '2030-10-01T00:00:00Z',
      sourceReferenceId: ref.id,
      producer: { type: 'connector', id: 'x' },
    });
  }
}

function offering(key: string, extra: Record<string, unknown>): string {
  const id = stableId('courseOffering', 'x', key);
  put(
    {
      id,
      kind: 'courseOffering',
      title: `科目 ${key}`,
      instructorIds: [],
      instructorNames: [],
      schedule: [],
      ...extra,
    } as CanonicalEntityInput,
    'academic-system',
  );
  return id;
}

function assignment(key: string, course: string | undefined, dueAt?: string): string {
  const id = stableId('assignment', 'x', key);
  put(
    {
      id,
      kind: 'assignment',
      title: `課題 ${key}`,
      ...(course ? { courseOfferingId: course } : {}),
      ...(dueAt ? { dueAt } : {}),
    } as CanonicalEntityInput,
    'submission-system',
    dueAt ? { assignment_due: dueAt } : {},
  );
  return id;
}

const statusOf = (e: TaskEngine, key: string): string | undefined =>
  e.list().find((t) => t.title === `課題 ${key}`)?.status;

beforeEach(() => {
  db = openDatabase();
  clock = new ManualClock('2030-10-02T01:00:00Z'); // 2030-10-02 10:00 JST
  resolver = new ConflictResolver(db, { clock });
  engine = new TaskEngine({ db, clock, resolver, profile });
});
afterEach(() => db.close());

describe('expired_past_term classification', () => {
  it('classifies unfinished work of an ended term, by the offering term in the calendar', () => {
    const spring = offering('spring', { academicYear: 2030, term: '前期' });
    const autumn = offering('autumn', { academicYear: 2030, term: '後期' });
    assignment('spring-open', spring, '2030-07-20T23:59:00+09:00');
    // The term decides, not the due date: a current-term assignment due before the term start.
    assignment('autumn-early', autumn, '2030-09-15T23:59:00+09:00');
    assignment('autumn-overdue', autumn, '2030-10-01T12:00:00+09:00');
    engine.derive();
    expect(statusOf(engine, 'spring-open')).toBe('expired_past_term');
    expect(statusOf(engine, 'autumn-early')).toBe('pending');
    expect(statusOf(engine, 'autumn-overdue')).toBe('pending');
  });

  it('classifies an unlinked class team of a past academic year, with or without a due date', () => {
    const team = offering('team-2028', { academicYear: 2028 });
    assignment('team-undated', team);
    assignment('team-dated', team, '2029-01-10T23:59:00+09:00');
    engine.derive();
    expect(statusOf(engine, 'team-undated')).toBe('expired_past_term');
    expect(statusOf(engine, 'team-dated')).toBe('expired_past_term');
  });

  it('falls back to the due date against the current term start', () => {
    const team = offering('team-2030', { academicYear: 2030 });
    assignment('this-year-old', team, '2030-07-01T23:59:00+09:00');
    assignment('this-year-overdue', team, '2030-10-01T10:00:00+09:00');
    assignment('this-year-ahead', team, '2030-10-20T23:59:00+09:00');
    assignment('this-year-undated', team);
    assignment('no-course-old', undefined, '2030-03-01T23:59:00+09:00');
    assignment('no-course-ahead', undefined, '2030-10-09T23:59:00+09:00');
    engine.derive();
    expect(statusOf(engine, 'this-year-old')).toBe('expired_past_term');
    expect(statusOf(engine, 'this-year-overdue')).toBe('pending');
    expect(statusOf(engine, 'this-year-ahead')).toBe('pending');
    expect(statusOf(engine, 'this-year-undated')).toBe('pending');
    expect(statusOf(engine, 'no-course-old')).toBe('expired_past_term');
    expect(statusOf(engine, 'no-course-ahead')).toBe('pending');
  });

  it('uses the term of any linked offering', () => {
    const team = offering('team-linked', { academicYear: 2028 });
    const lcu = offering('lcu-linked', { academicYear: 2030, term: '後期' });
    const linked = new TaskEngine({
      db,
      clock,
      resolver,
      profile,
      expandCourse: (id) => (id === team || id === lcu ? [team, lcu] : [id]),
    });
    assignment('linked', team, '2030-09-01T23:59:00+09:00');
    linked.derive();
    expect(statusOf(linked, 'linked')).toBe('pending');
  });

  it('never overrides submission evidence or the student, and never touches submission state', () => {
    const spring = offering('spring', { academicYear: 2030, term: '前期' });
    const done = assignment('done', spring, '2030-07-20T23:59:00+09:00');
    assignment('mine', spring, '2030-07-20T23:59:00+09:00');
    put(
      {
        id: stableId('submission', 'done'),
        kind: 'submission',
        assignmentId: done as never,
        status: 'submitted',
      },
      'submission-system',
      { submission_status: 'submitted' },
    );
    engine.derive();
    expect(statusOf(engine, 'done')).toBe('submitted');
    const task = engine.list().find((t) => t.title === '課題 mine');
    expect(task?.status).toBe('expired_past_term');
    engine.setStatus(task?.id as string, 'in_progress', { actor: 'user' });
    engine.derive();
    expect(statusOf(engine, 'mine')).toBe('in_progress');
    // The source's own submission status values are not rewritten.
    const subs = new EntityStore(db, { clock }).list('submission');
    expect(subs.map((s) => s.status)).toEqual(['submitted']);
  });

  it('lifts the classification again while the term is still running', () => {
    const spring = offering('spring', { academicYear: 2030, term: '前期' });
    assignment('spring-open', spring, '2030-07-20T23:59:00+09:00');
    engine.derive();
    expect(statusOf(engine, 'spring-open')).toBe('expired_past_term');
    clock.set('2030-09-30T10:00:00Z'); // last day of the term (JST 19:00)
    engine.derive();
    expect(statusOf(engine, 'spring-open')).toBe('pending');
    clock.set('2030-10-01T00:00:00Z'); // first day after the term (JST 09:00)
    engine.derive();
    expect(statusOf(engine, 'spring-open')).toBe('expired_past_term');
  });

  it('cannot be set by hand', () => {
    const team = offering('team-2030', { academicYear: 2030 });
    assignment('x', team, '2030-10-20T23:59:00+09:00');
    engine.derive();
    const t = engine.list()[0];
    expect(() => engine.setStatus(t?.id as string, 'expired_past_term', { actor: 'user' })).toThrow(
      PolicyViolationError,
    );
  });

  it('uses the academic year alone when there is no academic calendar', () => {
    const bare = new TaskEngine({ db, clock, resolver });
    const old = offering('old', { academicYear: 2020 });
    const team = offering('cur', { academicYear: 2030 });
    assignment('bare-old', old);
    assignment('bare-cur', team, '2030-01-01T00:00:00+09:00');
    bare.derive();
    expect(statusOf(bare, 'bare-old')).toBe('expired_past_term');
    expect(statusOf(bare, 'bare-cur')).toBe('pending');
  });
});
