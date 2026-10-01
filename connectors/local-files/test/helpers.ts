import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import {
  instantiateConnector,
  type RawItem,
  type SyncInput,
  type SyncResult,
  type SourceAdapter,
} from '@unicontext/connector-sdk';
import type { Clock, SecretStore } from '@unicontext/core';
import JSZip from 'jszip';
import connector, { LocalFilesAdapter, type LocalFilesAdapterOptions } from '../src/index.js';

export const memorySecrets: SecretStore = {
  backend: 'memory',
  get: () => Promise.resolve(undefined),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve(false),
};

export async function makeTempDir(prefix = 'uc-local-files-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function put(root: string, rel: string, data: string | Uint8Array): Promise<string> {
  const abs = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, data);
  return abs;
}

/** Give a file a distinct mtime (seconds from an arbitrary base) so diffing never races the clock. */
export async function setMtime(abs: string, seconds: number): Promise<void> {
  const t = new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + seconds * 1000);
  await utimes(abs, t, t);
}

export function createAdapter(
  config: Record<string, unknown>,
  init: { cacheDir?: string; clock?: Clock } = {},
  options: LocalFilesAdapterOptions = {},
): LocalFilesAdapter {
  const inst = instantiateConnector(connector, {
    sourceId: 'files',
    config,
    secrets: memorySecrets,
    ...(init.cacheDir ? { cacheDir: init.cacheDir } : {}),
    ...(init.clock ? { clock: init.clock } : {}),
  });
  // The connector's adapter is a LocalFilesAdapter; rebuild with injected options when given.
  if (Object.keys(options).length > 0) return new LocalFilesAdapter(inst.context, options);
  return inst.adapter as LocalFilesAdapter;
}

/** Run sync() through all pages. */
export async function collect(
  adapter: SourceAdapter,
  input: SyncInput,
): Promise<{ pages: SyncResult[]; items: RawItem[]; deletions: string[]; warnings: string[] }> {
  const pages: SyncResult[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 100; i++) {
    const res = await adapter.sync({ ...input, ...(pageToken ? { pageToken } : {}) });
    pages.push(res);
    if (!res.hasMore) break;
    pageToken = res.nextPageToken;
  }
  return {
    pages,
    items: pages.flatMap((p) => p.items),
    deletions: pages.flatMap((p) => (p.deletions ?? []).map((d) => d.externalId)),
    warnings: pages.flatMap((p) => p.warnings ?? []),
  };
}

// ------------------------------------------------------------------ fixture builders

/** A minimal valid PDF (Helvetica, one text line per page) with a correct xref table. */
export function makePdf(pageTexts: string[]): Uint8Array {
  const objects: string[] = [];
  const n = pageTexts.length;
  // 1 catalog, 2 pages, 3 font, then (page, content) pairs
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pageTexts.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pageTexts.forEach((text, i) => {
    const stream = `BT /F1 24 Tf 72 700 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function makeDocx(paragraphs: string[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`)
    .join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'uint8array' });
}

export interface SlideSpec {
  title?: string;
  body?: string[];
  notes?: string;
}

function spXml(id: number, ph: string | undefined, paragraphs: string[]): string {
  const phXml = ph ? `<p:nvPr><p:ph type="${ph}"/></p:nvPr>` : '<p:nvPr/>';
  const paras = paragraphs
    .map((t) => `<a:p><a:r><a:rPr lang="ja-JP"/><a:t>${xmlEscape(t)}</a:t></a:r></a:p>`)
    .join('');
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="s${id}"/><p:cNvSpPr/>${phXml}</p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>`;
}

/**
 * PPTX with slides stored as slide1..slideN. `order` lists the slide numbers in presentation order
 * (default 1..N) so tests can prove that presentation.xml, not the file name, decides the order.
 */
export async function makePptx(slides: SlideSpec[], order?: number[]): Promise<Uint8Array> {
  const zip = new JSZip();
  const NS =
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
  );
  const seq = order ?? slides.map((_, i) => i + 1);
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${NS}><p:sldIdLst>${seq
      .map((n, i) => `<p:sldId id="${256 + i}" r:id="rId${n + 10}"/>`)
      .join('')}</p:sldIdLst></p:presentation>`,
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 11}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
      )
      .join('')}</Relationships>`,
  );
  slides.forEach((s, i) => {
    const n = i + 1;
    const shapes = [
      s.title ? spXml(2, 'title', [s.title]) : '',
      s.body && s.body.length > 0 ? spXml(3, undefined, s.body) : '',
    ].join('');
    zip.file(
      `ppt/slides/slide${n}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`,
    );
    if (s.notes) {
      zip.file(
        `ppt/slides/_rels/slide${n}.xml.rels`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/></Relationships>`,
      );
      zip.file(
        `ppt/notesSlides/notesSlide${n}.xml`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes ${NS}><p:cSld><p:spTree>${spXml(2, 'sldNum', [String(n)])}${spXml(3, 'body', [s.notes])}</p:spTree></p:cSld></p:notes>`,
      );
    }
  });
  return zip.generateAsync({ type: 'uint8array' });
}

/** Tiny PNG (IHDR + IEND only: enough for dimensions). */
export function makePng(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** The standard University tree used by most tests. */
export async function buildUniversityTree(root: string): Promise<void> {
  await put(
    root,
    '2026前期/データベースシステム論/第3回.pdf',
    makePdf(['Relational model', 'Normalization']),
  );
  await put(
    root,
    '2026前期/データベースシステム論/slides 2026-10-01.pptx',
    await makePptx([
      { title: 'ER図', body: ['エンティティと関係'], notes: '例を板書する' },
      { title: '正規化', body: ['第3正規形'] },
    ]),
  );
  await put(
    root,
    '2026前期/データベースシステム論/メモ.md',
    '# 概要\n\nデータベースの基礎。\n\n## 課題\n\nレポートを提出する。\n',
  );
  await put(
    root,
    '2026前期/データベースシステム論/report.docx',
    await makeDocx(['レポート本文', '第二段落']),
  );
  await put(
    root,
    '2026前期/データベースシステム論/index.html',
    '<html><head><title>授業ページ</title><style>x{}</style></head><body><h1>DB</h1><p>A &amp; B</p><script>alert(1)</script></body></html>',
  );
  await put(root, '2026前期/データベースシステム論/photo.png', makePng(64, 32));
  await put(
    root,
    '2026前期/データベースシステム論/lecture.mp4',
    new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
  );
  await put(root, 'ノート/todo.txt', 'ToDo list\n');
  await put(root, '.hidden/secret.txt', 'secret');
  await put(root, 'node_modules/pkg/index.js', 'x');
  await put(root, 'readme.txt', 'root file');
}
