/**
 * Fixed-window counters per key (client IP). In memory only: the persistent defence against
 * passphrase guessing is the owner lockout in RemoteStateStore, this just slows bursts down.
 */
export class WindowRateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one hit; false when the key is over its limit in the current window. */
  hit(key: string): boolean {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      w = { start: t, count: 0 };
      this.windows.set(key, w);
      if (this.windows.size > 10_000) this.sweep(t);
    }
    w.count++;
    return w.count <= this.limit;
  }

  /** Milliseconds until the key's window resets. */
  retryAfterMs(key: string): number {
    const w = this.windows.get(key);
    return w ? Math.max(0, w.start + this.windowMs - this.now()) : 0;
  }

  private sweep(t: number): void {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}
