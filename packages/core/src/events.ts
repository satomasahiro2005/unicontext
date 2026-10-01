export type Listener<T> = (payload: T) => void | Promise<void>;

/**
 * Minimal typed pub/sub. Listener errors are isolated and reported via onError so one
 * subscriber (e.g. notifications) can never break the sync pipeline.
 */
export class EventBus<Events extends object> {
  private listeners = new Map<keyof Events, Set<Listener<never>>>();

  constructor(private readonly onError: (error: unknown, event: keyof Events) => void = () => {}) {}

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const off = this.on(event, (p) => {
      off();
      return listener(p);
    });
    return off;
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<never>);
  }

  /** Calls listeners in subscription order and awaits async ones. Never throws. */
  async emit<K extends keyof Events>(event: K, payload: Events[K]): Promise<void> {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const l of [...set]) {
      try {
        await (l as Listener<Events[K]>)(payload);
      } catch (e) {
        this.onError(e, event);
      }
    }
  }

  listenerCount(event: keyof Events): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
