import {
  type HealthState,
  type HealthStatus,
  HealthStatusSchema,
} from '@unicontext/canonical-model';
import { type Clock, stableUuid, systemClock } from '@unicontext/core';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { UniContextDatabase } from '../db.js';
import { connectorHealth, productVersions, schemaDrift, syncState } from '../schema/raw.js';

/** Incremental sync state (§35). */
export interface SyncCursorState {
  cursor?: string;
  etag?: string;
  deltaToken?: string;
  lastModified?: string;
  /** Connector-specific extras (JSON). */
  extra?: Record<string, unknown>;
}

export interface StoredSyncState extends SyncCursorState {
  sourceId: string;
  scope: string;
  lastMode: string | undefined;
  lastFullSyncAt: string | undefined;
  updatedAt: string;
}

export class SyncStateStore {
  constructor(
    private readonly db: UniContextDatabase,
    private readonly clock: Clock = systemClock,
  ) {}

  get(sourceId: string, scope = ''): StoredSyncState | undefined {
    const r = this.db.orm
      .select()
      .from(syncState)
      .where(and(eq(syncState.sourceId, sourceId), eq(syncState.scope, scope)))
      .get();
    if (!r) return undefined;
    return {
      sourceId: r.sourceId,
      scope: r.scope,
      ...(r.cursor ? { cursor: r.cursor } : {}),
      ...(r.etag ? { etag: r.etag } : {}),
      ...(r.deltaToken ? { deltaToken: r.deltaToken } : {}),
      ...(r.lastModified ? { lastModified: r.lastModified } : {}),
      ...(r.extraJson ? { extra: JSON.parse(r.extraJson) as Record<string, unknown> } : {}),
      lastMode: r.lastMode ?? undefined,
      lastFullSyncAt: r.lastFullSyncAt ?? undefined,
      updatedAt: r.updatedAt,
    };
  }

  set(
    sourceId: string,
    state: SyncCursorState,
    options: { scope?: string; mode?: string; fullSync?: boolean } = {},
  ): StoredSyncState {
    const now = this.clock.now().toISOString();
    const scope = options.scope ?? '';
    const prev = this.get(sourceId, scope);
    const row = {
      sourceId,
      scope,
      cursor: state.cursor ?? null,
      etag: state.etag ?? null,
      deltaToken: state.deltaToken ?? null,
      lastModified: state.lastModified ?? null,
      extraJson: state.extra ? JSON.stringify(state.extra) : null,
      lastMode: options.mode ?? prev?.lastMode ?? null,
      lastFullSyncAt: options.fullSync ? now : (prev?.lastFullSyncAt ?? null),
      updatedAt: now,
    };
    this.db.orm
      .insert(syncState)
      .values(row)
      .onConflictDoUpdate({ target: [syncState.sourceId, syncState.scope], set: row })
      .run();
    const out = this.get(sourceId, scope);
    if (!out) throw new Error('sync state write failed');
    return out;
  }

  clear(sourceId: string): number {
    return this.db.orm.delete(syncState).where(eq(syncState.sourceId, sourceId)).run().changes;
  }
}

export interface HealthRecord extends HealthStatus {
  sourceId: string;
  lastFailureAt: string | undefined;
}

export class HealthStore {
  constructor(private readonly db: UniContextDatabase) {}

  get(sourceId: string): HealthRecord | undefined {
    const r = this.db.orm
      .select()
      .from(connectorHealth)
      .where(eq(connectorHealth.sourceId, sourceId))
      .get();
    if (!r) return undefined;
    const status = HealthStatusSchema.parse({
      state: r.state,
      checkedAt: r.checkedAt,
      ...(r.message ? { message: r.message } : {}),
      ...(r.detectedVersion ? { detectedVersion: r.detectedVersion } : {}),
      ...(r.retryAfter ? { retryAfter: r.retryAfter } : {}),
      ...(r.lastSuccessAt ? { lastSuccessAt: r.lastSuccessAt } : {}),
      consecutiveFailures: r.consecutiveFailures,
    });
    return { ...status, sourceId, lastFailureAt: r.lastFailureAt ?? undefined };
  }

  list(): HealthRecord[] {
    return this.db.orm
      .select({ id: connectorHealth.sourceId })
      .from(connectorHealth)
      .orderBy(asc(connectorHealth.sourceId))
      .all()
      .map((r) => this.get(r.id))
      .filter((h): h is HealthRecord => h !== undefined);
  }

  set(
    sourceId: string,
    h: {
      state: HealthState;
      checkedAt: string;
      message?: string;
      detectedVersion?: string;
      retryAfter?: string;
      lastSuccessAt?: string;
      lastFailureAt?: string;
      consecutiveFailures?: number;
    },
  ): HealthRecord {
    const prev = this.get(sourceId);
    const row = {
      sourceId,
      state: h.state,
      message: h.message ?? null,
      checkedAt: h.checkedAt,
      lastSuccessAt: h.lastSuccessAt ?? prev?.lastSuccessAt ?? null,
      lastFailureAt: h.lastFailureAt ?? prev?.lastFailureAt ?? null,
      consecutiveFailures: h.consecutiveFailures ?? 0,
      retryAfter: h.retryAfter ?? null,
      detectedVersion: h.detectedVersion ?? prev?.detectedVersion ?? null,
    };
    this.db.orm
      .insert(connectorHealth)
      .values(row)
      .onConflictDoUpdate({ target: connectorHealth.sourceId, set: row })
      .run();
    const out = this.get(sourceId);
    if (!out) throw new Error('health write failed');
    return out;
  }

