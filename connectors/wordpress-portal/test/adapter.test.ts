import type { RawItem, SyncInput, SyncResult } from '@unicontext/connector-sdk';
import { instantiateConnector } from '@unicontext/connector-sdk';
import { ConfigError, loadProfile } from '@unicontext/core';
import { describe, expect, it } from 'vitest';
import {
  gmtToIso,
  unpdfExtractor,
  WordpressConfigSchema,
  WordpressPortalAdapter,
  wordpressPortalConnector,
  type WpPdfPayload,
  type WpPostPayload,
} from '../src/index.js';
import { BASE, buildPdf, makeContext, memorySecrets, samplePosts } from './helpers.js';
import { createWpServer, post, type WpSiteOptions } from './wp-server.js';

const CATEGORIES = [
  { id: 1, name: '全学向け情報', slug: 'zengaku' },
  { id: 2, name: '学部向け情報', slug: 'gakubu' },
];

function config(partial: Record<string, unknown> = {}) {
  return WordpressConfigSchema.parse({ baseUrl: BASE, ...partial });
}

function setup(site: Partial<WpSiteOptions> = {}, partial: Record<string, unknown> = {}) {
  const srv = createWpServer({ posts: samplePosts(), categories: CATEGORIES, ...site });
  const adapter = new WordpressPortalAdapter(makeContext(config(partial), srv.fetch));
  return { srv, adapter };
}

async function runAll(
  adapter: WordpressPortalAdapter,
  input: Partial<SyncInput> = {},
): Promise<{ items: RawItem[]; pages: SyncResult[] }> {
  const pages: SyncResult[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 30; i++) {
    const res = await adapter.sync({
      mode: 'initial',
      ...input,
      ...(pageToken ? { pageToken } : {}),
    });
    pages.push(res);
    if (!res.hasMore) break;
    pageToken = res.nextPageToken;
  }
  return { items: pages.flatMap((p) => p.items), pages };
}

const ofType = (items: RawItem[], type: string) => items.filter((i) => i.sourceType === type);

