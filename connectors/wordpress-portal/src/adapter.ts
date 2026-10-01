import type { Capability, HealthStatus } from '@unicontext/canonical-model';
import {
  type AuthResult,
  type ConnectorContext,
  createHttpClient,
  type HttpClient,
  HttpError,
  type RawItem,
  type SourceAdapter,
  type SyncInput,
  type SyncResult,
} from '@unicontext/connector-sdk';
import { ConnectorError, errorMessage, sha256 } from '@unicontext/core';
import { extractPdfLinks, type PageLink } from './html.js';
import { looksLikePdf, type PdfTextExtractor, unpdfExtractor } from './pdf.js';
import { PORTAL_PRODUCT, POST_FIELDS, WP_CATEGORY, WP_PDF, WP_POST } from './types.js';
import {
  type WordpressConfig,
  type WpCategoryPayload,
  type WpPdfPayload,
  type WpPostPayload,
} from './types.js';
import { type ResolvedPortal, resolvePortal } from './profiles/index.js';

export interface WordpressAdapterOptions {
  /** Replace the PDF text engine (default: unpdf). */
  pdfExtractor?: PdfTextExtractor;
}

interface KnownPdf {
  size: number;
  sha256?: string;
  /** Why it was not stored (kept so a permanently unusable link is not retried every run). */
  skipped?: 'too_large' | 'not_pdf' | 'http_error';
}

interface WatchState {
  etag?: string;
  lastModified?: string;
}

interface PortalCursorExtra {
  known: Record<string, KnownPdf>;
  watch: Record<string, WatchState>;
}

interface RunState {
  /** Greatest modified_gmt seen in this run (becomes the next cursor). */
  maxModified: string | undefined;
  cursorModified: string | undefined;
  mode: SyncInput['mode'];
  categories: Map<number, string>;
  categoriesOk: boolean;
  pdfSeen: Set<string>;
  known: Record<string, KnownPdf>;
  watch: Record<string, WatchState>;
  totalPages: number | undefined;
  /** The run did not start at page 1, so it cannot claim a full listing. */
  partial: boolean;
}

const MAX_KNOWN = 2000;

/** WordPress 5.2 gives "2026-03-06T08:34:23" (GMT, no suffix). */
export function gmtToIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const iso = /(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString();
}

function readExtra(cursor: SyncInput['cursor']): PortalCursorExtra {
  const extra = (cursor?.extra ?? {}) as Partial<PortalCursorExtra>;
  return { known: { ...(extra.known ?? {}) }, watch: { ...(extra.watch ?? {}) } };
}

/**
 * WordPress REST connector. Posts are listed newest-modified first and paging stops at the stored
 * cursor (there is no `modified_after` before WordPress 5.7); linked PDFs are downloaded once per
 * URL, their text extracted, and the bytes kept as raw blobs.
 */
export class WordpressPortalAdapter implements SourceAdapter {
  readonly id = 'wordpress-portal';
  readonly version = '1.0.0';
  readonly portal: ResolvedPortal;
  private readonly http: HttpClient;
  private readonly extractor: PdfTextExtractor;
  private run: RunState | undefined;
  private lastSuccessAt: string | undefined;
  private lastError: string | undefined;
  private consecutiveFailures = 0;

  constructor(
    private readonly ctx: ConnectorContext<WordpressConfig>,
    options: WordpressAdapterOptions = {},
  ) {
    this.portal = resolvePortal(ctx.config, ctx.profile?.products[PORTAL_PRODUCT]);
    this.extractor = options.pdfExtractor ?? unpdfExtractor;
    this.http = createHttpClient({
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
      rateLimiter: ctx.rateLimiter,
      clock: ctx.clock,
    });
  }

  capabilities(): Promise<Capability[]> {
    return Promise.resolve(['announcements', 'materials', 'files']);
  }

  /** The WordPress REST API is public: nothing to authenticate. */
  authenticate(): Promise<AuthResult> {
    return Promise.resolve({ status: 'not_required' });
  }

  health(): Promise<HealthStatus> {
    return Promise.resolve({
      state: this.lastError ? (this.consecutiveFailures >= 3 ? 'failed' : 'degraded') : 'healthy',
      checkedAt: this.ctx.clock.now().toISOString(),
      ...(this.lastError ? { message: this.lastError } : {}),
      ...(this.lastSuccessAt ? { lastSuccessAt: this.lastSuccessAt } : {}),
      ...(this.consecutiveFailures ? { consecutiveFailures: this.consecutiveFailures } : {}),
    });
  }

  dispose(): Promise<void> {
    this.run = undefined;
    return Promise.resolve();
  }

  private postsUrl(page: number): string {
    const { perPage, categories } = this.ctx.config;
    const q = new URLSearchParams({
      per_page: String(perPage),
      page: String(page),
      orderby: 'modified',
      order: 'desc',
      _fields: POST_FIELDS,
    });
    if (categories?.length) q.set('categories', categories.join(','));
    return `${this.portal.restBase}posts?${q.toString()}`;
  }

