import { CanonicalEntitySchema, type EntityOfKind } from '@unicontext/canonical-model';
import {
  createNormalizeContext,
  type NormalizedEntity,
  type RawItemView,
} from '@unicontext/connector-sdk';
import { describe, expect, it } from 'vitest';
import {
  createPortalNormalizer,
  decodeEntities,
  detectPdfKind,
  extractPdfLinks,
  htmlToText,
  PORTAL_AUTHORITY,
  type WpPdfPayload,
} from '../src/index.js';
import { BASE, samplePosts } from './helpers.js';
import { post } from './wp-server.js';

const ctx = createNormalizeContext({
  sourceId: 'portal',
  sourceSystem: 'wordpress-portal',
  sourceLabel: '大学ポータル',
  defaultAuthority: PORTAL_AUTHORITY,
});

function view(
  sourceType: string,
  externalId: string,
  payload: unknown,
  sourceUpdatedAt?: string,
): RawItemView {
  return {
    id: `raw:${externalId}`,
    sourceId: 'portal',
    sourceType,
    externalId,
    payload: JSON.parse(JSON.stringify(payload)) as unknown,
    fetchedAt: '2026-10-01T00:00:00.000Z',
    sourceUpdatedAt,
    contentHash: 'h',
  };
}

const of = <K extends NormalizedEntity['entity']['kind']>(es: NormalizedEntity[], kind: K) =>
  es.filter((e) => e.entity.kind === kind) as (NormalizedEntity & { entity: EntityOfKind[K] })[];

describe('html helpers', () => {
  it('decodes entities and flattens content to text', () => {
    expect(decodeEntities('A &amp; B &#8211; &raquo; C')).toBe('A & B – » C');
    expect(htmlToText('<p>一行目<br>二行目</p><ul><li>項目1</li><li>項目2</li></ul>')).toBe(
      '一行目\n二行目\n項目1\n項目2',
    );
  });

  it('finds PDF links, resolving relative URLs, dropping duplicates and falling back to file names', () => {
    const links = extractPdfLinks(
      `<a href="/a/x.pdf?ver=2">時間割 前期</a><a href="x.PDF#p3">again</a>
       <a href="/a/y.pdf"><img src="i.png"></a><a href="/doc.pdf.html">no</a><a href="mailto:a@b.c">m</a>
       <a href="/a/x.pdf?ver=2">dup</a>`,
      'https://site.example/dir/page',
    );
    expect(links).toEqual([
      { url: 'https://site.example/a/x.pdf?ver=2', text: '時間割 前期' },
      { url: 'https://site.example/dir/x.PDF', text: 'again' },
      { url: 'https://site.example/a/y.pdf', text: 'y.pdf' },
    ]);
  });

  it('classifies timetable, exam timetable and calendar PDFs', () => {
    expect(detectPdfKind('情報学部・情報学専攻 R8時間割 前期')).toBe('timetable');
    expect(detectPdfKind('令和８年度前期末試験時間割')).toBe('exam-timetable');
    expect(detectPdfKind('令和8年度行事予定表')).toBe('calendar');
    expect(detectPdfKind('読替表')).toBeUndefined();
  });
});

describe('wp.post -> announcement', () => {
  it('maps the sample posts', async () => {
    const [plain, important] = samplePosts() as [
      ReturnType<typeof samplePosts>[number],
      ReturnType<typeof samplePosts>[number],
    ];
    const n = createPortalNormalizer({ label: '学生教務ポータル' });
    const a = await n.normalize(
      view('wp.post', String(plain.id), { ...plain, categoryNames: ['全学向け情報'] }),
      ctx,
    );
    expect(a.drift).toEqual([]);
    const [ann] = of(a.entities, 'announcement');
    expect(CanonicalEntitySchema.safeParse(ann?.entity).success).toBe(true);
    expect(ann?.entity).toMatchObject({
      title: '2026年度オンライン授業科目一覧表に関するお知らせを掲載しました。',
      body: '本サイト【学生向け情報】の「オンライン授業科目関係」をご参照ください。',
      publishedAt: '2026-03-06T08:34:23.000Z',
      importance: 'normal',
      scope: 'university',
      category: '全学向け情報',
      url: 'https://wwp.shizuoka.ac.jp/acad-affairs-portal/archives/2813',
    });
    expect(ann?.ref).toMatchObject({
      authority: 'university-portal',
      sourceLabel: '学生教務ポータル',
      url: 'https://wwp.shizuoka.ac.jp/acad-affairs-portal/archives/2813',
    });

    const b = await n.normalize(view('wp.post', String(important.id), important), ctx);
    const [imp] = of(b.entities, 'announcement');
    expect(imp?.entity.importance).toBe('high');
    expect(imp?.entity.title).toContain('【重要】');
    // The link of the post is kept in the body, with its text.
    expect(imp?.entity.body).toContain('リンク:');
    expect(imp?.entity.body).toContain('https://www.cii.shizuoka.ac.jp/?p=3434');
    expect(imp?.entity.category).toBeUndefined();
  });

  it('falls back to the local date, decodes entity titles and reports drift', async () => {
    const p = post(7, '2026-06-01T00:00:00', {
      title: { rendered: '前期 &amp; 後期 &#8211; 日程' },
      date_gmt: undefined,
      date: '2026-06-01T09:00:00',
    });
    const withExtra = { ...p, template: 'x' };
    const out = await createPortalNormalizer().normalize(view('wp.post', '7', withExtra), ctx);
    const [ann] = of(out.entities, 'announcement');
    expect(ann?.entity.title).toBe('前期 & 後期 – 日程');
    expect(ann?.entity.publishedAt).toBe('2026-06-01T00:00:00.000Z'); // 09:00 JST
    expect(out.drift).toContainEqual({ path: 'template', kind: 'unknown' });
    const broken = await createPortalNormalizer().normalize(
      view('wp.post', '8', { nope: true }),
      ctx,
    );
    expect(broken.entities).toEqual([]);
    expect(broken.warnings?.[0]).toMatch(/invalid wp.post payload/);
  });

  it('ignores categories (names are resolved into post payloads)', async () => {
    const out = await createPortalNormalizer().normalize(
      view('wp.category', '1', { id: 1, name: '全学向け情報' }),
      ctx,
    );
    expect(out.entities).toEqual([]);
  });
});

