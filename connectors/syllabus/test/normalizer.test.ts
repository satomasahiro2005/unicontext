import { CanonicalEntitySchema, type EntityOfKind } from '@unicontext/canonical-model';
import {
  createNormalizeContext,
  type NormalizedEntity,
  type RawItemView,
} from '@unicontext/connector-sdk';
import { describe, expect, it } from 'vitest';
import {
  createSyllabusNormalizer,
  SyllabusAdapter,
  SyllabusConfigSchema,
  type SyllabusEntryPayload,
} from '../src/index.js';
import { BASE, makeContext, shizuokaProfile } from './helpers.js';
import { createLcuServer } from './lcu-server.js';

async function fetchEntry(): Promise<RawItemView> {
  const srv = createLcuServer();
  const adapter = new SyllabusAdapter(
    makeContext(
      SyllabusConfigSchema.parse({
        baseUrl: BASE,
        screens: { syllabusSearch: 'SC_06001B00_21', syllabusDetail: 'SC_06001B00_22' },
        targets: [{ year: 2026, subjectCode: '77403030' }],
      }),
      srv.fetch,
    ),
  );
  const res = await adapter.sync({ mode: 'initial' });
  const raw = res.items[0]!;
  return {
    id: 'raw:1',
    sourceId: 'syllabus',
    sourceType: raw.sourceType,
    externalId: raw.externalId,
    payload: JSON.parse(JSON.stringify(raw.payload)) as unknown,
    fetchedAt: '2026-10-01T00:00:00.000Z',
    sourceUpdatedAt: undefined,
    contentHash: 'h',
  };
}

const of = <K extends NormalizedEntity['entity']['kind']>(es: NormalizedEntity[], kind: K) =>
  es.filter((e) => e.entity.kind === kind) as (NormalizedEntity & {
    entity: EntityOfKind[K];
  })[];

describe('syllabus normalizer', () => {
  it('maps an entry to course, courseOffering, document and chunks', async () => {
    const view = await fetchEntry();
    const ctx = createNormalizeContext({
      sourceId: 'syllabus',
      sourceSystem: 'syllabus',
      sourceLabel: 'シラバス',
      defaultAuthority: 'syllabus',
      profile: shizuokaProfile(),
    });
    const out = await createSyllabusNormalizer().normalize(view, ctx);
    expect(out.drift).toEqual([]);
    expect(out.warnings).toBeUndefined();
    for (const e of out.entities)
      expect(CanonicalEntitySchema.safeParse(e.entity).success).toBe(true);

    const [course] = of(out.entities, 'course');
    expect(course?.entity).toMatchObject({
      courseCode: '77403030',
      title: 'データベースシステム論',
      titleEn: 'Database System',
      credits: 2,
      department: '情報学領域',
    });

    const [offering] = of(out.entities, 'courseOffering');
    expect(offering?.entity).toMatchObject({
      courseId: course?.entity.id,
      courseCode: '77403030',
      academicYear: 2026,
      term: '後期',
      title: 'データベースシステム論',
      instructorNames: ['教員 花子'],
      room: '共通講義棟３１',
    });
    // 木3・4 -> weekday 4, LCU period pair index 2 (10:20-11:50 in the Shizuoka profile).
    expect(offering?.entity.schedule).toEqual([
      { dayOfWeek: 4, period: 2, startTime: '10:20', endTime: '11:50' },
    ]);
    expect(offering?.entity.extra).toMatchObject({
      rawSchedule: '木3・4',
      slots: [{ dayOfWeek: 4, period: 2, rawPeriod: '3・4' }],
      className: '1クラス',
    });
    // The room becomes an authoritative fact of authority "syllabus" via the source default.
    expect(offering?.ref?.authority).toBeUndefined();
    expect(ctx.defaultAuthority).toBe('syllabus');
    expect(offering?.deriveFacts).not.toBe(false);

    const [doc] = of(out.entities, 'document');
    expect(doc?.entity.title).toBe('シラバス: データベースシステム論');
    expect(doc?.entity.courseOfferingId).toBe(offering?.entity.id);
    expect(doc?.entity.text).toContain('リレーショナルデータベース');
    const chunks = of(out.entities, 'documentChunk');
    expect(chunks.length).toBeGreaterThan(8);
    expect(chunks.every((c) => c.entity.documentId === doc?.entity.id)).toBe(true);
    expect(chunks.map((c) => c.entity.ordinal)).toEqual(chunks.map((_, i) => i));
    expect(chunks.map((c) => c.entity.heading)).toEqual(
      expect.arrayContaining(['概要', '授業の目標', '授業計画', '成績評価の方法・基準']),
    );
    const plan = chunks.find((c) => c.entity.heading === '授業計画');
    expect(plan?.entity.text).toContain('第1回 導入');
    expect(plan?.ref?.location?.selector).toBe('授業計画');
    expect(out.entities.every((e) => e.ref?.url?.endsWith('SC_06001B00_21/init'))).toBe(true);
  });

  it('is deterministic and keys entities by source-local ids', async () => {
    const view = await fetchEntry();
    const ctx = createNormalizeContext({ sourceId: 'syllabus', sourceSystem: 'syllabus' });
    const n = createSyllabusNormalizer();
    const a = await n.normalize(view, ctx);
    const b = await n.normalize(view, ctx);
    expect(a.entities.map((e) => e.entity.id)).toEqual(b.entities.map((e) => e.entity.id));
    expect(of(a.entities, 'course')[0]?.entity.id).toBe(ctx.id('course', '77403030'));
  });

  it('reports drift and invalid payloads without throwing', async () => {
    const view = await fetchEntry();
    const payload = view.payload as SyllabusEntryPayload & { surprise?: string };
    payload.surprise = 'new field';
    const ctx = createNormalizeContext({ sourceId: 'syllabus', sourceSystem: 'syllabus' });
    const out = await createSyllabusNormalizer().normalize(view, ctx);
    expect(out.drift).toContainEqual({ path: 'surprise', kind: 'unknown' });
    expect(out.entities.length).toBeGreaterThan(0);

    const broken = await createSyllabusNormalizer().normalize(
      { ...view, payload: { nope: 1 } },
      ctx,
    );
    expect(broken.entities).toEqual([]);
    expect(broken.warnings?.[0]).toMatch(/invalid syllabus.entry payload/);
  });
});
