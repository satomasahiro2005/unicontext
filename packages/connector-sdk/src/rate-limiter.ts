import {
  AuthRequiredError,
  type Clock,
  OfflineError,
  RateLimitedError,
  systemClock,
} from '@unicontext/core';

export interface RateLimiterOptions {
  /** Bucket size (max burst). Default 5. */
  capacity?: number;
  /** Tokens added per second. Default 1. */
  refillPerSecond?: number;
  /** Retries after the first attempt. Default 4. */
  maxRetries?: number;
  /** First backoff step. Default 500 ms. */
  baseDelayMs?: number;
  /** Backoff ceiling. Default 60 s. */
  maxDelayMs?: number;
  /** "full" jitter (AWS style) or none. Default full. */
  jitter?: 'full' | 'none';
  clock?: Clock;
  random?: () => number;
}

export interface ScheduleOptions {
  /** Tokens this call costs. Default 1. */
  cost?: number;
  signal?: AbortSignal;
  /** Extra predicate for retryable errors (rate limit / offline are always retried). */
  retryOn?: (error: unknown) => boolean;
}

/**
 * Shared politeness layer for connectors (§37): token bucket, Retry-After handling,
 * exponential backoff with jitter. One instance per source.
 */
export class RateLimiter {
  readonly capacity: number;
  readonly refillPerSecond: number;
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  private readonly jitter: 'full' | 'none';
  private readonly clock: Clock;
  private readonly random: () => number;
  private tokens: number;
  private lastRefill: number;
  private pausedUntil = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions = {}) {
    this.capacity = options.capacity ?? 5;
    this.refillPerSecond = options.refillPerSecond ?? 1;
    this.maxRetries = options.maxRetries ?? 4;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 60_000;
    this.jitter = options.jitter ?? 'full';
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? Math.random;
    this.tokens = this.capacity;
    this.lastRefill = this.clock.now().getTime();
  }

  private refill(): void {
    const now = this.clock.now().getTime();
    const elapsed = Math.max(0, now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.lastRefill = now;
  }

  /** Tokens currently available (after refill). */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /** Block all requests until the given time (from Retry-After). */
  pauseUntil(until: Date | number): void {
    const t = typeof until === 'number' ? until : until.getTime();
    this.pausedUntil = Math.max(this.pausedUntil, t);
  }

  get pausedUntilTime(): Date | undefined {
    return this.pausedUntil > this.clock.now().getTime() ? new Date(this.pausedUntil) : undefined;
  }

  /** Wait until `cost` tokens are available and take them. Calls are served FIFO. */
  acquire(cost = 1, signal?: AbortSignal): Promise<void> {
    if (cost > this.capacity)
      throw new RangeError(`cost ${cost} exceeds capacity ${this.capacity}`);
    const run = async (): Promise<void> => {
      for (;;) {
        signal?.throwIfAborted();
        const now = this.clock.now().getTime();
        if (this.pausedUntil > now) {
          await this.clock.sleep(this.pausedUntil - now, signal);
          continue;
        }
        this.refill();
        if (this.tokens >= cost) {
          this.tokens -= cost;
          return;
        }
        const waitMs = Math.ceil(((cost - this.tokens) / this.refillPerSecond) * 1000);
        await this.clock.sleep(Math.max(1, waitMs), signal);
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Backoff for retry attempt n (1-based): min(max, base * 2^(n-1)), with full jitter. */
  backoffDelay(attempt: number): number {
    const exp = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.max(0, attempt - 1));
    return this.jitter === 'full' ? Math.floor(this.random() * exp) : exp;
  }

  /**
   * Run fn under the limiter with retries. RateLimitedError honours retryAfterMs (pausing the whole
   * bucket); OfflineError and retryOn() errors back off exponentially. AuthRequiredError is never retried.
   */
  async schedule<T>(fn: () => Promise<T>, options: ScheduleOptions = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.acquire(options.cost ?? 1, options.signal);
      try {
        return await fn();
      } catch (e) {
        if (e instanceof AuthRequiredError || attempt >= this.maxRetries) throw e;
        if (e instanceof RateLimitedError) {
          const wait = e.retryAfterMs ?? this.backoffDelay(attempt + 1);
          this.pauseUntil(this.clock.now().getTime() + wait);
          continue;
        }
        const retryable = e instanceof OfflineError || (options.retryOn?.(e) ?? false);
        if (!retryable) throw e;
        await this.clock.sleep(this.backoffDelay(attempt + 1), options.signal);
      }
    }
  }
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(
  value: string | null | undefined,
  now: Date = new Date(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const t = Date.parse(trimmed);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, t - now.getTime());
}