  delete(sourceId: string): number {
    return this.db.orm.delete(connectorHealth).where(eq(connectorHealth.sourceId, sourceId)).run()
      .changes;
  }
}

export type DriftKind = 'unknown' | 'missing' | 'type_mismatch';

export interface DriftRecord {
  id: string;
  sourceId: string;
  sourceType: string;
  fieldPath: string;
  driftKind: DriftKind;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  sampleRawItemId: string | undefined;
  resolvedAt: string | undefined;
}

/** Schema drift log (§73). */
export class SchemaDriftStore {
  constructor(
    private readonly db: UniContextDatabase,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Record drift findings; returns the entries that are new (first sighting). */
  record(
    sourceId: string,
    sourceType: string,
    findings: { path: string; kind: DriftKind }[],
    rawItemId?: string,
  ): DriftRecord[] {
    const now = this.clock.now().toISOString();
    const fresh: DriftRecord[] = [];
    for (const f of findings) {
      const id = `drift:${stableUuid(sourceId, sourceType, f.path, f.kind)}`;
      const existing = this.db.orm.select().from(schemaDrift).where(eq(schemaDrift.id, id)).get();
      if (existing) {
        this.db.orm
          .update(schemaDrift)
          .set({ lastSeenAt: now, occurrences: existing.occurrences + 1, resolvedAt: null })
          .where(eq(schemaDrift.id, id))
          .run();
      } else {
        this.db.orm
          .insert(schemaDrift)
          .values({
            id,
            sourceId,
            sourceType,
            fieldPath: f.path,
            driftKind: f.kind,
            firstSeenAt: now,
            lastSeenAt: now,
            occurrences: 1,
            sampleRawItemId: rawItemId ?? null,
          })
          .run();
        const rec = this.list({ sourceId }).find((d) => d.id === id);
        if (rec) fresh.push(rec);
      }
    }
    return fresh;
  }

  list(options: { sourceId?: string; unresolvedOnly?: boolean } = {}): DriftRecord[] {
    const conds = [];
    if (options.sourceId) conds.push(eq(schemaDrift.sourceId, options.sourceId));
    if (options.unresolvedOnly) conds.push(isNull(schemaDrift.resolvedAt));
    return this.db.orm
      .select()
      .from(schemaDrift)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(schemaDrift.sourceId), asc(schemaDrift.fieldPath))
      .all()
      .map((r) => ({
        id: r.id,
        sourceId: r.sourceId,
        sourceType: r.sourceType,
        fieldPath: r.fieldPath,
        driftKind: r.driftKind as DriftKind,
        firstSeenAt: r.firstSeenAt,
        lastSeenAt: r.lastSeenAt,
        occurrences: r.occurrences,
        sampleRawItemId: r.sampleRawItemId ?? undefined,
        resolvedAt: r.resolvedAt ?? undefined,
      }));
  }

  resolve(id: string): void {
    this.db.orm
      .update(schemaDrift)
      .set({ resolvedAt: this.clock.now().toISOString() })
      .where(eq(schemaDrift.id, id))
      .run();
  }

  deleteBySource(sourceId: string): number {
    return this.db.orm.delete(schemaDrift).where(eq(schemaDrift.sourceId, sourceId)).run().changes;
  }
}

export interface ProductVersionRecord {
  sourceId: string;
  product: string;
  version: string;
  known: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Detected product versions (§72). */
export class ProductVersionStore {
  constructor(
    private readonly db: UniContextDatabase,
    private readonly clock: Clock = systemClock,
  ) {}

  record(sourceId: string, product: string, version: string, known: boolean): ProductVersionRecord {
    const now = this.clock.now().toISOString();
    this.db.orm
      .insert(productVersions)
      .values({ sourceId, product, version, known, firstSeenAt: now, lastSeenAt: now })
      .onConflictDoUpdate({
        target: [productVersions.sourceId, productVersions.product, productVersions.version],
        set: { lastSeenAt: now, known },
      })
      .run();
    const latest = this.latest(sourceId);
    if (!latest) throw new Error('product version write failed');
    return latest;
  }

  latest(sourceId: string): ProductVersionRecord | undefined {
    const rows = this.list(sourceId);
    return rows.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
  }

  list(sourceId: string): ProductVersionRecord[] {
    return this.db.orm
      .select()
      .from(productVersions)
      .where(eq(productVersions.sourceId, sourceId))
      .all();
  }

  deleteBySource(sourceId: string): number {
    return this.db.orm.delete(productVersions).where(eq(productVersions.sourceId, sourceId)).run()
      .changes;
  }
}
