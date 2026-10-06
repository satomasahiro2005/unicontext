import JSZip from 'jszip';
import { type CanonicalEntityInput, stableId } from '@unicontext/canonical-model';
import {
  createNormalizeContext,
  defineMetadata,
  type FileDownloadAdapter,
  type FileDownloadOutcome,
  type FileDownloadRequest,
  type Normalizer,
  type RawItem,
  type SourceAdapter,
} from '@unicontext/connector-sdk';
import { createCanvas } from '@napi-rs/canvas';
import { createLocalFilesNormalizer, metadata as localMetadata } from '@unicontext/local-files';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/* Synthetic documents and fake sources for the document tests (no network, no real data). */

/** A PDF with one page per entry: text pages draw their string, an empty string is a "scan" (a box). */
export function makePdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const add = (body: string): number => objects.push(body);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  );
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((text, i) => {
    // 10 pt lines of at most 80 characters, so everything stays on the page (pdf.js drops the rest)
    const lines = text.match(/.{1,80}/g) ?? [];
    const content = text
      ? `BT /F1 10 Tf 12 TL 72 780 Td ${lines.map((l) => `(${l}) Tj T*`).join(' ')} ET`
      : '0.6 g 72 72 400 600 re f';
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
    );
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A PNG big enough to count as content (not a decoration). */
export function makePng(width = 320, height = 200, color = '#2255cc'): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  // deterministic speckle so the file is not a few hundred bytes of flat colour
  let seed = 12345;
  const next = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `rgb(${next() % 256},${next() % 256},${next() % 256})`;
    ctx.fillRect(next() % width, next() % height, 9, 9);
  }
  return canvas.toBuffer('image/png');
}

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const slideXml = (title: string, body: string): string =>
  `<p:sld ${NS}><p:cSld><p:spTree>` +
  `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>` +
  `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp>` +
  `</p:spTree></p:cSld></p:sld>`;

/** A deck: slide 1 and 2 have text, slide 2 also embeds `ppt/media/image1.png` (and a tiny icon). */
export async function makePptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'ppt/presentation.xml',
    `<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>' +
      '</Relationships>',
  );
  zip.file('ppt/slides/slide1.xml', slideXml('第1回 ガイダンス', '関係モデルの基礎を学ぶ'));
  zip.file('ppt/slides/slide2.xml', slideXml('ER図', 'エンティティと関連を描く'));
  zip.file(
    'ppt/slides/_rels/slide2.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>' +
      '<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/icon.png"/>' +
      '<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
      '</Relationships>',
  );
  zip.file('ppt/media/image1.png', makePng(640, 400));
  zip.file('ppt/media/icon.png', makePng(16, 16));
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** A minimal Word file: one paragraph and one embedded picture. */
export async function makeDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/figure1.png"/></Relationships>',
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:p><w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rId9"/></w:drawing></w:r></w:p></w:body></w:document>`,
  );
  zip.file('word/media/figure1.png', makePng(500, 300, '#cc5522'));
  return zip.generateAsync({ type: 'nodebuffer' });
}

