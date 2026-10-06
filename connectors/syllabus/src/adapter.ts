import path from 'node:path';
import type { Capability, HealthStatus } from '@unicontext/canonical-model';
import {
  type AuthResult,
  type ConnectorContext,
  createHttpClient,
  type DetailFetchAdapter,
  type DetailFetchResult,
  type RawItem,
  type SyncInput,
  type SyncResult,
} from '@unicontext/connector-sdk';
import {
  AuthRequiredError,
  ConnectorError,
  errorMessage,
  OfflineError,
  RateLimitedError,
} from '@unicontext/core';
import {
  type CachedDetail,
  DETAIL_CACHE_FILE,
  DETAIL_RANK,
  DetailCache,
  type DetailCandidate,
  isFresh,
  orderDetailCandidates,
  resolveCatalogTerms,
} from './catalog.js';
import { yearOfTitle } from './lcu/parse.js';
import { HttpSession } from './session.js';
import type { SyllabusStrategy } from './strategy.js';
import { createStrategy } from './strategies.js';
import {
  emptySyllabusDetail,
  SYLLABUS_ENTRY,
  type SyllabusConfig,
  type SyllabusDetail,
  type SyllabusDetailPriority,
  SyllabusDetailPrioritySchema,
  type SyllabusEntryPayload,
  SyllabusEntryPayloadSchema,
  type SyllabusSearchRow,
  type SyllabusTarget,
  SyllabusTargetSchema,
  type SyllabusUnit,
} from './types.js';

/**
 * Supplies the courses whose syllabus should be read, usually the student's LCU course codes
 * (host-injected by the daemon, e.g. from the livecampusu source). Merged with `targets:` in config.
 */
export type SyllabusTargetProvider = () =>
  Promise<readonly SyllabusTarget[]> | readonly SyllabusTarget[];

/**
 * Supplies which catalog rows matter to the student (host-injected by the daemon from the
 * student's enrollments, grades and graduation requirements), so their details are opened before
 * the general backlog. Evaluated once per sync run.
 */
export type SyllabusPriorityProvider = () =>
  Promise<readonly SyllabusDetailPriority[]> | readonly SyllabusDetailPriority[];

export interface SyllabusAdapterOptions {
  /** Override the strategy chosen by `config.strategy` (tests, custom systems). */
  strategy?: SyllabusStrategy;
  targetProvider?: SyllabusTargetProvider;
  priorityProvider?: SyllabusPriorityProvider;
}

/** A unit of one run: a lookup / listing, or (last, catalog only) the budgeted detail openings. */
type RunUnit = SyllabusUnit | { kind: 'details' };

/** A catalog row held back until the run knows every listing, to give the budget by priority. */
interface PendingRow extends DetailCandidate {
  row: SyllabusSearchRow;
  cached: CachedDetail | undefined;
}

interface RunState {
  units: RunUnit[];
  seen: Set<string>;
  failures: number;
  /** Something expected was not seen (no rows, row not opened, provider failed): never retire entries. */
  incomplete: boolean;
  items: number;
  firstError: string | undefined;
  /** Catalog detail pages this run may still open (config `catalog.detailsPerRun`). */
  detailBudget: number;
  /** Rows of all listings whose detail is missing or stale (emitted by the `details` unit). */
  pending: PendingRow[];
  priorities: SyllabusDetailPriority[];
  detailsOpened: number;
  detailFailures: number;
  /** Consecutive failed detail openings; at MAX_DETAIL_STREAK the run stops opening details. */
  detailStreak: number;
  firstDetailError: string | undefined;
}

function unitKey(u: RunUnit): string {
  switch (u.kind) {
    case 'details':
      return 'd';
    case 'target':
      return `t|${u.target.year}|${u.target.faculty ?? ''}|${u.target.titleCode ?? ''}|${u.target.subjectCode}|${u.target.classCode ?? ''}`;
    case 'search':
      return `s|${JSON.stringify(u.search)}`;
    case 'catalog':
      return `c|${u.catalog.year ?? ''}|${u.catalog.semester}|${u.catalog.titleCode}`;
  }
}

const DAY_MS = 86_400_000;
const MAX_DETAIL_STREAK = 3;
/** On-demand detail fetches per call (one is about six requests). */
export const MAX_DETAIL_FETCH_PER_CALL = 5;
/** A row whose on-demand fetch just failed is not tried again within this time (queued instead). */
const FETCH_RETRY_MS = 60_000;
/** Freshness of a detail for on-demand requests when no catalog is configured. */
const DEFAULT_MAX_AGE_DAYS = 30;

