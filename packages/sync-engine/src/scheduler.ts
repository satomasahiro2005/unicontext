import {
  type Clock,
  parseDuration,
  RateLimitedError,
  systemClock,
  type TimerHandle,
} from '@unicontext/core';
import type { SyncEngine } from './engine.js';
import type { SyncRunReport } from './events.js';

/** "push" (change notifications), "event" (fs watch) and "manual" sources are only run via trigger(). */
export const NON_PERIODIC = new Set(['push', 'event', 'manual']);

export interface SchedulerOptions {
  clock?: Clock;
  /** Per-source schedule: "15m", "5m", "1d", "push", "event", "manual" (§36). */
  schedules?: Record<string, string>;
  /** Used when a source has no schedule. Default "15m". */
  defaultInterval?: string;
  /** Random spread added to intervals (0..1 of the interval). Default 0.1. */
  jitterRatio?: number;
  random?: () => number;
  /** Delay before the first run after start(). Default 0. */
  initialDelayMs?: number;
  /** Limits for runs forced on request (trigger with reason 'on-demand'). */
  onDemand?: {
    /** At most one forced run per source in this time. Default 10 min. */
    minIntervalMs?: number;
    /** At most this many forced runs per hour over all sources. Default 6. */
    maxPerHour?: number;
  };
}

export const ON_DEMAND_MIN_INTERVAL_MS = 10 * 60_000;
export const ON_DEMAND_MAX_PER_HOUR = 6;
const HOUR_MS = 3_600_000;

/**
 * 'on-demand': a forced run because an answer needs fresher data (MCP refresh_sources, the REST
 * endpoint with `reason=on-demand`); it is rate-limited. Other triggers (CLI sync, change
 * notifications, file events) run unconditionally.
 */
export type TriggerReason = 'manual' | 'on-demand';

export interface TriggerOptions {
  reason?: TriggerReason;
  /** On-demand: minimum time since this source's last forced or successful run. */
  minIntervalMs?: number;
}

export type OnDemandRefusal =
  'auth_required' | 'backoff' | 'recently_forced' | 'recently_synced' | 'hourly_cap';

export interface OnDemandVerdict {
  ok: boolean;
  reason?: OnDemandRefusal;
  /** When it may be asked again. */
  retryAfterMs?: number;
  detail?: string;
}

/** A forced run was refused (HTTP 429 over REST); `reason` says which limit. */
export class OnDemandRefusedError extends RateLimitedError {
  constructor(
    readonly reason: OnDemandRefusal,
    detail: string,
    retryAfterMs?: number,
  ) {
    super(`on-demand sync refused (${reason}): ${detail}`, {
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      details: { reason },
    });
  }
}

export interface ScheduledSource {
  sourceId: string;
  schedule: string;
  intervalMs: number | undefined;
  nextRunAt: Date | undefined;
}

/**
 * Per-connector intervals (§36). Never runs two syncs of one source at once, honours
 * Retry-After from rate limiting and backs off after consecutive failures.
 */
export class SyncScheduler {
  private readonly clock: Clock;
  private readonly timers = new Map<string, TimerHandle>();
  private readonly next = new Map<string, Date>();
  private readonly forced = new Map<string, number>();
  private forcedLog: number[] = [];
  private started = false;

  constructor(
    private readonly engine: SyncEngine,
    private readonly options: SchedulerOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
  }

  scheduleOf(sourceId: string): string {
    return (
      this.options.schedules?.[sourceId] ??
      this.engine.getSource(sourceId).metadata.defaultSchedule ??
      this.options.defaultInterval ??
      '15m'
    );
  }

