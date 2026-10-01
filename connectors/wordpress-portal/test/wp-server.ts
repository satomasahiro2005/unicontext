import type { FetchLike } from '@unicontext/core';
import type { WpPostPayload } from '../src/index.js';
import { BASE } from './helpers.js';

export interface WpSiteOptions {
  base?: string;
  posts: WpPostPayload[];
  categories?: { id: number; name: string; slug?: string }[];
  /** HTML pages by URL (watched pages). */
  pages?: Record<string, { html: string; etag?: string }>;
  /** PDFs by URL. */
  pdfs?: Record<string, Uint8Array | { status: number }>;
  /** Extra Content-Length to claim for a PDF url (too-large tests). */
  claimedSize?: Record<string, number>;
}

const modifiedOf = (p: WpPostPayload): string => `${p.modified_gmt ?? p.date_gmt ?? ''}`;

/** A stand-in for a WordPress 5.2 site: /posts (paged, modified desc), /categories, pages, PDFs. */
export function createWpServer(options: WpSiteOptions) {
  const base = options.base ?? BASE;
  const state = {
    posts: [...options.posts],
    requests: [] as string[],
    violations: [] as string[],
    downloads: [] as string[],
    pageFetches: [] as { url: string; ifNoneMatch: string | null }[],
    pages: { ...(options.pages ?? {}) },
    pdfs: { ...(options.pdfs ?? {}) },
  };

  const json = (body: unknown, headers: Record<string, string> = {}, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

  const fetchFn: FetchLike = (input, init) => {
    state.requests.push(input);
    const url = new URL(input);
    const headers = new Headers(init?.headers);
    const rest = `${base}wp-json/wp/v2/`;
    if (input.startsWith(`${rest}posts`)) {
      const perPage = Number(url.searchParams.get('per_page') ?? '10');
      const page = Number(url.searchParams.get('page') ?? '1');
      for (const [k, v] of [
        ['orderby', 'modified'],
        ['order', 'desc'],
      ] as const)
        if (url.searchParams.get(k) !== v) state.violations.push(`${k}=${url.searchParams.get(k)}`);
      let list = [...state.posts].sort((a, b) => modifiedOf(b).localeCompare(modifiedOf(a)));
      const cats = url.searchParams.get('categories');
      if (cats) {
        const ids = cats.split(',').map(Number);
        list = list.filter((p) => p.categories?.some((c) => ids.includes(c)));
      }
      const totalPages = Math.ceil(list.length / perPage);
      const meta = { 'x-wp-total': String(list.length), 'x-wp-totalpages': String(totalPages) };
      if (page > Math.max(totalPages, 1))
        return Promise.resolve(
          json({ code: 'rest_post_invalid_page_number', message: 'past the last page' }, meta, 400),
        );
      return Promise.resolve(json(list.slice((page - 1) * perPage, page * perPage), meta));
    }
    if (input.startsWith(`${rest}categories`))
      return Promise.resolve(json(options.categories ?? [], { 'x-wp-total': '1' }));
    const pageEntry = state.pages[input];
    if (pageEntry) {
      const inm = headers.get('if-none-match');
      state.pageFetches.push({ url: input, ifNoneMatch: inm });
      if (pageEntry.etag && inm === pageEntry.etag)
        return Promise.resolve(new Response(null, { status: 304 }));
      return Promise.resolve(
        new Response(pageEntry.html, {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=UTF-8',
            ...(pageEntry.etag ? { etag: pageEntry.etag } : {}),
          },
        }),
      );
    }
    const pdf = state.pdfs[input];
    if (pdf) {
      state.downloads.push(input);
      if (!(pdf instanceof Uint8Array))
        return Promise.resolve(new Response('gone', { status: pdf.status }));
      const claimed = options.claimedSize?.[input];
      return Promise.resolve(
        new Response(new Blob([pdf]), {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            'content-length': String(claimed ?? pdf.byteLength),
            'last-modified': 'Wed, 01 Apr 2026 03:00:00 GMT',
          },
        }),
      );
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };

  return { fetch: fetchFn, state };
}

/** Synthetic post for paging / incremental tests. */
export function post(
  id: number,
  modifiedGmt: string,
  extra: Partial<WpPostPayload> = {},
): WpPostPayload {
  return {
    id,
    date: modifiedGmt,
    date_gmt: modifiedGmt,
    modified: modifiedGmt,
    modified_gmt: modifiedGmt,
    link: `${BASE}archives/${id}`,
    title: { rendered: `お知らせ ${id}` },
    content: { rendered: `<p>本文 ${id}</p>`, protected: false },
    excerpt: { rendered: `<p>抜粋 ${id}</p>`, protected: false },
    categories: [1],
    ...extra,
  };
}
