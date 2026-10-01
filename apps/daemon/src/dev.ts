import {
  applySeedDay2,
  createFakeConnector,
  createShizuokaSeed,
  type FakeSourceAdapter,
  type InstantiatedConnector,
  SEED_DAY1_SYNC_AT,
  SEED_DAY2_SYNC_AT,
} from '@unicontext/connector-sdk';
import { type Clock, systemClock, type TimerHandle } from '@unicontext/core';

/** "Now" in dev mode: 2026-10-01 09:30 JST, then flowing with real time. */
export const DEV_NOW = '2026-10-01T00:30:00.000Z';

/** A clock whose current time is shifted by an offset; timers are real. */
export class OffsetClock implements Clock {
  private offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
  /** Make now() return `instant` (and keep ticking from there). */
  set(instant: string | Date): void {
    this.offsetMs = new Date(instant).getTime() - Date.now();
  }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    return systemClock.setTimeout(fn, ms);
  }
  clearTimeout(handle: TimerHandle): void {
    systemClock.clearTimeout(handle);
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return systemClock.sleep(ms, signal);
  }
}

export interface DevSeedTarget {
  register(
    c: Pick<InstantiatedConnector<unknown>, 'sourceId' | 'adapter' | 'normalizer' | 'metadata'>,
  ): void;
  sync(sourceId: string): Promise<{ ok: boolean; error: string | undefined }>;
  sourceIds(): string[];
}

async function expectOk(target: DevSeedTarget, id: string): Promise<void> {
  const r = await target.sync(id);
  if (!r.ok) throw new Error(`dev seed sync failed for ${id}: ${r.error ?? 'unknown'}`);
}

/** Register the synthetic seed sources (fake connectors) and run the two seed days. */
export async function seedDevData(target: DevSeedTarget, clock: OffsetClock): Promise<string[]> {
  const adapters: Record<string, FakeSourceAdapter> = {};
  clock.set(SEED_DAY1_SYNC_AT);
  const ids: string[] = [];
  for (const s of createShizuokaSeed()) {
    const fake = createFakeConnector(s.options);
    adapters[s.sourceId] = fake.adapter;
    ids.push(s.sourceId);
    target.register({
      sourceId: s.sourceId,
      adapter: fake.adapter,
      normalizer: fake.normalizer,
      metadata: fake.metadata,
    });
  }
  for (const id of ids) await expectOk(target, id);
  applySeedDay2(adapters);
  clock.set(SEED_DAY2_SYNC_AT);
  for (const id of ids) await expectOk(target, id);
  clock.set(DEV_NOW);
  return ids;
}
