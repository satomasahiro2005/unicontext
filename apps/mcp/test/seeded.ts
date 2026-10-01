import {
  applySeedDay2,
  createFakeConnector,
  createShizuokaSeed,
  type FakeSourceAdapter,
  SEED_DAY1_SYNC_AT,
  SEED_DAY2_SYNC_AT,
} from '../../../packages/connector-sdk/src/index.js';
import { createUniContext, type UniContext } from '@unicontext/context-engine';
import { ManualClock } from '@unicontext/core';
import { expect } from 'vitest';

export interface Seeded {
  uc: UniContext;
  clock: ManualClock;
}

/** In-memory UniContext populated from the synthetic seed; "now" is 2026-10-01 09:30 JST. */
export async function createSeeded(): Promise<Seeded> {
  const clock = new ManualClock(SEED_DAY1_SYNC_AT);
  const uc = createUniContext({ profile: 'shizuoka-university', clock });
  const adapters: Record<string, FakeSourceAdapter> = {};
  for (const s of createShizuokaSeed()) {
    const fake = createFakeConnector(s.options);
    adapters[s.sourceId] = fake.adapter;
    uc.sync.register({
      sourceId: s.sourceId,
      adapter: fake.adapter,
      normalizer: fake.normalizer,
      metadata: fake.metadata,
    });
  }
  for (const s of uc.sync.sources()) expect((await uc.sync.sync(s.sourceId)).ok).toBe(true);
  applySeedDay2(adapters);
  clock.set(SEED_DAY2_SYNC_AT);
  for (const s of uc.sync.sources()) expect((await uc.sync.sync(s.sourceId)).ok).toBe(true);
  clock.set('2026-10-01T00:30:00.000Z');
  return { uc, clock };
}
