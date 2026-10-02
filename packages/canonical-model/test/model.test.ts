import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  ConflictSchema,
  CourseOfferingSchema,
  CourseSchema,
  ENTITY_KINDS,
  ENTITY_SCHEMAS,
  FactSchema,
  HEALTH_STATES,
  kindOf,
  makeId,
  parseEntity,
  parseId,
  stableId,
  TASK_STATUSES,
  TaskSchema,
} from '../src/index.js';

describe('ids', () => {
  it('follow "<kind>:<uuid>"', () => {
    const id = makeId('courseOffering');
    expect(id).toMatch(/^courseOffering:[0-9a-f-]{36}$/);
    expect(parseId(id).kind).toBe('courseOffering');
    expect(kindOf('fact:1')).toBe('fact');
    expect(() => parseId('nope:1')).toThrow();
    expect(stableId('course', 'lcu', 'DB')).toBe(stableId('course', 'lcu', 'DB'));
    expect(stableId('course', 'lcu', 'DB')).not.toBe(stableId('course', 'teams', 'DB'));
  });
});

describe('canonical entities (§7)', () => {
  it('has a schema for every entity kind', () => {
    expect(Object.keys(ENTITY_SCHEMAS).sort()).toEqual([...ENTITY_KINDS].sort());
  });

  it('separates Course and CourseOffering (§8)', () => {
    const course = CourseSchema.parse({
      id: 'course:1',
      kind: 'course',
      title: 'データベースシステム論',
      courseCode: 'DB',
    });
    const offering = CourseOfferingSchema.parse({
      id: 'courseOffering:2026',
      kind: 'courseOffering',
      courseId: course.id,
      academicYear: 2026,
      term: '後期',
      title: 'データベースシステム論',
      instructorNames: ['山田 太郎'],
      schedule: [{ dayOfWeek: 4, period: 2, room: '21教室' }],
    });
    expect(offering.courseId).toBe(course.id);
    expect(offering.instructorIds).toEqual([]);
  });

  it('rejects ids of the wrong kind and bad timestamps', () => {
    expect(() => parseEntity({ id: 'course:1', kind: 'assignment', title: 'x' })).toThrow();
    expect(() =>
      parseEntity({
        id: 'assignment:1',
        kind: 'assignment',
        title: 'x',
        dueAt: '2026-10-15 23:59',
      }),
    ).toThrow();
    expect(
      parseEntity({
        id: 'assignment:1',
        kind: 'assignment',
        title: 'x',
        dueAt: '2026-10-15T23:59:00+09:00',
      }).kind,
    ).toBe('assignment');
  });
});

describe('facts (§9–§11)', () => {
  const base = {
    id: 'fact:1',
    subject: 'courseOffering:123',
    predicate: 'room',
    value: '情報学部2号館21教室',
    confidence: 1,
    observedAt: '2026-10-01T00:42:00Z',
    sourceReferenceId: 'sourceReference:1',
  };
  it('accepts the spec example', () => {
    expect(
      FactSchema.parse({
        ...base,
        origin: 'authoritative',
        producer: { type: 'connector', id: 'livecampusu' },
      }).value,
    ).toBe('情報学部2号館21教室');
  });
  it('never lets AI output be authoritative (§48)', () => {
    expect(() =>
      FactSchema.parse({
        ...base,
        origin: 'authoritative',
        producer: { type: 'ai', id: 'openai' },
      }),
    ).toThrow(/AI-produced/);
    expect(
      FactSchema.parse({ ...base, origin: 'extracted', producer: { type: 'ai', id: 'openai' } })
        .origin,
    ).toBe('extracted');
  });
  it('reserves origin "user" for human input (§74)', () => {
    expect(() =>
      FactSchema.parse({ ...base, origin: 'user', producer: { type: 'connector', id: 'x' } }),
    ).toThrow();
    expect(() =>
      FactSchema.parse({ ...base, origin: 'authoritative', producer: { type: 'user', id: 'me' } }),
    ).toThrow();
  });
  it('conflicts need at least two candidates', () => {
    expect(() =>
      ConflictSchema.parse({
        id: 'conflict:1',
        subject: 'courseOffering:1',
        predicate: 'room',
        status: 'open',
        candidates: [],
        detectedAt: base.observedAt,
      }),
    ).toThrow();
  });
});

describe('enums', () => {
  it('match the spec', () => {
    expect(TASK_STATUSES).toEqual([
      'pending',
      'in_progress',
      'submitted',
      'completed',
      'cancelled',
      'unknown',
      'expired_past_term',
    ]);
    expect(HEALTH_STATES).toEqual([
      'healthy',
      'degraded',
      'auth_required',
      'rate_limited',
      'offline',
      'failed',
    ]);
    expect(CAPABILITIES).toHaveLength(14);
    expect(() =>
      TaskSchema.parse({
        id: 'task:1',
        title: 't',
        status: 'done',
        createdBy: 'system',
        taskKind: 'manual',
        origin: 'user',
        createdAt: base(),
        updatedAt: base(),
      }),
    ).toThrow();
    function base() {
      return '2026-10-01T00:00:00Z';
    }
  });
});
