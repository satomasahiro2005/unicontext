import { type FactOrigin, type JsonValue, stableId } from '@unicontext/canonical-model';
import { ManualClock, PolicyViolationError } from '@unicontext/core';
import { openDatabase, SourceReferenceStore, type UniContextDatabase } from '@unicontext/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConflictResolver,
  factId,
  formatCitationLabel,
  loadDefaultAuthorityRules,
  mergeAuthorityRules,
  parseAuthorityRules,
  toCitation,
} from '../src/index.js';

let db: UniContextDatabase;
let clock: ManualClock;
let resolver: ConflictResolver;
const subject = stableId('courseOffering', 'lcu', 'DB');
const teamsSubject = stableId('courseOffering', 'teams', 'DB');

beforeEach(() => {
  db = openDatabase();
  clock = new ManualClock('2026-10-02T03:00:00Z');
  resolver = new ConflictResolver(db, { clock });
});
afterEach(() => db.close());

let n = 0;
function addFact(opts: {
  value: JsonValue;
  authority: string;
  observedAt: string;
  origin?: FactOrigin;
  subject?: string;
  predicate?: string;
  confidence?: number;
  validFrom?: string;
  validUntil?: string;
  producer?: 'connector' | 'ai' | 'rule';
}) {
  const refs = new SourceReferenceStore(db);
  const ref = refs.upsert({
    id: stableId('sourceReference', String(n++)),
    sourceSystem: opts.authority === 'academic-system' ? 'livecampusu' : 'microsoft365',
    authority: opts.authority,
    sourceItemId: `item-${n}`,
    retrievedAt: opts.observedAt,
  });
  const s = opts.subject ?? subject;
  const predicate = opts.predicate ?? 'room';
  return resolver.facts.put({
    id: factId(ref.id, s, predicate, opts.value),
    subject: s as typeof subject,
    predicate,
    value: opts.value,
    origin: opts.origin ?? 'authoritative',
    confidence: opts.confidence ?? 1,
    observedAt: opts.observedAt,
    sourceReferenceId: ref.id,
    producer: { type: opts.producer ?? 'connector', id: 'test' },
    ...(opts.validFrom ? { validFrom: opts.validFrom } : {}),
    ...(opts.validUntil ? { validUntil: opts.validUntil } : {}),
  });
}

describe('authority rules (§12)', () => {
  it('ships defaults matching the spec examples', () => {
    const r = loadDefaultAuthorityRules();
    expect(r.predicates.room).toEqual(['academic-system', 'instructor-announcement', 'syllabus']);
    expect(r.predicates.grade).toEqual(['academic-system']);
    expect(r.predicates.assignment_due).toEqual([
      'submission-system',
      'instructor-announcement',
      'syllabus',
      'academic-system',
      'transcript',
    ]);
    expect(r.multiValued).toEqual(['todo']);
  });
  it('parses and merges overrides', () => {
    const r = mergeAuthorityRules(loadDefaultAuthorityRules(), {
      predicates: { room: ['instructor-announcement', 'academic-system'] },
    });
    expect(r.predicates.room?.[0]).toBe('instructor-announcement');
    expect(r.predicates.grade).toEqual(['academic-system']);
    expect(() => parseAuthorityRules('recencyOverride: maybe')).toThrow();
  });
});

