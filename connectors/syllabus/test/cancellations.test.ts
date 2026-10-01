import { CanonicalEntitySchema, type EntityOfKind } from '@unicontext/canonical-model';
import {
  createNormalizeContext,
  instantiateConnector,
  type NormalizedEntity,
  type RawItem,
  type RawItemView,
} from '@unicontext/connector-sdk';
import type { FetchLike } from '@unicontext/core';
import { describe, expect, it } from 'vitest';
import {
  type CancellationPayload,
  CancellationsAdapter,
  CancellationsConfigSchema,
  cancellationsConnector,
  cancellationTitle,
  createCancellationNormalizer,
  inferYear,
  matchUserCourse,
  parseCancellations,
  splitTitleAndClass,
} from '../src/index.js';
import { BASE, fixture, makeContext, memorySecrets, shizuokaProfile } from './helpers.js';

const htmlFetch =
  (html: string, calls: string[] = []): FetchLike =>
  (input) => {
    calls.push(input);
    return Promise.resolve(
      new Response(html, { status: 200, headers: { 'content-type': 'text/html;charset=UTF-8' } }),
    );
  };

function cfg(partial: Record<string, unknown> = {}) {
  return CancellationsConfigSchema.parse({
    baseUrl: BASE,
    screens: { publicCancellations: 'SC_90002szu_01' },
    ...partial,
  });
}

const page = (asOf: string, rows: [string, string, string, string][]): string => `
<main><h1>休講案内</h1><table class="c-table"><thead><tr>
<th>授業科目</th><th>休講日</th><th>時限</th><th>担当教員</th></tr></thead><tbody>
${rows.map(([a, b, c, d]) => `<tr class="is-unread"><td>${a}</td><td>${b}</td><td>${c}</td><td>${d}</td></tr>`).join('\n')}
</tbody></table><div align="right">${asOf}</div></main>`;

describe('public cancellations parser', () => {
  it('parses the fixture table and the as-of footer', () => {
    const res = parseCancellations(fixture('lcu-kyuko-SC_90002szu_01.html'));
    expect(res.recognized).toBe(true);
    expect(res.headerMismatch).toBe(false);
    expect(res.rows).toHaveLength(8);
    expect(res.asOf).toEqual({ year: 2026, month: 10, day: 1, hour: 11, minute: 29 });
    expect(res.rows[1]).toMatchObject({
      courseTitle: '数学Ⅲ（微分積分Ｂ）',
      className: '理２',
      month: 10,
      day: 1,
      period: '3・4',
      periodIndex: 2,
    });
    expect(res.rows[7]).toMatchObject({ courseTitle: '教育の原理', className: '教（Ｃ組）' });
  });

  it('splits the last top-level parenthesis as the class', () => {
    expect(splitTitleAndClass('数学Ⅲ（微分積分Ｂ） (理２)')).toEqual({
      courseTitle: '数学Ⅲ（微分積分Ｂ）',
      className: '理２',
    });
    expect(splitTitleAndClass('教育の原理 (教（Ｃ組）)')).toEqual({
      courseTitle: '教育の原理',
      className: '教（Ｃ組）',
    });
    expect(splitTitleAndClass('English (Advanced) (情)')).toEqual({
      courseTitle: 'English (Advanced)',
      className: '情',
    });
    expect(splitTitleAndClass('クラス無しの科目')).toEqual({ courseTitle: 'クラス無しの科目' });
  });

  it('accepts 時点 as well as 現在 and flags layout changes', () => {
    const p = parseCancellations(
      page('2026年10月01日09:05時点', [['国語 (情)', '10/02', '1・2', '教員']]),
    );
    expect(p.asOf).toMatchObject({ hour: 9, minute: 5 });
    const bad = parseCancellations(
      '<main><h1>休講案内</h1><table class="c-table"><thead><tr><th>科目</th></tr></thead></table></main>',
    );
    expect(bad.headerMismatch).toBe(true);
    expect(parseCancellations('<html><body>maintenance</body></html>').recognized).toBe(false);
    // No table but the heading: a legitimately empty page.
    expect(parseCancellations('<main><h1>休講案内</h1></main>')).toMatchObject({
      recognized: true,
      rows: [],
    });
  });

  it('infers the year of MM/DD from the as-of date across the year end', () => {
    const asOf = { year: 2026, month: 12, day: 28 };
    expect(inferYear(12, 29, asOf)).toBe(2026);
    expect(inferYear(1, 5, asOf)).toBe(2027);
    expect(inferYear(10, 1, { year: 2026, month: 10, day: 1 })).toBe(2026);
    const jan = { year: 2027, month: 1, day: 4 };
    expect(inferYear(12, 25, jan)).toBe(2026);
    expect(inferYear(1, 20, jan)).toBe(2027);
    expect(inferYear(2, 29, { year: 2027, month: 3, day: 1 })).toBe(2028);
  });
});

