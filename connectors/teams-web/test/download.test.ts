import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import type { FileDownloadRequest, RawItem } from '@unicontext/connector-sdk';
import { RateLimitedError, silentLogger } from '@unicontext/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TeamsWebAdapter } from '../src/adapter.js';
import { PlaywrightTeamsClient } from '../src/client.js';
import * as scripts from '../src/page-scripts.js';
import { CLASS_GROUP, harness, SITE, testClock } from './helpers.js';

const ORIGIN = new URL(SITE).origin;

interface FakeFile {
  status?: number;
  body?: Uint8Array;
  /** Send a content-length header (default true). */
  length?: boolean;
  headers?: Record<string, string>;
}

/**
 * A SharePoint page for the streaming page scripts: the scripts run in a vm context whose `fetch`
 * answers from `routes` (by pathname) with a chunked ReadableStream body, like the real page.
 */
function fakeSharePoint(routes: Record<string, FakeFile>) {
  const requests: { method: string; url: string; credentials: string | undefined }[] = [];
  let evaluations = 0;
  const window: Record<string, unknown> = {};
  const fetchImpl = (url: string, init?: { method?: string; credentials?: string }) => {
    requests.push({ method: init?.method ?? 'GET', url, credentials: init?.credentials });
    const u = new URL(url, ORIGIN);
    const f = routes[decodeURIComponent(u.pathname)] ?? { status: 404 };
    const status = f.status ?? 200;
    const body = f.body;
    const headers: Record<string, string> = { ...(f.headers ?? {}) };
    if (body && f.length !== false) headers['content-length'] = String(body.byteLength);
    const stream =
      body && status < 400
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              for (let i = 0; i < body.byteLength; i += 65_536)
                controller.enqueue(body.subarray(i, i + 65_536));
              controller.close();
            },
          })
        : null;
    return Promise.resolve(new Response(stream, { status, headers }));
  };
  const ctx = vm.createContext({
    window,
    location: { origin: ORIGIN, host: new URL(ORIGIN).host },
    fetch: fetchImpl,
    URL,
    btoa,
    Uint8Array,
    String,
    Number,
    encodeURIComponent,
  });
  const page = {
    url: () => `${SITE}/SitePages/Home.aspx`,
    isClosed: () => false,
    evaluate: (expr: string) => {
      evaluations++;
      return Promise.resolve(vm.runInContext(expr, ctx) as unknown);
    },
    goto: () => Promise.resolve(null),
    route: () => Promise.resolve(),
    close: () => Promise.resolve(),
    waitForTimeout: () => Promise.resolve(),
    waitForLoadState: () => Promise.resolve(),
    locator: () => {
      throw new Error('not used');
    },
    frames: () => [],
    mouse: { move: () => Promise.resolve(), wheel: () => Promise.resolve() },
  };
  const context = {
    on: () => undefined,
    off: () => undefined,
    route: () => Promise.resolve(),
    newPage: () => Promise.reject(new Error('no new pages in this test')),
  };
  const client = new PlaywrightTeamsClient(page as never, context, {
    clientUrl: 'https://teams.cloud.microsoft',
    bootTimeoutMs: 1000,
    clock: testClock(),
  });
  return {
    client,
    requests,
    window,
    evaluations: () => evaluations,
  };
}

const CONTENT = '/sites/2026X_abc123/_api/v2.0/drive/items/01FILE/content';
const BY_ID =
  "/sites/2026X_abc123/_api/web/GetFileById('5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e')/$value";

function bytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

async function collect(
  client: PlaywrightTeamsClient,
  request: Parameters<PlaywrightTeamsClient['streamFile']>[0],
) {
  const parts: Uint8Array[] = [];
  const r = await client.streamFile(request, (c) => {
    parts.push(c);
    return Promise.resolve();
  });
  return { r, data: Buffer.concat(parts), chunks: parts.length };
}

describe('page scripts', () => {
  it('are valid JavaScript functions', () => {
    for (const [name, value] of Object.entries(scripts)) {
      if (typeof value !== 'string') continue;
      expect(() => new vm.Script(`(${value})`), name).not.toThrow();
    }
  });
});

