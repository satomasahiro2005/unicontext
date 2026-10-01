import { type CanonicalEntityInput, type JsonValue, stableId } from '@unicontext/canonical-model';
import { ManualClock, PolicyViolationError } from '@unicontext/core';
import {
  EntityStore,
  openDatabase,
  SourceReferenceStore,
  type UniContextDatabase,
} from '@unicontext/database';
import { ConflictResolver, factId } from '@unicontext/provenance';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaskEngine } from '../src/index.js';

let db: UniContextDatabase;
let clock: ManualClock;
let engine: TaskEngine;
let resolver: ConflictResolver;
const course = stableId('courseOffering', 'lms', 'c1');
const a1 = stableId('assignment', 'lms', 'a1');

function put(
  entity: CanonicalEntityInput,
  authority: string,
  facts: Record<string, JsonValue> = {},
) {
  new EntityStore(db, { clock }).upsert(entity, { sourceId: 'lms' });
  const ref = new SourceReferenceStore(db).upsert({
    id: stableId('sourceReference', entity.id),
    sourceSystem: 'lms',
    authority,
    sourceItemId: entity.id,
    retrievedAt: '2026-10-01T00:00:00Z',
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
      observedAt: '2026-10-01T00:00:00Z',
      sourceReferenceId: ref.id,
      producer: { type: 'connector', id: 'lms' },
    });
  }
}

beforeEach(() => {
  db = openDatabase();
  clock = new ManualClock('2026-10-01T01:00:00Z');
  resolver = new ConflictResolver(db, { clock });
  engine = new TaskEngine({ db, clock, resolver });
  put(
    {
      id: course,
      kind: 'courseOffering',
      title: 'データベースシステム論',
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
    { assignment_due: '2026-10-08T23:59:00+09:00' },
  );
});
afterEach(() => db.close());

describe('TaskEngine (§19)', () => {
  it('derives pending tasks from assignments with source facts', () => {
    expect(engine.derive().created).toBe(1);
    const [t] = engine.list();
    expect(t).toMatchObject({
      title: '課題1',
      status: 'pending',
      dueAt: '2026-10-08T23:59:00+09:00',
      createdBy: 'system',
      taskKind: 'assignment',
    });
    expect(t?.sourceFactIds).toHaveLength(1);
  });

  it('marks submitted only when the submission system confirms it', () => {
    put(
      {
        id: stableId('submission', 'x'),
        kind: 'submission',
        assignmentId: a1,
        status: 'submitted',
      },
      'academic-system',
      { submission_status: 'submitted' },
    );
    engine.derive();
    expect(engine.list()[0]?.status).toBe('pending');
    put(
      {
        id: stableId('submission', 'y'),
        kind: 'submission',
        assignmentId: a1,
        status: 'submitted',
      },
      'submission-system',
      { submission_status: 'submitted' },
    );
    engine.derive();
    expect(engine.list()[0]).toMatchObject({
      status: 'submitted',
      statusSetBy: 'submission-system',
    });
  });

  it('never lets AI mark a task submitted or completed', () => {
    engine.derive();
    const id = engine.list()[0]?.id ?? '';
    expect(() => engine.setStatus(id, 'submitted', { actor: 'ai' })).toThrow(PolicyViolationError);
    expect(() => engine.setStatus(id, 'completed', { actor: 'ai' })).toThrow(PolicyViolationError);
    expect(() => engine.setStatus(id, 'submitted', { actor: 'system' })).toThrow(
      PolicyViolationError,
    );
    expect(engine.setStatus(id, 'in_progress', { actor: 'ai' }).status).toBe('in_progress');
    expect(engine.setStatus(id, 'completed', { actor: 'user' })).toMatchObject({
      status: 'completed',
      statusSetBy: 'user',
    });
    engine.derive();
    expect(engine.get(id)?.status).toBe('completed');
  });

  it('turns deadlines in announcements into extracted tasks with evidence (§20)', () => {
    put(
      {
        id: stableId('announcement', 'n1'),
        kind: 'announcement',
        title: '小レポート',
        body: 'ERモデルの小レポートを10月12日17時までに提出してください。',
        courseOfferingId: course,
        publishedAt: '2026-10-01T00:00:00Z',
      },
      'instructor-announcement',
    );
    put(
      {
        id: stableId('announcement', 'n2'),
        kind: 'announcement',
        title: '課題1について',
        body: '課題1は10月8日23時59分までです。',
        courseOfferingId: course,
        publishedAt: '2026-10-01T00:00:00Z',
      },
      'instructor-announcement',
    );
    const r = engine.derive();
    expect(r.extractedFacts).toBe(2);
    const extracted = engine.list().filter((t) => t.taskKind === 'extracted');
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toMatchObject({
      origin: 'extracted',
      createdBy: 'extractor',
      dueAt: '2026-10-12T08:00:00.000Z',
      courseOfferingId: course,
    });
    expect(extracted[0]?.evidence).toContain('10月12日17時までに');
    // the restated assignment deadline is merged into the assignment task
    expect(engine.list().find((t) => t.taskKind === 'assignment')?.sourceFactIds).toHaveLength(2);
    // idempotent
    expect(engine.derive()).toMatchObject({ created: 0, extractedFacts: 0 });
  });

  it('cancels derived tasks whose assignment disappeared', () => {
    engine.derive();
    new EntityStore(db).softDelete(a1);
    expect(engine.derive().cancelled).toBe(1);
    expect(engine.list()[0]?.status).toBe('cancelled');
  });

  it('keeps manual tasks', () => {
    engine.createManualTask({ title: '図書館で本を返す', dueAt: '2026-10-03T08:00:00Z' });
    engine.derive();
    expect(engine.list().map((t) => t.title)).toContain('図書館で本を返す');
  });
});