describe('ConflictResolver', () => {
  it('keeps contradicting facts side by side and reports a conflict when a newer lower-authority source disagrees (§9, §12)', () => {
    addFact({ value: '21教室', authority: 'academic-system', observedAt: '2026-09-01T00:00:00Z' });
    addFact({
      value: '11教室',
      authority: 'instructor-announcement',
      observedAt: '2026-10-02T01:00:00Z',
      origin: 'extracted',
      confidence: 0.9,
    });
    const res = resolver.resolve(subject, 'room');
    expect(res.status).toBe('conflict');
    expect(res.candidates.map((c) => c.fact.value)).toEqual(['21教室', '11教室']);
    expect(resolver.facts.active({ subjects: [subject] })).toHaveLength(2);
  });

  it('prefers higher authority when it is also the newest', () => {
    addFact({
      value: '11教室',
      authority: 'instructor-announcement',
      observedAt: '2026-09-01T00:00:00Z',
      origin: 'extracted',
    });
    addFact({ value: '21教室', authority: 'academic-system', observedAt: '2026-10-01T00:00:00Z' });
    expect(resolver.resolve(subject, 'room')).toMatchObject({
      status: 'resolved',
      value: '21教室',
      method: 'authority',
    });
  });

  it('ignores newer values from sources not listed for the predicate', () => {
    addFact({ value: '21教室', authority: 'academic-system', observedAt: '2026-09-01T00:00:00Z' });
    addFact({
      value: '99教室',
      authority: 'discussion',
      observedAt: '2026-10-02T00:00:00Z',
      origin: 'extracted',
    });
    expect(resolver.resolve(subject, 'room')).toMatchObject({
      status: 'resolved',
      value: '21教室',
      method: 'authority',
    });
  });

  it('follows the recency policy when configured', () => {
    const r = new ConflictResolver(db, {
      clock,
      rules: { ...loadDefaultAuthorityRules(), recencyOverride: 'recency' },
    });
    addFact({ value: '21教室', authority: 'academic-system', observedAt: '2026-09-01T00:00:00Z' });
    addFact({
      value: '11教室',
      authority: 'instructor-announcement',
      observedAt: '2026-10-02T00:00:00Z',
      origin: 'extracted',
    });
    expect(r.resolve(subject, 'room')).toMatchObject({
      status: 'resolved',
      value: '11教室',
      method: 'recency',
    });
  });

  it('never promotes inferred facts over direct evidence (§11)', () => {
    addFact({ value: '21教室', authority: 'academic-system', observedAt: '2026-09-01T00:00:00Z' });
    addFact({
      value: '31教室',
      authority: 'academic-system',
      observedAt: '2026-10-02T00:00:00Z',
      origin: 'inferred',
      producer: 'rule',
    });
    expect(resolver.resolve(subject, 'room')).toMatchObject({
      status: 'resolved',
      value: '21教室',
      origin: 'authoritative',
    });
  });

  it('presents an inferred value as inferred when nothing else exists', () => {
    addFact({
      value: '31教室',
      authority: 'academic-system',
      observedAt: '2026-10-02T00:00:00Z',
      origin: 'inferred',
      producer: 'ai',
    });
    expect(resolver.resolve(subject, 'room')).toMatchObject({
      status: 'resolved',
      value: '31教室',
      origin: 'inferred',
      method: 'only_inferred',
    });
  });

  it('rejects AI facts that claim authority (§48)', () => {
    expect(() =>
      addFact({
        value: 'x',
        authority: 'academic-system',
        observedAt: '2026-10-02T00:00:00Z',
        producer: 'ai',
      }),
    ).toThrow(PolicyViolationError);
  });

  it('honours validity windows', () => {
    addFact({ value: '21教室', authority: 'academic-system', observedAt: '2026-09-01T00:00:00Z' });
    addFact({
      value: '11教室',
      authority: 'instructor-announcement',
      observedAt: '2026-09-30T00:00:00Z',
      origin: 'extracted',
      validFrom: '2026-09-30T15:00:00Z',
      validUntil: '2026-10-01T15:00:00Z',
    });
    expect(resolver.resolve(subject, 'room', { at: new Date('2026-10-01T01:00:00Z') }).status).toBe(
      'conflict',
    );
    expect(
      resolver.resolve(subject, 'room', { at: new Date('2026-10-02T01:00:00Z') }),
    ).toMatchObject({ status: 'resolved', value: '21教室' });
  });

  it('merges facts across identity-linked subjects (§14)', () => {
    const linked = new ConflictResolver(db, {
      clock,
      expandSubject: (id) =>
        id === subject || id === teamsSubject ? [subject, teamsSubject] : [id],
      canonicalSubject: (id) => (id === teamsSubject ? subject : id),
    });
    addFact({ value: '21教室', authority: 'academic-system', observedAt: '2026-09-01T00:00:00Z' });
    addFact({
      value: '11教室',
      authority: 'instructor-announcement',
      observedAt: '2026-10-02T00:00:00Z',
      origin: 'extracted',
      subject: teamsSubject,
    });
    expect(linked.resolve(teamsSubject, 'room').status).toBe('conflict');
    const { opened } = linked.detectConflicts();
    expect(opened).toHaveLength(1);
    expect(opened[0]?.subject).toBe(subject);
    expect(opened[0]?.candidates.map((c) => c.value).sort()).toEqual(['11教室', '21教室']);
  });

  it('persists conflicts, resolves them by human correction (§74) and is idempotent', () => {
    addFact({ value: '21教室', authority: 'academic-system', observedAt: '2026-09-01T00:00:00Z' });
    addFact({
      value: '11教室',
      authority: 'instructor-announcement',
      observedAt: '2026-10-02T00:00:00Z',
      origin: 'extracted',
    });
    expect(resolver.detectConflicts().opened).toHaveLength(1);
    expect(resolver.detectConflicts().opened).toHaveLength(0);
    const open = resolver.listConflicts({ status: 'open' });
    expect(open).toHaveLength(1);
    const { fact, conflict } = resolver.correct({
      subject,
      predicate: 'room',
      value: '11教室',
      note: '教室で確認した',
    });
    expect(fact.origin).toBe('user');
    expect(conflict?.status).toBe('resolved');
    expect(resolver.resolve(subject, 'room')).toMatchObject({
      status: 'resolved',
      value: '11教室',
      method: 'user',
    });
    expect(resolver.detectConflicts()).toEqual({ opened: [], resolved: [] });
    expect(resolver.listConflicts({ status: 'open' })).toHaveLength(0);
  });

  it('auto-resolves a conflict once the disagreeing fact is retracted', () => {
    addFact({ value: '21教室', authority: 'academic-system', observedAt: '2026-09-01T00:00:00Z' });
    const f = addFact({
      value: '11教室',
      authority: 'instructor-announcement',
      observedAt: '2026-10-02T00:00:00Z',
      origin: 'extracted',
    });
    resolver.detectConflicts();
    resolver.facts.retract([f.id]);
    const { resolved } = resolver.detectConflicts();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.resolution?.method).toBe('authority');
  });

  it('formats citations for explanations (§75)', () => {
    const ref = new SourceReferenceStore(db).upsert({
      id: stableId('sourceReference', 'c'),
      sourceSystem: 'livecampusu',
      sourceLabel: '学務情報システム',
      authority: 'academic-system',
      sourceItemId: 'x',
      retrievedAt: '2026-10-01T00:42:00Z',
    });
    expect(toCitation(ref).label).toBe('学務情報システム 10/1 09:42取得');
    expect(
      formatCitationLabel({
        sourceSystem: 'chatgpt-record',
        retrievedAt: '2026-10-01T06:00:00Z',
        location: { timestamp: '00:42:18' },
      }),
    ).toBe('chatgpt-record 00:42:18 10/1 15:00取得');
  });
});
