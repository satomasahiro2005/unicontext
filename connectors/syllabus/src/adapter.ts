import path from 'node:path';
import type { Capability, HealthStatus } from '@unicontext/canonical-model';
import {
  type AuthResult,
  type ConnectorContext,
  createHttpClient,
  type RawItem,
  type SourceAdapter,
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
  DetailCache,
  isFresh,
  pickDetailsToOpen,
  resolveCatalogTerms,
} from './catalog.js';
import { HttpSession } from './session.js';
import type { SyllabusStrategy } from './strategy.js';
import { createStrategy } from './strategies.js';
import {
  emptySyllabusDetail,
  SYLLABUS_ENTRY,
  type SyllabusConfig,
  type SyllabusDetail,
  type SyllabusEntryPayload,
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

export interface SyllabusAdapterOptions {
  /** Override the strategy chosen by `config.strategy` (tests, custom systems). */
  strategy?: SyllabusStrategy;
  targetProvider?: SyllabusTargetProvider;
}

interface RunState {
  units: SyllabusUnit[];
  seen: Set<string>;
  failures: number;
  /** Something expected was not seen (no rows, row not opened, provider failed): never retire entries. */
  incomplete: boolean;
  items: number;
  firstError: string | undefined;
  /** Catalog detail pages this run may still open (config `catalog.detailsPerRun`). */
  detailBudget: number;
  /** `catalogAfter[i]` = number of catalog units at index >= i (fair split of the budget). */
  catalogAfter: number[];
  detailsOpened: number;
  detailFailures: number;
  /** Consecutive failed detail openings; at MAX_DETAIL_STREAK the run stops opening details. */
  detailStreak: number;
  firstDetailError: string | undefined;
}

function unitKey(u: SyllabusUnit): string {
  switch (u.kind) {
    case 'target':
      return `t|${u.target.year}|${u.target.faculty ?? ''}|${u.target.titleCode ?? ''}|${u.target.subjectCode}|${u.target.classCode ?? ''}`;
    case 'search':
      return `s|${JSON.stringify(u.search)}`;
    case 'catalog':
      return `c|${u.catalog.year ?? ''}|${u.catalog.semester}|${u.catalog.titleCode}`;
  }
}

function suffixCounts(units: readonly SyllabusUnit[]): number[] {
  const out = new Array<number>(units.length + 1).fill(0);
  for (let i = units.length - 1; i >= 0; i--)
    out[i] = (out[i + 1] ?? 0) + (units[i]?.kind === 'catalog' ? 1 : 0);
  return out;
}

const DAY_MS = 86_400_000;
const MAX_DETAIL_STREAK = 3;

function isTransient(e: unknown): boolean {
  return (
    e instanceof AuthRequiredError || e instanceof RateLimitedError || e instanceof OfflineError
  );
}

/**
 * Generic syllabus adapter: decides which courses to look up (config `targets` / `searches` plus
 * an optional injected `targetProvider`) and asks the configured strategy to search and open
 * each syllabus, one request at a time. Optionally (`catalog:`) it also lists whole terms of the
 * configured faculties: one search per (faculty, term) and only a budgeted number of detail pages
 * per run, so it never crawls a whole syllabus database in one go.
 */
export class SyllabusAdapter implements SourceAdapter {
  readonly id: string;
  readonly version = '1.0.0';
  /**
   * Host-injected target feed; may also be assigned after construction by the daemon:
   * `adapter.targetProvider = () => lcuCourseCodes()`.
   */
  targetProvider: SyllabusTargetProvider | undefined;
  private readonly strategy: SyllabusStrategy;
  private readonly session: HttpSession;
  private readonly cache: DetailCache;
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
    if (catalog.generalEducation)
      for (const f of catalog.faculties) {
        const ge = this.strategy.generalEducationFor?.(f);
        if (ge && !faculties.includes(ge)) faculties.push(ge);
      }
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

  private async collectUnits(warnings: string[]): Promise<{ units: SyllabusUnit[]; ok: boolean }> {
    const units: SyllabusUnit[] = [];
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
    units.push(...this.catalogUnits(warnings));
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

  async sync(input: SyncInput): Promise<SyncResult> {
    const warnings: string[] = [];
    if (!input.pageToken || !this.run) {
      const { units, ok } = await this.collectUnits(warnings);
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
        catalogAfter: suffixCounts(units),
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
            await this.syncCatalogUnit(unit, start + offset, run, items, warnings, input.signal);
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
   * One (faculty, term) listing: every row becomes an entry from the list row alone, enriched with
   * a cached detail when one is fresh, or a newly opened one while the run's budget lasts (rows
   * never fetched first, then the stalest). The budget left is split evenly over the catalog
   * units still to come, so one big faculty cannot starve the others.
   */
  private async syncCatalogUnit(
    unit: Extract<SyllabusUnit, { kind: 'catalog' }>,
    index: number,
    run: RunState,
    items: RawItem[],
    warnings: string[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const catalog = this.ctx.config.catalog;
    if (!catalog) return;
    warnings.push(...(await this.cache.load()));
    const left = Math.max(1, run.catalogAfter[index] ?? 1);
    const allowance = Math.min(run.detailBudget, Math.ceil(run.detailBudget / left));
    let attempted = 0;
    try {
      const found = await this.strategy.search(unit, this.session);
      warnings.push(...found.warnings);
      if (found.rows.length === 0 || found.truncated) run.incomplete = true;
      const now = this.ctx.clock.now();
      const maxAgeMs = catalog.detailMaxAgeDays * DAY_MS;
      const rows = found.rows.filter((r) => !run.seen.has(r.key));
      const toOpen = pickDetailsToOpen(rows, this.cache, now.getTime(), maxAgeMs, allowance);
      for (const row of rows) {
        signal?.throwIfAborted();
        const cached = this.cache.get(row.key);
        let use: CachedDetail | undefined =
          cached && isFresh(cached, now.getTime(), maxAgeMs) ? cached : undefined;
        if (!use && toOpen.has(row.key) && run.detailStreak < MAX_DETAIL_STREAK) {
          attempted++;
          try {
            const opened = await this.strategy.detail(row, this.session);
            if (opened) {
              warnings.push(...opened.warnings);
              use = {
                detail: opened.detail,
                url: opened.url,
                ...(opened.titleCode ? { titleCode: opened.titleCode } : {}),
                fetchedAt: now.toISOString(),
              };
              this.cache.set(row.key, use);
              run.detailStreak = 0;
            } else {
              this.detailFailed(run, warnings, `could not open syllabus ${row.key}`);
            }
          } catch (e) {
            if (isTransient(e) || signal?.aborted) throw e;
            this.detailFailed(run, warnings, `syllabus detail failed: ${errorMessage(e)}`);
          }
        }
        // A stale cached detail still beats no detail when the refresh failed or is not due yet.
        const shown = use ?? cached;
        run.seen.add(row.key);
        items.push(this.entryItem(row, shown));
        run.items++;
      }
    } finally {
      run.detailBudget = Math.max(0, run.detailBudget - attempted);
      run.detailsOpened += attempted;
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
}
