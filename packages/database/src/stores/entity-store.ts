import {
  type CanonicalEntity,
  type CanonicalEntityInput,
  type EntityKind,
  type EntityOfKind,
  ENTITY_KINDS,
  isEntityKind,
  parseEntity,
  parseId,
} from '@unicontext/canonical-model';
import { type Clock, stableStringify, systemClock, ValidationError } from '@unicontext/core';
import { getTableColumns, getTableName } from 'drizzle-orm';
import type { UniContextDatabase } from '../db.js';
import { ENTITY_TABLES } from '../schema/entities.js';

export type EntityWriteStatus = 'created' | 'updated' | 'unchanged' | 'restored';

export interface EntityWriteResult<E extends CanonicalEntity = CanonicalEntity> {
  status: EntityWriteStatus;
  entity: E;
  previous: E | undefined;
  /** Top-level fields whose value changed (empty for created/unchanged). */
  changedFields: string[];
}

export interface StoredEntityMeta {
  sourceId: string | undefined;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | undefined;
}

const ENVELOPE_KEYS = new Set(['id', 'data', 'sourceId', 'createdAt', 'updatedAt', 'deletedAt']);

/** FTS table per searchable kind (§15). */
export const FTS_TABLES: Partial<Record<EntityKind, string>> = {
  document: 'fts_documents',
  documentChunk: 'fts_document_chunks',
  announcement: 'fts_announcements',
  message: 'fts_messages',
  lectureSegment: 'fts_lecture_segments',
};

interface TableInfo {
  name: string;
  /** [jsKey, sqlColumn] for typed columns beyond the envelope. */
  columns: [string, string][];
}

const TABLE_INFO = new Map<EntityKind, TableInfo>();
for (const kind of ENTITY_KINDS) {
  const table = ENTITY_TABLES[kind];
  const cols = Object.entries(getTableColumns(table))
    .filter(([key]) => !ENVELOPE_KEYS.has(key))
    .map(([key, col]) => [key, col.name] as [string, string]);
  TABLE_INFO.set(kind, { name: getTableName(table), columns: cols });
}

function info(kind: EntityKind): TableInfo {
  const t = TABLE_INFO.get(kind);
  if (!t) throw new ValidationError(`Unknown entity kind ${kind}`);
  return t;
}

function columnValue(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string') return v;
  return JSON.stringify(v);
}

interface Row {
  id: string;
  data: string;
  source_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Diff two entities by top-level field (stable JSON comparison). */
export function diffEntities(before: object, after: object): string[] {
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if (stableStringify(a[k]) !== stableStringify(b[k])) out.push(k);
  }
  return out.sort();
}

/**
 * Generic canonical entity storage. Every write validates with the canonical zod schema, keeps the
 * typed columns and the FTS index in sync, and reports a field-level diff for ChangeEvents.
 */
export class EntityStore {
  private readonly clock: Clock;

  constructor(
    private readonly db: UniContextDatabase,
    options: { clock?: Clock } = {},
  ) {
    this.clock = options.clock ?? systemClock;
  }

  private row(kind: EntityKind, id: string): Row | undefined {
    return this.db.sqlite
      .prepare(
        `SELECT id, data, source_id, created_at, updated_at, deleted_at FROM ${info(kind).name} WHERE id = ?`,
      )
      .get(id) as Row | undefined;
  }

