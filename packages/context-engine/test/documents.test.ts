import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FileDownloadAdapter, FileDownloadRequest } from '@unicontext/connector-sdk';
import { createLocalFilesNormalizer, metadata as localMetadata } from '@unicontext/local-files';
import { ManualClock, NotFoundError, ValidationError } from '@unicontext/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createUniContext,
  LCU_ATTACHMENT_REASON,
  parsePageSpec,
  readDocument,
  resolveDocument,
  setCanvasLoader,
  setOcrEnvironment,
  type UniContext,
} from '../src/index.js';
import {
  fakeFileAdapter,
  fakeMetadata,
  fakeNormalizer,
  idleAdapter,
  makeDocx,
  makePdf,
  makePng,
  makePptx,
  writeFixture,
} from './document-fixtures.js';

const clock = new ManualClock('2026-10-01T00:00:00Z');

let uc: UniContext;
let tmp: string;
let root: string;

/** A local-files source holding `relative` (the file is written under the root). */
async function indexLocalFile(
  relative: string,
  data: Buffer,
  extra: Record<string, unknown> = {},
): Promise<string> {
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
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'uc-documents-'));
  root = path.join(tmp, 'University');
  uc = createUniContext({ profile: 'shizuoka-university', clock });
  uc.sync.register({
    sourceId: 'local-files',
    adapter: idleAdapter('local-files'),
    normalizer: createLocalFilesNormalizer(),
    metadata: localMetadata,
  });
  setOcrEnvironment({ platform: 'linux' }); // no OCR unless a test asks for it
});

afterEach(() => {
  setCanvasLoader(undefined);
  setOcrEnvironment();
  rmSync(tmp, { recursive: true, force: true });
});