  intervalOf(sourceId: string): number | undefined {
    const s = this.scheduleOf(sourceId);
    return NON_PERIODIC.has(s) ? undefined : parseDuration(s);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const s of this.engine.sources()) {
      if (this.intervalOf(s.sourceId) !== undefined)
        this.arm(s.sourceId, this.options.initialDelayMs ?? 0);
    }
  }

  stop(): void {
    this.started = false;
    for (const t of this.timers.values()) this.clock.clearTimeout(t);
    this.timers.clear();
    this.next.clear();
  }

  status(): ScheduledSource[] {
    return this.engine.sources().map((s) => ({
      sourceId: s.sourceId,
      schedule: this.scheduleOf(s.sourceId),
      intervalMs: this.intervalOf(s.sourceId),
      nextRunAt: this.next.get(s.sourceId),
    }));
  }

  /**
   * Whether a forced run may start now: not when the source needs a login or is backing off, not
   * within `minIntervalMs` of its last forced or successful run, and not beyond the hourly cap
   * over all sources. Health is read from the store, so a daemon's runs count for an MCP process
   * next to it; the forced-run counters are this scheduler's own.
   */
  checkOnDemand(sourceId: string, options: { minIntervalMs?: number } = {}): OnDemandVerdict {
    const now = this.clock.now().getTime();
    const minInterval =
      options.minIntervalMs ?? this.options.onDemand?.minIntervalMs ?? ON_DEMAND_MIN_INTERVAL_MS;
    const min = Math.round(minInterval / 60_000);
    const health = this.engine.health(sourceId);
    if (health?.state === 'auth_required')
      return {
        ok: false,
        reason: 'auth_required',
        detail: 'ログインが必要なため更新できません（本人がログインし直す必要があります）',
      };
    const retryAt = health?.retryAfter ? Date.parse(health.retryAfter) : undefined;
    if ((retryAt !== undefined && retryAt > now) || (health?.consecutiveFailures ?? 0) >= 2)
      return {
        ok: false,
        reason: 'backoff',
        ...(retryAt !== undefined && retryAt > now ? { retryAfterMs: retryAt - now } : {}),
        detail: '失敗が続いて待機中のため更新できません',
      };
    const last = this.forced.get(sourceId);
    if (last !== undefined && now - last < minInterval)
      return {
        ok: false,
        reason: 'recently_forced',
        retryAfterMs: minInterval - (now - last),
        detail: `強制更新は1つの情報源につき${min}分に1回までです`,
      };
    const ok = health?.lastSuccessAt ? Date.parse(health.lastSuccessAt) : undefined;
    if (ok !== undefined && now - ok < minInterval)
      return {
        ok: false,
        reason: 'recently_synced',
        retryAfterMs: minInterval - (now - ok),
        detail: `${Math.max(0, Math.round((now - ok) / 60_000))}分前に取得済みです`,
      };
    const cap = this.options.onDemand?.maxPerHour ?? ON_DEMAND_MAX_PER_HOUR;
    const recent = this.forcedLog.filter((t) => now - t < HOUR_MS);
    const oldest = recent[0];
    if (recent.length >= cap && oldest !== undefined)
      return {
        ok: false,
        reason: 'hourly_cap',
        retryAfterMs: HOUR_MS - (now - oldest),
        detail: `強制更新は全体で1時間に${cap}回までです`,
      };
    return { ok: true };
  }

  /** Throws an OnDemandRefusedError unless checkOnDemand allows a forced run now. */
  assertOnDemand(sourceId: string, options: { minIntervalMs?: number } = {}): void {
    const verdict = this.checkOnDemand(sourceId, options);
    if (!verdict.ok && verdict.reason)
      throw new OnDemandRefusedError(
        verdict.reason,
        verdict.detail ?? verdict.reason,
        verdict.retryAfterMs,
      );
  }

  /**
   * Run now (e.g. Graph change notification, file event, CLI `sync`). Re-arms the periodic timer.
   * With `reason: 'on-demand'` the run is rate-limited (checkOnDemand) and refused with an
   * OnDemandRefusedError instead of started.
   */
  async trigger(sourceId: string, options: TriggerOptions = {}): Promise<SyncRunReport> {
    if (options.reason === 'on-demand') {
      this.assertOnDemand(
        sourceId,
        options.minIntervalMs !== undefined ? { minIntervalMs: options.minIntervalMs } : {},
      );
      const now = this.clock.now().getTime();
      this.forced.set(sourceId, now);
      this.forcedLog = [...this.forcedLog.filter((t) => now - t < HOUR_MS), now];
    }
    const t = this.timers.get(sourceId);
    if (t) this.clock.clearTimeout(t);
    this.timers.delete(sourceId);
    const report = await this.engine.sync(sourceId);
    if (this.started) this.afterRun(sourceId);
    return report;
  }

  private arm(sourceId: string, delayMs: number): void {
    const prev = this.timers.get(sourceId);
    if (prev) this.clock.clearTimeout(prev);
    this.next.set(sourceId, new Date(this.clock.now().getTime() + delayMs));
    this.timers.set(
      sourceId,
      this.clock.setTimeout(() => {
        this.timers.delete(sourceId);
        // A rejected timer run (source unregistered meanwhile, DB closed during shutdown) must not
        // become an unhandled rejection that takes the daemon down.
        void this.engine
          .sync(sourceId)
          .catch(() => undefined)
          .finally(() => {
            if (this.started) this.afterRun(sourceId);
          });
      }, delayMs),
    );
  }

  private afterRun(sourceId: string): void {
    if (!this.engine.sources().some((s) => s.sourceId === sourceId)) {
      this.next.delete(sourceId);
      return;
    }
    const interval = this.intervalOf(sourceId);
    if (interval === undefined) return;
    const health = this.engine.health(sourceId);
    let delay = interval;
    const failures = health?.consecutiveFailures ?? 0;
    if (failures > 0)
      delay = Math.min(interval * 2 ** Math.min(failures, 3), Math.max(interval, 6 * 3_600_000));
    if (health?.retryAfter)
      delay = Math.max(delay, new Date(health.retryAfter).getTime() - this.clock.now().getTime());
    if (health?.state === 'auth_required') delay = Math.max(delay, 6 * 3_600_000);
    const jitter =
      (this.options.jitterRatio ?? 0.1) * interval * (this.options.random ?? Math.random)();
    this.arm(sourceId, Math.round(delay + jitter));
  }
}