describe('streaming download from the SharePoint page', () => {
  it('streams the file in chunks with same-origin GETs only, never holding it whole', async () => {
    const data = bytes(3 * 1024 * 1024 + 123);
    const sp = fakeSharePoint({ [CONTENT]: { body: data } });
    const {
      r,
      data: got,
      chunks,
    } = await collect(sp.client, {
      siteUrl: SITE,
      itemId: '01FILE',
      maxBytes: 10 * 1024 * 1024,
    });
    expect(r).toEqual({ ok: true, bytes: data.byteLength, contentType: undefined });
    expect(Buffer.compare(got, Buffer.from(data))).toBe(0);
    expect(chunks).toBeGreaterThanOrEqual(3);
    expect(sp.requests).toEqual([
      {
        method: 'GET',
        url: `${SITE}${CONTENT.replace('/sites/2026X_abc123', '')}`,
        credentials: 'same-origin',
      },
    ]);
    // the reader was released in the page
    expect(Object.keys((sp.window.__ucDownloads as object | undefined) ?? {})).toEqual([]);
  });

  it('falls back to the classic GetFileById endpoint when the drive item content fails', async () => {
    const data = bytes(1000);
    const sp = fakeSharePoint({ [CONTENT]: { status: 404 }, [BY_ID]: { body: data } });
    const { r, data: got } = await collect(sp.client, {
      siteUrl: SITE,
      itemId: '01FILE',
      uniqueId: '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e',
      maxBytes: 5000,
    });
    expect(r.ok).toBe(true);
    expect(got.byteLength).toBe(1000);
    expect(sp.requests.map((q) => q.method)).toEqual(['GET', 'GET']);
  });

  it('refuses files over the limit by header and while streaming', async () => {
    const big = fakeSharePoint({ [CONTENT]: { body: bytes(5000) } });
    expect(
      (await collect(big.client, { siteUrl: SITE, itemId: '01FILE', maxBytes: 4000 })).r,
    ).toEqual({ ok: false, reason: 'tooLarge' });
    expect(big.evaluations()).toBe(1); // no chunk was read
    const noLength = fakeSharePoint({ [CONTENT]: { body: bytes(300_000), length: false } });
    const r = await collect(noLength.client, {
      siteUrl: SITE,
      itemId: '01FILE',
      maxBytes: 100_000,
    });
    expect(r.r).toEqual({ ok: false, reason: 'tooLarge' });
  });

  it('reports throttling as RateLimitedError and a missing file as notFound', async () => {
    const throttled = fakeSharePoint({
      [CONTENT]: { status: 429, headers: { 'retry-after': '30' } },
    });
    await expect(
      collect(throttled.client, { siteUrl: SITE, itemId: '01FILE', maxBytes: 4000 }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    const missing = fakeSharePoint({});
    expect(
      (await collect(missing.client, { siteUrl: SITE, itemId: '01FILE', maxBytes: 4000 })).r,
    ).toEqual({ ok: false, reason: 'notFound', status: 404 });
  });
});

describe('TeamsWebAdapter file downloads', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uc-teams-dl-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function driveItems(h: ReturnType<typeof harness>): Promise<Map<string, RawItem>> {
    const r = await h.adapter.sync({ mode: 'initial' });
    h.client.downloads = [];
    h.sessions.length = 0;
    return new Map(
      r.items
        .filter((i) => i.sourceType === 'teamsweb.driveItem')
        .map((i) => [i.externalId.split('/')[1] ?? '', i]),
    );
  }

  const request = (item: RawItem, target: string, extra: Partial<FileDownloadRequest> = {}) => ({
    externalId: item.externalId,
    payload: item.payload,
    targetPath: target,
    maxBytes: 1_000_000,
    extract: true,
    ...extra,
  });

  it('describes files and exposes the download and mirror settings', async () => {
    const h = harness({ config: { mirror: { enabled: true, root: '~/University/Teams' } } });
    const items = await driveItems(h);
    const slides = items.get('01FILESLIDES')!;
    expect(h.adapter.describeFile(slides)).toEqual({
      externalId: `${CLASS_GROUP}/01FILESLIDES`,
      name: '第1回スライド.pptx',
      container: '2026データベース演習X(情報科)',
      containerId: CLASS_GROUP,
      isClass: true,
      folder: '00_講義資料/スライド',
      version: '"c:{11111111-2222-4333-8444-555555555555},1"',
      sizeBytes: 2048,
      modifiedAt: expect.any(String) as unknown as string,
      mimeType: expect.any(String) as unknown as string,
    });
    const s = h.adapter.fileSettings();
    expect(s.maxDownloadBytes).toBe(200 * 1024 * 1024);
    expect(s.mirror).toMatchObject({
      enabled: true,
      root: join(homedir(), 'University/Teams'),
      courses: 'linked',
      maxFileBytes: 200 * 1024 * 1024,
    });
    expect(harness().adapter.fileSettings().mirror?.enabled).toBe(false);
  });

  it('streams files to disk on the team site, pacing them, then extracts their text', async () => {
    const h = harness({
      extract: (data, ext) =>
        Promise.resolve({
          text: new TextDecoder().decode(data),
          ...(ext === 'pptx' ? { pages: [{ page: 1, text: new TextDecoder().decode(data) }] } : {}),
        }),
    });
    const items = await driveItems(h);
    h.client.files['01FILESLIDES'] = new TextEncoder().encode('第1回 ERモデルとリレーション');
    h.client.files['01FILEROOT'] = new TextEncoder().encode('シラバス本文');
    const out = await h.adapter.downloadFiles([
      request(items.get('01FILESLIDES')!, join(dir, 'a', 'slides.pptx')),
      request(items.get('01FILEROOT')!, join(dir, 'b', 'syllabus.docx')),
    ]);
    expect(out.results.map((r) => [r.status, r.bytes])).toEqual([
      ['downloaded', 40],
      ['downloaded', 18],
    ]);
    expect(readFileSync(join(dir, 'a', 'slides.pptx'), 'utf8')).toBe(
      '第1回 ERモデルとリレーション',
    );
    // one browser session, started on the team's SharePoint site (no Teams boot)
    expect(h.sessions).toEqual([SITE]);
    expect(h.clock.slept).toContain(1500);
    expect(out.items.map((i) => [i.sourceType, i.externalId])).toEqual([
      ['teamsweb.fileText', `${CLASS_GROUP}/01FILESLIDES`],
      ['teamsweb.fileText', `${CLASS_GROUP}/01FILEROOT`],
    ]);
    expect(out.items[0]?.payload).toMatchObject({
      itemId: '01FILESLIDES',
      pages: [{ page: 1, text: '第1回 ERモデルとリレーション' }],
    });
    expect(out.results[0]?.text).toEqual({ chars: 16, pages: 1 });
    // no partial files are left behind
    expect(() => readFileSync(join(dir, 'a', 'slides.pptx.part'))).toThrow();
  });

  it('refuses a file over the limit without contacting SharePoint and extracts cached files offline', async () => {
    const h = harness({ extract: (d) => Promise.resolve({ text: new TextDecoder().decode(d) }) });
    const items = await driveItems(h);
    const week1 = items.get('01FILEWEEK1')!; // 123 456 bytes
    const big = await h.adapter.downloadFiles([
      request(week1, join(dir, 'w.pdf'), { maxBytes: 1000 }),
    ]);
    expect(big.results[0]).toMatchObject({ status: 'tooLarge', bytes: 123456 });
    expect(h.client.downloads).toEqual([]);
    expect(h.sessions).toEqual([]);

    // already on disk: only its text is extracted, no browser
    const target = join(dir, 'syllabus.docx');
    h.client.files['01FILEROOT'] = new TextEncoder().encode('ローカルの本文');
    await h.adapter.downloadFiles([request(items.get('01FILEROOT')!, target, { extract: false })]);
    h.sessions.length = 0;
    const again = await h.adapter.downloadFiles([
      request(items.get('01FILEROOT')!, target, { extractOnly: true }),
    ]);
    expect(again.results[0]?.status).toBe('extracted');
    expect(again.items).toHaveLength(1);
    expect(h.sessions).toEqual([]);

    const bad = await h.adapter.downloadFiles([
      {
        externalId: 'x',
        payload: { nope: true },
        targetPath: join(dir, 'x'),
        maxBytes: 1,
        extract: false,
      },
    ]);
    expect(bad.results[0]?.status).toBe('notFound');
  });

  it('stops the batch when SharePoint throttles and reports a needed sign-in', async () => {
    const h = harness();
    const items = await driveItems(h);
    h.client.fileStatus['01FILESLIDES'] = 429;
    h.client.files['01FILEROOT'] = new TextEncoder().encode('x');
    const out = await h.adapter.downloadFiles([
      request(items.get('01FILESLIDES')!, join(dir, 's.pptx')),
      request(items.get('01FILEROOT')!, join(dir, 'r.docx')),
    ]);
    expect(out.results.map((r) => [r.status, r.error])).toEqual([
      ['failed', 'throttled'],
      ['failed', 'throttled'],
    ]);
    expect(h.client.downloads).toEqual(['01FILESLIDES']);
    expect(out.warnings[0]).toContain('throttling');

    const auth = harness({ auth: { status: 'auth_required', message: 'sign in' } });
    await expect(
      auth.adapter.downloadFiles([request(items.get('01FILEROOT')!, join(dir, 'z'))]),
    ).rejects.toThrow('sign in');
  });
});

describe('download session start', () => {
  it('retries once when the SharePoint site does not open in time', async () => {
    const base = harness();
    const r = await base.adapter.sync({ mode: 'initial' });
    const item = r.items.find((i) => i.externalId.endsWith('/01FILEROOT'))!;
    base.client.files['01FILEROOT'] = new TextEncoder().encode('x');
    let attempts = 0;
    const adapter = new TeamsWebAdapter({
      sourceId: 'teams-web',
      config: base.config,
      clock: base.clock,
      logger: silentLogger,
      timezone: 'Asia/Tokyo',
      profileExists: () => true,
      random: () => 0,
      withClient: async (fn) => {
        attempts++;
        if (attempts === 1) throw new Error('page.goto: Timeout 30000ms exceeded.');
        return { result: await fn(base.client) };
      },
    });
    const dir = mkdtempSync(join(tmpdir(), 'uc-teams-retry-'));
    try {
      const out = await adapter.downloadFiles([
        {
          externalId: item.externalId,
          payload: item.payload,
          targetPath: join(dir, 'f.docx'),
          maxBytes: 1000,
          extract: false,
        },
      ]);
      expect(attempts).toBe(2);
      expect(out.results[0]?.status).toBe('downloaded');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