describe('posts and categories', () => {
  it('lists posts newest-modified first with the documented fields and resolves category names', async () => {
    const { srv, adapter } = setup();
    const { items, pages } = await runAll(adapter);
    const postsUrl = srv.state.requests.find((u) => u.includes('/posts?'))!;
    const q = new URL(postsUrl).searchParams;
    expect(postsUrl.startsWith(`${BASE}wp-json/wp/v2/posts?`)).toBe(true);
    expect(q.get('_fields')).toBe(
      'id,date,date_gmt,modified,modified_gmt,link,title,excerpt,content,categories',
    );
    expect(q.get('per_page')).toBe('20');
    expect(srv.state.violations).toEqual([]);

    expect(ofType(items, 'wp.category').map((i) => i.externalId)).toEqual(['1', '2']);
    const posts = ofType(items, 'wp.post');
    expect(posts.map((p) => p.externalId)).toEqual(['2813', '1527']); // modified desc
    expect(posts[0]?.sourceUpdatedAt).toBe('2026-03-06T08:34:23.000Z');
    expect(posts[1]?.sourceUpdatedAt).toBe('2026-01-14T07:21:33.000Z');
    expect((posts[0]?.payload as WpPostPayload).categoryNames).toEqual(['全学向け情報']);
    // Full listing without a delete feed: whatever is not returned is retired.
    expect(pages.at(-1)?.complete).toEqual({ sourceTypes: ['wp.category', 'wp.post'] });
    expect(pages.at(-1)?.cursor?.lastModified).toBe('2026-03-06T08:34:23.000Z');
    expect(await adapter.health()).toMatchObject({ state: 'healthy' });
  });

  it('pages with X-WP-TotalPages and stops at maxPages without claiming completeness', async () => {
    const posts = [1, 2, 3, 4, 5].map((n) => post(n, `2026-05-0${n}T00:00:00`));
    const full = setup({ posts }, { perPage: 2 });
    const { items, pages } = await runAll(full.adapter);
    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.hasMore)).toEqual([true, true, false]);
    expect(pages[0]?.nextPageToken).toBe('2');
    expect(ofType(items, 'wp.post').map((i) => i.externalId)).toEqual(['5', '4', '3', '2', '1']);
    expect(pages.slice(0, 2).every((p) => p.complete === undefined)).toBe(true);
    expect(pages[2]?.complete?.sourceTypes).toContain('wp.post');
    // categories are fetched once per run, not per page
    expect(full.srv.state.requests.filter((u) => u.includes('/categories')).length).toBe(1);

    const capped = setup({ posts }, { perPage: 2, maxPages: 2 });
    const r = await runAll(capped.adapter);
    expect(r.pages).toHaveLength(2);
    expect(r.pages[1]?.warnings?.join()).toMatch(/maxPages=2/);
    expect(r.pages[1]?.complete?.sourceTypes).toEqual(['wp.category']);
  });

  it('filters by category id', async () => {
    const posts = [
      post(1, '2026-05-01T00:00:00', { categories: [1] }),
      post(2, '2026-05-02T00:00:00', { categories: [2] }),
    ];
    const { adapter } = setup({ posts }, { categories: [2] });
    const { items } = await runAll(adapter);
    expect(ofType(items, 'wp.post').map((i) => i.externalId)).toEqual(['2']);
  });

  it('is incremental: stops paging at the cursor (modified_gmt) and never retires posts', async () => {
    const posts = [1, 2, 3, 4, 5].map((n) => post(n, `2026-05-0${n}T00:00:00`));
    const { srv, adapter } = setup({ posts }, { perPage: 2 });
    const first = await runAll(adapter);
    const cursor = first.pages.at(-1)!.cursor!;
    expect(cursor.lastModified).toBe('2026-05-05T00:00:00.000Z');

    // Nothing changed: one request for posts, no items (the newest post equals the cursor).
    srv.state.requests.length = 0;
    const idle = await runAll(adapter, { mode: 'incremental', cursor });
    expect(ofType(idle.items, 'wp.post')).toEqual([]);
    expect(srv.state.requests.filter((u) => u.includes('/posts?'))).toHaveLength(1);
    expect(idle.pages[0]?.cursor?.lastModified).toBe('2026-05-05T00:00:00.000Z');

    // Post 2 is edited and a new post 6 arrives: both are fetched, older pages are not requested.
    srv.state.posts = [
      ...srv.state.posts.filter((p) => p.id !== 2),
      post(2, '2026-05-07T00:00:00', { title: { rendered: '更新されたお知らせ' } }),
      post(6, '2026-05-06T00:00:00'),
    ];
    srv.state.requests.length = 0;
    const next = await runAll(adapter, { mode: 'incremental', cursor });
    expect(ofType(next.items, 'wp.post').map((i) => i.externalId)).toEqual(['2', '6']);
    expect(next.pages.at(-1)?.cursor?.lastModified).toBe('2026-05-07T00:00:00.000Z');
    expect(next.pages.every((p) => !p.complete?.sourceTypes.includes('wp.post'))).toBe(true);
    // page 1 holds [2, 6]; page 2 starts with post 5 (<= cursor) => stop; page 3 is never requested.
    expect(srv.state.requests.filter((u) => u.includes('/posts?')).length).toBe(2);
  });

  it('turns WordPress GMT strings into instants', () => {
    expect(gmtToIso('2026-03-06T08:34:23')).toBe('2026-03-06T08:34:23.000Z');
    expect(gmtToIso('2026-03-06T08:34:23+09:00')).toBe('2026-03-05T23:34:23.000Z');
    expect(gmtToIso(undefined)).toBeUndefined();
    expect(gmtToIso('garbage')).toBeUndefined();
  });

  it('fails clearly when the REST API is not available', async () => {
    const srv = createWpServer({ posts: [] });
    const adapter = new WordpressPortalAdapter(
      makeContext(config({ baseUrl: 'https://other.example.org/blog/' }), srv.fetch),
    );
    await expect(adapter.sync({ mode: 'initial' })).rejects.toThrow(/REST API/);
    expect(await adapter.health()).toMatchObject({ state: 'degraded' });
  });
});

const PDF_A = 'https://portal.example.ac.jp/site/wp-content/uploads/2026/03/aaa.pdf';
const PDF_B = 'https://portal.example.ac.jp/site/wp-content/uploads/2026/03/bbb.pdf';
const FACULTY = 'https://portal.example.ac.jp/site/student_e/inf';

function facultyHtml(links: [string, string][]): string {
  return `<html><body><ul>${links.map(([href, text]) => `<li><a href="${href}">${text}</a></li>`).join('')}</ul></body></html>`;
}

