import {
  type Fact,
  FactSchema,
  type JsonValue,
  type SourceReference,
  stableId,
} from '@unicontext/canonical-model';
import { type Clock, PolicyViolationError, stableStringify, systemClock } from '@unicontext/core';
import {
  factToRow,
  facts,
  rowToFact,
  SourceReferenceStore,
  type UniContextDatabase,
} from '@unicontext/database';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

export interface FactWithSource {
  fact: Fact;
  source: SourceReference | undefined;
}

export interface ActiveFactQuery {
  subjects: readonly string[];
  predicate?: string;
  /** Only facts valid at this instant. Without it: facts not expired at "now" (incl. future-valid ones). */
  at?: Date;
}

/** Stable fact id: the same claim from the same place keeps its id across reprocessing. */
export function factId(
  sourceReferenceId: string,
  subject: string,
  predicate: string,
  value: JsonValue,
): Fact['id'] {
  return stableId('fact', sourceReferenceId, subject, predicate, stableStringify(value));
}

/** Persistence for facts (§9). Validation enforces §48 (AI never authoritative) via FactSchema. */
export class FactStore {
  private readonly refs: SourceReferenceStore;
  constructor(
    private readonly db: UniContextDatabase,
    private readonly clock: Clock = systemClock,
  ) {
    this.refs = new SourceReferenceStore(db);
  }

  /** Insert or update a fact. Throws PolicyViolationError for AI facts claiming authority. */
  put(input: Fact): Fact {
    const parsed = FactSchema.safeParse(input);
    if (!parsed.success) {
      const policy = parsed.error.issues.find(
        (i) => i.message.includes('§48') || i.message.includes('origin "user"'),
      );
      if (policy) throw new PolicyViolationError(policy.message);
      throw parsed.error;
    }
    const fact = parsed.data;
    const row = factToRow(fact, this.clock.now().toISOString());
    const { createdAt: _c, ...update } = row;
    this.db.orm
      .insert(facts)
      .values(row)
      .onConflictDoUpdate({ target: facts.id, set: update })
      .run();
    return fact;
  }

  get(id: string): Fact | undefined {
    const r = this.db.orm.select().from(facts).where(eq(facts.id, id)).get();
    return r ? rowToFact(r) : undefined;
  }

  getMany(ids: readonly string[]): Fact[] {
    if (ids.length === 0) return [];
    return this.db.orm
      .select()
      .from(facts)
      .where(inArray(facts.id, [...ids]))
      .all()
      .map(rowToFact);
  }

  /** All facts (incl. retracted) about a subject, oldest first. */
  history(subject: string, predicate?: string): Fact[] {
    return this.db.orm
      .select()
      .from(facts)
      .where(
        predicate
          ? and(eq(facts.subject, subject), eq(facts.predicate, predicate))
          : eq(facts.subject, subject),
      )
      .orderBy(asc(facts.observedAt))
      .all()
      .map(rowToFact);
  }

  /** Non-retracted facts valid for the query window. */
  active(q: ActiveFactQuery): Fact[] {
    if (q.subjects.length === 0) return [];
    const conds = [inArray(facts.subject, [...q.subjects]), isNull(facts.retractedAt)];
    if (q.predicate) conds.push(eq(facts.predicate, q.predicate));
    const rows = this.db.orm
      .select()
      .from(facts)
      .where(and(...conds))
      .orderBy(asc(facts.observedAt), asc(facts.id))
      .all();
    const now = (q.at ?? this.clock.now()).getTime();
    return rows.map(rowToFact).filter((f) => {
      const from = f.validFrom ? new Date(f.validFrom).getTime() : Number.NEGATIVE_INFINITY;
      const until = f.validUntil ? new Date(f.validUntil).getTime() : Number.POSITIVE_INFINITY;
      return q.at ? from <= now && now < until : until > now;
    });
  }

  /** Distinct (subject, predicate) pairs with live facts. */
  activePairs(): { subject: string; predicate: string }[] {
    return this.db.sqlite
      .prepare(
        'SELECT DISTINCT subject, predicate FROM facts WHERE retracted_at IS NULL ORDER BY subject, predicate',
      )
      .all() as { subject: string; predicate: string }[];
  }

  withSources(list: readonly Fact[]): FactWithSource[] {
    const refs = this.refs.getMany([...new Set(list.map((f) => f.sourceReferenceId))]);
    return list.map((fact) => ({ fact, source: refs.get(fact.sourceReferenceId) }));
  }

  retract(ids: readonly string[], at: string = this.clock.now().toISOString()): number {
    if (ids.length === 0) return 0;
    return this.db.orm
      .update(facts)
      .set({ retractedAt: at })
      .where(and(inArray(facts.id, [...ids]), isNull(facts.retractedAt)))
      .run().changes;
  }

  /** Live fact ids whose source reference points at a raw item (used when a raw item changes). */
  activeIdsForRawItem(rawItemId: string): string[] {
    return (
      this.db.sqlite
        .prepare(
          'SELECT f.id FROM facts f JOIN source_references r ON r.id = f.source_reference_id WHERE r.raw_item_id = ? AND f.retracted_at IS NULL',
        )
        .all(rawItemId) as { id: string }[]
    ).map((r) => r.id);
  }
}
