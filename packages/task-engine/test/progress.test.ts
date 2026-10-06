import { type CanonicalEntityInput, type Fact, stableId } from '@unicontext/canonical-model';
import { ManualClock, parseProfile, PolicyViolationError } from '@unicontext/core';
import {
  EntityStore,
  openDatabase,
  SourceReferenceStore,
  type UniContextDatabase,
} from '@unicontext/database';
import { ConflictResolver, factId } from '@unicontext/provenance';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isStudentStatementStatus,
  latestTaskProgress,
  mergeProgressSteps,
  normalizeStepLabel,
  parseTaskProgress,
  progressPercent,
  remainingSteps,
  STUDENT_STATEMENT_STATUSES,
  stepsMatch,
  TASK_PROGRESS_PREDICATE,
  TaskEngine,
  taskProgressSubject,
} from '../src/index.js';

describe('step labels', () => {
  it('ignores the minutes tail, width, spaces and a closing 。', () => {
    expect(normalizeStepLabel('課題文を開いて設問を読む（10分）')).toBe('課題文を開いて設問を読む');
    expect(normalizeStepLabel('Ｒｅａｄ  the prompt。')).toBe('readtheprompt');
  });

  it('matches a step spelled a little differently, not a short fragment', () => {
    expect(stepsMatch('課題文を開いて設問を読む（10分）', '課題文を開いて設問を読む')).toBe(true);
    expect(stepsMatch('課題文を開いて設問を読む', '設問を読む')).toBe(true);
    expect(stepsMatch('本文を書く', '構成を箇条書きで作る')).toBe(false);
    expect(stepsMatch('書く', '本文を書く')).toBe(false);
    expect(stepsMatch('', '本文を書く')).toBe(false);
  });
});

describe('progress steps', () => {
  const plan = ['課題文を開いて設問を読む', '書くことを3行メモする', '本文を書いて提出する'];

  it('starts from the plan and marks the steps the student said they did', () => {
    const steps = mergeProgressSteps(undefined, plan, { doneSteps: ['設問を読んだ'] });
    // 「設問を読んだ」 is the student's word, not a plan step: it is kept as a step they did.
    expect(steps).toEqual([
      { label: '課題文を開いて設問を読む', done: false },
      { label: '書くことを3行メモする', done: false },
      { label: '本文を書いて提出する', done: false },
      { label: '設問を読んだ', done: true },
    ]);
    const exact = mergeProgressSteps(undefined, plan, { doneSteps: ['課題文を開いて設問を読む'] });
    expect(exact?.map((s) => s.done)).toEqual([true, false, false]);
  });

  it('keeps earlier marks and adds the new ones; steps given replace the list', () => {
    const first = mergeProgressSteps(undefined, plan, { doneSteps: [plan[0] as string] });
    const second = mergeProgressSteps(first, plan, { doneSteps: [plan[1] as string] });
    expect(second?.map((s) => s.done)).toEqual([true, true, false]);
    const replaced = mergeProgressSteps(second, plan, {
      steps: [
        { label: 'ER図を描く', done: true },
        { label: '説明を書く', done: false },
      ],
    });
    expect(replaced).toEqual([
      { label: 'ER図を描く', done: true },
      { label: '説明を書く', done: false },
    ]);
    expect(progressPercent(replaced)).toBe(50);
  });

  it('records nothing about steps when the statement said nothing about them', () => {
    expect(mergeProgressSteps(undefined, plan, {})).toBeUndefined();
    const before = [{ label: 'ER図を描く', done: true }];
    expect(mergeProgressSteps(before, plan, {})).toEqual(before);
  });

  it('drops the done steps of a plan and keeps the rest; no record keeps all', () => {
    const items = plan.map((text, i) => ({ text, minutes: 10 + i }));
    expect(remainingSteps(items, undefined)).toHaveLength(3);
    expect(
      remainingSteps(items, { steps: [{ label: '書くことを3行メモする', done: false }] }),
    ).toHaveLength(3);
    expect(
      remainingSteps(items, {
        steps: [
          { label: '課題文を開いて設問を読む（10分）', done: true },
          { label: '書くことを3行メモする', done: true },
        ],
      }).map((x) => x.text),
    ).toEqual(['本文を書いて提出する']);
  });
});