  /** Validate and insert/update. Deleted entities are restored. */
  upsert<I extends CanonicalEntityInput>(
    input: I,
    options: { sourceId?: string; at?: string } = {},
  ): EntityWriteResult<EntityOfKind[I['kind']]> {
    type E = EntityOfKind[I['kind']];
    const entity = parseEntity(input) as E;
    const kind = entity.kind;
    const t = info(kind);
    const now = options.at ?? this.clock.now().toISOString();
    const existing = this.row(kind, entity.id);
    const previous = existing ? (JSON.parse(existing.data) as E) : undefined;
    const changedFields = previous ? diffEntities(previous, entity) : [];
    if (existing && !existing.deleted_at && changedFields.length === 0) {
      return { status: 'unchanged', entity, previous, changedFields };
    }
    const rec = entity as unknown as Record<string, unknown>;
    const typed = t.columns.map(([key]) => columnValue(rec[key]));
    const data = JSON.stringify(entity);
    if (!existing) {
      const cols = [
        'id',
        'data',
        'source_id',
        'created_at',
        'updated_at',
        ...t.columns.map(([, c]) => c),
      ];
      this.db.sqlite
        .prepare(
          `INSERT INTO ${t.name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        )
        .run(entity.id, data, options.sourceId ?? null, now, now, ...typed);
    } else {
      const sets = [
        'data = ?',
        'updated_at = ?',
        'deleted_at = NULL',
        ...t.columns.map(([, c]) => `${c} = ?`),
      ];
      this.db.sqlite
        .prepare(`UPDATE ${t.name} SET ${sets.join(', ')} WHERE id = ?`)
        .run(data, now, ...typed, entity.id);
    }
    this.indexFts(entity);
    const status: EntityWriteStatus = !existing
      ? 'created'
      : existing.deleted_at
        ? 'restored'
        : 'updated';
    return { status, entity, previous, changedFields };
  }

  get(id: string, options: { includeDeleted?: boolean } = {}): CanonicalEntity | undefined {
    const kind = parseId(id).kind;
    if (!isEntityKind(kind)) return undefined;
    const r = this.row(kind, id);
    if (!r || (r.deleted_at && !options.includeDeleted)) return undefined;
    return JSON.parse(r.data) as CanonicalEntity;
  }

  getOfKind<K extends EntityKind>(
    kind: K,
    id: string,
    options: { includeDeleted?: boolean } = {},
  ): EntityOfKind[K] | undefined {
    if (!id.startsWith(`${kind}:`)) return undefined;
    return this.get(id, options) as EntityOfKind[K] | undefined;
  }

  meta(id: string): StoredEntityMeta | undefined {
    const kind = parseId(id).kind;
    if (!isEntityKind(kind)) return undefined;
    const r = this.row(kind, id);
    if (!r) return undefined;
    return {
      sourceId: r.source_id ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at ?? undefined,
    };
  }

  getMany(ids: readonly string[]): CanonicalEntity[] {
    const out: CanonicalEntity[] = [];
    for (const id of ids) {
      const e = this.get(id);
      if (e) out.push(e);
    }
    return out;
  }

  /**
   * List entities of a kind. `where` filters on typed columns by JS field name (equality or IN for arrays).
   */
  list<K extends EntityKind>(
    kind: K,
    options: {
      includeDeleted?: boolean;
      where?: Record<string, string | number | readonly (string | number)[]>;
      sourceId?: string;
      limit?: number;
      orderBy?: string;
    } = {},
  ): EntityOfKind[K][] {
    const t = info(kind);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (!options.includeDeleted) clauses.push('deleted_at IS NULL');
    if (options.sourceId) {
      clauses.push('source_id = ?');
      params.push(options.sourceId);
    }
    for (const [field, value] of Object.entries(options.where ?? {})) {
      const col = t.columns.find(([k]) => k === field)?.[1];
      if (!col) throw new ValidationError(`${kind} has no typed column ${field}`);
      if (Array.isArray(value)) {
        if (value.length === 0) return [];
        clauses.push(`${col} IN (${value.map(() => '?').join(', ')})`);
        params.push(...(value as (string | number)[]));
      } else {
        clauses.push(`${col} = ?`);
        params.push(value as string | number);
      }
    }
    let order = 'id';
    if (options.orderBy) {
      const col = t.columns.find(([k]) => k === options.orderBy)?.[1];
      if (!col) throw new ValidationError(`${kind} has no typed column ${options.orderBy}`);
      order = `${col}, id`;
    }
    const sqlText = `SELECT data FROM ${t.name}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${order}${options.limit ? ` LIMIT ${Math.floor(options.limit)}` : ''}`;
    return (this.db.sqlite.prepare(sqlText).all(...params) as { data: string }[]).map(
      (r) => JSON.parse(r.data) as EntityOfKind[K],
    );
  }

  /** Entities of a kind whose typed column lies in [from, to). Strings compare lexicographically (ISO). */
  listInRange<K extends EntityKind>(
    kind: K,
    field: string,
    from: string,
    to: string,
  ): EntityOfKind[K][] {
    const t = info(kind);
    const col = t.columns.find(([k]) => k === field)?.[1];
    if (!col) throw new ValidationError(`${kind} has no typed column ${field}`);
    // ISO instants with different offsets are compared via julianday()
    const rows = this.db.sqlite
      .prepare(
        `SELECT data FROM ${t.name} WHERE deleted_at IS NULL AND ${col} IS NOT NULL AND julianday(${col}) >= julianday(?) AND julianday(${col}) < julianday(?) ORDER BY julianday(${col}), id`,
      )
      .all(from, to) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as EntityOfKind[K]);
  }

  /** Same as listInRange for plain local-date columns (YYYY-MM-DD). */
  listByDateRange<K extends EntityKind>(
    kind: K,
    field: string,
    fromDate: string,
    toDateExclusive: string,
  ): EntityOfKind[K][] {
    const t = info(kind);
    const col = t.columns.find(([k]) => k === field)?.[1];
    if (!col) throw new ValidationError(`${kind} has no typed column ${field}`);
    const rows = this.db.sqlite
      .prepare(
        `SELECT data FROM ${t.name} WHERE deleted_at IS NULL AND ${col} >= ? AND ${col} < ? ORDER BY ${col}, id`,
      )
      .all(fromDate, toDateExclusive) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as EntityOfKind[K]);
  }

  /** Soft delete. Returns the entity as it was, or undefined if missing/already deleted. */
  softDelete(id: string, at: string = this.clock.now().toISOString()): CanonicalEntity | undefined {
    const kind = parseId(id).kind;
    if (!isEntityKind(kind)) return undefined;
    const r = this.row(kind, id);
    if (!r || r.deleted_at) return undefined;
    this.db.sqlite
      .prepare(`UPDATE ${info(kind).name} SET deleted_at = ?, updated_at = ? WHERE id = ?`)
      .run(at, at, id);
    this.removeFts(kind, id);
    return JSON.parse(r.data) as CanonicalEntity;
  }

  /** Permanently remove (used by purge). */
  hardDelete(id: string): boolean {
    const kind = parseId(id).kind;
    if (!isEntityKind(kind)) return false;
    this.removeFts(kind, id);
    return (
      this.db.sqlite.prepare(`DELETE FROM ${info(kind).name} WHERE id = ?`).run(id).changes > 0
    );
  }

  /** Ids of all entities owned by a source (any deletion state). */
  idsBySource(sourceId: string): string[] {
    const out: string[] = [];
    for (const kind of ENTITY_KINDS) {
      const rows = this.db.sqlite
        .prepare(`SELECT id FROM ${info(kind).name} WHERE source_id = ?`)
        .all(sourceId) as { id: string }[];
      out.push(...rows.map((r) => r.id));
    }
    return out;
  }

  counts(): Record<EntityKind, number> {
    const out = {} as Record<EntityKind, number>;
    for (const kind of ENTITY_KINDS) {
      const r = this.db.sqlite
        .prepare(`SELECT COUNT(*) AS n FROM ${info(kind).name} WHERE deleted_at IS NULL`)
        .get() as { n: number };
      out[kind] = r.n;
    }
    return out;
  }

  /** Rebuild every FTS table from entity tables. */
  rebuildFts(): void {
    for (const [kind, table] of Object.entries(FTS_TABLES)) {
      this.db.sqlite.prepare(`DELETE FROM ${table}`).run();
      for (const e of this.list(kind as EntityKind)) this.indexFts(e);
    }
  }

  private removeFts(kind: EntityKind, id: string): void {
    const table = FTS_TABLES[kind];
    if (table) this.db.sqlite.prepare(`DELETE FROM ${table} WHERE entity_id = ?`).run(id);
  }

  private indexFts(entity: CanonicalEntity): void {
    const table = FTS_TABLES[entity.kind];
    if (!table) return;
    let title: string;
    let body: string;
    let courseOfferingId: string | undefined;
    switch (entity.kind) {
      case 'document':
        title = entity.title;
        body = entity.text ?? '';
        courseOfferingId = entity.courseOfferingId;
        break;
      case 'documentChunk': {
        title = entity.heading ?? '';
        body = entity.text;
        const doc = this.getOfKind('document', entity.documentId);
        courseOfferingId = doc?.courseOfferingId;
        if (!title && doc) title = doc.title;
        break;
      }
      case 'announcement':
        title = entity.title;
        body = entity.body;
        courseOfferingId = entity.courseOfferingId;
        break;
      case 'message':
        title = entity.authorName ?? '';
        body = entity.body;
        courseOfferingId = entity.courseOfferingId;
        break;
      case 'lectureSegment': {
        title = entity.speaker ?? '';
        body = entity.text;
        const tr = this.getOfKind('lectureTranscript', entity.transcriptId);
        courseOfferingId = tr?.courseOfferingId;
        break;
      }
      default:
        return;
    }
    this.removeFts(entity.kind, entity.id);
    this.db.sqlite
      .prepare(
        `INSERT INTO ${table} (entity_id, course_offering_id, title, body) VALUES (?, ?, ?, ?)`,
      )
      .run(entity.id, courseOfferingId ?? null, title, body);
  }
}