describe('matching the user courses', () => {
  const courses = [
    { title: '外国史概論', classCode: '人文専門１A' },
    { title: 'データベースシステム論' },
  ];
  it('matches by normalized title and optional class', () => {
    expect(
      matchUserCourse({ courseTitle: '外国史概論', className: '人文専門１A' }, courses, 0.85)
        ?.title,
    ).toBe('外国史概論');
    expect(
      matchUserCourse({ courseTitle: '外国史概論', className: '人文専門１B' }, courses, 0.85),
    ).toBeUndefined();
    expect(
      matchUserCourse(
        { courseTitle: 'データベースシステム論', className: undefined },
        courses,
        0.85,
      )?.title,
    ).toBe('データベースシステム論');
    expect(
      matchUserCourse({ courseTitle: '数学Ⅲ（微分積分Ｂ）', className: '理２' }, courses, 0.85),
    ).toBeUndefined();
  });
});

describe('cancellations adapter', () => {
  it('emits one raw item per row, marks the user courses, and completes the type', async () => {
    const calls: string[] = [];
    const adapter = new CancellationsAdapter(
      makeContext(
        cfg({ courses: [{ title: '外国史概論', classCode: '人文専門１A' }] }),
        htmlFetch(fixture('lcu-kyuko-SC_90002szu_01.html'), calls),
      ),
    );
    const res = await adapter.sync({ mode: 'initial' });
    expect(calls).toEqual([`${BASE}SC_90002szu_01`]);
    expect(res.items).toHaveLength(8);
    expect(res.complete).toEqual({ sourceTypes: ['lcu.publicCancellation'] });
    const byId = new Map(res.items.map((i) => [i.externalId, i.payload as CancellationPayload]));
    const a = byId.get('外国史概論|人文専門１A|2026-10-02|3・4');
    expect(a).toMatchObject({
      date: '2026-10-02',
      dateText: '10/02',
      period: '3・4',
      periodIndex: 2,
      matched: { title: '外国史概論', classCode: '人文専門１A' },
    });
    expect(byId.get('外国史概論|人文専門１B|2026-10-02|3・4')?.matched).toBeUndefined();
    expect(res.items.filter((i) => (i.payload as CancellationPayload).matched)).toHaveLength(1);
    expect(res.items.every((i) => i.sourceUpdatedAt === '2026-10-01T02:29:00.000Z')).toBe(true);
    expect(res.cursor).toEqual({ lastModified: '2026-10-01T02:29:00.000Z' });
  });

  it('merges duplicate rows and handles the year rollover', async () => {
    const html = page('2026年12月28日10:00現在', [
      ['国語 (情)', '12/29', '1・2', '教員 A'],
      ['国語 (情)', '12/29', '1・2', '教員 B'],
      ['国語 (情)', '01/05', '1・2', '教員 A'],
    ]);
    const adapter = new CancellationsAdapter(makeContext(cfg(), htmlFetch(html)));
    const res = await adapter.sync({ mode: 'initial' });
    expect(res.items.map((i) => i.externalId)).toEqual([
      '国語|情|2026-12-29|1・2',
      '国語|情|2027-01-05|1・2',
    ]);
    expect((res.items[0]?.payload as CancellationPayload).instructors).toEqual([
      '教員 A',
      '教員 B',
    ]);
  });

  it('uses an injected courseProvider and fails loudly when the layout changes', async () => {
    const html = page('2026年10月01日10:00現在', [['国語 (情)', '10/02', '1・2', '教員']]);
    const adapter = new CancellationsAdapter(makeContext(cfg(), htmlFetch(html)), {
      courseProvider: () => [{ title: '国語' }],
    });
    expect((await adapter.sync({ mode: 'initial' })).items[0]?.payload).toMatchObject({
      matched: { title: '国語' },
    });
    adapter.courseProvider = () => {
      throw new Error('timetable not synced');
    };
    // failing provider: the run fails instead of rewriting rows without their matches
    await expect(adapter.sync({ mode: 'initial' })).rejects.toThrow(/courseProvider failed/);

    const broken = new CancellationsAdapter(makeContext(cfg(), htmlFetch('<html>x</html>')));
    await expect(broken.sync({ mode: 'initial' })).rejects.toThrow(/layout changed/);
    expect(await broken.health()).toMatchObject({ state: 'degraded' });
  });

  it('is configured through the Shizuoka deployment profile', () => {
    const inst = instantiateConnector(cancellationsConnector, {
      sourceId: 'cancellations',
      config: { deployment: 'shizuoka' },
      secrets: memorySecrets(),
      fetch: htmlFetch(fixture('lcu-kyuko-SC_90002szu_01.html')),
    });
    expect(inst.metadata).toMatchObject({
      product: 'lcu-public-cancellations',
      defaultSchedule: '15m',
      defaultAuthority: 'academic-system',
      sourceLabel: '休講案内',
    });
  });
});

