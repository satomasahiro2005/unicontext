import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type Clock,
  contentHash,
  NotFoundError,
  sha256,
  stableUuid,
  systemClock,
} from '@unicontext/core';
import { and, asc, eq, inArray, isNull, or, ne, sql } from 'drizzle-orm';
import type { UniContextDatabase } from '../db.js';
import { rawBlobs, rawItems, rawSources } from '../schema/raw.js';

export interface RawSourceInput {
  id: string;
  connector: string;
  adapter?: string;
  displayName?: string;
}

export interface RawSourceRecord extends RawSourceInput {
  createdAt: string;
  updatedAt: string;
  lastSyncAt: string | undefined;
}

export interface RawItemInput {
  /** Item type in the source's own vocabulary, e.g. "lcu.course", "graph.message". */
  sourceType: string;
  /** Stable id of the item in the source system. */
  externalId: string;
  /** JSON-serializable payload exactly as received. */
  payload: unknown;
  sourceUpdatedAt?: string;
  fetchedAt?: string;
}

export interface RawItemRecord {
  id: string;
  sourceId: string;
  sourceType: string;
  externalId: string;
  payload: unknown;
  fetchedAt: string;
  sourceUpdatedAt: string | undefined;
  contentHash: string;
  deletedAt: string | undefined;
  normalizedAt: string | undefined;
  normalizedHash: string | undefined;
  normalizerVersion: string | undefined;
  normalizeError: string | undefined;
}

export type RawUpsertStatus = 'inserted' | 'updated' | 'unchanged' | 'restored';

export interface RawBlobInput {
  sourceId: string;
  rawItemId?: string;
  data: Uint8Array;
  mimeType?: string;
}

export interface RawBlobRecord {
  id: string;
  sha256: string;
  sourceId: string;
  rawItemId: string | undefined;
  mimeType: string | undefined;
  size: number;
  storage: 'file' | 'inline';
  path: string | undefined;
  createdAt: string;
}

export function rawItemId(sourceId: string, sourceType: string, externalId: string): string {
  return `raw:${stableUuid(sourceId, sourceType, externalId)}`;
}

type RawRow = typeof rawItems.$inferSelect;
const u = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

function toRecord(r: RawRow): RawItemRecord {
  return {
    id: r.id,
    sourceId: r.sourceId,
    sourceType: r.sourceType,
    externalId: r.externalId,
    payload: JSON.parse(r.payloadJson) as unknown,
    fetchedAt: r.fetchedAt,
    sourceUpdatedAt: u(r.sourceUpdatedAt),
    contentHash: r.contentHash,
    deletedAt: u(r.deletedAt),
    normalizedAt: u(r.normalizedAt),
    normalizedHash: u(r.normalizedHash),
    normalizerVersion: u(r.normalizerVersion),
    normalizeError: u(r.normalizeError),
  };
}

/** Raw layer access (§6): content-hash dedupe, soft deletion and normalization bookkeeping. */
export class RawStore {
  private readonly clock: Clock;

  constructor(
    private readonly db: UniContextDatabase,
    options: { clock?: Clock } = {},
  ) {
    this.clock = options.clock ?? systemClock;
  }

  private nowIso(): string {
    return this.clock.now().toISOString();
  }

  ensureSource(input: RawSourceInput): RawSourceRecord {
    const now = this.nowIso();
    this.db.orm
      .insert(rawSources)
      .values({
        id: input.id,
        connector: input.connector,
        adapter: input.adapter ?? null,
        displayName: input.displayName ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: rawSources.id,
        set: {
          connector: input.connector,
          adapter: input.adapter ?? null,
          displayName: input.displayName ?? null,
          updatedAt: now,
        },
      })
      .run();
    const s = this.getSource(input.id);
    if (!s) throw new NotFoundError(`source ${input.id}`);
    return s;
  }

  getSource(id: string): RawSourceRecord | undefined {
    const r = this.db.orm.select().from(rawSources).where(eq(rawSources.id, id)).get();
    if (!r) return undefined;
    return {
      id: r.id,
      connector: r.connector,
      ...(r.adapter ? { adapter: r.adapter } : {}),
      ...(r.displayName ? { displayName: r.displayName } : {}),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      lastSyncAt: u(r.lastSyncAt),
    };
  }

  listSources(): RawSourceRecord[] {
    return this.db.orm
      .select({ id: rawSources.id })
      .from(rawSources)
      .orderBy(asc(rawSources.id))
      .all()
      .map((r) => this.getSource(r.id))
      .filter((s): s is RawSourceRecord => s !== undefined);
  }

  touchSourceSync(id: string, at: string = this.nowIso()): void {
    this.db.orm
      .update(rawSources)
      .set({ lastSyncAt: at, updatedAt: at })
      .where(eq(rawSources.id, id))
      .run();
  }