describe('PDFs', () => {
  it('downloads PDFs linked from posts and watched pages once, with text and bytes', async () => {
    const pdfA = buildPdf(['Timetable R8 spring', 'Second page']);
    const pdfB = buildPdf(['Exam schedule 2026']);
    const posts = [
      post(10, '2026-06-01T00:00:00', {
        content: {
          rendered: `<p>時間割は <a href="/site/wp-content/uploads/2026/03/aaa.pdf">R8時間割 前期</a> です</p>`,
        },
      }),
    ];
    const { srv, adapter } = setup(
      {
        posts,
        pages: {
          [FACULTY]: {
            html: facultyHtml([
              [PDF_B, '令和8年度前期末試験時間割'],
              [PDF_A, 'duplicate link'],
            ]),
            etag: '"v1"',
          },
        },
        pdfs: { [PDF_A]: pdfA, [PDF_B]: pdfB },
      },
      { pdf: { watchPages: [FACULTY] } },
    );
    const first = await runAll(adapter);
    const pdfs = ofType(first.items, 'wp.pdf');
    // watched pages are read first, so aaa.pdf is found on the faculty page
    expect(pdfs.map((p) => p.externalId)).toEqual([PDF_B, PDF_A]);
    expect(srv.state.downloads).toEqual([PDF_B, PDF_A]);

    const a = pdfs.find((p) => p.externalId === PDF_A)!;
    const payload = a.payload as WpPdfPayload;
    expect(payload).toMatchObject({ url: PDF_A, foundOn: FACULTY, size: pdfA.byteLength });
    expect(payload.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.pages).toHaveLength(2);
    expect(payload.pages[0]).toMatchObject({ page: 1 });
    // A real unpdf extraction of a generated PDF.
    expect(payload.pages[0]?.text).toContain('Timetable R8 spring');
    expect(payload.pages[1]?.text).toContain('Second page');
    expect(a.blobs?.[0]?.mimeType).toBe('application/pdf');
    expect(Buffer.from(a.blobs![0]!.data).equals(Buffer.from(pdfA))).toBe(true);
    expect(a.sourceUpdatedAt).toBe('2026-04-01T03:00:00.000Z');
    expect(JSON.stringify(a.payload)).not.toContain('%PDF');

    // The next run knows both URLs: no downloads, conditional GET of the watched page.
    const cursor = first.pages.at(-1)!.cursor!;
    expect(Object.keys((cursor.extra as { known: object }).known).sort()).toEqual([PDF_A, PDF_B]);
    srv.state.downloads.length = 0;
    const second = await runAll(adapter, { mode: 'incremental', cursor });
    expect(srv.state.downloads).toEqual([]);
    expect(ofType(second.items, 'wp.pdf')).toEqual([]);
    expect(srv.state.pageFetches.at(-1)?.ifNoneMatch).toBe('"v1"');
  });

  it('treats a changed URL as a new version and keeps the old one', async () => {
    const PDF_C = 'https://portal.example.ac.jp/site/wp-content/uploads/2026/09/ccc.pdf';
    const { srv, adapter } = setup(
      {
        posts: [],
        pages: { [FACULTY]: { html: facultyHtml([[PDF_A, 'R8時間割 後期']]) } },
        pdfs: { [PDF_A]: buildPdf(['v1']), [PDF_C]: buildPdf(['v2']) },
      },
      { pdf: { watchPages: [FACULTY] } },
    );
    const first = await runAll(adapter);
    srv.state.pages[FACULTY] = { html: facultyHtml([[PDF_C, 'R8時間割 後期']]) };
    const second = await runAll(adapter, {
      mode: 'incremental',
      cursor: first.pages.at(-1)!.cursor!,
    });
    expect(ofType(second.items, 'wp.pdf').map((i) => i.externalId)).toEqual([PDF_C]);
    // wp.pdf is never "complete": the previous version stays available.
    expect(second.pages.every((p) => !p.complete?.sourceTypes.includes('wp.pdf'))).toBe(true);
  });

  it('skips oversized, non-PDF and missing files and does not retry them', async () => {
    const BIG = 'https://portal.example.ac.jp/site/big.pdf';
    const FAKE = 'https://portal.example.ac.jp/site/fake.pdf';
    const GONE = 'https://portal.example.ac.jp/site/gone.pdf';
    const { srv, adapter } = setup(
      {
        posts: [],
        pages: {
          [FACULTY]: {
            html: facultyHtml([
              [BIG, 'big'],
              [FAKE, 'fake'],
              [GONE, 'gone'],
              [PDF_A, 'ok'],
            ]),
          },
        },
        pdfs: {
          [BIG]: buildPdf(['big']),
          [FAKE]: new TextEncoder().encode('<html>login</html>'),
          [GONE]: { status: 404 },
          [PDF_A]: buildPdf(['ok']),
        },
        claimedSize: { [BIG]: 50 * 1024 * 1024 },
      },
      { pdf: { watchPages: [FACULTY], maxSizeMb: 5 } },
    );
    const first = await runAll(adapter);
    expect(ofType(first.items, 'wp.pdf').map((i) => i.externalId)).toEqual([PDF_A]);
    const warnings = first.pages.flatMap((p) => p.warnings ?? []).join('\n');
    expect(warnings).toMatch(/exceeds 5 MB/);
    expect(warnings).toMatch(/not a PDF/);
    expect(warnings).toMatch(/HTTP 404/);
    srv.state.downloads.length = 0;
    await runAll(adapter, { mode: 'incremental', cursor: first.pages.at(-1)!.cursor! });
    expect(srv.state.downloads).toEqual([]);
  });

  it('can ignore PDF links in posts and survives a failing extractor', async () => {
    const posts = [
      post(10, '2026-06-01T00:00:00', { content: { rendered: `<a href="${PDF_A}">資料</a>` } }),
    ];
    const off = setup(
      { posts, pdfs: { [PDF_A]: buildPdf(['x']) } },
      { pdf: { followLinksInPosts: false } },
    );
    expect(ofType((await runAll(off.adapter)).items, 'wp.pdf')).toEqual([]);

    const srv = createWpServer({ posts, pdfs: { [PDF_A]: buildPdf(['x']) } });
    const adapter = new WordpressPortalAdapter(makeContext(config(), srv.fetch), {
      pdfExtractor: () => Promise.reject(new Error('encrypted')),
    });
    const { items, pages } = await runAll(adapter);
    expect((ofType(items, 'wp.pdf')[0]?.payload as WpPdfPayload).pages).toEqual([]);
    expect(pages[0]?.warnings?.join()).toMatch(/text extraction failed \(encrypted\)/);
  });

  it('exposes the unpdf extractor for hosts', async () => {
    const pages = await unpdfExtractor(buildPdf(['Hello', 'World']));
    expect(pages.map((p) => p.text)).toEqual(['Hello', 'World']);
  });
});

