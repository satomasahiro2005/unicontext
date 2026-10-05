import {
  type Conflict,
  type ConflictCandidate,
  type EntityId,
  type Fact,
  type FactOrigin,
  type JsonValue,
  type SourceReference,
  stableId,
} from '@unicontext/canonical-model';
import { type Clock, NotFoundError, stableStringify, systemClock } from '@unicontext/core';
import {
  conflictToRow,
  conflicts,
  rowToConflict,
  SourceReferenceStore,
  type UniContextDatabase,
} from '@unicontext/database';
import { and, asc, eq } from 'drizzle-orm';
import { factId, FactStore, type FactWithSource } from './fact-store.js';
import {
  type AuthorityRules,
  authorityOrder,
  comparableValue,
  loadDefaultAuthorityRules,
} from './rules.js';

export type ResolutionMethod =
  'single' | 'agreement' | 'user' | 'authority' | 'recency' | 'only_inferred';

export interface RankedCandidate extends FactWithSource {
  authority: string;
  /** Position in the predicate's authority list (lower = stronger); unlisted = list length. */
  rank: number;
}

export interface Resolution {
  subjects: string[];
  predicate: string;
  status: 'resolved' | 'conflict' | 'none';
  value: JsonValue | undefined;
  /** Winning fact (resolved) or the best-authority fact (conflict). */
  winner: RankedCandidate | undefined;
  /** Origin of the presented value. An inferred value stays "inferred" (§11). */
  origin: FactOrigin | undefined;
  method: ResolutionMethod | undefined;
  candidates: RankedCandidate[];
  /** Id of the persisted conflict when status = conflict and it was detected/persisted. */
  conflictId: string | undefined;
}

export interface ResolverOptions {
  rules?: AuthorityRules;
  clock?: Clock;
  /** All ids that denote the same real-world entity (identity resolution, §14). Default: [id]. */
  expandSubject?: (id: string) => string[];
  /** Representative id for a group of linked ids (used as Conflict.subject). Default: id. */
  canonicalSubject?: (id: string) => string;
}

const ORIGIN_RANK: Record<FactOrigin, number> = {
  user: -1,
  authoritative: 0,
  extracted: 1,
  inferred: 2,
};

export function conflictIdFor(subject: string, predicate: string): Conflict['id'] {
  return stableId('conflict', subject, predicate);
}

/**
 * Per-predicate authority rules + recency weighting (§12). Unresolvable disagreements become
 * Conflicts that are handed to the AI as-is.
 */
export class ConflictResolver {
  readonly rules: AuthorityRules;
  readonly facts: FactStore;
  private readonly refs: SourceReferenceStore;
  private readonly clock: Clock;
  private readonly expand: (id: string) => string[];
  private readonly canonical: (id: string) => string;

  constructor(
    private readonly db: UniContextDatabase,
    options: ResolverOptions = {},
  ) {
    this.rules = options.rules ?? loadDefaultAuthorityRules();
    this.clock = options.clock ?? systemClock;
    this.facts = new FactStore(db, this.clock);
    this.refs = new SourceReferenceStore(db);
    this.expand = options.expandSubject ?? ((id) => [id]);
    this.canonical = options.canonicalSubject ?? ((id) => id);
  }