describe('progress facts', () => {
  const fact = (value: unknown, id = 'f', retractedAt?: string): Fact =>
    ({
      id: `fact:${id}`,
      subject: taskProgressSubject('task:x'),
      predicate: TASK_PROGRESS_PREDICATE,
      value,
      origin: 'extracted',
      confidence: 0.7,
      observedAt: '2026-10-01T00:00:00Z',
      sourceReferenceId: 'sourceReference:x',
      producer: { type: 'ai', id: 'mcp:test' },
      ...(retractedAt ? { retractedAt } : {}),
    }) as unknown as Fact;
  const value = (statedAt: string, status = 'in_progress') => ({
    status,
    statement: '始めた',
    statedAt,
  });

  it('parses only well-formed records', () => {
    expect(parseTaskProgress(value('2026-10-01T00:00:00Z') as never)).toMatchObject({
      status: 'in_progress',
    });
    expect(parseTaskProgress({ status: 'in_progress' } as never)).toBeUndefined();
    expect(parseTaskProgress('x' as never)).toBeUndefined();
    expect(parseTaskProgress({ ...value('not a date') } as never)).toBeUndefined();
  });

  it('picks the newest statement by when it was stated, skipping retracted facts', () => {
    const newest = latestTaskProgress([
      fact(value('2026-10-02T00:00:00Z', 'completed'), 'b'),
      fact(value('2026-10-01T00:00:00Z'), 'a'),
      fact(value('2026-10-03T00:00:00Z', 'pending'), 'c', '2026-10-04T00:00:00Z'),
    ]);
    expect(newest?.value.status).toBe('completed');
    expect(latestTaskProgress([])).toBeUndefined();
  });

  it('only pending, in_progress, completed and cancelled are the student’s to set', () => {
    expect(STUDENT_STATEMENT_STATUSES).toEqual([
      'pending',
      'in_progress',
      'completed',
      'cancelled',
    ]);
    for (const s of ['submitted', 'expired_past_term', 'unknown'])
      expect(isStudentStatementStatus(s)).toBe(false);
  });
});