describe('configuration', () => {
  it('uses the Shizuoka portal deployment by name or from profile settings', async () => {
    const srv = createWpServer({
      base: 'https://wwp.shizuoka.ac.jp/acad-affairs-portal/',
      posts: samplePosts(),
    });
    const byName = new WordpressPortalAdapter(
      makeContext(WordpressConfigSchema.parse({ deployment: 'shizuoka' }), srv.fetch),
    );
    expect(byName.portal.baseUrl).toBe('https://wwp.shizuoka.ac.jp/acad-affairs-portal/');
    expect(byName.portal.label).toBe('学生教務ポータル');
    expect(ofType((await runAll(byName)).items, 'wp.post')).toHaveLength(2);
    expect(srv.state.requests[0]).toContain(
      'https://wwp.shizuoka.ac.jp/acad-affairs-portal/wp-json/wp/v2/',
    );

    const base = loadProfile('shizuoka-university');
    const profile = {
      ...base,
      products: {
        ...base.products,
        'wordpress-portal': { deployment: 'shizuoka', label: 'テストポータル' },
      },
    };
    const viaProfile = new WordpressPortalAdapter(
      makeContext(config({ baseUrl: undefined }), srv.fetch, profile),
    );
    expect(viaProfile.portal).toMatchObject({ label: 'テストポータル', id: 'shizuoka' });
  });

  it('refuses to start without a site or with an unknown deployment', () => {
    const base = { sourceId: 'x', secrets: memorySecrets() };
    expect(() => instantiateConnector(wordpressPortalConnector, { ...base, config: {} })).toThrow(
      ConfigError,
    );
    expect(() =>
      instantiateConnector(wordpressPortalConnector, {
        ...base,
        config: { deployment: 'atlantis' },
      }),
    ).toThrow(/Unknown deployment/);
    expect(() =>
      instantiateConnector(wordpressPortalConnector, {
        ...base,
        config: { baseUrl: BASE, perPage: 500 },
      }),
    ).toThrow(ConfigError);
  });
});