function isTransient(e: unknown): boolean {
  return (
    e instanceof AuthRequiredError || e instanceof RateLimitedError || e instanceof OfflineError
  );
}

function normText(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, '');
}

function normClass(s: string): string {
  return normText(s).replace(/クラス$/, '');
}

/** '1' (前期) / '2' (後期) from the row's 開講学期 (「前期 ～ 後期（通年）」 counts as 前期). */
function semesterOf(row: SyllabusSearchRow): '1' | '2' | undefined {
  const t = normText(row.columns['開講学期'] ?? '');
  if (t.startsWith('前期')) return '1';
  if (t.startsWith('後期')) return '2';
  return undefined;
}

/** Does a priority rule describe this row? Category rules only apply to faculty listings. */
export function priorityMatches(
  p: SyllabusDetailPriority,
  row: SyllabusSearchRow,
  options: { semester?: '1' | '2' | undefined; generalEducation?: boolean } = {},
): boolean {
  if (p.subjectCode && normText(p.subjectCode) !== normText(row.subjectCode)) return false;
  if (p.title && normText(p.title) !== normText(row.columns['講義名'] ?? '')) return false;
  if (p.category) {
    if (options.generalEducation) return false;
    const want = normText(p.category);
    if (!row.categories.some((c) => normText(c).includes(want))) return false;
  }
  if (p.year !== undefined && row.year !== undefined && p.year !== row.year) return false;
  const semester = semesterOf(row) ?? options.semester;
  if (p.semester && semester && p.semester !== semester) return false;
  if (p.className && normClass(p.className) !== normClass(row.className)) return false;
  return true;
}

/**
 * Generic syllabus adapter: decides which courses to look up (config `targets` / `searches` plus
 * an optional injected `targetProvider`) and asks the configured strategy to search and open
 * each syllabus, one request at a time. Optionally (`catalog:`) it also lists whole terms of the
 * configured faculties: one search per (faculty, term) and only a budgeted number of detail pages
 * per run, given to the rows that matter most to the student first (`priorityProvider`), so it
 * never crawls a whole syllabus database in one go. `fetchDetails` reads one row's detail on the
 * user's request.
 */
export class SyllabusAdapter implements DetailFetchAdapter {
  readonly id: string;
  readonly version = '1.0.0';
  /**
   * Host-injected target feed; may also be assigned after construction by the daemon:
   * `adapter.targetProvider = () => lcuCourseCodes()`.
   */
  targetProvider: SyllabusTargetProvider | undefined;
  /**
   * Host-injected detail priorities (the student's courses first); may be assigned after
   * construction like `targetProvider`.
   */
  priorityProvider: SyllabusPriorityProvider | undefined;
  private readonly strategy: SyllabusStrategy;
  private readonly session: HttpSession;
  private readonly cache: DetailCache;
  /** Row key -> time of the last failed on-demand fetch. */
  private readonly fetchFailures = new Map<string, number>();
  private run: RunState | undefined;
  private lastSuccessAt: string | undefined;
  private lastError: string | undefined;
  private consecutiveFailures = 0;

  constructor(
    private readonly ctx: ConnectorContext<SyllabusConfig>,
    options: SyllabusAdapterOptions = {},
  ) {
    this.strategy = options.strategy ?? createStrategy(ctx);
    this.targetProvider = options.targetProvider;
    this.priorityProvider = options.priorityProvider;
    this.id = `syllabus:${this.strategy.id}`;
    const http = createHttpClient({
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
      rateLimiter: ctx.rateLimiter,
      clock: ctx.clock,
    });
    this.session = new HttpSession(http, this.strategy.baseUrl, undefined, {
      minIntervalMs: ctx.config.minRequestIntervalMs,
      clock: ctx.clock,
    });
    this.cache = new DetailCache(
      ctx.cacheDir ? path.join(ctx.cacheDir, DETAIL_CACHE_FILE) : undefined,
    );
  }

  capabilities(): Promise<Capability[]> {
    return Promise.resolve(['courses', 'timetable', 'rooms']);
  }

