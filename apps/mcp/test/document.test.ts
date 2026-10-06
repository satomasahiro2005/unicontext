import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ManualClock } from '@unicontext/core';
import {
  createUniContext,
  type DocumentImage,
  setCanvasLoader,
  setOcrEnvironment,
  type UniContext,
} from '@unicontext/context-engine';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createDocumentRuntime,
  fakeMetadata,
  fakeNormalizer,
  idleAdapter,
  makePdf,
  makePptx,
} from '../../../packages/context-engine/test/document-fixtures.js';
import { limitImages, DOCUMENT_LIMITS } from '../src/document.js';
import { createMcpServer, type McpDeps, ProposalStore } from '../src/index.js';

/*
 * get_document over MCP: a JSON envelope as text, then real image content, within the caps of the
 * surface (local: 8 images, 1.5 MB each, 6 MB in all; remote: 4 images, 3 MB in all).
 */

let uc: UniContext;
let tmp: string;
let proposals: ProposalStore;
let indexLocalFile: (rel: string, data: Buffer, extra?: Record<string, unknown>) => Promise<string>;
const ids: Record<string, string> = {};

const LONG = 'Hello page of the lecture notes about the relational model';

async function connect(surface: 'local' | 'remote', extra: Partial<McpDeps> = {}) {
  const server = createMcpServer({
    uc,
    proposals,
    surface,
    filesDir: path.join(tmp, 'files'),
    ...extra,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'document-test', version: '0.0.0' });
  await client.connect(b);
  return client;
}

interface Body {
  document: { id: string; title: string };
  kind: string;
  pageCount?: number;
  pages: {
    index: number;
    kind: string;
    text: string;
    needsVision?: boolean;
    truncated?: boolean;
  }[];
  images: { n: number; page?: number; mimeType: string; label: string }[];
  truncated: boolean;
  warnings: string[];
  citations: { label: string }[];
  answerHint: string;
  unsupported?: { reason: string; openUrl?: string };
}

async function getDocument(client: Client, args: Record<string, unknown>) {
  const res = await client.callTool({ name: 'get_document', arguments: args });
  const content = res.content as {
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }[];
  const first = content[0];
  const images = content.filter((c) => c.type === 'image');
  return {
    isError: res.isError === true,
    content,
    body:
      first?.type === 'text' && !res.isError ? (JSON.parse(first.text ?? '') as Body) : undefined,
    errorText: res.isError ? (first?.text ?? '') : '',
    images,
  };
}

const base64Bytes = (images: { data?: string }[]): number =>
  images.reduce((n, i) => n + (i.data?.length ?? 0), 0);

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'uc-mcp-document-'));
  const rt = createDocumentRuntime(tmp, () =>
    createUniContext({
      profile: 'shizuoka-university',
      clock: new ManualClock('2026-10-01T00:00:00Z'),
    }),
  );
  uc = rt.uc;
  indexLocalFile = rt.indexLocalFile;
  proposals = new ProposalStore(path.join(tmp, 'proposals'), { clock: uc.clock });
  ids.two = await indexLocalFile('情報科学/二枚.pdf', makePdf([LONG, '']));
  ids.ten = await indexLocalFile(
    '情報科学/十枚.pdf',
    makePdf(Array.from({ length: 10 }, (_, i) => `${LONG} number ${i + 1}`)),
  );
  ids.long = await indexLocalFile(
    '情報科学/長文.pdf',
    makePdf(['a'.repeat(300), 'b'.repeat(300), 'c'.repeat(300)]),
  );
  ids.deck = await indexLocalFile('情報科学/deck.pptx', await makePptx());
  uc.sync.register({
    sourceId: 'livecampusu',
    adapter: idleAdapter('livecampusu'),
    normalizer: fakeNormalizer('livecampusu', 'lcu.notice', () => ({
      kind: 'announcement',
      title: '補講のお知らせ',
      body: '添付を見てください',
      publishedAt: '2026-09-30T01:00:00Z',
      scope: 'course',
      url: 'https://lcu.example.test/notice/9',
      extra: { attachments: [{ name: '日程.pdf' }] },
    })),
    metadata: fakeMetadata('livecampusu', ['lcu.notice']),
  });
  await uc.sync.ingest('livecampusu', {
    items: [{ sourceType: 'lcu.notice', externalId: 'n9', payload: { id: 'n9' } }],
  });
  ids.notice = uc.sync.stores.entities.list('announcement')[0]!.id;
  setOcrEnvironment({ platform: 'linux' });
}, 60_000);

afterEach(() => {
  setCanvasLoader(undefined);
});