describe('local PDF', () => {
  it('returns per-page text and a picture of each page; a page without text needs vision', async () => {
    const id = await indexLocalFile(
      '情報科学/第1回.pdf',
      makePdf(['Hello page one of the lecture notes', '']),
    );
    const handle = resolveDocument(uc, id);
    expect(handle).toMatchObject({ id, title: '第1回.pdf' });
    const read = await readDocument(handle, { ocr: false });
    expect(read.kind).toBe('pdf');
    expect(read.pageCount).toBe(2);
    expect(read.pages).toHaveLength(2);
    expect(read.pages[0]).toMatchObject({ index: 1, kind: 'page' });
    expect(read.pages[0]?.text).toContain('Hello page one');
    expect(read.pages[0]?.needsVision).toBeUndefined();
    expect(read.pages[1]).toMatchObject({ index: 2, kind: 'page', text: '', needsVision: true });
    expect(read.images).toHaveLength(2);
    for (const img of read.images) {
      expect(img.mimeType).toBe('image/jpeg');
      expect(img.source).toBe('render');
      expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(1568);
      expect(img.data.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    }
    expect(read.images.map((i) => i.page)).toEqual([1, 2]);
    expect(read.unsupported).toBeUndefined();
  });

  it('opens a path inside the local-files root, and only such paths', async () => {
    const id = await indexLocalFile('情報科学/第1回.pdf', makePdf(['Hello']));
    const file = path.join(root, '情報科学', '第1回.pdf');
    expect(resolveDocument(uc, file).id).toBe(id);
    expect(resolveDocument(uc, `file:///${file.replace(/\\/g, '/')}`).id).toBe(id);
    // inside the root but never indexed: still a document of the root
    writeFixture(root, '情報科学/new.pdf', makePdf(['x']));
    const fresh = resolveDocument(uc, path.join(root, '情報科学', 'new.pdf'));
    expect(fresh.title).toBe('new.pdf');
    expect((await readDocument(fresh, { render: 'text' })).pages[0]?.text).toContain('x');
    // anywhere else on the disk is refused
    const outside = writeFixture(tmp, 'secret.pdf', makePdf(['no']));
    expect(() => resolveDocument(uc, outside)).toThrow(ValidationError);
    expect(() => resolveDocument(uc, path.join(root, '..', 'secret.pdf'))).toThrow(ValidationError);
    expect(() => resolveDocument(uc, path.join(root, 'missing.pdf'))).toThrow(NotFoundError);
  });

  it('takes `<course>/<path>`, a search hit (document chunk) and rejects other entity ids', async () => {
    const id = await indexLocalFile('情報科学/第1回.pdf', makePdf(['Hello']), {
      pages: [{ page: 1, text: 'Hello stored' }],
    });
    const chunk = uc.sync.stores.entities.list('documentChunk', { where: { documentId: id } })[0];
    expect(chunk).toBeDefined();
    expect(resolveDocument(uc, chunk!.id).id).toBe(id);
    expect(() => resolveDocument(uc, 'assignment:nope')).toThrow(ValidationError);
    expect(() => resolveDocument(uc, 'document:nope')).toThrow(NotFoundError);
    expect(() => resolveDocument(uc, '')).toThrow(ValidationError);
  });

  it('reads the pages asked for, and the first five by default', async () => {
    const pages = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
    const id = await indexLocalFile('情報科学/長い.pdf', makePdf(pages));
    const first = await readDocument(resolveDocument(uc, id), { render: 'text' });
    expect(first.pageCount).toBe(7);
    expect(first.pages.map((p) => p.index)).toEqual([1, 2, 3, 4, 5]);
    expect(first.warnings.join(' ')).toContain('先頭の5ページ');
    expect(first.images).toEqual([]);
    const picked = await readDocument(resolveDocument(uc, id), { pages: [7, 2, 99] });
    expect(picked.pages.map((p) => p.index)).toEqual([2, 7]);
    expect(picked.pages[1]?.text).toContain('seven');
    expect(picked.images.map((i) => i.page)).toEqual([2, 7]);
    expect(picked.warnings.join(' ')).toContain('99');
  });

  it('answers render=images without the text', async () => {
    const id = await indexLocalFile('情報科学/a.pdf', makePdf(['Hello']));
    const read = await readDocument(resolveDocument(uc, id), { render: 'images' });
    expect(read.pages[0]?.text).toBe('');
    expect(read.images).toHaveLength(1);
  });

  it('falls back to the stored text when the file is gone', async () => {
    const id = await indexLocalFile('情報科学/消えた.pdf', makePdf(['Hello']), {
      pages: [
        { page: 1, text: '保存済みの1ページ目' },
        { page: 2, text: '保存済みの2ページ目' },
      ],
    });
    rmSync(path.join(root, '情報科学', '消えた.pdf'));
    const read = await readDocument(resolveDocument(uc, id), { render: 'both' });
    expect(read.unsupported?.reason).toContain('見つかりません');
    expect(read.fromStoredText).toBe(true);
    expect(read.pages.map((p) => p.text)).toEqual(['保存済みの1ページ目', '保存済みの2ページ目']);
    expect(read.images).toEqual([]);
  });
});

describe('scanned pages and OCR', () => {
  it('puts OCR text in ocrText (origin ocr) when the OS can read the page', async () => {
    const seen: string[] = [];
    setOcrEnvironment({
      platform: 'win32',
      runner: (script, env) => {
        seen.push(script.includes('AvailableRecognizerLanguages') ? 'detect' : 'ocr');
        return Promise.resolve(
          script.includes('AvailableRecognizerLanguages')
            ? { code: 0, stdout: 'ja-JP', stderr: '', timedOut: false }
            : {
                code: 0,
                stdout: `読み取った文字 ${env.UC_OCR_IMAGE ? 'ok' : ''}\r\n`,
                stderr: '',
                timedOut: false,
              },
        );
      },
    });
    const id = await indexLocalFile(
      '情報科学/scan.pdf',
      makePdf(['Hello page one of the lecture notes', '']),
    );
    const read = await readDocument(resolveDocument(uc, id));
    expect(read.pages[1]).toMatchObject({ ocrText: '読み取った文字 ok', origin: 'ocr' });
    expect(read.pages[1]?.needsVision).toBeUndefined();
    expect(read.pages[0]?.ocrText).toBeUndefined();
    // detection ran once, OCR once (only the scanned page)
    expect(seen).toEqual(['detect', 'ocr']);
    // the picture still comes back for the client's own vision
    expect(read.images.map((i) => i.page)).toEqual([1, 2]);
  });

  it('keeps needsVision when OCR is not available (no ja-JP engine)', async () => {
    setOcrEnvironment({
      platform: 'win32',
      runner: () => Promise.resolve({ code: 3, stdout: '', stderr: '', timedOut: false }),
    });
    const id = await indexLocalFile('情報科学/scan.pdf', makePdf(['']));
    const read = await readDocument(resolveDocument(uc, id));
    expect(read.pages[0]).toMatchObject({ needsVision: true });
    expect(read.pages[0]?.ocrText).toBeUndefined();
    expect(read.images).toHaveLength(1);
  });
});

describe('PPTX', () => {
  it('returns the slide texts and the images embedded in the slides', async () => {
    const id = await indexLocalFile('情報科学/第1回.pptx', await makePptx());
    const read = await readDocument(resolveDocument(uc, id), { ocr: false });
    expect(read.kind).toBe('pptx');
    expect(read.pageCount).toBe(2);
    expect(read.pages.map((p) => [p.index, p.kind])).toEqual([
      [1, 'slide'],
      [2, 'slide'],
    ]);
    expect(read.pages[0]?.text).toContain('関係モデルの基礎を学ぶ');
    expect(read.pages[1]?.text).toContain('エンティティと関連を描く');
    // image1.png (640x400) comes back; the 16 px icon is a decoration
    expect(read.images).toHaveLength(1);
    expect(read.images[0]).toMatchObject({
      page: 2,
      source: 'embedded',
      mimeType: 'image/jpeg',
      label: 'slide 2 image1.png',
    });
    const textOnly = await readDocument(resolveDocument(uc, id), { render: 'text' });
    expect(textOnly.images).toEqual([]);
  });
});

describe('Word and image files', () => {
  it('returns the text and the pictures embedded in a .docx', async () => {
    const id = await indexLocalFile('情報科学/課題.docx', await makeDocx('課題の説明文です'));
    const read = await readDocument(resolveDocument(uc, id), { ocr: false });
    expect(read.kind).toBe('docx');
    expect(read.pages).toEqual([{ index: 1, kind: 'page', text: '課題の説明文です' }]);
    expect(read.images).toHaveLength(1);
    expect(read.images[0]).toMatchObject({ source: 'embedded', mimeType: 'image/jpeg' });
  });

  it('brings an image down to 1568 px on the long edge as JPEG', async () => {
    const id = await indexLocalFile('情報科学/写真.png', makePng(3200, 1800));
    const read = await readDocument(resolveDocument(uc, id), { ocr: false });
    expect(read.kind).toBe('image');
    expect(read.pages).toEqual([{ index: 1, kind: 'image', text: '', needsVision: true }]);
    expect(read.images).toHaveLength(1);
    expect(read.images[0]).toMatchObject({ source: 'file', mimeType: 'image/jpeg', width: 1568 });
    expect(read.images[0]?.height).toBe(882);
  });

  it('HEIC that the canvas cannot decode is reported, not guessed at', async () => {
    const id = await indexLocalFile('情報科学/IMG_0001.heic', Buffer.from('not really heic data'));
    const read = await readDocument(resolveDocument(uc, id), { ocr: false });
    expect(read.images).toEqual([]);
    expect(read.warnings.join(' ')).toContain('HEIC');
  });

  it('a .ppt it cannot open is a warning with the stored text', async () => {
    const id = await indexLocalFile('情報科学/old.ppt', Buffer.from('binary'), {
      slides: [{ slide: 1, text: '保存済みスライド' }],
    });
    const read = await readDocument(resolveDocument(uc, id), { ocr: false });
    expect(read.pages.map((p) => p.text)).toEqual(['保存済みスライド']);
    expect(read.fromStoredText).toBe(true);
    expect(read.warnings.join(' ')).toContain('.ppt');
  });
});

describe('sources that do not hand over files', () => {
  it('a LiveCampusU announcement attachment is unsupported, with where to open it', async () => {
    uc.sync.register({
      sourceId: 'livecampusu',
      adapter: idleAdapter('livecampusu'),
      normalizer: fakeNormalizer('livecampusu', 'lcu.notice', () => ({
        kind: 'announcement',
        title: '休講のお知らせ',
        body: '資料を添付します',
        publishedAt: '2026-09-30T01:00:00Z',
        scope: 'course',
        url: 'https://lcu.example.test/notice/1',
        extra: { attachments: [{ name: '補講日程.pdf', size: 1234 }] },
      })),
      metadata: fakeMetadata('livecampusu', ['lcu.notice']),
    });
    await uc.sync.ingest('livecampusu', {
      items: [{ sourceType: 'lcu.notice', externalId: 'n1', payload: { id: 'n1' } }],
    });
    const a = uc.sync.stores.entities.list('announcement')[0];
    expect(a).toBeDefined();
    const handle = resolveDocument(uc, a!.id);
    expect(await handle.fetch()).toEqual({
      ok: false,
      unsupported: { reason: LCU_ATTACHMENT_REASON, openUrl: 'https://lcu.example.test/notice/1' },
    });
    const read = await readDocument(handle);
    expect(read.unsupported).toEqual({
      reason: 'LiveCampusU の添付は LiveCampusU で開いてください（コネクタ方針でダウンロード不可）',
      openUrl: 'https://lcu.example.test/notice/1',
    });
    expect(read.pages).toEqual([]);
    expect(read.images).toEqual([]);
    expect(read.document.path).toBe('補講日程.pdf');
    expect(read.citations.length).toBeGreaterThan(0);
  });

  it('Microsoft 365 files are unsupported while the source is disabled', async () => {
    uc.sync.register({
      sourceId: 'm365',
      adapter: idleAdapter('m365'),
      normalizer: fakeNormalizer('m365', 'graph.driveItem', () => ({
        kind: 'document',
        title: 'レポート.docx',
        url: 'https://onedrive.example.test/x',
      })),
      metadata: fakeMetadata('microsoft365', ['graph.driveItem']),
    });
    await uc.sync.ingest('m365', {
      items: [{ sourceType: 'graph.driveItem', externalId: 'd1', payload: {} }],
    });
    const d = uc.sync.stores.entities.list('document').find((x) => x.title === 'レポート.docx')!;
    const read = await readDocument(resolveDocument(uc, d.id));
    expect(read.unsupported?.reason).toContain('Microsoft 365');
    expect(read.unsupported?.openUrl).toBe('https://onedrive.example.test/x');
  });
});

describe('teams-web document', () => {
  it('goes through the existing download cache (one download, then the cached copy)', async () => {
    const pdf = makePdf(['Teams week one']);
    const adapter = fakeFileAdapter('teams-web', 'teams.file', pdf);
    uc.sync.register({
      sourceId: 'teams-web',
      adapter,
      normalizer: fakeNormalizer('teams-web', 'teams.file', (item) => ({
        kind: 'document',
        title: (item.payload as { name: string }).name,
        mimeType: 'application/pdf',
        url: 'https://sp.example.test/week1.pdf',
        path: '/00_講義資料/week1.pdf',
      })),
      metadata: fakeMetadata('teams-web', ['teams.file']),
    });
    await uc.sync.ingest('teams-web', {
      items: [
        {
          sourceType: 'teams.file',
          externalId: 'F1',
          payload: { name: 'week1.pdf', version: 'v1' },
        },
      ],
    });
    const d = uc.sync.stores.entities.list('document').find((x) => x.title === 'week1.pdf')!;
    const filesDir = path.join(tmp, 'files');
    const handle = resolveDocument(uc, d.id, { filesDir });
    const first = await readDocument(handle, { ocr: false });
    expect(first.pages[0]?.text).toContain('Teams week one');
    expect(first.images).toHaveLength(1);
    expect(adapter.downloads).toEqual(['F1']);
    const second = await readDocument(resolveDocument(uc, d.id, { filesDir }), { ocr: false });
    expect(second.pages[0]?.text).toContain('Teams week one');
    expect(adapter.downloads).toEqual(['F1']); // served from <files dir>/teams-web/cache
    // a download that goes through another process (the daemon) is used as given
    const calls: string[][] = [];
    const via = await readDocument(
      resolveDocument(uc, d.id, {
        downloadFiles: (refs, o) => {
          calls.push(refs);
          expect(o.extract).toBe(false);
          return Promise.resolve({
            results: [
              {
                id: d.id,
                ref: d.id,
                title: d.title,
                status: 'cached' as const,
                path: path.join(filesDir, 'teams-web', 'cache', 'x.pdf'),
              },
            ],
            downloaded: 0,
            warnings: [],
          });
        },
      }),
    );
    expect(calls).toEqual([[d.id]]);
    expect(via.unsupported).toBeUndefined();
  });

  it('reports a failed download as unsupported with the document link', async () => {
    const failing: FileDownloadAdapter = {
      ...fakeFileAdapter('teams-web', 'teams.file', makePdf(['x'])),
      downloadFiles: (requests: readonly FileDownloadRequest[]) =>
        Promise.resolve({
          results: requests.map((r) => ({
            externalId: r.externalId,
            status: 'failed' as const,
            error: 'session expired',
          })),
          items: [],
          warnings: [],
        }),
    };
    uc.sync.register({
      sourceId: 'teams-web',
      adapter: failing,
      normalizer: fakeNormalizer('teams-web', 'teams.file', () => ({
        kind: 'document',
        title: 'week2.pdf',
        url: 'https://sp.example.test/week2.pdf',
      })),
      metadata: fakeMetadata('teams-web', ['teams.file']),
    });
    await uc.sync.ingest('teams-web', {
      items: [
        {
          sourceType: 'teams.file',
          externalId: 'F2',
          payload: { name: 'week2.pdf', version: 'v1' },
        },
      ],
    });
    const d = uc.sync.stores.entities.list('document').find((x) => x.title === 'week2.pdf')!;
    const read = await readDocument(resolveDocument(uc, d.id, { filesDir: path.join(tmp, 'f') }));
    expect(read.unsupported?.reason).toContain('session expired');
    expect(read.unsupported?.openUrl).toBe('https://sp.example.test/week2.pdf');
  });
});

describe('without the native canvas', () => {
  it('still returns the text, with a warning, and no pictures', async () => {
    setCanvasLoader(() => Promise.reject(new Error('The specified module could not be found')));
    const id = await indexLocalFile(
      '情報科学/第1回.pdf',
      makePdf(['Hello page one of the lecture notes', '']),
    );
    const read = await readDocument(resolveDocument(uc, id), { ocr: false });
    expect(read.pages[0]?.text).toContain('Hello page one');
    expect(read.pages[1]?.needsVision).toBe(true);
    expect(read.images).toEqual([]);
    expect(read.warnings.join('\n')).toContain('@napi-rs/canvas');
    expect(read.warnings.join('\n')).toContain('The specified module could not be found');
    // slides: text only too
    const pptx = await indexLocalFile('情報科学/deck.pptx', await makePptx());
    const deck = await readDocument(resolveDocument(uc, pptx), { ocr: false });
    expect(deck.pages[1]?.text).toContain('エンティティ');
    // a picture that already fits goes out as it is (PNG, no re-encoding); the icon is skipped
    expect(deck.images.map((i) => [i.page, i.mimeType])).toEqual([[2, 'image/png']]);
  });
});

describe('parsePageSpec', () => {
  it('reads ranges, lists and numbers', () => {
    expect(parsePageSpec(undefined)).toBeUndefined();
    expect(parsePageSpec('1-5')).toEqual([1, 2, 3, 4, 5]);
    expect(parsePageSpec('7, 2,4-5')).toEqual([2, 4, 5, 7]);
    expect(parsePageSpec([3, 1, 3])).toEqual([1, 3]);
    for (const bad of ['0', 'a', '5-2', '1-9999', '1.5', '-3'])
      expect(() => parsePageSpec(bad), bad).toThrow(ValidationError);
    expect(() => parsePageSpec([0])).toThrow(ValidationError);
  });
});
