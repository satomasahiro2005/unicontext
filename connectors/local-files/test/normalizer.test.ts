import path from 'node:path';
import { CanonicalEntitySchema, type CanonicalEntity } from '@unicontext/canonical-model';
import {
  createNormalizeContext,
  type NormalizeOutput,
  type RawItem,
  type RawItemView,
} from '@unicontext/connector-sdk';
import { normalizeCourseTitle } from '@unicontext/identity';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalFilesNormalizer, materialKindFor } from '../src/index.js';
import {
  buildUniversityTree,
  collect,
  createAdapter,
  makeTempDir,
  put,
  removeDir,
} from './helpers.js';

const SOURCE_ID = 'files';
const ctx = createNormalizeContext({
  sourceId: SOURCE_ID,
  sourceSystem: 'local-files',
  sourceLabel: 'ローカルファイル',
  defaultAuthority: 'local-file',
  now: new Date('2026-10-01T00:00:00Z'),
});
const normalizer = createLocalFilesNormalizer({ chunkSize: 200, chunkOverlap: 20 });

function view(item: RawItem): RawItemView {
  return {
    id: `raw:${item.externalId}`,
    sourceId: SOURCE_ID,
    sourceType: item.sourceType,
    externalId: item.externalId,
    payload: JSON.parse(JSON.stringify(item.payload)) as unknown,
    fetchedAt: '2026-10-01T00:00:00.000Z',
    sourceUpdatedAt: item.sourceUpdatedAt,
    contentHash: 'h',
  };
}

let root: string;
let items: RawItem[];

beforeAll(async () => {
  root = await makeTempDir();
  await buildUniversityTree(root);
  items = (await collect(createAdapter({ roots: [root] }), { mode: 'initial' })).items;
});
afterAll(async () => {
  await removeDir(root);
});

async function normalizeRel(rel: string): Promise<NormalizeOutput> {
  const item = items.find((i) => (i.payload as { relativePath: string }).relativePath === rel);
  if (!item) throw new Error(`no raw item for ${rel}`);
  return normalizer.normalize(view(item), ctx);
}

const ofKind = <K extends CanonicalEntity['kind']>(
  out: NormalizeOutput,
  kind: K,
): Extract<CanonicalEntity, { kind: K }>[] =>
  out.entities
    .map((e) => CanonicalEntitySchema.parse(e.entity))
    .filter((e): e is Extract<CanonicalEntity, { kind: K }> => e.kind === kind);

const DIR = '2026前期/データベースシステム論';

