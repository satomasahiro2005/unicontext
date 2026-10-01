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
import { HttpSession } from './session.js';
import type { SyllabusStrategy } from './strategy.js';
import { createStrategy } from './strategies.js';
import {
  SYLLABUS_ENTRY,
  type SyllabusConfig,
  type SyllabusEntryPayload,
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
}

function unitKey(u: SyllabusUnit): string {
  return u.kind === 'target'
    ? `t|${u.target.year}|${u.target.faculty ?? ''}|${u.target.titleCode ?? ''}|${u.target.subjectCode}|${u.target.classCode ?? ''}`
    : `s|${JSON.stringify(u.search)}`;
}

function isTransient(e: unknown): boolean {
  return (
    e instanceof AuthRequiredError || e instanceof RateLimitedError || e instanceof OfflineError
  );
}

/**
 * Generic syllabus adapter: decides which courses to look up (config `targets` / `searches` plus
 * an optional injected `targetProvider`) and asks the configured strategy to search and open
 * each syllabus, one request at a time. It never crawls a whole syllabus database.
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
    this.session = new HttpSession(http, this.strategy.baseUrl);
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
        incomplete: !ok,
        items: 0,
        firstError: undefined,
      };
    }
    const run = this.run;
    const start = input.pageToken ? Number(input.pageToken) || 0 : 0;
    const slice = run.units.slice(start, start + this.ctx.config.unitsPerPage);
    const items: RawItem[] = [];

    try {
      for (const unit of slice) {
        input.signal?.throwIfAborted();
        try {
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
            const payload: SyllabusEntryPayload = {
              strategy: this.strategy.id,
              url: opened.url,
              title: row.title,
              ...(opened.titleCode ? { titleCode: opened.titleCode } : {}),
              ...(row.year !== undefined ? { year: row.year } : {}),
              subjectCode: row.subjectCode,
              className: row.className,
              categories: row.categories,
              row: row.columns,
              detail: opened.detail,
            };
            items.push({ sourceType: SYLLABUS_ENTRY, externalId: row.key, payload });
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
      if (run.items === 0 && run.firstError) {
        this.lastError = run.firstError;
        this.consecutiveFailures++;
        throw new ConnectorError(`Syllabus sync failed: ${run.firstError}`);
      }
      if (run.failures === 0) {
        this.lastError = undefined;
        this.consecutiveFailures = 0;
      }
      this.lastSuccessAt = this.ctx.clock.now().toISOString();
    }
    return {
      items,
      hasMore,
      ...(hasMore ? { nextPageToken: String(end) } : {}),
      cursor: { extra: { syncedAt: this.ctx.clock.now().toISOString(), units: run.units.length } },
      // Only a fully successful pass over a non-empty target list may retire entries.
      ...(!hasMore && !run.incomplete && run.units.length > 0
        ? { complete: { sourceTypes: [SYLLABUS_ENTRY] } }
        : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }
}
