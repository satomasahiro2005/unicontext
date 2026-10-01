import {
  type SourceReference,
  type SourceReferenceInput,
  SourceReferenceSchema,
  SourceLocationSchema,
} from '@unicontext/canonical-model';
import { eq, inArray } from 'drizzle-orm';
import type { UniContextDatabase } from '../db.js';
import { sourceReferences } from '../schema/entities.js';

type Row = typeof sourceReferences.$inferSelect;

function toRef(r: Row): SourceReference {
  return SourceReferenceSchema.parse({
    id: r.id,
    sourceSystem: r.sourceSystem,
    ...(r.sourceId ? { sourceId: r.sourceId } : {}),
    ...(r.sourceLabel ? { sourceLabel: r.sourceLabel } : {}),
    authority: r.authority,
    sourceItemId: r.sourceItemId,
    ...(r.url ? { url: r.url } : {}),
    retrievedAt: r.retrievedAt,
    ...(r.rawItemId ? { rawItemId: r.rawItemId } : {}),
    ...(r.locationJson ? { location: SourceLocationSchema.parse(JSON.parse(r.locationJson)) } : {}),
    ...(r.entityId ? { entityId: r.entityId } : {}),
  });
}

/** Provenance pointers (§10). Upserts are idempotent on id. */
export class SourceReferenceStore {
  constructor(private readonly db: UniContextDatabase) {}

  upsert(input: SourceReferenceInput): SourceReference {
    const ref = SourceReferenceSchema.parse(input);
    const row = {
      id: ref.id,
      sourceSystem: ref.sourceSystem,
      sourceId: ref.sourceId ?? null,
      sourceLabel: ref.sourceLabel ?? null,
      authority: ref.authority,
      sourceItemId: ref.sourceItemId,
      url: ref.url ?? null,
      retrievedAt: ref.retrievedAt,
      rawItemId: ref.rawItemId ?? null,
      locationJson: ref.location ? JSON.stringify(ref.location) : null,
      entityId: ref.entityId ?? null,
    };
    this.db.orm
      .insert(sourceReferences)
      .values(row)
      .onConflictDoUpdate({ target: sourceReferences.id, set: row })
      .run();
    return ref;
  }

  get(id: string): SourceReference | undefined {
    const r = this.db.orm.select().from(sourceReferences).where(eq(sourceReferences.id, id)).get();
    return r ? toRef(r) : undefined;
  }

  getMany(ids: readonly string[]): Map<string, SourceReference> {
    const out = new Map<string, SourceReference>();
    if (ids.length === 0) return out;
    for (const r of this.db.orm
      .select()
      .from(sourceReferences)
      .where(inArray(sourceReferences.id, [...ids]))
      .all())
      out.set(r.id, toRef(r));
    return out;
  }

  forEntity(entityId: string): SourceReference[] {
    return this.db.orm
      .select()
      .from(sourceReferences)
      .where(eq(sourceReferences.entityId, entityId))
      .all()
      .map(toRef);
  }

  forEntities(entityIds: readonly string[]): Map<string, SourceReference[]> {
    const out = new Map<string, SourceReference[]>();
    if (entityIds.length === 0) return out;
    for (const r of this.db.orm
      .select()
      .from(sourceReferences)
      .where(inArray(sourceReferences.entityId, [...entityIds]))
      .all()) {
      const ref = toRef(r);
      const list = out.get(r.entityId ?? '') ?? [];
      list.push(ref);
      out.set(r.entityId ?? '', list);
    }
    return out;
  }

  byRawItem(rawItemId: string): SourceReference[] {
    return this.db.orm
      .select()
      .from(sourceReferences)
      .where(eq(sourceReferences.rawItemId, rawItemId))
      .all()
      .map(toRef);
  }

  bySource(sourceId: string): SourceReference[] {
    return this.db.orm
      .select()
      .from(sourceReferences)
      .where(eq(sourceReferences.sourceId, sourceId))
      .all()
      .map(toRef);
  }

  deleteBySource(sourceId: string): number {
    return this.db.orm.delete(sourceReferences).where(eq(sourceReferences.sourceId, sourceId)).run()
      .changes;
  }
}