describe('local-files normalizer', () => {
  it('produces canonical-valid entities for every fixture file', async () => {
    for (const item of items) {
      const out = await normalizer.normalize(view(item), ctx);
      expect(out.warnings ?? []).toEqual([]);
      for (const e of out.entities)
        expect(CanonicalEntitySchema.safeParse(e.entity).success).toBe(true);
      expect(ofKind(out, 'document')).toHaveLength(1);
    }
  });

  it('PDF: page-aware chunks with ref.location.page and a course offering', async () => {
    const out = await normalizeRel(`${DIR}/第3回.pdf`);
    const [doc] = ofKind(out, 'document');
    expect(doc).toMatchObject({
      title: '第3回.pdf',
      mimeType: 'application/pdf',
      pageCount: 2,
      text: 'Relational model\n\nNormalization',
    });
    expect(doc?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc?.path).toBe(path.join(root, ...`${DIR}/第3回.pdf`.split('/')));
    expect(doc?.title).not.toContain(root);
    expect(doc?.modifiedAt).toBeTruthy();
    const chunks = ofKind(out, 'documentChunk');
    expect(chunks.map((c) => [c.ordinal, c.page, c.text])).toEqual([
      [0, 1, 'Relational model'],
      [1, 2, 'Normalization'],
    ]);
    expect(chunks.every((c) => c.documentId === doc?.id)).toBe(true);
    const chunkRefs = out.entities
      .filter((e) => e.entity.kind === 'documentChunk')
      .map((e) => e.ref?.location?.page);
    expect(chunkRefs).toEqual([1, 2]);

    const [offering] = ofKind(out, 'courseOffering');
    expect(offering).toMatchObject({
      title: 'データベースシステム論',
      academicYear: 2026,
      term: '前期',
    });
    expect(offering?.id).toBe(
      ctx.id('courseOffering', normalizeCourseTitle('データベースシステム論'), '2026'),
    );
    expect(doc?.courseOfferingId).toBe(offering?.id);
    const [material] = ofKind(out, 'material');
    expect(material).toMatchObject({
      materialKind: 'handout',
      documentId: doc?.id,
      courseOfferingId: offering?.id,
    });
  });

  it('PPTX: slide-aware chunks with heading = slide title or "Slide N", material = slides, lecture date', async () => {
    const out = await normalizeRel(`${DIR}/slides 2026-10-01.pptx`);
    const chunks = ofKind(out, 'documentChunk');
    expect(chunks.map((c) => [c.page, c.heading])).toEqual([
      [1, 'ER図'],
      [2, '正規化'],
    ]);
    expect(chunks[0]?.text).toContain('例を板書する');
    const [doc] = ofKind(out, 'document');
    expect(doc?.pageCount).toBe(2);
    expect(doc?.extra).toMatchObject({ lectureDate: '2026-10-01', ext: 'pptx' });
    const [material] = ofKind(out, 'material');
    expect(material?.materialKind).toBe('slides');
    const [lecture] = ofKind(out, 'lecture');
    expect(lecture).toMatchObject({ date: '2026-10-01' });
    expect(material?.lectureId).toBe(lecture?.id);
    expect(lecture?.courseOfferingId).toBe(material?.courseOfferingId);
  });

  it('untitled slides get "Slide N" headings', async () => {
    const out = await normalizer.normalize(
      view({
        sourceType: 'file.document',
        externalId: 'k:x.pptx',
        payload: {
          root: '/r',
          relativePath: 'x.pptx',
          name: 'x.pptx',
          ext: 'pptx',
          mimeType: 'application/octet-stream',
          size: 1,
          mtime: '2026-10-01T00:00:00.000Z',
          hash: 'h',
          slides: [{ slide: 1, text: 'only body' }],
        },
      }),
      ctx,
    );
    expect(ofKind(out, 'documentChunk')[0]?.heading).toBe('Slide 1');
    expect(ofKind(out, 'material')).toHaveLength(0); // no course folder, no material
    expect(ofKind(out, 'courseOffering')).toHaveLength(0);
  });

  it('Markdown chunks keep headings; HTML/TXT/DOCX produce text chunks', async () => {
    const md = await normalizeRel(`${DIR}/メモ.md`);
    expect(ofKind(md, 'documentChunk').map((c) => c.heading)).toEqual(['概要', '課題']);
    expect(ofKind(md, 'material')[0]?.materialKind).toBe('other');
    const html = await normalizeRel(`${DIR}/index.html`);
    expect(ofKind(html, 'documentChunk')[0]?.text).toContain('授業ページ');
    const docx = await normalizeRel(`${DIR}/report.docx`);
    expect(ofKind(docx, 'document')[0]?.text).toContain('レポート本文');
  });

  it('images and recordings are documents without chunks; recording material kind', async () => {
    const png = await normalizeRel(`${DIR}/photo.png`);
    expect(ofKind(png, 'documentChunk')).toHaveLength(0);
    expect(ofKind(png, 'document')[0]?.extra).toMatchObject({ image: { width: 64, height: 32 } });
    const mp4 = await normalizeRel(`${DIR}/lecture.mp4`);
    expect(ofKind(mp4, 'material')[0]?.materialKind).toBe('recording');
  });

  it('all documents of one course share the same offering id', async () => {
    const a = ofKind(await normalizeRel(`${DIR}/第3回.pdf`), 'courseOffering')[0];
    const b = ofKind(await normalizeRel(`${DIR}/メモ.md`), 'courseOffering')[0];
    const c = ofKind(await normalizeRel('ノート/todo.txt'), 'courseOffering')[0];
    expect(a?.id).toBe(b?.id);
    expect(c?.id).not.toBe(a?.id);
    expect(c).toMatchObject({ title: 'ノート' });
    expect(c?.academicYear).toBeUndefined();
  });

  it('files outside any course folder get no offering and no material', async () => {
    const out = await normalizeRel('readme.txt');
    expect(ofKind(out, 'courseOffering')).toHaveLength(0);
    expect(ofKind(out, 'material')).toHaveLength(0);
    expect(ofKind(out, 'document')[0]?.courseOfferingId).toBeUndefined();
  });

  it('is deterministic and reports an invalid payload as a warning', async () => {
    const a = await normalizeRel(`${DIR}/第3回.pdf`);
    const b = await normalizeRel(`${DIR}/第3回.pdf`);
    expect(a.entities.map((e) => e.entity.id)).toEqual(b.entities.map((e) => e.entity.id));
    const bad = await normalizer.normalize(
      view({ sourceType: 'file.document', externalId: 'x', payload: { nope: 1 } }),
      ctx,
    );
    expect(bad.entities).toEqual([]);
    expect(bad.warnings?.[0]).toMatch(/invalid/);
    expect(bad.drift?.length).toBeGreaterThan(0);
  });

  it('long text is split into several chunks within the chunk size', async () => {
    const dir = await makeTempDir();
    try {
      await put(dir, 'データ/long.txt', '文章です。'.repeat(200));
      const { items: its } = await collect(createAdapter({ roots: [dir] }), { mode: 'initial' });
      const out = await normalizer.normalize(view(its[0] as RawItem), ctx);
      const chunks = ofKind(out, 'documentChunk');
      expect(chunks.length).toBeGreaterThan(4);
      expect(chunks.every((c) => c.text.length <= 200)).toBe(true);
      expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
    } finally {
      await removeDir(dir);
    }
  });

  it('classifies material kinds', () => {
    expect(materialKindFor('pptx')).toBe('slides');
    expect(materialKindFor('key')).toBe('slides');
    expect(materialKindFor('pdf')).toBe('handout');
    expect(materialKindFor('m4a')).toBe('recording');
    expect(materialKindFor('py')).toBe('code');
    expect(materialKindFor('docx')).toBe('other');
  });
});
