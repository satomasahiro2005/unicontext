import { type Addition, AdditionSchema, type AdditionStatus } from '@unicontext/canonical-model';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { UniContextDatabase } from '../db.js';
import { additions } from '../schema/records.js';

export type AdditionRow = typeof additions.$inferSelect;

export function additionToRow(a: Addition): AdditionRow {
  return {
    id: a.id,
    clientId: a.clientId,
    clientName: a.clientName ?? null,
    tool: a.tool,
    kind: a.kind,
    status: a.status,
    courseOfferingId: a.courseOfferingId ?? null,
    title: a.title,
    dueAt: a.dueAt ?? null,
    dedupeKey: a.dedupeKey ?? null,
    idempotencyKey: a.idempotencyKey ?? null,
    sourceReferenceId: a.sourceReferenceId ?? null,
    entityIdsJson: JSON.stringify(a.entityIds),
    ownEntityIdsJson: JSON.stringify(a.ownEntityIds),
    factIdsJson: JSON.stringify(a.factIds),
    dataJson: JSON.stringify(a.data),
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    decidedAt: a.decidedAt ?? null,
  };
}

export function rowToAddition(r: AdditionRow): Addition {
  return AdditionSchema.parse({
    id: r.id,
    clientId: r.clientId,
    ...(r.clientName ? { clientName: r.clientName } : {}),
    tool: r.tool,
    kind: r.kind,
    status: r.status,
    ...(r.courseOfferingId ? { courseOfferingId: r.courseOfferingId } : {}),
    title: r.title,
    ...(r.dueAt ? { dueAt: r.dueAt } : {}),
    ...(r.dedupeKey ? { dedupeKey: r.dedupeKey } : {}),
    ...(r.idempotencyKey ? { idempotencyKey: r.idempotencyKey } : {}),
    ...(r.sourceReferenceId ? { sourceReferenceId: r.sourceReferenceId } : {}),
    entityIds: JSON.parse(r.entityIdsJson) as unknown,
    ownEntityIds: JSON.parse(r.ownEntityIdsJson) as unknown,
    factIds: JSON.parse(r.factIdsJson) as unknown,
    data: JSON.parse(r.dataJson) as unknown,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...(r.decidedAt ? { decidedAt: r.decidedAt } : {}),
  });
}

export interface AdditionListOptions {
  clientId?: string;
  statuses?: readonly AdditionStatus[];
  courseOfferingIds?: readonly string[];
  limit?: number;
}

/** Ledger of MCP write-tool additions (008_additions). Newest first. */
export class AdditionStore {
  constructor(private readonly db: UniContextDatabase) {}

  save(a: Addition): Addition {
    const parsed = AdditionSchema.parse(a);
    const row = additionToRow(parsed);
    this.db.orm
      .insert(additions)
      .values(row)
      .onConflictDoUpdate({ target: additions.id, set: row })
      .run();
    return parsed;
  }

  get(id: string): Addition | undefined {
    const r = this.db.orm.select().from(additions).where(eq(additions.id, id)).get();
    return r ? rowToAddition(r) : undefined;
  }

  byIdempotencyKey(clientId: string, key: string): Addition | undefined {
    const r = this.db.orm
      .select()
      .from(additions)
      .where(and(eq(additions.clientId, clientId), eq(additions.idempotencyKey, key)))
      .get();
    return r ? rowToAddition(r) : undefined;
  }

  byDedupeKey(key: string, statuses: readonly AdditionStatus[]): Addition[] {
    return this.db.orm
      .select()
      .from(additions)
      .where(and(eq(additions.dedupeKey, key), inArray(additions.status, [...statuses])))
      .orderBy(desc(additions.updatedAt))
      .all()
      .map(rowToAddition);
  }

  list(options: AdditionListOptions = {}): Addition[] {
    const conds = [];
    if (options.clientId) conds.push(eq(additions.clientId, options.clientId));
    if (options.statuses?.length) conds.push(inArray(additions.status, [...options.statuses]));
    if (options.courseOfferingIds?.length)
      conds.push(inArray(additions.courseOfferingId, [...options.courseOfferingIds]));
    const q = this.db.orm
      .select()
      .from(additions)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(additions.createdAt), desc(additions.id));
    return (options.limit ? q.limit(options.limit) : q).all().map(rowToAddition);
  }

  /** Additions a client wrote or updated since `sinceIso` (write rate limit). */
  countWritesSince(clientId: string, sinceIso: string): number {
    const r = this.db.orm
      .select({ n: sql<number>`count(*)` })
      .from(additions)
      .where(and(eq(additions.clientId, clientId), gte(additions.updatedAt, sinceIso)))
      .get();
    return r?.n ?? 0;
  }

  deleteAll(): number {
    return this.db.orm.delete(additions).run().changes;
  }
}
