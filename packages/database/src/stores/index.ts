import { type Clock, systemClock } from '@unicontext/core';
import type { UniContextDatabase } from '../db.js';
import { ChangeEventStore } from './change-event-store.js';
import { EntityStore } from './entity-store.js';
import { RawStore } from './raw-store.js';
import { SourceReferenceStore } from './source-ref-store.js';
import {
  HealthStore,
  ProductVersionStore,
  SchemaDriftStore,
  SyncStateStore,
} from './source-state-stores.js';

export interface Stores {
  raw: RawStore;
  entities: EntityStore;
  sourceRefs: SourceReferenceStore;
  changes: ChangeEventStore;
  syncState: SyncStateStore;
  health: HealthStore;
  drift: SchemaDriftStore;
  versions: ProductVersionStore;
}

export function createStores(db: UniContextDatabase, clock: Clock = systemClock): Stores {
  return {
    raw: new RawStore(db, { clock }),
    entities: new EntityStore(db, { clock }),
    sourceRefs: new SourceReferenceStore(db),
    changes: new ChangeEventStore(db),
    syncState: new SyncStateStore(db, clock),
    health: new HealthStore(db),
    drift: new SchemaDriftStore(db, clock),
    versions: new ProductVersionStore(db, clock),
  };
}