  find(sourceId: string, sourceType: string, externalId: string): RawItemRecord | undefined {
    return this.get(rawItemId(sourceId, sourceType, externalId));
  }

  get(id: string): RawItemRecord | undefined {
    const r = this.db.orm.select().from(rawItems).where(eq(rawItems.id, id)).get();
    return r ? toRecord(r) : undefined;
  }

  /**
   * Insert or update one raw item. Unchanged payloads (same content hash, not deleted) are a
   * no-op so they are not normalized again.
   */
  upsertItem(
    sourceId: string,
    input: RawItemInput,
  ): { status: RawUpsertStatus; item: RawItemRecord } {
    const id = rawItemId(sourceId, input.sourceType, input.externalId);
    const hash = contentHash(input.payload);
    const fetchedAt = input.fetchedAt ?? this.nowIso();
    const existing = this.get(id);
    if (existing && existing.contentHash === hash && !existing.deletedAt) {
      this.db.orm.update(rawItems).set({ fetchedAt }).where(eq(rawItems.id, id)).run();
      return { status: 'unchanged', item: { ...existing, fetchedAt } };
    }
    const payloadJson = JSON.stringify(input.payload ?? null);
    if (!existing) {
      this.db.orm
        .insert(rawItems)
        .values({
          id,
          sourceId,
          sourceType: input.sourceType,
          externalId: input.externalId,
          payloadJson,
          fetchedAt,
          sourceUpdatedAt: input.sourceUpdatedAt ?? null,
          contentHash: hash,
        })
        .run();
    } else {
      this.db.orm
        .update(rawItems)
        .set({
          payloadJson,
          fetchedAt,
          sourceUpdatedAt: input.sourceUpdatedAt ?? null,
          contentHash: hash,
          deletedAt: null,
          normalizedAt: null,
          normalizeError: null,
        })
        .where(eq(rawItems.id, id))
        .run();
    }
    const item = this.get(id);
    if (!item) throw new NotFoundError(id);
    return { status: !existing ? 'inserted' : existing.deletedAt ? 'restored' : 'updated', item };
  }

  /** Soft-delete. Returns the item if it was live. */
  markDeleted(
    sourceId: string,
    sourceType: string,
    externalId: string,
    at: string = this.nowIso(),
  ): RawItemRecord | undefined {
    const id = rawItemId(sourceId, sourceType, externalId);
    const existing = this.get(id);
    if (!existing || existing.deletedAt) return undefined;
    this.db.orm
      .update(rawItems)
      .set({ deletedAt: at, normalizedAt: null })
      .where(eq(rawItems.id, id))
      .run();
    return this.get(id);
  }

  /** Full refresh: everything of these types that was not seen in the listing is deleted. */
  markMissingDeleted(
    sourceId: string,
    sourceTypes: string[],
    seenIds: Set<string>,
    at: string = this.nowIso(),
  ): RawItemRecord[] {
    if (sourceTypes.length === 0) return [];
    const live = this.db.orm
      .select()
      .from(rawItems)
      .where(
        and(
          eq(rawItems.sourceId, sourceId),
          inArray(rawItems.sourceType, sourceTypes),
          isNull(rawItems.deletedAt),
        ),
      )
      .all();
    const out: RawItemRecord[] = [];
    for (const r of live) {
      if (seenIds.has(r.id)) continue;
      const d = this.markDeleted(sourceId, r.sourceType, r.externalId, at);
      if (d) out.push(d);
    }
    return out;
  }