const of = <K extends NormalizedEntity['entity']['kind']>(es: NormalizedEntity[], kind: K) =>
  es.filter((e) => e.entity.kind === kind) as (NormalizedEntity & { entity: EntityOfKind[K] })[];

function view(item: RawItem): RawItemView {
  return {
    id: 'raw:x',
    sourceId: 'cancel',
    sourceType: item.sourceType,
    externalId: item.externalId,
    payload: JSON.parse(JSON.stringify(item.payload)) as unknown,
    fetchedAt: '2026-10-01T02:30:00.000Z',
    sourceUpdatedAt: item.sourceUpdatedAt,
    contentHash: 'h',
  };
}

describe('cancellations normalizer', () => {
  it('always emits a university announcement; matched rows also get a cancelled class session', async () => {
    const adapter = new CancellationsAdapter(
      makeContext(
        cfg({ courses: [{ title: '外国史概論', classCode: '人文専門１A' }] }),
        htmlFetch(fixture('lcu-kyuko-SC_90002szu_01.html')),
      ),
    );
    const { items } = await adapter.sync({ mode: 'initial' });
    const ctx = createNormalizeContext({
      sourceId: 'cancel',
      sourceSystem: 'lcu-public-cancellations',
      sourceLabel: '休講案内',
      defaultAuthority: 'academic-system',
      profile: shizuokaProfile(),
    });
    const normalizer = createCancellationNormalizer();

    const other = items.find((i) => i.externalId.startsWith('数学Ⅲ'))!;
    const o = await normalizer.normalize(view(other), ctx);
    expect(o.drift).toEqual([]);
    expect(o.entities.map((e) => e.entity.kind)).toEqual(['announcement']);
    expect(o.entities[0]?.entity).toMatchObject({
      title: '休講: 数学Ⅲ（微分積分Ｂ） (理２) 10/1 3・4限',
      scope: 'other',
      category: '休講',
      importance: 'low',
      publishedAt: '2026-10-01T02:29:00.000Z',
    });

    const mine = items.find((i) => i.externalId.startsWith('外国史概論|人文専門１A'))!;
    const m = await normalizer.normalize(view(mine), ctx);
    for (const e of m.entities)
      expect(CanonicalEntitySchema.safeParse(e.entity).success).toBe(true);
    const [offering] = of(m.entities, 'courseOffering');
    const [session] = of(m.entities, 'classSession');
    const [announcement] = of(m.entities, 'announcement');
    expect(offering?.entity).toMatchObject({
      title: '外国史概論',
      academicYear: 2026,
      instructorNames: ['教員 花子'],
      // 2026-10-02 is a Friday; 3・4 is the second 90-minute period.
      schedule: [{ dayOfWeek: 5, period: 2 }],
    });
    expect(session?.entity).toMatchObject({
      courseOfferingId: offering?.entity.id,
      date: '2026-10-02',
      period: 2,
      status: 'cancelled',
      startsAt: '2026-10-02T01:20:00.000Z',
      endsAt: '2026-10-02T02:50:00.000Z',
    });
    expect(announcement?.entity).toMatchObject({
      importance: 'high',
      scope: 'course',
      courseOfferingId: offering?.entity.id,
    });
    // The cancelled status flows into the class_status fact with the source authority (academic-system).
    expect(ctx.defaultAuthority).toBe('academic-system');
    expect(session?.deriveFacts).not.toBe(false);
  });

  it('formats the announcement title', () => {
    expect(
      cancellationTitle({
        title: 'x',
        courseTitle: '国語',
        className: '情',
        dateText: '10/01',
        date: '2026-10-01',
        period: '3・4',
        instructors: [],
        url: 'u',
      }),
    ).toBe('休講: 国語 (情) 10/1 3・4限');
  });
});