describe('wp.pdf -> document, chunks, material', () => {
  const payload: WpPdfPayload = {
    url: `${BASE}wp-content/uploads/2026/08/abc.pdf`,
    title: '情報学部・情報学専攻 R8時間割 後期',
    foundOn: `${BASE}student_e/inf`,
    size: 1234,
    sha256: 'a'.repeat(64),
    lastModified: '2026-08-20T03:00:00.000Z',
    pages: [
      { page: 1, text: '月 1・2限 データベースシステム論 共通講義棟31' },
      { page: 2, text: '   ' },
      { page: 3, text: '木 3・4限 実験' },
    ],
  };

  it('creates the document with kind, per-page chunks and a handout material', async () => {
    const out = await createPortalNormalizer({ label: '学生教務ポータル' }).normalize(
      view('wp.pdf', payload.url, payload),
      ctx,
    );
    expect(out.drift).toEqual([]);
    for (const e of out.entities)
      expect(CanonicalEntitySchema.safeParse(e.entity).success).toBe(true);
    const [doc] = of(out.entities, 'document');
    expect(doc?.entity).toMatchObject({
      title: payload.title,
      mimeType: 'application/pdf',
      url: payload.url,
      sizeBytes: 1234,
      contentHash: 'a'.repeat(64),
      pageCount: 3,
      modifiedAt: '2026-08-20T03:00:00.000Z',
      extra: { kind: 'timetable', foundOn: payload.foundOn },
    });
    expect(doc?.entity.text).toContain('データベースシステム論');
    const chunks = of(out.entities, 'documentChunk');
    expect(chunks.map((c) => [c.entity.page, c.entity.ordinal])).toEqual([
      [1, 0],
      [3, 2],
    ]);
    expect(chunks[1]?.ref?.location).toEqual({ page: 3 });
    expect(chunks.every((c) => c.ref?.url === payload.url)).toBe(true);
    const [mat] = of(out.entities, 'material');
    expect(mat?.entity).toMatchObject({
      materialKind: 'handout',
      documentId: doc?.entity.id,
      url: payload.url,
    });
    expect(out.entities.every((e) => e.ref?.authority === 'university-portal')).toBe(true);
  });

  it('marks exam timetables and calendars', async () => {
    const n = createPortalNormalizer();
    const exam = await n.normalize(
      view('wp.pdf', 'u1', { ...payload, url: 'u1', title: '令和8年度前期末試験時間割' }),
      ctx,
    );
    expect(of(exam.entities, 'document')[0]?.entity.extra).toMatchObject({
      kind: 'exam-timetable',
    });
    const cal = await n.normalize(
      view('wp.pdf', 'u2', { ...payload, url: 'u2', title: '令和8年度行事予定表' }),
      ctx,
    );
    expect(of(cal.entities, 'document')[0]?.entity.extra).toMatchObject({ kind: 'calendar' });
    const other = await n.normalize(
      view('wp.pdf', 'u3', { ...payload, url: 'u3', title: '読替表' }),
      ctx,
    );
    expect(of(other.entities, 'document')[0]?.entity.extra).toEqual({ foundOn: payload.foundOn });
  });

  it('is deterministic', async () => {
    const n = createPortalNormalizer();
    const v = view('wp.pdf', payload.url, payload);
    const a = await n.normalize(v, ctx);
    const b = await n.normalize(v, ctx);
    expect(a.entities.map((e) => e.entity.id)).toEqual(b.entities.map((e) => e.entity.id));
  });
});
