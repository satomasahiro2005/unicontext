import { eq, inArray } from 'drizzle-orm';
import type { UniContextDatabase } from '../db.js';
import { readMarks } from '../schema/records.js';

export interface ReadMark {
  entityId: string;
  unread: boolean;
  /** Why it was set, e.g. "opened-on-request", "user". */
  reason: string | undefined;
  updatedAt: string;
}

/** UniContext's own read/unread flag per entity (009_read_marks). */
export class ReadMarkStore {
  constructor(private readonly db: UniContextDatabase) {}

  get(entityId: string): ReadMark | undefined {
    const r = this.db.orm.select().from(readMarks).where(eq(readMarks.entityId, entityId)).get();
    return r
      ? {
          entityId: r.entityId,
          unread: r.unread === 1,
          reason: r.reason ?? undefined,
          updatedAt: r.updatedAt,
        }
      : undefined;
  }

  getMany(entityIds: readonly string[]): Map<string, ReadMark> {
    const out = new Map<string, ReadMark>();
    if (entityIds.length === 0) return out;
    for (const r of this.db.orm
      .select()
      .from(readMarks)
      .where(inArray(readMarks.entityId, [...entityIds]))
      .all())
      out.set(r.entityId, {
        entityId: r.entityId,
        unread: r.unread === 1,
        reason: r.reason ?? undefined,
        updatedAt: r.updatedAt,
      });
    return out;
  }

  set(entityId: string, unread: boolean, reason: string, at: string): ReadMark {
    const row = { entityId, unread: unread ? 1 : 0, reason, updatedAt: at };
    this.db.orm
      .insert(readMarks)
      .values(row)
      .onConflictDoUpdate({ target: readMarks.entityId, set: row })
      .run();
    return { entityId, unread, reason, updatedAt: at };
  }

  delete(entityId: string): boolean {
    return this.db.orm.delete(readMarks).where(eq(readMarks.entityId, entityId)).run().changes > 0;
  }
}
