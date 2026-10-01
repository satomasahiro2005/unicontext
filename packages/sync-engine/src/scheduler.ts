import { type Clock, parseDuration, systemClock, type TimerHandle } from '@unicontext/core';
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

  /** Run now (e.g. Graph change notification, file event, CLI `sync`). Re-arms the periodic timer. */
  async trigger(sourceId: string): Promise<SyncRunReport> {
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
        void this.engine.sync(sourceId).finally(() => {
          if (this.started) this.afterRun(sourceId);
        });
      }, delayMs),
    );
  }

  private afterRun(sourceId: string): void {
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
