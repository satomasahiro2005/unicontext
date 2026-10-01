import { stableId, makeId, type ChangeEvent, type EntityKind } from '@unicontext/canonical-model';
import { ManualClock } from '@unicontext/core';
import {
  applySeedDay2,
  createFakeConnector,
  createShizuokaSeed,
  type FakeSourceAdapter,
  SEED_DAY1_SYNC_AT,
  SEED_DAY2_SYNC_AT,
} from '@unicontext/connector-sdk';
import { createUniContext, type UniContext } from '@unicontext/context-engine';
import type { Notification, NotificationSink } from '../src/index.js';

export interface SeedHarness {
  uc: UniContext;
  clock: ManualClock;
  adapters: Record<string, FakeSourceAdapter>;
  syncAll(): Promise<void>;
  day2(): Promise<void>;
}

/** In-memory UniContext with the Shizuoka seed registered; nothing synced yet. */
export function createSeedHarness(): SeedHarness {
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
  const syncAll = async (): Promise<void> => {
    for (const s of uc.sync.sources()) await uc.sync.sync(s.sourceId);
  };
  return {
    uc,
    clock,
    adapters,
    syncAll,
    async day2() {
      applySeedDay2(adapters);
      clock.set(SEED_DAY2_SYNC_AT);
      await syncAll();
    },
  };
}

export interface MemorySink extends NotificationSink {
  sent: Notification[];
}

export function memorySink(id = 'memory'): MemorySink {
  const sent: Notification[] = [];
  return {
    id,
    sent,
    send(n) {
      sent.push(n);
    },
  };
}

export const lcuDb = stableId('courseOffering', 'lcu', 'J2401-2026-2');

export function makeEvent(
  kind: EntityKind,
  key: string,
  partial: Partial<ChangeEvent> & Pick<ChangeEvent, 'type'>,
  at = '2026-10-01T00:30:00.000Z',
): ChangeEvent {
  return {
    id: makeId('changeEvent'),
    entityId: stableId(kind, 'test', key) as ChangeEvent['entityId'],
    entityKind: kind,
    changedFields: [],
    before: null,
    after: null,
    source: { sourceId: 'lms' },
    occurredAt: at,
    observedAt: at,
    ...partial,
  };
}
