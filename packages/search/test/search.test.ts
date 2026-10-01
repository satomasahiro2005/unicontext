import { stableId } from '@unicontext/canonical-model';
import { ManualClock } from '@unicontext/core';
import {
  EntityStore,
  openDatabase,
  SourceReferenceStore,
  type UniContextDatabase,
} from '@unicontext/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createEmbeddingProvider,
  EmbeddingIndex,
  extractTerms,
  lexicalSearch,
  routeQuery,
  SearchService,
} from '../src/index.js';

describe('query router (§15)', () => {
  it('routes the spec examples', () => {
    expect(routeQuery('明日締切')).toMatchObject({
      route: 'structured',
      intent: 'deadlines',
      range: 'tomorrow',
    });
    const er = routeQuery('ERモデルの説明どこ？');
    expect(er.route).toBe('lexical');
    expect(er.terms).toContain('ERモデル');
    expect(er.semantic).toBe(true);
    const tr = routeQuery('先生は試験について何て言った？');
    expect(tr.route).toBe('transcript');
    expect(tr.terms).toEqual(['試験']);
  });

  it('handles other structured questions', () => {
    expect(routeQuery('今日の授業')).toMatchObject({
      route: 'structured',
      intent: 'classes',
      range: 'today',
    });
    expect(routeQuery('来週の試験')).toMatchObject({
      route: 'structured',
      intent: 'exams',
      range: 'next_week',
    });
    expect(routeQuery('何が変わった？')).toMatchObject({ route: 'structured', intent: 'changes' });
    expect(extractTerms('正規化')).toEqual(['正規化']);
  });
});

let db: UniContextDatabase;
const clock = new ManualClock('2026-10-01T00:00:00Z'); // 09:00 JST, Thursday
const course = stableId('courseOffering', 'lcu', 'DB');
const other = stableId('courseOffering', 'lcu', 'LA');

beforeEach(() => {
  db = openDatabase();
  const e = new EntityStore(db, { clock });
  const refs = new SourceReferenceStore(db);
  const ann = stableId('announcement', 'a1');
  e.upsert({
    id: ann,
    kind: 'announcement',
    title: '第3回 補足',
    body: '今回扱ったデータの正規化について、第3正規形まで復習してください。',
    courseOfferingId: course,
  });
  refs.upsert({
    id: stableId('sourceReference', 'a1'),
    sourceSystem: 'microsoft365',
    sourceLabel: 'Microsoft Teams',
    authority: 'instructor-announcement',
    sourceItemId: 'msg-3812',
    retrievedAt: '2026-10-01T05:23:00Z',
    entityId: ann,
  });
  const doc = stableId('document', 'd1');
  e.upsert({ id: doc, kind: 'document', title: 'Lecture 3.pdf', courseOfferingId: course });
  e.upsert({
    id: stableId('documentChunk', 'd1', '0'),
    kind: 'documentChunk',
    documentId: doc,
    ordinal: 0,
    page: 4,
    text: 'ERモデルはエンティティと関連で実世界をモデル化する。',
  });
  const tr = stableId('lectureTranscript', 't1');
  e.upsert({ id: tr, kind: 'lectureTranscript', courseOfferingId: course });
  e.upsert({
    id: stableId('lectureSegment', 't1', '0'),
    kind: 'lectureSegment',
    transcriptId: tr,
    ordinal: 0,
    startMs: 2538000,
    text: '期末試験は持ち込み不可です。範囲は正規化まで。',
  });
  e.upsert({
    id: stableId('announcement', 'a2'),
    kind: 'announcement',
    title: '線形代数 小テスト',
    body: '行列の正規化は扱いません',
    courseOfferingId: other,
  });
  e.upsert({
    id: stableId('assignment', 'x1'),
    kind: 'assignment',
    title: '課題2',
    courseOfferingId: course,
    dueAt: '2026-10-02T23:59:00+09:00',
  });
  e.upsert({
    id: stableId('assignment', 'x2'),
    kind: 'assignment',
    title: '課題3',
    courseOfferingId: course,
    dueAt: '2026-10-09T23:59:00+09:00',
  });
});
afterEach(() => db.close());

describe('lexical search (FTS5 trigram)', () => {
  it('finds 「正規化」 inside Japanese text across kinds', () => {
    const hits = lexicalSearch(db, ['正規化']);
    expect(hits.map((h) => h.kind).sort()).toEqual([
      'announcement',
      'announcement',
      'lectureSegment',
    ]);
    expect(hits.find((h) => h.kind === 'lectureSegment')?.snippet).toContain('[正規化]');
  });

  it('matches two-character terms via LIKE fallback and filters by course', () => {
    expect(lexicalSearch(db, ['試験']).map((h) => h.kind)).toEqual(['lectureSegment']);
    expect(lexicalSearch(db, ['正規化'], { courseOfferingIds: [other] })).toHaveLength(1);
  });

  it('requires all terms first, then falls back to any', () => {
    expect(lexicalSearch(db, ['正規化', '第3正規形'])).toHaveLength(1);
    expect(lexicalSearch(db, ['ERモデル', '存在しない語']).map((h) => h.kind)).toEqual([
      'documentChunk',
    ]);
  });
});

describe('SearchService', () => {
  it('answers structured, lexical and transcript questions with citations', async () => {
    const s = new SearchService({ db, clock });
    const tomorrow = await s.search('明日締切');
    expect(tomorrow.hits.map((h) => h.title)).toEqual(['課題2']);
    const er = await s.search('ERモデルの説明どこ？');
    expect(er.hits[0]?.kind).toBe('documentChunk');
    const teacher = await s.search('先生は試験について何て言った？');
    expect(teacher.query.route).toBe('transcript');
    expect(teacher.hits[0]?.snippet).toContain('試験');
    const norm = await s.search('正規化', { courseOfferingId: course });
    const ann = norm.hits.find((h) => h.kind === 'announcement');
    expect(ann?.citations[0]?.label).toBe('Microsoft Teams 10/1 14:23取得');
  });

  it('blends optional semantic search (§16)', async () => {
    expect(createEmbeddingProvider({ provider: 'none' })).toBeUndefined();
    const vocab = ['正規', 'ER', '試験', '行列'];
    const provider = createEmbeddingProvider({
      provider: 'local',
      embedFn: async (texts) =>
        texts.map((t) => Float32Array.from(vocab.map((w) => (t.includes(w) ? 1 : 0)))),
    });
    if (!provider) throw new Error('provider');
    const index = new EmbeddingIndex(db, provider);
    expect(await index.refresh()).toBeGreaterThan(0);
    expect(await index.refresh()).toBe(0);
    const hits = await index.search('行列');
    expect(hits[0]?.entityId).toBe(stableId('announcement', 'a2'));
    const s = new SearchService({ db, clock, embeddings: index });
    const res = await s.search('行列のことはどこ');
    expect(res.hits.some((h) => h.id === stableId('announcement', 'a2'))).toBe(true);
  });
});
