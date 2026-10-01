import { AuthRequiredError, ManualClock, OfflineError, RateLimitedError } from '@unicontext/core';
import { describe, expect, it } from 'vitest';
import { parseRetryAfter, RateLimiter } from '../src/index.js';

describe('RateLimiter', () => {
  it('allows a burst up to capacity, then refills over time (token bucket)', async () => {
    const clock = new ManualClock();
    const rl = new RateLimiter({ capacity: 2, refillPerSecond: 1, clock });
    let done = 0;
    for (let i = 0; i < 3; i++) void rl.acquire().then(() => done++);
    await clock.advance(0);
    expect(done).toBe(2);
    await clock.advance(999);
    expect(done).toBe(2);
    await clock.advance(1);
    expect(done).toBe(3);
  });

  it('honours Retry-After by pausing the whole bucket', async () => {
    const clock = new ManualClock();
    const rl = new RateLimiter({ capacity: 10, refillPerSecond: 10, clock });
    let calls = 0;
    const p = rl.schedule(async () => {
      calls++;
      if (calls === 1) throw new RateLimitedError('slow down', { retryAfterMs: 5000 });
      return 'ok';
    });
    await clock.advance(0);
    expect(calls).toBe(1);
    expect(rl.pausedUntilTime?.toISOString()).toBe('2026-10-01T00:00:05.000Z');
    await clock.advance(4999);
    expect(calls).toBe(1);
    await clock.advance(1);
    await expect(p).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('retries offline errors with exponential backoff and jitter, then gives up', async () => {
    const clock = new ManualClock();
    const rl = new RateLimiter({
      capacity: 100,
      refillPerSecond: 100,
      maxRetries: 3,
      baseDelayMs: 100,
      clock,
      random: () => 0.5,
    });
    expect([1, 2, 3, 4].map((n) => rl.backoffDelay(n))).toEqual([50, 100, 200, 400]);
    let calls = 0;
    const p = rl.schedule(async () => {
      calls++;
      throw new OfflineError();
    });
    const assertion = expect(p).rejects.toBeInstanceOf(OfflineError);
    await clock.advance(10_000);
    await assertion;
    expect(calls).toBe(4);
  });

  it('caps backoff at maxDelayMs and never retries auth errors', async () => {
    const rl = new RateLimiter({ baseDelayMs: 1000, maxDelayMs: 4000, jitter: 'none' });
    expect(rl.backoffDelay(10)).toBe(4000);
    let calls = 0;
    await expect(
      rl.schedule(async () => {
        calls++;
        throw new AuthRequiredError();
      }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    expect(calls).toBe(1);
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter('Thu, 01 Oct 2026 00:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('garbage', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});