  /** Public pages: nothing to authenticate. */
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
    this.session.reset();
    this.run = undefined;
    return Promise.resolve();
  }

  /**
   * One catalog unit per (term, faculty), the faculties' campus 全学教育 included unless
   * `generalEducation: false`; a year without a known title code is skipped with a warning.
   */
  private catalogUnits(warnings: string[]): SyllabusUnit[] {
    const catalog = this.ctx.config.catalog;
    if (!catalog) return [];
    const timeZone = this.ctx.profile?.academicCalendar.timezone ?? 'Asia/Tokyo';
    const terms = resolveCatalogTerms(catalog.terms, this.ctx.clock.now(), timeZone);
    const units: SyllabusUnit[] = [];
    const unknown = new Set<string>();
    const faculties = [...catalog.faculties];
    // The campus 全学教育 catalogs of the configured faculties (also when listed explicitly).
    const campusGe = new Set<string>();
    for (const f of catalog.faculties) {
      const ge = this.strategy.generalEducationFor?.(f);
      if (ge && ge !== f) campusGe.add(ge);
    }
    if (catalog.generalEducation)
      for (const ge of campusGe) if (!faculties.includes(ge)) faculties.push(ge);
    for (const term of terms) {
      for (const faculty of faculties) {
        const titleCode = this.strategy.titleCodeFor?.(term.year, faculty);
        if (!titleCode) {
          unknown.add(`${term.year} ${faculty}`);
          continue;
        }
        units.push({
          kind: 'catalog',
          catalog: {
            year: term.year,
            semester: term.semester,
            faculty,
            titleCode,
            maxRows: catalog.maxRows,
            ...(campusGe.has(faculty) ? { generalEducation: true } : {}),
          },
        });
      }
      for (const titleCode of catalog.titleCodes) {
        const year = this.strategy.yearOfTitleCode?.(titleCode);
        if (year !== undefined && year !== term.year) continue;
        units.push({
          kind: 'catalog',
          catalog: { year, semester: term.semester, titleCode, maxRows: catalog.maxRows },
        });
      }
    }
    for (const u of unknown)
      warnings.push(`syllabus for ${u} is not published/known yet (no title code)`);
    return units;
  }

  private async collectUnits(warnings: string[]): Promise<{ units: RunUnit[]; ok: boolean }> {
    const units: RunUnit[] = [];
    let ok = true;
    for (const target of this.ctx.config.targets) units.push({ kind: 'target', target });
    if (this.targetProvider) {
      try {
        for (const candidate of await this.targetProvider()) {
          const parsed = SyllabusTargetSchema.safeParse(candidate);
          if (parsed.success) units.push({ kind: 'target', target: parsed.data });
          else {
            ok = false;
            warnings.push(`ignored invalid target from targetProvider: ${parsed.error.message}`);
          }
        }
      } catch (e) {
        ok = false;
        warnings.push(`targetProvider failed: ${errorMessage(e)}`);
      }
    }
    for (const search of this.ctx.config.searches) units.push({ kind: 'search', search });
    const catalogUnits = this.catalogUnits(warnings);
    units.push(...catalogUnits);
    if (catalogUnits.length) units.push({ kind: 'details' });
    const seen = new Set<string>();
    return {
      units: units.filter((u) => {
        const k = unitKey(u);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }),
      ok,
    };
  }

  /** The provider's rules (invalid ones dropped with a warning); never fails the run. */
  private async loadPriorities(warnings: string[]): Promise<SyllabusDetailPriority[]> {
    if (!this.priorityProvider || !this.ctx.config.catalog) return [];
    const out: SyllabusDetailPriority[] = [];
    let invalid = 0;
    try {
      for (const p of await this.priorityProvider()) {
        const parsed = SyllabusDetailPrioritySchema.safeParse(p);
        if (parsed.success) out.push(parsed.data);
        else invalid++;
      }
    } catch (e) {
      warnings.push(`priorityProvider failed: ${errorMessage(e)}`);
    }
    if (invalid) warnings.push(`ignored ${invalid} invalid syllabus detail priorities`);
    return out;
  }

  /** Rank of a catalog row (DETAIL_RANK: requested, enrolled, needed, department, 全学教育, other). */
  private rankOf(
    row: SyllabusSearchRow,
    unit: Extract<SyllabusUnit, { kind: 'catalog' }>,
    priorities: readonly SyllabusDetailPriority[],
  ): number {
    if (this.cache.isRequested(row.key)) return DETAIL_RANK.requested;
    const ge = unit.catalog.generalEducation === true;
    let rank: number = ge ? DETAIL_RANK.generalEducation : DETAIL_RANK.other;
    for (const p of priorities)
      if (
        DETAIL_RANK[p.priority] < rank &&
        priorityMatches(p, row, { semester: unit.catalog.semester, generalEducation: ge })
      )
        rank = DETAIL_RANK[p.priority];
    return rank;
  }

  async sync(input: SyncInput): Promise<SyncResult> {
    const warnings: string[] = [];
    if (!input.pageToken || !this.run) {
      const { units, ok } = await this.collectUnits(warnings);
      const priorities = await this.loadPriorities(warnings);
      this.run = {
        units,
        seen: new Set(),
        failures: 0,
        // Resumed at a later page without the run state (restart): earlier pages are unknown
        // to this run, so it must not retire anything.
        incomplete: !ok || !!input.pageToken,
        items: 0,
        firstError: undefined,
        detailBudget: this.ctx.config.catalog?.detailsPerRun ?? 0,
        pending: [],
        priorities,
        detailsOpened: 0,
        detailFailures: 0,
        detailStreak: 0,
        firstDetailError: undefined,
      };
    }
    const run = this.run;
    const start = input.pageToken ? Number(input.pageToken) || 0 : 0;
    const slice = run.units.slice(start, start + this.ctx.config.unitsPerPage);
    const items: RawItem[] = [];

    try {
      for (const [offset, unit] of slice.entries()) {
        input.signal?.throwIfAborted();
        try {
          if (unit.kind === 'catalog') {
            await this.syncCatalogUnit(unit, start + offset, run, items, warnings);
            continue;
          }
          if (unit.kind === 'details') {
            await this.openPendingDetails(run, items, warnings, input.signal);
            continue;
          }
          const found = await this.strategy.search(unit, this.session);
          warnings.push(...found.warnings);
          if (found.rows.length === 0) run.incomplete = true;
          for (const row of found.rows) {
            if (run.seen.has(row.key)) continue;
            const opened = await this.strategy.detail(row, this.session);
            if (!opened) {
              warnings.push(`could not open syllabus ${row.key}`);
              run.incomplete = true;
              continue;
            }
            warnings.push(...opened.warnings);
            run.seen.add(row.key);
            items.push(this.entryItem(row, opened));
            run.items++;
          }
        } catch (e) {
          if (isTransient(e) || input.signal?.aborted) throw e;
          run.failures++;
          run.incomplete = true;
          run.firstError ??= errorMessage(e);
          warnings.push(`syllabus lookup failed: ${errorMessage(e)}`);
        }
      }
    } catch (e) {
      this.lastError = errorMessage(e);
      this.consecutiveFailures++;
      this.run = undefined;
      throw e;
    }

    const end = start + slice.length;
    const hasMore = end < run.units.length;
    if (!hasMore) {
      this.run = undefined;
      if (this.ctx.config.catalog) {
        // Rows the source no longer lists must not stay cached forever (only after a full pass).
        if (!run.incomplete && run.units.length > 0) this.cache.prune(run.seen);
        const warning = await this.cache.save();
        if (warning) warnings.push(warning);
      }
      if (run.items === 0 && run.firstError) {
        this.lastError = run.firstError;
        this.consecutiveFailures++;
        throw new ConnectorError(`Syllabus sync failed: ${run.firstError}`);
      }
      if (run.failures === 0 && run.detailFailures === 0) {
        this.lastError = undefined;
        this.consecutiveFailures = 0;
      } else if (run.failures === 0 && run.firstDetailError) {
        this.lastError = `${run.detailFailures} syllabus detail pages could not be read: ${run.firstDetailError}`;
      }
      this.lastSuccessAt = this.ctx.clock.now().toISOString();
    }
    return {
      items,
      hasMore,
      ...(hasMore ? { nextPageToken: String(end) } : {}),
      cursor: {
        extra: {
          syncedAt: this.ctx.clock.now().toISOString(),
          units: run.units.length,
          ...(this.ctx.config.catalog ? { detailsOpened: run.detailsOpened } : {}),
        },
      },
      // Only a fully successful pass over a non-empty target list may retire entries.
      ...(!hasMore && !run.incomplete && run.units.length > 0
        ? { complete: { sourceTypes: [SYLLABUS_ENTRY] } }
        : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }

  /** The raw item of one row: with a detail page, or (no `opened`) from the list row alone. */
  private entryItem(
    row: SyllabusSearchRow,
    opened: { detail: SyllabusDetail; url: string; titleCode?: string | undefined } | undefined,
  ): RawItem {
    const titleCode = opened ? opened.titleCode : row.titleCode;
    const payload: SyllabusEntryPayload = {
      strategy: this.strategy.id,
      url: opened?.url ?? row.url ?? this.strategy.baseUrl,
      title: row.title,
      ...(titleCode ? { titleCode } : {}),
      ...(row.year !== undefined ? { year: row.year } : {}),
      subjectCode: row.subjectCode,
      className: row.className,
      categories: row.categories,
      row: row.columns,
      detail: opened?.detail ?? emptySyllabusDetail(),
      ...(opened ? {} : { detailFetched: false }),
    };
    return { sourceType: SYLLABUS_ENTRY, externalId: row.key, payload };
  }

  /**
   * One (faculty, term) listing: every row becomes an entry. Rows with a fresh cached detail are
   * emitted right away; rows whose detail is missing or stale are held back (with their priority)
   * until the `details` unit at the end of the run, which knows every listing and gives the
   * budget to the rows that matter most to the student first.
   */
  private async syncCatalogUnit(
    unit: Extract<SyllabusUnit, { kind: 'catalog' }>,
    index: number,
    run: RunState,
    items: RawItem[],
    warnings: string[],
  ): Promise<void> {
    const catalog = this.ctx.config.catalog;
    if (!catalog) return;
    warnings.push(...(await this.cache.load()));
    const found = await this.strategy.search(unit, this.session);
    warnings.push(...found.warnings);
    if (found.rows.length === 0 || found.truncated) run.incomplete = true;
    const nowMs = this.ctx.clock.now().getTime();
    const maxAgeMs = catalog.detailMaxAgeDays * DAY_MS;
    for (const row of found.rows) {
      if (run.seen.has(row.key)) continue;
      run.seen.add(row.key);
      const cached = this.cache.get(row.key);
      if (cached && isFresh(cached, nowMs, maxAgeMs)) {
        items.push(this.entryItem(row, cached));
        run.items++;
        continue;
      }
      run.pending.push({
        key: row.key,
        row,
        cached,
        rank: this.rankOf(row, unit, run.priorities),
        unit: index,
        fetchedAt: cached?.fetchedAt,
      });
    }
  }

  /**
   * The budgeted part of a catalog run: open the details of the held-back rows in priority order
   * (DETAIL_RANK, then never-fetched before stale, the listings taking turns) while the budget
   * lasts, then emit every held-back row in listing order (with its new detail, its stale cached
   * one, or row-only).
   */
  private async openPendingDetails(
    run: RunState,
    items: RawItem[],
    warnings: string[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const catalog = this.ctx.config.catalog;
    if (!catalog) return;
    const nowMs = this.ctx.clock.now().getTime();
    const maxAgeMs = catalog.detailMaxAgeDays * DAY_MS;
    const shown = new Map<string, CachedDetail>();
    let attempted = 0;
    try {
      for (const p of orderDetailCandidates(run.pending)) {
        // An on-demand fetch may have read it in the meantime.
        const now = this.cache.get(p.key);
        if (now && isFresh(now, nowMs, maxAgeMs)) {
          shown.set(p.key, now);
          continue;
        }
        if (attempted >= run.detailBudget || run.detailStreak >= MAX_DETAIL_STREAK) continue;
        signal?.throwIfAborted();
        attempted++;
        try {
          const opened = await this.strategy.detail(p.row, this.session);
          if (opened) {
            warnings.push(...opened.warnings);
            const entry: CachedDetail = {
              detail: opened.detail,
              url: opened.url,
              ...(opened.titleCode ? { titleCode: opened.titleCode } : {}),
              fetchedAt: this.ctx.clock.now().toISOString(),
            };
            this.cache.set(p.key, entry);
            shown.set(p.key, entry);
            run.detailStreak = 0;
          } else {
            this.detailFailed(run, warnings, `could not open syllabus ${p.key}`);
          }
        } catch (e) {
          if (isTransient(e) || signal?.aborted) throw e;
          this.detailFailed(run, warnings, `syllabus detail failed: ${errorMessage(e)}`);
        }
      }
      // A stale cached detail still beats no detail when its refresh failed or did not fit.
      for (const p of run.pending) {
        items.push(this.entryItem(p.row, shown.get(p.key) ?? p.cached));
        run.items++;
      }
    } finally {
      run.detailBudget = Math.max(0, run.detailBudget - attempted);
      run.detailsOpened += attempted;
      run.pending = [];
      const warning = await this.cache.save();
      if (warning) warnings.push(warning);
    }
  }

  private detailFailed(run: RunState, warnings: string[], message: string): void {
    run.detailFailures++;
    run.detailStreak++;
    run.firstDetailError ??= message;
    warnings.push(message);
    if (run.detailStreak === MAX_DETAIL_STREAK)
      warnings.push(
        `${MAX_DETAIL_STREAK} syllabus details in a row failed; no more details are opened in this run`,
      );
  }

  /**
   * On-demand detail fetch (the user asked for a course whose detail the budgeted sync has not
   * read yet): a narrow search for the row (year x title, subject code, class) and its detail,
   * about six requests through the same paced session as the sync. A row that cannot be read
   * now is queued: the next sync opens it before every other row. At most
   * MAX_DETAIL_FETCH_PER_CALL rows are opened per call; the rest are queued.
   */
  async fetchDetails(
    requests: readonly { externalId: string; previousPayload?: unknown }[],
    options: { signal?: AbortSignal } = {},
  ): Promise<DetailFetchResult> {
    const warnings: string[] = [...(await this.cache.load())];
    const items: RawItem[] = [];
    const results: DetailFetchResult['results'] = [];
    const nowMs = (): number => this.ctx.clock.now().getTime();
    const maxAgeMs = (this.ctx.config.catalog?.detailMaxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * DAY_MS;
    let opened = 0;
    try {
      for (const req of requests) {
        const key = req.externalId;
        const parsed = SyllabusEntryPayloadSchema.safeParse(req.previousPayload);
        if (!parsed.success) {
          results.push({ externalId: key, status: 'failed', error: 'not a syllabus entry' });
          continue;
        }
        const p = parsed.data;
        const cached = this.cache.get(key);
        if (cached && isFresh(cached, nowMs(), maxAgeMs)) {
          items.push(this.entryItem(rowOfPayload(key, p), cached));
          results.push({ externalId: key, status: 'alreadyFetched' });
          continue;
        }
        const queue = (error: string): void => {
          this.cache.request(key, this.ctx.clock.now().toISOString());
          results.push({ externalId: key, status: 'queued', error });
        };
        if (opened >= MAX_DETAIL_FETCH_PER_CALL) {
          queue(`at most ${MAX_DETAIL_FETCH_PER_CALL} syllabus details are read per request`);
          continue;
        }
        const failedAt = this.fetchFailures.get(key);
        if (failedAt !== undefined && nowMs() - failedAt < FETCH_RETRY_MS) {
          queue('the previous attempt failed a moment ago');
          continue;
        }
        const year =
          p.year ??
          yearOfTitle(p.title) ??
          (p.titleCode ? this.strategy.yearOfTitleCode?.(p.titleCode) : undefined);
        if (year === undefined) {
          results.push({ externalId: key, status: 'failed', error: 'academic year unknown' });
          continue;
        }
        options.signal?.throwIfAborted();
        opened++;
        try {
          const target: SyllabusTarget = {
            year,
            subjectCode: p.subjectCode,
            ...(p.titleCode ? { titleCode: p.titleCode } : {}),
            ...(p.className ? { classCode: p.className } : {}),
          };
          const found = await this.strategy.search({ kind: 'target', target }, this.session);
          const hit = found.rows.find((r) => r.key === key);
          if (!hit) {
            results.push({ externalId: key, status: 'notFound' });
            continue;
          }
          const detail = await this.strategy.detail(hit, this.session);
          if (!detail) {
            this.fetchFailures.set(key, nowMs());
            queue(`could not open syllabus ${key}`);
            continue;
          }
          warnings.push(...detail.warnings);
          const entry: CachedDetail = {
            detail: detail.detail,
            url: detail.url,
            ...(detail.titleCode ? { titleCode: detail.titleCode } : {}),
            fetchedAt: this.ctx.clock.now().toISOString(),
          };
          this.cache.set(key, entry);
          this.fetchFailures.delete(key);
          items.push(this.entryItem(hit, entry));
          results.push({ externalId: key, status: 'fetched' });
        } catch (e) {
          if (options.signal?.aborted) throw e;
          this.fetchFailures.set(key, nowMs());
          queue(errorMessage(e));
        }
      }
    } finally {
      const warning = await this.cache.save();
      if (warning) warnings.push(warning);
    }
    return { items, results, warnings };
  }
}

/** The list row a stored entry was made from (enough to rebuild its raw item). */
function rowOfPayload(key: string, p: SyllabusEntryPayload): SyllabusSearchRow {
  return {
    key,
    subjectCode: p.subjectCode,
    className: p.className,
    title: p.title,
    year: p.year,
    categories: p.categories,
    columns: p.row,
    url: p.url,
    ...(p.titleCode ? { titleCode: p.titleCode } : {}),
    handle: undefined,
  };
}