  private rank(predicate: string, items: FactWithSource[]): RankedCandidate[] {
    const order = authorityOrder(this.rules, predicate);
    return items
      .map((c) => {
        const authority = c.fact.origin === 'user' ? 'user' : (c.source?.authority ?? 'unknown');
        const idx = order.indexOf(authority);
        return { ...c, authority, rank: idx === -1 ? order.length : idx };
      })
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          ORIGIN_RANK[a.fact.origin] - ORIGIN_RANK[b.fact.origin] ||
          b.fact.confidence - a.fact.confidence ||
          b.fact.observedAt.localeCompare(a.fact.observedAt) ||
          a.fact.id.localeCompare(b.fact.id),
      );
  }

  /** Decide what to present for (subjects, predicate). subjects are expanded through identity links. */
  resolve(
    subjects: string | readonly string[],
    predicate: string,
    options: { at?: Date } = {},
  ): Resolution {
    const list = typeof subjects === 'string' ? [subjects] : [...subjects];
    const expanded = [...new Set(list.flatMap((s) => this.expand(s)))];
    const active = this.facts.active({
      subjects: expanded,
      predicate,
      ...(options.at ? { at: options.at } : {}),
    });
    const candidates = this.rank(predicate, this.facts.withSources(active));
    const base = { subjects: expanded, predicate, candidates, conflictId: undefined };
    if (candidates.length === 0)
      return {
        ...base,
        status: 'none',
        value: undefined,
        winner: undefined,
        origin: undefined,
        method: undefined,
      };

    const done = (winner: RankedCandidate, method: ResolutionMethod): Resolution => ({
      ...base,
      status: 'resolved',
      value: winner.fact.value,
      winner,
      origin: winner.fact.origin,
      method,
    });
    const time = (c: RankedCandidate): number => new Date(c.fact.observedAt).getTime();

    // §74: human corrections win, newest first.
    const user = candidates.filter((c) => c.fact.origin === 'user');
    if (this.rules.userOverrides && user.length > 0)
      return done(user.sort((a, b) => time(b) - time(a))[0] as RankedCandidate, 'user');

    // §11: inferred facts never compete with direct evidence.
    const direct = candidates.filter(
      (c) => c.fact.origin !== 'inferred' && c.fact.origin !== 'user',
    );
    if (direct.length === 0) return done(candidates[0] as RankedCandidate, 'only_inferred');

    const groups = new Map<string, RankedCandidate[]>();
    // Two phrasings of the same value (a deadline's dueAt matched by different phrases) agree.
    const keyOf = (c: RankedCandidate): string =>
      stableStringify(comparableValue(this.rules, predicate, c.fact.value) as JsonValue);
    for (const c of direct) {
      const key = keyOf(c);
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    const best = direct[0] as RankedCandidate;
    if (groups.size === 1) return done(best, direct.length === 1 ? 'single' : 'agreement');

    const bestKey = keyOf(best);
    const bestTime = Math.max(...(groups.get(bestKey) ?? []).map(time));
    const listed = authorityOrder(this.rules, predicate).length;
    let challenger: RankedCandidate | undefined;
    let tie = false;
    for (const [key, members] of groups) {
      if (key === bestKey) continue;
      for (const m of members) {
        if (m.fact.confidence < this.rules.minConfidence) continue;
        const sameLevel =
          m.rank === best.rank && ORIGIN_RANK[m.fact.origin] === ORIGIN_RANK[best.fact.origin];
        if (sameLevel && time(m) === bestTime) tie = true;
        if (time(m) > bestTime && (m.rank < listed || sameLevel)) {
          if (!challenger || time(m) > time(challenger)) challenger = m;
        }
      }
    }
    if (tie && !challenger)
      return {
        ...base,
        status: 'conflict',
        value: undefined,
        winner: best,
        origin: best.fact.origin,
        method: undefined,
      };
    if (!challenger) return done(best, 'authority');
    const sameLevel =
      challenger.rank === best.rank &&
      ORIGIN_RANK[challenger.fact.origin] === ORIGIN_RANK[best.fact.origin];
    if (sameLevel || this.rules.recencyOverride === 'recency') return done(challenger, 'recency');
    if (this.rules.recencyOverride === 'authority') return done(best, 'authority');
    return {
      ...base,
      status: 'conflict',
      value: undefined,
      winner: best,
      origin: best.fact.origin,
      method: undefined,
    };
  }

  /**
   * Re-evaluate every live (subject group, predicate) and persist Conflict rows: new
   * disagreements are opened, settled ones are marked resolved. Returns what changed.
   */
  detectConflicts(): { opened: Conflict[]; resolved: Conflict[] } {
    const now = this.clock.now().toISOString();
    const seen = new Set<string>();
    const opened: Conflict[] = [];
    const resolved: Conflict[] = [];
    const multiValued = new Set(this.rules.multiValued);
    for (const { subject, predicate } of this.facts.activePairs()) {
      if (multiValued.has(predicate)) continue;
      const canonical = this.canonical(subject);
      const key = `${canonical}\u0000${predicate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const res = this.resolve(canonical, predicate);
      const id = conflictIdFor(canonical, predicate);
      const existing = this.getConflict(id);
      if (res.status === 'conflict') {
        const candidates = this.toCandidates(
          res.candidates.filter((c) => c.fact.origin !== 'inferred'),
        );
        const changed =
          !existing ||
          existing.status !== 'open' ||
          stableStringify(existing.candidates.map((c) => c.factId).sort()) !==
            stableStringify(candidates.map((c) => c.factId).sort());
        if (
          changed &&
          existing?.status === 'dismissed' &&
          stableStringify(existing.candidates.map((c) => c.factId).sort()) ===
            stableStringify(candidates.map((c) => c.factId).sort())
        )
          continue;
        if (changed) {
          const conflict: Conflict = {
            id,
            subject: canonical as EntityId,
            predicate,
            status: 'open',
            candidates,
            detectedAt: existing?.status === 'open' ? existing.detectedAt : now,
            reason: 'Sources disagree and the newer value comes from a lower-authority source',
          };
          this.saveConflict(conflict);
          if (!existing || existing.status !== 'open') opened.push(conflict);
        }
      } else if (existing?.status === 'open') {
        const conflict: Conflict = {
          ...existing,
          status: 'resolved',
          resolvedAt: now,
          resolution: {
            ...(res.winner ? { factId: res.winner.fact.id } : {}),
            method:
              res.method === 'user'
                ? 'user'
                : res.method === 'recency'
                  ? 'recency'
                  : res.status === 'none'
                    ? 'superseded'
                    : 'authority',
          },
        };
        this.saveConflict(conflict);
        resolved.push(conflict);
      }
    }
    // conflicts whose facts all disappeared
    for (const c of this.listConflicts({ status: 'open' })) {
      if (seen.has(`${c.subject}\u0000${c.predicate}`)) continue;
      const conflict: Conflict = {
        ...c,
        status: 'resolved',
        resolvedAt: now,
        resolution: { method: 'superseded' },
      };
      this.saveConflict(conflict);
      resolved.push(conflict);
    }
    return { opened, resolved };
  }

  private toCandidates(list: RankedCandidate[]): ConflictCandidate[] {
    return list.map((c) => ({
      factId: c.fact.id,
      value: c.fact.value,
      origin: c.fact.origin,
      authority: c.authority,
      sourceSystem: c.source?.sourceSystem ?? 'unknown',
      ...(c.source?.sourceLabel ? { sourceLabel: c.source.sourceLabel } : {}),
      observedAt: c.fact.observedAt,
    }));
  }

  private saveConflict(c: Conflict): void {
    const row = conflictToRow(c, this.clock.now().toISOString());
    this.db.orm
      .insert(conflicts)
      .values(row)
      .onConflictDoUpdate({ target: conflicts.id, set: row })
      .run();
  }

  getConflict(id: string): Conflict | undefined {
    const r = this.db.orm.select().from(conflicts).where(eq(conflicts.id, id)).get();
    return r ? rowToConflict(r) : undefined;
  }

  listConflicts(
    options: { status?: Conflict['status']; subjects?: readonly string[] } = {},
  ): Conflict[] {
    const rows = this.db.orm
      .select()
      .from(conflicts)
      .where(options.status ? and(eq(conflicts.status, options.status)) : undefined)
      .orderBy(asc(conflicts.detectedAt), asc(conflicts.id))
      .all()
      .map(rowToConflict);
    if (!options.subjects) return rows;
    const wanted = new Set(options.subjects.flatMap((s) => [s, this.canonical(s)]));
    return rows.filter((c) => wanted.has(c.subject));
  }

  dismissConflict(id: string): Conflict {
    const c = this.getConflict(id);
    if (!c) throw new NotFoundError(`conflict ${id}`);
    const next: Conflict = {
      ...c,
      status: 'dismissed',
      resolvedAt: this.clock.now().toISOString(),
    };
    this.saveConflict(next);
    return next;
  }

  /**
   * Human correction (§74): store the user's value as an origin=user fact with its own source
   * reference, and resolve any open conflict for it.
   */
  correct(input: {
    subject: string;
    predicate: string;
    value: JsonValue;
    note?: string;
    userId?: string;
  }): { fact: Fact; source: SourceReference; conflict: Conflict | undefined } {
    const now = this.clock.now().toISOString();
    const canonical = this.canonical(input.subject);
    const source = this.refs.upsert({
      id: stableId('sourceReference', 'user', canonical, input.predicate, now),
      sourceSystem: 'user',
      sourceLabel: '本人による修正',
      authority: 'user',
      sourceItemId: `${canonical}#${input.predicate}`,
      retrievedAt: now,
    });
    const fact = this.facts.put({
      id: factId(source.id, canonical, input.predicate, input.value),
      subject: canonical as EntityId,
      predicate: input.predicate,
      value: input.value,
      origin: 'user',
      confidence: 1,
      observedAt: now,
      sourceReferenceId: source.id,
      producer: { type: 'user', id: input.userId ?? 'self' },
      ...(input.note ? { evidence: input.note } : {}),
    });
    // Earlier corrections are superseded by the new one.
    const older = this.facts
      .active({ subjects: this.expand(canonical), predicate: input.predicate })
      .filter((f) => f.origin === 'user' && f.id !== fact.id);
    this.facts.retract(
      older.map((f) => f.id),
      now,
    );
    const id = conflictIdFor(canonical, input.predicate);
    const existing = this.getConflict(id);
    let conflict: Conflict | undefined;
    if (existing && existing.status === 'open') {
      conflict = {
        ...existing,
        status: 'resolved',
        resolvedAt: now,
        resolution: { factId: fact.id, method: 'user' },
      };
      this.saveConflict(conflict);
    }
    return { fact, source, conflict };
  }
}