export function writeFixture(dir: string, relative: string, data: Buffer | string): string {
  const file = path.join(dir, ...relative.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  return file;
}

export const fakeMetadata = (product: string, rawTypes: string[]) =>
  defineMetadata({
    name: `@test/${product}`,
    product,
    version: '1.0.0',
    license: 'MIT',
    capabilities: ['files'],
    adapter: 'rest',
    apiStability: 'official',
    risk: 'supported',
    sourceLabel: product,
    rawTypes,
  });

/** Normalizer that turns each raw item of `rawType` into one entity (and a source reference). */
export function fakeNormalizer(
  sourceId: string,
  rawType: string,
  build: (item: { externalId: string; payload: unknown }) => Omit<CanonicalEntityInput, 'id'> & {
    kind: 'document' | 'announcement';
  },
): Normalizer {
  return {
    id: `${sourceId}-fake`,
    version: '1',
    sourceTypes: [rawType],
    normalize(item) {
      const entity = build(item);
      return {
        entities: [
          {
            entity: {
              ...entity,
              id: stableId(entity.kind, sourceId, item.externalId),
            } as CanonicalEntityInput,
            ref: { url: (entity as { url?: string }).url ?? '', authority: 'lms' },
          },
        ],
      };
    },
  };
}

export const fakeCtx = createNormalizeContext({ sourceId: 'x', sourceSystem: 'x' });

/** What the fixtures need of a runtime (structural, so the caller's own build of UniContext fits). */
export interface DocumentHost {
  sync: {
    register(source: {
      sourceId: string;
      adapter: SourceAdapter;
      normalizer: Normalizer;
      metadata: ReturnType<typeof defineMetadata>;
    }): void;
    ingest(sourceId: string, result: { items: RawItem[] }): Promise<unknown>;
    stores: { entities: { list(kind: 'document'): { id: string; title: string }[] } };
  };
}

/** A runtime with a local-files source whose files live under `<tmp>/University`. */
export function createDocumentRuntime<U extends DocumentHost>(
  tmp: string,
  create: () => U,
): {
  uc: U;
  root: string;
  indexLocalFile: (
    relative: string,
    data: Buffer,
    extra?: Record<string, unknown>,
  ) => Promise<string>;
} {
  const root = path.join(tmp, 'University');
  const uc = create();
  uc.sync.register({
    sourceId: 'local-files',
    adapter: idleAdapter('local-files'),
    normalizer: createLocalFilesNormalizer(),
    metadata: localMetadata,
  });
  const indexLocalFile = async (
    relative: string,
    data: Buffer,
    extra: Record<string, unknown> = {},
  ): Promise<string> => {
    writeFixture(root, relative, data);
    const ext = relative.split('.').pop() ?? '';
    const name = relative.split('/').pop() ?? relative;
    await uc.sync.ingest('local-files', {
      items: [
        {
          sourceType: 'file.document',
          externalId: `k:${relative}`,
          payload: {
            root,
            relativePath: relative,
            name,
            ext,
            mimeType: 'application/octet-stream',
            size: data.length,
            mtime: '2026-09-30T00:00:00.000Z',
            hash: 'h',
            courseFolder: '情報科学',
            ...extra,
          },
        },
      ],
    });
    const doc = uc.sync.stores.entities.list('document').find((d) => d.title === name);
    if (!doc) throw new Error('document was not normalized');
    return doc.id;
  };
  return { uc, root, indexLocalFile };
}

/** A source with no sync of its own: items are ingested by hand. */
export function idleAdapter(id: string): SourceAdapter {
  return {
    id,
    version: '1.0.0',
    capabilities: () => Promise.resolve(['files']),
    authenticate: () => Promise.resolve({ status: 'not_required' }),
    sync: () => Promise.resolve({ items: [] as RawItem[] }),
    health: () => Promise.resolve({ state: 'healthy', checkedAt: new Date().toISOString() }),
    dispose: () => Promise.resolve(),
  };
}

/** A FileDownloadAdapter whose "download" writes `bytes` (and counts the calls). */
export function fakeFileAdapter(
  id: string,
  rawType: string,
  bytes: Buffer,
): FileDownloadAdapter & { downloads: string[] } {
  const downloads: string[] = [];
  return {
    ...idleAdapter(id),
    downloads,
    fileSourceTypes: [rawType],
    fileTextSourceTypes: [],
    fileSettings: () => ({ maxDownloadBytes: 10_000_000 }),
    describeFile: (item) => {
      const p = item.payload as { name: string; version: string };
      return {
        externalId: item.externalId,
        name: p.name,
        container: 'class',
        containerId: 'class',
        isClass: true,
        folder: '',
        version: p.version,
        sizeBytes: bytes.length,
        modifiedAt: undefined,
        mimeType: 'application/pdf',
      };
    },
    downloadFiles: (requests: readonly FileDownloadRequest[]) => {
      const results: FileDownloadOutcome[] = [];
      for (const r of requests) {
        if (r.extractOnly) {
          results.push({ externalId: r.externalId, status: 'extracted' });
          continue;
        }
        mkdirSync(path.dirname(r.targetPath), { recursive: true });
        writeFileSync(r.targetPath, bytes);
        downloads.push(r.externalId);
        results.push({
          externalId: r.externalId,
          status: 'downloaded',
          bytes: bytes.length,
          version: (r.payload as { version: string }).version,
        });
      }
      return Promise.resolve({ results, items: [], warnings: [] });
    },
  };
}
