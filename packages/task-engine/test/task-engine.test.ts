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
    // idempotent: no churn on the assignment task that absorbed the restated deadline
    expect(engine.derive()).toMatchObject({ created: 0, updated: 0, extractedFacts: 0 });
    expect(engine.list().find((t) => t.taskKind === 'assignment')?.sourceFactIds).toHaveLength(2);

    // Re-normalizing the announcement's raw item retracts every fact on its source reference.
    // The next derive must bring the extracted deadlines back, and the task with them.
    const deadlineIds = (
      db.sqlite.prepare("SELECT id FROM facts WHERE predicate = 'deadline'").all() as {
        id: string;
      }[]
    ).map((r) => r.id);
    resolver.facts.retract(deadlineIds);
    expect(engine.derive().cancelled).toBe(0);
    expect(resolver.facts.getMany(deadlineIds).every((f) => f.retractedAt === undefined)).toBe(
      true,
    );
    expect(engine.list().find((t) => t.taskKind === 'extracted')?.status).toBe('pending');

    // The announcement disappears (task cancelled by the system), then comes back.
    const n1 = stableId('announcement', 'n1');
    const store = new EntityStore(db, { clock });
    const announcement = store.get(n1);
    store.softDelete(n1);
    resolver.facts.retract(deadlineIds);
    expect(engine.derive().cancelled).toBe(1);
    if (announcement) store.upsert(announcement);
    engine.derive();
    expect(engine.list().find((t) => t.taskKind === 'extracted')?.status).toBe('pending');
  });

  it('only personal/actionable notice deadlines become tasks; expired general ones do not', () => {
    const uni = (key: string, title: string, body: string, extra: Record<string, unknown> = {}) =>
      put(
        {
          id: stableId('announcement', key),
          kind: 'announcement',
          title,
          body,
          scope: 'university',
          importance: 'normal',
          publishedAt: '2026-09-01T00:00:00Z',
          ...extra,
        } as CanonicalEntityInput,
        'academic-system',
      );
    // expired, general (履修登録 for everyone): no overdue task
    uni('u1', '抽選履修登録期間のご案内(9月25日(金)12:00まで)', '');
    // upcoming, general: a task while it is ahead
    uni('u2', '後期履修登録期間について', '10月7日(水)17時までに登録してください。');
    // campaign (low importance): never a task
    uni('u3', '【試読キャンペーンは10月20日まで】電子ブックのご案内', '', { importance: 'low' });
    // informational without an action: no task
    uni('u4', '図書館の開館時間', '10月10日まで短縮開館です。');
    // the academic system's personal deadline widget: a task even when overdue
    uni('u5', '履修登録期限', '履修登録期限（一般）: 9月30日まで（未）', {
      category: '期限',
      importance: 'high',
    });
    engine.derive();
    const titles = engine
      .list({ statuses: ['pending'] })
      .filter((t) => t.taskKind === 'extracted')
      .map((t) => t.title);
    expect(titles).toHaveLength(2);
    expect(titles.some((t) => t.includes('10月7日'))).toBe(true);
    expect(titles.some((t) => t.includes('9月30日'))).toBe(true);
    expect(engine.deadlineActionability(stableId('announcement', 'u3'), {})).toBe('informational');
    expect(engine.deadlineActionability(stableId('announcement', 'u4'), {})).toBe('informational');
    expect(engine.deadlineActionability(stableId('announcement', 'u2'), {})).toBe('general');
    expect(engine.deadlineActionability(stableId('announcement', 'u5'), {})).toBe('personal');

    // Once the general deadline passes, its task is withdrawn (cancelled by the system), not
    // shown as 期限切れ; the personal one stays pending.
    clock.set(new Date('2026-10-08T00:00:00Z'));
    engine.derive();
    const pending = engine
      .list({ statuses: ['pending'] })
      .filter((t) => t.taskKind === 'extracted');
    expect(pending.map((t) => t.title)).toEqual([expect.stringContaining('9月30日')]);
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
