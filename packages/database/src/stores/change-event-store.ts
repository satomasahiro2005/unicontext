import {
  type ChangeEvent,
  ChangeEventSchema,
  type ChangeEventType,
} from '@unicontext/canonical-model';
import type { UniContextDatabase } from '../db.js';
import { changeEvents } from '../schema/records.js';

type Row = typeof changeEvents.$inferSelect;

function toEvent(r: Row): ChangeEvent {
  return ChangeEventSchema.parse({
    id: r.id,
    entityId: r.entityId,
    entityKind: r.entityKind,
    type: r.type,
    changedFields: JSON.parse(r.changedFieldsJson) as unknown,
    before: r.beforeJson ? (JSON.parse(r.beforeJson) as unknown) : null,
    after: r.afterJson ? (JSON.parse(r.afterJson) as unknown) : null,
    source: {
      ...(r.sourceId ? { sourceId: r.sourceId } : {}),
      ...(r.sourceSystem ? { sourceSystem: r.sourceSystem } : {}),
      ...(r.rawItemId ? { rawItemId: r.rawItemId } : {}),
    },
    occurredAt: r.occurredAt,
    observedAt: r.observedAt,
    ...(r.courseOfferingId ? { courseOfferingId: r.courseOfferingId } : {}),
    ...(r.summary ? { summary: r.summary } : {}),
  });
}

export interface ChangeEventQuery {
  /** observedAt >= since (ISO). */
  since?: string;
  /** observedAt < until (ISO). */
  until?: string;
  entityIds?: readonly string[];
  courseOfferingIds?: readonly string[];
  types?: readonly ChangeEventType[];
  sourceId?: string;
  limit?: number;
}

/** Append-only event log (§13). */
export class ChangeEventStore {
  constructor(private readonly db: UniContextDatabase) {}

  append(event: ChangeEvent): ChangeEvent {
    const e = ChangeEventSchema.parse(event);
    this.db.orm
      .insert(changeEvents)
      .values({
        id: e.id,
        entityId: e.entityId,
        entityKind: e.entityKind,
        type: e.type,
        changedFieldsJson: JSON.stringify(e.changedFields),
        beforeJson: e.before ? JSON.stringify(e.before) : null,
        afterJson: e.after ? JSON.stringify(e.after) : null,
        sourceId: e.source.sourceId ?? null,
        sourceSystem: e.source.sourceSystem ?? null,
        rawItemId: e.source.rawItemId ?? null,
        occurredAt: e.occurredAt,
        observedAt: e.observedAt,
        courseOfferingId: e.courseOfferingId ?? null,
        summary: e.summary ?? null,
      })
      .onConflictDoNothing()
      .run();
    return e;
  }

  list(q: ChangeEventQuery = {}): ChangeEvent[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (q.since) {
      clauses.push('julianday(observed_at) >= julianday(?)');
      params.push(q.since);
    }
    if (q.until) {
      clauses.push('julianday(observed_at) < julianday(?)');
      params.push(q.until);
    }
    const inList = (col: string, values: readonly string[] | undefined): boolean => {
      if (!values) return true;
      if (values.length === 0) return false;
      clauses.push(`${col} IN (${values.map(() => '?').join(', ')})`);
      params.push(...values);
      return true;
    };
    if (
      !inList('entity_id', q.entityIds) ||
      !inList('course_offering_id', q.courseOfferingIds) ||
      !inList('type', q.types)
    )
      return [];
    if (q.sourceId) {
      clauses.push('source_id = ?');
      params.push(q.sourceId);
    }
    const sql = `SELECT * FROM change_events${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY observed_at, rowid${q.limit ? ` LIMIT ${Math.floor(q.limit)}` : ''}`;
    const rows = this.db.sqlite.prepare(sql).all(...params) as Record<string, string | null>[];
    return rows.map((r) =>
      toEvent({
        id: r.id ?? '',
        entityId: r.entity_id ?? '',
        entityKind: r.entity_kind ?? '',
        type: r.type ?? '',
        changedFieldsJson: r.changed_fields_json ?? '[]',
        beforeJson: r.before_json ?? null,
        afterJson: r.after_json ?? null,
        sourceId: r.source_id ?? null,
        sourceSystem: r.source_system ?? null,
        rawItemId: r.raw_item_id ?? null,
        occurredAt: r.occurred_at ?? '',
        observedAt: r.observed_at ?? '',
        courseOfferingId: r.course_offering_id ?? null,
        summary: r.summary ?? null,
      }),
    );
  }

  deleteBySource(sourceId: string): number {
    return this.db.sqlite.prepare('DELETE FROM change_events WHERE source_id = ?').run(sourceId)
      .changes;
  }
}
