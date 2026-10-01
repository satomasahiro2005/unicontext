import type { ChangeEvent, Conflict, HealthState } from '@unicontext/canonical-model';
import { EventBus } from '@unicontext/core';
import type { DriftRecord, HealthRecord } from '@unicontext/database';
import type { SyncMode } from '@unicontext/connector-sdk';

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
 * - change: every ChangeEvent appended to the event log (§13)
 * - conflict: a conflict opened/resolved (§12)
 * - health: connector health state changed, incl. auth expiry (§38)
 * - sync:*: run lifecycle; sync:failed carries the classified health state
 * - drift: first sighting of schema drift (§73)
 */
export interface SyncEngineEvents {
  change: ChangeEvent;
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