describe('TaskEngine.setStatus with a student statement', () => {
  let db: UniContextDatabase;
  let clock: ManualClock;
  let engine: TaskEngine;
  let resolver: ConflictResolver;
  const course = stableId('courseOffering', 'lms', 'c1');
  const a1 = stableId('assignment', 'lms', 'a1');
  const taskId = stableId('task', 'assignment', a1);

  beforeEach(() => {
    db = openDatabase();
    clock = new ManualClock('2026-10-01T01:00:00Z');
    resolver = new ConflictResolver(db, { clock });
    engine = new TaskEngine({ db, clock, resolver });
    const entities = new EntityStore(db, { clock });
    const refs = new SourceReferenceStore(db);
    const put = (entity: CanonicalEntityInput, authority: string, due?: string) => {
      entities.upsert(entity, { sourceId: 'lms' });
      const ref = refs.upsert({
        id: stableId('sourceReference', entity.id),
        sourceSystem: 'lms',
        authority,
        sourceItemId: entity.id,
        retrievedAt: '2026-10-01T00:00:00Z',
        entityId: entity.id,
      });
      if (due)
        resolver.facts.put({
          id: factId(ref.id, entity.id, 'assignment_due', due),
          subject: entity.id,
          predicate: 'assignment_due',
          value: due,
          origin: 'authoritative',
          confidence: 1,
          observedAt: '2026-10-01T00:00:00Z',
          sourceReferenceId: ref.id,
          producer: { type: 'connector', id: 'lms' },
        });
    };
    put(
      {
        id: course,
        kind: 'courseOffering',
        title: 'データベース',
        instructorIds: [],
        instructorNames: [],
        schedule: [],
      },
      'academic-system',
    );
    put(
      {
        id: a1,
        kind: 'assignment',
        title: '課題1',
        courseOfferingId: course,
        dueAt: '2026-10-08T23:59:00+09:00',
      },
      'submission-system',
      '2026-10-08T23:59:00+09:00',
    );
    engine.derive();
  });
  afterEach(() => db.close());

  it('sets the student’s own status with the fact that quotes them', () => {
    const t = engine.setStatus(taskId, 'completed', {
      actor: 'student-statement',
      evidenceFactId: 'fact:quote',
    });
    expect(t).toMatchObject({
      status: 'completed',
      statusSetBy: 'user',
      statusEvidenceFactId: 'fact:quote',
    });
    // The derive that follows every write keeps it.
    engine.derive();
    expect(engine.get(taskId)).toMatchObject({
      status: 'completed',
      statusSetBy: 'user',
      statusEvidenceFactId: 'fact:quote',
    });
  });

  it('never sets submitted, expired_past_term or unknown', () => {
    for (const s of ['submitted', 'expired_past_term', 'unknown'] as const)
      expect(() => engine.setStatus(taskId, s, { actor: 'student-statement' })).toThrow(
        PolicyViolationError,
      );
    expect(engine.get(taskId)?.status).toBe('pending');
  });

  it('leaves the plain ai and system rules as they were', () => {
    expect(() => engine.setStatus(taskId, 'completed', { actor: 'ai' })).toThrow(
      PolicyViolationError,
    );
    expect(() => engine.setStatus(taskId, 'submitted', { actor: 'ai' })).toThrow(
      PolicyViolationError,
    );
    expect(() => engine.setStatus(taskId, 'submitted', { actor: 'system' })).toThrow(
      PolicyViolationError,
    );
    expect(engine.setStatus(taskId, 'in_progress', { actor: 'ai' })).toMatchObject({
      status: 'in_progress',
      statusSetBy: 'system',
    });
  });

  it('restores the status fields it saved', () => {
    const before = engine.get(taskId);
    engine.setStatus(taskId, 'completed', { actor: 'student-statement', evidenceFactId: 'fact:q' });
    const restored = engine.restoreStatus(taskId, {
      status: before?.status ?? 'pending',
      statusSetBy: before?.statusSetBy ?? 'system',
    });
    expect(restored).toMatchObject({ status: 'pending', statusSetBy: 'system' });
    expect(restored.statusEvidenceFactId).toBeUndefined();
  });

  it('reads the newest statement back (progressOf)', () => {
    expect(engine.progressOf(taskId)).toBeUndefined();
    const ref = new SourceReferenceStore(db).upsert({
      id: stableId('sourceReference', 'chat', 'x'),
      sourceSystem: 'chat',
      authority: 'student-statement',
      sourceItemId: 'x',
      retrievedAt: '2026-10-01T00:00:00Z',
    });
    const v = {
      status: 'in_progress',
      steps: [{ label: '課題文を読む', done: true }],
      statement: '読んだ',
      statedAt: '2026-10-01T01:00:00.000Z',
    };
    resolver.facts.put({
      id: factId(ref.id, taskProgressSubject(taskId), TASK_PROGRESS_PREDICATE, v),
      subject: taskProgressSubject(taskId) as never,
      predicate: TASK_PROGRESS_PREDICATE,
      value: v,
      origin: 'extracted',
      confidence: 0.7,
      observedAt: '2026-10-01T01:00:00.000Z',
      sourceReferenceId: ref.id,
      producer: { type: 'ai', id: 'mcp:test' },
      evidence: '読んだ',
    });
    expect(engine.progressOf(taskId)?.value).toMatchObject({
      status: 'in_progress',
      steps: [{ label: '課題文を読む', done: true }],
    });
  });

  describe('a statement followed by the submission system', () => {
    const putStatement = (status: 'in_progress' | 'completed'): string => {
      const ref = new SourceReferenceStore(db).upsert({
        id: stableId('sourceReference', 'chat', status),
        sourceSystem: 'chat',
        authority: 'student-statement',
        sourceItemId: status,
        retrievedAt: '2026-10-01T00:00:00Z',
      });
      const v = { status, statement: '始めた', statedAt: '2026-10-01T01:00:00.000Z' };
      const fact = resolver.facts.put({
        id: factId(ref.id, taskProgressSubject(taskId), TASK_PROGRESS_PREDICATE, v),
        subject: taskProgressSubject(taskId) as never,
        predicate: TASK_PROGRESS_PREDICATE,
        value: v,
        origin: 'extracted',
        confidence: 0.7,
        observedAt: '2026-10-01T01:00:00.000Z',
        sourceReferenceId: ref.id,
        producer: { type: 'ai', id: 'mcp:test' },
        evidence: '始めた',
      });
      engine.setStatus(taskId, status, { actor: 'student-statement', evidenceFactId: fact.id });
      return fact.id;
    };
    const submit = (): void => {
      const e: CanonicalEntityInput = {
        id: stableId('submission', 'lms', 's1'),
        kind: 'submission',
        assignmentId: a1,
        status: 'submitted',
      };
      new EntityStore(db, { clock }).upsert(e, { sourceId: 'lms' });
      const ref = new SourceReferenceStore(db).upsert({
        id: stableId('sourceReference', e.id),
        sourceSystem: 'lms',
        authority: 'submission-system',
        sourceItemId: e.id,
        retrievedAt: '2026-10-02T00:00:00Z',
        entityId: e.id,
      });
      resolver.facts.put({
        id: factId(ref.id, e.id, 'submission_status', 'submitted'),
        subject: e.id,
        predicate: 'submission_status',
        value: 'submitted',
        origin: 'authoritative',
        confidence: 1,
        observedAt: '2026-10-02T00:00:00Z',
        sourceReferenceId: ref.id,
        producer: { type: 'connector', id: 'lms' },
      });
    };

    it('lets a later submission override an in_progress the student stated', () => {
      putStatement('in_progress');
      engine.derive();
      expect(engine.get(taskId)).toMatchObject({ status: 'in_progress', statusSetBy: 'user' });
      submit();
      engine.derive();
      expect(engine.get(taskId)).toMatchObject({
        status: 'submitted',
        statusSetBy: 'submission-system',
      });
    });

    it('keeps completed, and the owner’s own in_progress', () => {
      putStatement('completed');
      submit();
      engine.derive();
      expect(engine.get(taskId)).toMatchObject({ status: 'completed', statusSetBy: 'user' });
      engine.setStatus(taskId, 'in_progress', { actor: 'user' });
      engine.derive();
      expect(engine.get(taskId)).toMatchObject({ status: 'in_progress', statusSetBy: 'user' });
    });

    it('lets the end of the term expire a stated in_progress', () => {
      putStatement('in_progress');
      clock.set('2027-10-01T00:00:00Z');
      const old = new TaskEngine({
        db,
        clock,
        resolver,
        profile: parseProfile(`
id: sample
academicCalendar:
  timezone: Asia/Tokyo
  terms:
    - { id: '2026-2', name: '2026年度 後期', termCode: 後期, year: 2026, start: '2026-10-01', end: '2027-03-31', classes: { start: '2026-10-01', end: '2027-01-31' } }
    - { id: '2027-2', name: '2027年度 後期', termCode: 後期, year: 2027, start: '2027-10-01', end: '2028-03-31', classes: { start: '2027-10-01', end: '2028-01-31' } }
`),
      });
      old.derive();
      expect(old.get(taskId)?.status).toBe('expired_past_term');
    });
  });
});
