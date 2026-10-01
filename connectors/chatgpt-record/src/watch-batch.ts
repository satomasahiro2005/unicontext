import type { Clock, TimerHandle } from '@unicontext/core';

/**
 * Debounced batch: every add() restarts the timer; when it fires the collected entries (last value
 * per key wins) are handed to `onFlush`. Uses the injected Clock so tests can drive it.
 */
export class DebouncedBatch<V> {
  private pending = new Map<string, V>();
  private timer: TimerHandle | undefined;
  private closed = false;

  constructor(
    private readonly clock: Clock,
    private readonly delayMs: number,
    private readonly onFlush: (batch: Map<string, V>) => void,
  ) {}

  add(key: string, value: V): void {
    if (this.closed) return;
    this.pending.set(key, value);
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => this.flush(), this.delayMs);
  }

  flush(): void {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.size === 0) return;
    const batch = this.pending;
    this.pending = new Map();
    this.onFlush(batch);
  }

  close(): void {
    this.closed = true;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }
}
