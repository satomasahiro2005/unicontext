export interface TimerHandle {
  readonly id: number;
}

/** Time source + timers. Inject ManualClock in tests to make schedules deterministic. */
export interface Clock {
  now(): Date;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

let nextId = 1;
const systemHandles = new Map<number, ReturnType<typeof globalThis.setTimeout>>();

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('aborted');
}

export const systemClock: Clock = {
  now: () => new Date(),
  setTimeout(fn, ms) {
    const handle = { id: nextId++ };
    const t = globalThis.setTimeout(() => {
      systemHandles.delete(handle.id);
      fn();
    }, ms);
    systemHandles.set(handle.id, t);
    return handle;
  },
  clearTimeout(handle) {
    const t = systemHandles.get(handle.id);
    if (t !== undefined) globalThis.clearTimeout(t);
    systemHandles.delete(handle.id);
  },
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const onAbort = (): void => {
        globalThis.clearTimeout(t);
        if (signal) reject(abortReason(signal));
      };
      const t = globalThis.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  },
};

interface PendingTimer {
  id: number;
  at: number;
  fn: () => void;
}

/** Deterministic clock for tests. Timers fire only when advance() is called. */
export class ManualClock implements Clock {
  private current: number;
  private timers: PendingTimer[] = [];

  constructor(start: Date | string = '2026-10-01T00:00:00.000Z') {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(date: Date | string): void {
    this.current = new Date(date).getTime();
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = nextId++;
    this.timers.push({ id, at: this.current + Math.max(0, ms), fn });
    return { id };
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers = this.timers.filter((t) => t.id !== handle.id);
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const h = this.setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          this.clearTimeout(h);
          reject(abortReason(signal));
        },
        { once: true },
      );
    });
  }

  /** Number of timers waiting to fire. */
  get pending(): number {
    return this.timers.length;
  }

  /** Move time forward, firing due timers in order and flushing microtasks between them. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      await flushMicrotasks();
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.current = Math.max(this.current, next.at);
      next.fn();
    }
    this.current = target;
    await flushMicrotasks();
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