  /**
   * List raw items. pendingOnly = never normalized, or changed/deleted since the last normalization.
   */
  list(
    options: {
      sourceId?: string;
      pendingOnly?: boolean;
      includeDeleted?: boolean;
      sourceTypes?: string[];
    } = {},
  ): RawItemRecord[] {
    const conds = [];
    if (options.sourceId) conds.push(eq(rawItems.sourceId, options.sourceId));
    if (options.sourceTypes?.length) conds.push(inArray(rawItems.sourceType, options.sourceTypes));
    if (options.pendingOnly)
      conds.push(
        or(
          isNull(rawItems.normalizedAt),
          isNull(rawItems.normalizedHash),
          ne(rawItems.normalizedHash, rawItems.contentHash),
        ),
      );
    else if (!options.includeDeleted) conds.push(isNull(rawItems.deletedAt));
    return this.db.orm
      .select()
      .from(rawItems)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(rawItems.fetchedAt), asc(rawItems.id))
      .all()
      .map(toRecord);
  }

  markNormalized(id: string, info: { version: string; error?: string; at?: string }): void {
    this.db.orm
      .update(rawItems)
      .set({
        normalizedAt: info.at ?? this.nowIso(),
        normalizedHash: info.error ? null : sql`${rawItems.contentHash}`,
        normalizerVersion: info.version,
        normalizeError: info.error ?? null,
      })
      .where(eq(rawItems.id, id))
      .run();
  }

  /** Force re-normalization of everything (or one source) without refetching (§6). */
  resetNormalization(sourceId?: string): number {
    const res = this.db.orm
      .update(rawItems)
      .set({ normalizedAt: null, normalizedHash: null })
      .where(sourceId ? eq(rawItems.sourceId, sourceId) : undefined)
      .run();
    return res.changes;
  }

  countBySource(sourceId: string): { live: number; deleted: number } {
    const row = this.db.sqlite
      .prepare(
        'SELECT SUM(deleted_at IS NULL) AS live, SUM(deleted_at IS NOT NULL) AS deleted FROM raw_items WHERE source_id = ?',
      )
      .get(sourceId) as { live: number | null; deleted: number | null };
    return { live: row.live ?? 0, deleted: row.deleted ?? 0 };
  }

  putBlob(input: RawBlobInput): RawBlobRecord {
    const digest = sha256(input.data);
    const id = `blob:${stableUuid(input.sourceId, digest, input.rawItemId ?? '')}`;
    const existing = this.getBlob(id);
    if (existing) return existing;
    const createdAt = this.nowIso();
    let storage: 'file' | 'inline' = 'inline';
    let relPath: string | null = null;
    if (this.db.blobsDir) {
      relPath = path.join(digest.slice(0, 2), digest);
      const abs = path.join(this.db.blobsDir, relPath);
      if (!existsSync(abs)) {
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, input.data);
      }
      storage = 'file';
    }
    this.db.orm
      .insert(rawBlobs)
      .values({
        id,
        sha256: digest,
        sourceId: input.sourceId,
        rawItemId: input.rawItemId ?? null,
        mimeType: input.mimeType ?? null,
        size: input.data.byteLength,
        storage,
        path: relPath,
        data: storage === 'inline' ? Buffer.from(input.data) : null,
        createdAt,
      })
      .run();
    const rec = this.getBlob(id);
    if (!rec) throw new NotFoundError(id);
    return rec;
  }

  getBlob(id: string): RawBlobRecord | undefined {
    const r = this.db.orm
      .select({
        id: rawBlobs.id,
        sha256: rawBlobs.sha256,
        sourceId: rawBlobs.sourceId,
        rawItemId: rawBlobs.rawItemId,
        mimeType: rawBlobs.mimeType,
        size: rawBlobs.size,
        storage: rawBlobs.storage,
        path: rawBlobs.path,
        createdAt: rawBlobs.createdAt,
      })
      .from(rawBlobs)
      .where(eq(rawBlobs.id, id))
      .get();
    if (!r) return undefined;
    return {
      id: r.id,
      sha256: r.sha256,
      sourceId: r.sourceId,
      rawItemId: u(r.rawItemId),
      mimeType: u(r.mimeType),
      size: r.size,
      storage: r.storage === 'file' ? 'file' : 'inline',
      path: u(r.path),
      createdAt: r.createdAt,
    };
  }

  readBlob(id: string): Buffer {
    const r = this.db.orm.select().from(rawBlobs).where(eq(rawBlobs.id, id)).get();
    if (!r) throw new NotFoundError(`blob ${id}`);
    if (r.storage === 'file') {
      if (!this.db.blobsDir || !r.path)
        throw new NotFoundError(`blob file for ${id} (no blobs dir configured)`);
      return readFileSync(path.join(this.db.blobsDir, r.path));
    }
    if (!r.data) throw new NotFoundError(`blob data ${id}`);
    return Buffer.from(r.data);
  }

  /** Remove blob rows of a source and delete files no longer referenced. Returns number of rows. */
  deleteBlobsBySource(sourceId: string): number {
    const rows = this.db.orm
      .select({ id: rawBlobs.id, sha256: rawBlobs.sha256, path: rawBlobs.path })
      .from(rawBlobs)
      .where(eq(rawBlobs.sourceId, sourceId))
      .all();
    this.db.orm.delete(rawBlobs).where(eq(rawBlobs.sourceId, sourceId)).run();
    if (this.db.blobsDir) {
      for (const r of rows) {
        if (!r.path) continue;
        const still = this.db.orm
          .select({ id: rawBlobs.id })
          .from(rawBlobs)
          .where(eq(rawBlobs.sha256, r.sha256))
          .get();
        if (!still) rmSync(path.join(this.db.blobsDir, r.path), { force: true });
      }
    }
    return rows.length;
  }
}