afterAll(() => {
  setOcrEnvironment();
  rmSync(tmp, { recursive: true, force: true });
});

describe('get_document', () => {
  it('is read-only and on both surfaces; download_course_file points at it for images', async () => {
    for (const surface of ['local', 'remote'] as const) {
      const client = await connect(surface);
      const tools = (await client.listTools()).tools;
      const tool = tools.find((t) => t.name === 'get_document');
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
        'id',
        'maxChars',
        'pages',
        'render',
      ]);
      expect(tool?.outputSchema).toBeTruthy();
      expect(tools.find((t) => t.name === 'download_course_file')?.description).toContain(
        'get_document',
      );
      expect(client.getInstructions()).toContain('get_document');
    }
  });

  it('returns the JSON envelope first, then image content within the local caps', async () => {
    const client = await connect('local');
    const r = await getDocument(client, { id: ids.two });
    expect(r.isError).toBe(false);
    expect(r.content[0]?.type).toBe('text');
    expect(r.content.slice(1).every((c) => c.type === 'image')).toBe(true);
    const body = r.body!;
    expect(body.document).toMatchObject({ id: ids.two, title: '二枚.pdf' });
    expect(body.kind).toBe('pdf');
    expect(body.pageCount).toBe(2);
    expect(body.pages[0]).toMatchObject({ index: 1, kind: 'page' });
    expect(body.pages[0]?.text).toContain('Hello page of the lecture notes');
    expect(body.pages[1]).toMatchObject({ index: 2, text: '', needsVision: true });
    expect(body.truncated).toBe(false);
    expect(body.citations.length).toBeGreaterThan(0);
    expect(body.answerHint).toContain('needsVision');
    // two page pictures, announced in the envelope and present as MCP image items
    expect(body.images.map((i) => [i.n, i.page, i.mimeType])).toEqual([
      [1, 1, 'image/jpeg'],
      [2, 2, 'image/jpeg'],
    ]);
    expect(r.images).toHaveLength(2);
    for (const img of r.images) {
      expect(img.mimeType).toBe('image/jpeg');
      expect(Buffer.from(img.data ?? '', 'base64').subarray(0, 3)).toEqual(
        Buffer.from([0xff, 0xd8, 0xff]),
      );
      expect(img.data?.length).toBeLessThanOrEqual(1_500_000);
    }
    expect(base64Bytes(r.images)).toBeLessThanOrEqual(6_000_000);
  });

  it('defaults to the first five pages and says how to ask for more', async () => {
    const client = await connect('local');
    const r = await getDocument(client, { id: ids.ten, render: 'text' });
    expect(r.body?.pages.map((p) => p.index)).toEqual([1, 2, 3, 4, 5]);
    expect(r.body?.pageCount).toBe(10);
    expect(r.body?.answerHint).toContain('先頭5ページ');
    expect(r.body?.answerHint).toContain('pages: "6-10"');
    expect(r.images).toHaveLength(0);
    // asked for: exactly those
    const more = await getDocument(client, { id: ids.ten, pages: '6-7', render: 'text' });
    expect(more.body?.pages.map((p) => p.index)).toEqual([6, 7]);
    expect(more.body?.pages[0]?.text).toContain('number 6');
    const list = await getDocument(client, { id: ids.ten, pages: [9, 10], render: 'text' });
    expect(list.body?.pages.map((p) => p.index)).toEqual([9, 10]);
  });

  it('local: at most 8 images; remote: at most 4 images and 3 MB', async () => {
    const local = await connect('local');
    const l = await getDocument(local, { id: ids.ten, pages: '1-10' });
    expect(l.images).toHaveLength(DOCUMENT_LIMITS.local.maxImages);
    expect(l.body?.pages).toHaveLength(10);
    expect(l.body?.warnings.join(' ')).toContain('8枚');
    expect(base64Bytes(l.images)).toBeLessThanOrEqual(DOCUMENT_LIMITS.local.maxTotalBase64);

    const remote = await connect('remote');
    const r = await getDocument(remote, { id: ids.ten, pages: '1-10' });
    expect(r.isError).toBe(false);
    expect(r.images).toHaveLength(DOCUMENT_LIMITS.remote.maxImages);
    expect(r.images).toHaveLength(4);
    expect(r.body?.images).toHaveLength(4);
    expect(r.body?.warnings.join(' ')).toContain('4枚');
    expect(base64Bytes(r.images)).toBeLessThanOrEqual(3_000_000);
  });

  it('enforces the per-image and total byte caps', () => {
    const img = (bytes: number, n: number): DocumentImage => ({
      page: n,
      source: 'render',
      mimeType: 'image/jpeg',
      data: Buffer.alloc(bytes, 1),
      width: 10,
      height: 10,
      label: `p.${n}`,
    });
    // 700 KB raw = 934 KB base64: three fit in 3 MB (remote), six in 6 MB (local)
    const ten = Array.from({ length: 10 }, (_, i) => img(700_000, i + 1));
    const warnings: string[] = [];
    expect(limitImages(ten, DOCUMENT_LIMITS.remote, warnings)).toHaveLength(3);
    expect(warnings.join(' ')).toContain('7枚は省きました');
    expect(limitImages(ten, DOCUMENT_LIMITS.local, [])).toHaveLength(6);
    // one picture above 1.5 MB base64 is dropped whatever the total
    const big = [img(1_200_000, 1), img(10_000, 2)];
    expect(limitImages(big, DOCUMENT_LIMITS.local, []).map((i) => i.page)).toEqual([2]);
  });

  it('cuts the text at maxChars and says so', async () => {
    const client = await connect('local');
    const r = await getDocument(client, { id: ids.long, render: 'text', maxChars: 400 });
    expect(r.body?.truncated).toBe(true);
    expect(r.body?.pages.map((p) => p.text.length)).toEqual([303, 97, 0]);
    expect(r.body?.pages[1]?.truncated).toBe(true);
    expect(r.body?.warnings.join(' ')).toContain('maxChars');
  });

  it('slides: text per slide and the embedded image as image content', async () => {
    const client = await connect('local');
    const r = await getDocument(client, { id: ids.deck });
    expect(r.body?.kind).toBe('pptx');
    expect(r.body?.pages.map((p) => p.kind)).toEqual(['slide', 'slide']);
    expect(r.body?.images).toEqual([
      expect.objectContaining({ page: 2, label: 'slide 2 image1.png' }),
    ]);
    expect(r.images).toHaveLength(1);
  });

  it('without @napi-rs/canvas it still returns the text, with a warning', async () => {
    setCanvasLoader(() => Promise.reject(new Error('Cannot find module @napi-rs/canvas-win32')));
    const client = await connect('local');
    const r = await getDocument(client, { id: ids.two });
    expect(r.isError).toBe(false);
    expect(r.images).toHaveLength(0);
    expect(r.content).toHaveLength(1);
    expect(r.body?.pages[0]?.text).toContain('Hello page of the lecture notes');
    expect(r.body?.pages[1]?.needsVision).toBe(true);
    expect(r.body?.warnings.join(' ')).toContain('@napi-rs/canvas');
  });

  it('a LiveCampusU attachment comes back unsupported with where to open it', async () => {
    const client = await connect('local');
    const r = await getDocument(client, { id: ids.notice });
    expect(r.isError).toBe(false);
    expect(r.images).toHaveLength(0);
    expect(r.body?.unsupported).toEqual({
      reason: 'LiveCampusU の添付は LiveCampusU で開いてください（コネクタ方針でダウンロード不可）',
      openUrl: 'https://lcu.example.test/notice/9',
    });
    expect(r.body?.answerHint).toContain('取得できません');
  });

  it('refuses local paths on the remote surface, and unknown or non-document ids everywhere', async () => {
    const remote = await connect('remote');
    const file = path.join(tmp, 'University', '情報科学', '二枚.pdf');
    const refused = await getDocument(remote, { id: file });
    expect(refused.isError).toBe(true);
    expect(refused.errorText).toContain('local paths');
    // the same path works locally
    const local = await connect('local');
    expect((await getDocument(local, { id: file, render: 'text' })).body?.document.id).toBe(
      ids.two,
    );
    const missing = await getDocument(local, { id: 'document:nope' });
    expect(missing.isError).toBe(true);
    expect(missing.errorText).toContain('not_found');
    const wrong = await getDocument(local, { id: 'assignment:abc' });
    expect(wrong.isError).toBe(true);
    expect(wrong.errorText).toContain('not a document');
    const badPages = await getDocument(local, { id: ids.two, pages: 'x-y' });
    expect(badPages.isError).toBe(true);
  });

  it('audits the call without its arguments', async () => {
    const events: { tool: string; ok: boolean }[] = [];
    const client = await connect('local', { onToolCall: (e) => events.push(e) });
    await getDocument(client, { id: ids.two, render: 'text' });
    await getDocument(client, { id: 'document:nope' });
    expect(events.map((e) => [e.tool, e.ok])).toEqual([
      ['get_document', true],
      ['get_document', false],
    ]);
  });
});
