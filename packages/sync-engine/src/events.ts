import type { ChangeEvent, Conflict, HealthState } from '@unicontext/canonical-model';
import { EventBus } from '@unicontext/core';
import type { DriftRecord, HealthRecord } from '@unicontext/database';
import type { SyncMode } from '@unicontext/connector-sdk';

/**
 * Where a change event came from. Only 'sync' (an incremental or full refresh of a source that
 * had synced before) and 'ingest' (a watcher or manual import) are genuine new observations; the
 * rest repopulate state and must never raise notifications:
 * - initial: the first sync of a source
 * - reprocess: raw items normalized again (reprocess(), or a new normalizer version)
 */
export type ChangeOrigin = 'initial' | 'sync' | 'ingest' | 'reprocess';

/** A change event as published on the bus; the sync engine sets `origin`. */
export type BusChangeEvent = ChangeEvent & { origin?: ChangeOrigin };

/** The engine finished publishing the change events of one normalization pass of a source. */
export interface ChangesSettledEvent {
  sourceId: string;
  origin: ChangeOrigin;
  count: number;
}

export interface SyncStartedEvent {
  sourceId: string;
  mode: SyncMode;
  at: string;
}

export interface SyncRunReport {
  sourceId: string;
  mode: SyncMode;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  error: string | undefined;
  pages: number;
  raw: { inserted: number; updated: number; unchanged: number; restored: number; deleted: number };
  normalized: NormalizeReport;
  health: HealthState;
}

export interface NormalizeReport {
  items: number;
  failed: number;
  entities: {
    created: number;
    updated: number;
    unchanged: number;
    deleted: number;
    restored: number;
  };
  facts: { asserted: number; retracted: number };
  changeEvents: number;
  /** Entity ids created/updated/deleted in this pass (input for post-processors). */
  changedEntityIds: string[];
}

export interface SyncFailedEvent {
  sourceId: string;
  error: string;
  health: HealthState;
}

export interface HealthChangedEvent {
  sourceId: string;
  previous: HealthState | undefined;
  current: HealthRecord;
}

export interface ConflictEvent {
  type: 'opened' | 'resolved';
  conflict: Conflict;
}

export interface DriftEvent {
  sourceId: string;
  findings: DriftRecord[];
}

/**
 * Everything the notifications lane (§46) can subscribe to. Payloads are plain data.
 * - change: every ChangeEvent appended to the event log (§13), tagged with its origin
 * - changes:settled: the change events of one normalization pass have all been published
 * - conflict: a conflict opened/resolved (§12)
 * - health: connector health state changed, incl. auth expiry (§38)
 * - sync:*: run lifecycle; sync:failed carries the classified health state
 * - drift: first sighting of schema drift (§73)
 */
export interface SyncEngineEvents {
  change: BusChangeEvent;
  'changes:settled': ChangesSettledEvent;
  conflict: ConflictEvent;
  health: HealthChangedEvent;
  'sync:started': SyncStartedEvent;
  'sync:completed': SyncRunReport;
  'sync:failed': SyncFailedEvent;
  drift: DriftEvent;
}

export type SyncEventBus = EventBus<SyncEngineEvents>;

export function createSyncEventBus(
  onError?: (error: unknown, event: keyof SyncEngineEvents) => void,
): SyncEventBus {
  return new EventBus<SyncEngineEvents>(onError);
}