  private async getJson(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ res: Response; body: unknown }> {
    const res = await this.http.request(url, {
      headers: { accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { res, body };
  }

  private async fetchCategories(
    run: RunState,
    items: RawItem[],
    signal?: AbortSignal,
  ): Promise<void> {
    const q = new URLSearchParams({ per_page: '100', _fields: 'id,name,slug,parent,count,link' });
    const { res, body } = await this.getJson(
      `${this.portal.restBase}categories?${q.toString()}`,
      signal,
    );
    if (!res.ok || !Array.isArray(body)) return;
    for (const c of body as WpCategoryPayload[]) {
      if (typeof c?.id !== 'number' || typeof c.name !== 'string') continue;
      run.categories.set(c.id, c.name);
      items.push({ sourceType: WP_CATEGORY, externalId: String(c.id), payload: c });
    }
    run.categoriesOk = true;
  }

  /** Download one new PDF URL and turn it into a wp.pdf item (or remember why not). */
  private async fetchPdf(
    link: PageLink,
    foundOn: string,
    run: RunState,
    warnings: string[],
    signal?: AbortSignal,
  ): Promise<RawItem | undefined> {
    if (run.pdfSeen.has(link.url) || run.known[link.url]) return undefined;
    run.pdfSeen.add(link.url);
    const maxBytes = this.ctx.config.pdf.maxSizeMb * 1024 * 1024;
    let res: Response;
    try {
      res = await this.http.request(link.url, {
        headers: { accept: 'application/pdf' },
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      warnings.push(`PDF ${link.url}: ${e.message}`);
      run.pdfSeen.delete(link.url); // server trouble: try again next run
      return undefined;
    }
    if (!res.ok) {
      warnings.push(`PDF ${link.url}: HTTP ${res.status}`);
      if (res.status >= 400 && res.status < 500)
        run.known[link.url] = { size: 0, skipped: 'http_error' };
      await res.arrayBuffer().catch(() => undefined);
      return undefined;
    }
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
      warnings.push(
        `PDF ${link.url} skipped: ${declared} bytes exceeds ${this.ctx.config.pdf.maxSizeMb} MB`,
      );
      run.known[link.url] = { size: declared, skipped: 'too_large' };
      await res.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength > maxBytes) {
      warnings.push(
        `PDF ${link.url} skipped: ${data.byteLength} bytes exceeds ${this.ctx.config.pdf.maxSizeMb} MB`,
      );
      run.known[link.url] = { size: data.byteLength, skipped: 'too_large' };
      return undefined;
    }
    if (!looksLikePdf(data)) {
      warnings.push(`PDF ${link.url} skipped: not a PDF`);
      run.known[link.url] = { size: data.byteLength, skipped: 'not_pdf' };
      return undefined;
    }
    let pages: WpPdfPayload['pages'] = [];
    try {
      pages = await this.extractor(data);
    } catch (e) {
      warnings.push(`PDF ${link.url}: text extraction failed (${errorMessage(e)})`);
    }
    const digest = sha256(data);
    run.known[link.url] = { size: data.byteLength, sha256: digest };
    const lastModified = res.headers.get('last-modified');
    const lm = lastModified ? new Date(lastModified) : undefined;
    const payload: WpPdfPayload = {
      url: link.url,
      title: link.text,
      foundOn,
      size: data.byteLength,
      sha256: digest,
      ...(lm && !Number.isNaN(lm.getTime()) ? { lastModified: lm.toISOString() } : {}),
      pages,
    };
    return {
      sourceType: WP_PDF,
      externalId: link.url,
      payload,
      ...(payload.lastModified ? { sourceUpdatedAt: payload.lastModified } : {}),
      blobs: [{ data, mimeType: 'application/pdf' }],
    };
  }

  /** Fetch a watched page (conditional GET) and download its new PDF links. */
  private async watchPage(
    url: string,
    run: RunState,
    items: RawItem[],
    warnings: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const state = run.watch[url] ?? {};
    const headers: Record<string, string> = { accept: 'text/html' };
    if (state.etag) headers['if-none-match'] = state.etag;
    if (state.lastModified) headers['if-modified-since'] = state.lastModified;
    let res: Response;
    try {
      res = await this.http.request(url, { headers, ...(signal ? { signal } : {}) });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      warnings.push(`watched page ${url}: ${e.message}`);
      return;
    }
    if (res.status === 304) return;
    if (!res.ok) {
      warnings.push(`watched page ${url}: HTTP ${res.status}`);
      await res.arrayBuffer().catch(() => undefined);
      return;
    }
    const html = await res.text();
    const next: WatchState = {};
    const etag = res.headers.get('etag');
    const modified = res.headers.get('last-modified');
    if (etag) next.etag = etag;
    if (modified) next.lastModified = modified;
    run.watch[url] = next;
    for (const link of extractPdfLinks(html, url)) {
      const item = await this.fetchPdf(link, url, run, warnings, signal);
      if (item) items.push(item);
    }
  }

  async sync(input: SyncInput): Promise<SyncResult> {
    const warnings: string[] = [];
    const items: RawItem[] = [];
    const page = input.pageToken ? Math.max(1, Number(input.pageToken) || 1) : 1;
    try {
      if (page === 1 || !this.run) {
        const extra = readExtra(input.cursor);
        this.run = {
          maxModified: undefined,
          cursorModified:
            input.mode === 'incremental' ? gmtToIso(input.cursor?.lastModified) : undefined,
          mode: input.mode,
          categories: new Map(),
          categoriesOk: false,
          pdfSeen: new Set(),
          known: extra.known,
          watch: extra.watch,
          totalPages: undefined,
          // Resumed at page > 1 without the run state (restart): pages before it are unknown.
          partial: page > 1,
        };
        await this.fetchCategories(this.run, items, input.signal);
        for (const url of this.ctx.config.pdf.watchPages) {
          input.signal?.throwIfAborted();
          await this.watchPage(url, this.run, items, warnings, input.signal);
        }
      }
      const run = this.run;
      const { res, body } = await this.getJson(this.postsUrl(page), input.signal);
      let posts: WpPostPayload[] = [];
      let invalidPage = false;
      if (res.ok && Array.isArray(body)) posts = body as WpPostPayload[];
      else if (page > 1 && res.status === 400)
        invalidPage = true; // rest_post_invalid_page_number: we are past the last page
      else
        throw new ConnectorError(
          `WordPress /posts returned HTTP ${res.status} (is the REST API enabled?)`,
        );

      const totalHeader = Number(res.headers.get('x-wp-totalpages') ?? '');
      if (Number.isFinite(totalHeader) && totalHeader > 0) run.totalPages = totalHeader;

      let stop = false;
      for (const post of posts) {
        const modified = gmtToIso(post.modified_gmt) ?? gmtToIso(post.date_gmt);
        if (modified && run.cursorModified && modified <= run.cursorModified) {
          stop = true; // sorted by modified desc: everything after this is older
          break;
        }
        if (modified && (!run.maxModified || modified > run.maxModified))
          run.maxModified = modified;
        const names = (post.categories ?? [])
          .map((id) => run.categories.get(id))
          .filter((n): n is string => n !== undefined);
        const payload: WpPostPayload = {
          ...post,
          ...(run.categoriesOk && names.length ? { categoryNames: names } : {}),
        };
        items.push({
          sourceType: WP_POST,
          externalId: String(post.id),
          payload,
          ...(modified ? { sourceUpdatedAt: modified } : {}),
        });
        if (this.ctx.config.pdf.followLinksInPosts && post.content?.rendered) {
          for (const link of extractPdfLinks(post.content.rendered, post.link)) {
            input.signal?.throwIfAborted();
            const pdf = await this.fetchPdf(link, post.link, run, warnings, input.signal);
            if (pdf) items.push(pdf);
          }
        }
      }

      const { perPage, maxPages } = this.ctx.config;
      const lastPage =
        invalidPage ||
        (run.totalPages !== undefined ? page >= run.totalPages : posts.length < perPage);
      const hasMore = !stop && !lastPage && page < maxPages;
      if (!stop && !lastPage && !hasMore)
        warnings.push(`stopped after maxPages=${maxPages}; older posts were not fetched`);
      // The whole listing was seen: neither cut by the cursor nor by maxPages.
      const exhausted = lastPage && !stop;

      const known = Object.entries(run.known);
      if (known.length > MAX_KNOWN)
        run.known = Object.fromEntries(known.slice(known.length - MAX_KNOWN));
      const lastModified = run.maxModified ?? gmtToIso(input.cursor?.lastModified);
      const extra: PortalCursorExtra = { known: run.known, watch: run.watch };
      const complete: string[] = [];
      if (!hasMore) {
        if (run.categoriesOk) complete.push(WP_CATEGORY);
        // A full listing lets deleted/unpublished posts disappear; incremental runs never retire.
        if (run.mode !== 'incremental' && exhausted && !run.partial) complete.push(WP_POST);
        this.lastError = undefined;
        this.consecutiveFailures = 0;
        this.lastSuccessAt = this.ctx.clock.now().toISOString();
        this.run = undefined;
      }
      return {
        items,
        hasMore,
        ...(hasMore ? { nextPageToken: String(page + 1) } : {}),
        cursor: {
          ...(lastModified ? { lastModified } : {}),
          extra: JSON.parse(JSON.stringify(extra)) as Record<string, unknown>,
        },
        ...(complete.length ? { complete: { sourceTypes: complete } } : {}),
        ...(warnings.length ? { warnings } : {}),
      };
    } catch (e) {
      this.lastError = errorMessage(e);
      this.consecutiveFailures++;
      this.run = undefined;
      throw e;
    }
  }
}
