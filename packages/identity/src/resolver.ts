import {
  type EntityKind,
  type IdentityLink,
  type IdentityLinkStatus,
  kindOf,
  stableId,
} from '@unicontext/canonical-model';
import { type Clock, systemClock, ValidationError } from '@unicontext/core';
import {
  EntityStore,
  identityLinks,
  linkToRow,
  rowToLink,
  type UniContextDatabase,
} from '@unicontext/database';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import {
  type CodeScheme,
  DEFAULT_THRESHOLDS,
  isTitleOnly,
  type MatchResult,
  type MatchThresholds,
  type OfferingCandidate,
  scoreOfferingMatch,
  toCandidate,
} from './matcher.js';

export interface IdentityResolverOptions {
  clock?: Clock;
  thresholds?: MatchThresholds;
  /**
   * Lower number = preferred as the canonical member of a linked group (e.g. the academic system).
   * Default: earliest stored entity wins.
   */
  sourcePriority?: (sourceId: string | undefined) => number;
  /**
   * Whether a source's course codes are the university's registrar codes or a platform's own labels
   * (Ed, an LMS). Default: registrar (codes are compared).
   */
  codeScheme?: (sourceId: string | undefined) => CodeScheme | undefined;
}

export interface ResolveReport {
  linked: IdentityLink[];
  suggested: IdentityLink[];
  removed: number;
}

const LIVE: IdentityLinkStatus[] = ['auto', 'confirmed'];
const ENROLLED_EVIDENCE = 'the only offering with this title the student is enrolled in';

function ordered(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Persisted identity resolution (§14). Links are pairwise; the connected components of
 * auto+confirmed links define "the same thing". User decisions are never overridden.
 */
export class IdentityResolver {
  private readonly clock: Clock;
  private readonly thresholds: MatchThresholds;
  private readonly entities: EntityStore;
  private readonly priority: (sourceId: string | undefined) => number;
  private readonly codeScheme: (sourceId: string | undefined) => CodeScheme | undefined;
  private cache: Map<string, string[]> | undefined;

  constructor(
    private readonly db: UniContextDatabase,
    options: IdentityResolverOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
    this.entities = new EntityStore(db, { clock: this.clock });
    this.priority = options.sourcePriority ?? (() => 0);
    this.codeScheme = options.codeScheme ?? (() => undefined);
  }

  getLink(a: string, b: string): IdentityLink | undefined {
    const [l, r] = ordered(a, b);
    const row = this.db.orm
      .select()
      .from(identityLinks)
      .where(and(eq(identityLinks.leftId, l), eq(identityLinks.rightId, r)))
      .get();
    return row ? rowToLink(row) : undefined;
  }

  listLinks(options: { status?: IdentityLinkStatus; entityId?: string } = {}): IdentityLink[] {
    const conds = [];
    if (options.status) conds.push(eq(identityLinks.status, options.status));
    if (options.entityId)
      conds.push(
        or(eq(identityLinks.leftId, options.entityId), eq(identityLinks.rightId, options.entityId)),
      );
    return this.db.orm
      .select()
      .from(identityLinks)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(identityLinks.leftId), asc(identityLinks.rightId))
      .all()
      .map(rowToLink);
  }

  /** Create or update a link. Rejected/confirmed links are only changed by decidedBy "user". */
  link(
    a: string,
    b: string,
    input: {
      status: IdentityLinkStatus;
      score: number;
      method: string;
      evidence?: string[];
      decidedBy: 'system' | 'user';
    },
  ): IdentityLink {
    if (a === b) throw new ValidationError('Cannot link an entity to itself');
    const kind = kindOf(a);
    if (kind !== kindOf(b)) throw new ValidationError(`Cannot link ${kindOf(a)} to ${kindOf(b)}`);
    const existing = this.getLink(a, b);
    if (existing && existing.decidedBy === 'user' && input.decidedBy === 'system') return existing;
    const [l, r] = ordered(a, b);
    const now = this.clock.now().toISOString();
    const link: IdentityLink = {
      id: existing?.id ?? stableId('identityLink', l, r),
      entityKind: kind as EntityKind,
      leftId: l as IdentityLink['leftId'],
      rightId: r as IdentityLink['rightId'],
      status: input.status,
      score: input.score,
      method: input.method,
      evidence: input.evidence ?? [],
      decidedBy: input.decidedBy,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const row = linkToRow(link);
    this.db.orm
      .insert(identityLinks)
      .values(row)
      .onConflictDoUpdate({ target: identityLinks.id, set: row })
      .run();
    this.cache = undefined;
    return link;
  }

  /** User confirmation (§14): "these are the same course". */
  confirm(a: string, b: string, note?: string): IdentityLink {
    const prev = this.getLink(a, b);
    return this.link(a, b, {
      status: 'confirmed',
      score: 1,
      method: prev?.method ?? 'user',
      evidence: [...(prev?.evidence ?? []), ...(note ? [note] : []), 'confirmed by user'],
      decidedBy: 'user',
    });
  }

  /** User rejection: never suggest/link this pair again. */
  reject(a: string, b: string, note?: string): IdentityLink {
    const prev = this.getLink(a, b);
    return this.link(a, b, {
      status: 'rejected',
      score: 0,
      method: prev?.method ?? 'user',
      evidence: [...(prev?.evidence ?? []), ...(note ? [note] : []), 'rejected by user'],
      decidedBy: 'user',
    });
  }

  /** Match CourseOfferings from different sources and persist auto/suggested links. */
  resolveCourseOfferings(): ResolveReport {
    const offerings = this.entities.list('courseOffering').map((o) => {
      const sourceId = this.entities.meta(o.id)?.sourceId;
      return toCandidate(o, sourceId, this.codeScheme(sourceId));
    });
    const report: ResolveReport = { linked: [], suggested: [], removed: 0 };
    // Every pair of offerings from different sources is scored: with a catalog source (syllabus,
    // VPN folders) that is ~10^6 pairs. The existing links are therefore read once, not queried per
    // pair (each drizzle query prepares a better-sqlite3 statement whose ~9 KB of native memory V8
    // does not see, so a million of them ran the process into gigabytes before a GC freed them),
    // and only pairs that match or have a link to remove are kept.
    const existingLinks = new Map<string, IdentityLink>();
    for (const row of this.db.orm
      .select()
      .from(identityLinks)
      .where(eq(identityLinks.entityKind, 'courseOffering'))
      .all())
      existingLinks.set(`${row.leftId}|${row.rightId}`, rowToLink(row));
    const existingLink = (a: string, b: string): IdentityLink | undefined =>
      existingLinks.get(ordered(a, b).join('|'));
    const pairs: {
      a: OfferingCandidate;
      b: OfferingCandidate;
      m: MatchResult;
      existing: IdentityLink | undefined;
    }[] = [];
    for (let i = 0; i < offerings.length; i++) {
      for (let j = i + 1; j < offerings.length; j++) {
        const a = offerings[i];
        const b = offerings[j];
        if (!a || !b || (a.sourceId && a.sourceId === b.sourceId)) continue;
        const existing = existingLink(a.id, b.id);
        if (existing?.decidedBy === 'user') continue;
        const m = scoreOfferingMatch(a, b, { thresholds: this.thresholds });
        if (m.decision === 'none' && !existing) continue;
        pairs.push({ a, b, m, existing });
      }
    }
    this.demoteAmbiguousTitleOnly(pairs);
    for (const { a, b, m, existing } of pairs) {
      if (m.decision === 'none') {
        if (existing) {
          this.db.orm.delete(identityLinks).where(eq(identityLinks.id, existing.id)).run();
          this.cache = undefined;
          report.removed++;
        }
        continue;
      }
      const status: IdentityLinkStatus = m.decision === 'link' ? 'auto' : 'suggested';
      if (existing && existing.status === status && existing.score === m.score) continue;
      const link = this.link(a.id, b.id, {
        status,
        score: m.score,
        method: 'course-offering-matcher',
        evidence: m.evidence,
        decidedBy: 'system',
      });
      (status === 'auto' ? report.linked : report.suggested).push(link);
    }
    return report;
  }

  /**
   * Offerings the student takes: targets of their active student enrollments (the self person's,
   * when one is marked).
   */
  private enrolledOfferingIds(): Set<string> {
    const self = new Set(
      this.entities
        .list('person')
        .filter((p) => p.isSelf)
        .map((p) => p.id as string),
    );
    return new Set(
      this.entities
        .list('enrollment')
        .filter(
          (e) =>
            e.status === 'active' &&
            e.role === 'student' &&
            (self.size === 0 || self.has(e.personId)),
        )
        .map((e) => e.courseOfferingId as string),
    );
  }

  /**
   * Links are unioned transitively, so a title-only offering (a folder named 「英語I」, an Ed
   * course) auto-linked to two different offerings with that title (two sections from the
   * syllabus) would merge those sections into one course. When the offerings a title-only one would
   * auto-link to are not all linked to each other on their own evidence (or by the user), those
   * links become suggestions, unless exactly one of those offerings (with what it is linked to) is
   * one the student is enrolled in: the student's own course is then the one meant, and only the
   * links to the others become suggestions.
   */
  private demoteAmbiguousTitleOnly(
    pairs: { a: OfferingCandidate; b: OfferingCandidate; m: MatchResult }[],
  ): void {
    const key = (x: string, y: string): string => ordered(x, y).join('|');
    const linked = new Set<string>();
    for (const { a, b, m } of pairs)
      if (m.decision === 'link' && !m.titleOnly) linked.add(key(a.id, b.id));
    for (const l of this.listLinks({ status: 'confirmed' })) linked.add(key(l.leftId, l.rightId));
    const byHub = new Map<string, MatchResult[]>();
    const targets = new Map<string, string[]>();
    for (const { a, b, m } of pairs) {
      if (m.decision !== 'link' || !m.titleOnly) continue;
      for (const [hub, other] of [
        [a, b],
        [b, a],
      ] as const) {
        if (!isTitleOnly(hub)) continue;
        byHub.set(hub.id, [...(byHub.get(hub.id) ?? []), m]);
        targets.set(hub.id, [...(targets.get(hub.id) ?? []), other.id]);
      }
    }
    let enrolled: Set<string> | undefined;
    for (const [hub, others] of targets) {
      const ambiguous = others.some((x, i) =>
        others.slice(i + 1).some((y) => !linked.has(key(x, y))),
      );
      if (!ambiguous) continue;
      // Groups of targets that are linked to each other; keep the links into the one enrolled group.
      enrolled ??= this.enrolledOfferingIds();
      let groups: string[][] = [];
      for (const x of others) {
        const hits = groups.filter((members) => members.some((y) => linked.has(key(x, y))));
        groups = [...groups.filter((g) => !hits.includes(g)), [x, ...hits.flat()]];
      }
      const mine = groups.filter((g) => g.some((x) => enrolled?.has(x)));
      const keep = mine.length === 1 ? new Set(mine[0]) : new Set<string>();
      const matches = byHub.get(hub) ?? [];
      others.forEach((other, i) => {
        const m = matches[i];
        if (!m || m.decision !== 'link') return;
        if (keep.has(other)) {
          if (!m.evidence.includes(ENROLLED_EVIDENCE)) m.evidence.push(ENROLLED_EVIDENCE);
          return;
        }
        m.decision = 'suggest';
        m.evidence.push('same title matches several different offerings; needs confirmation');
      });
    }
  }

  private components(): Map<string, string[]> {
    if (this.cache) return this.cache;
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let p = parent.get(x) ?? x;
      if (p !== x) {
        p = find(p);
        parent.set(x, p);
      }
      return p;
    };
    const live = this.db.orm
      .select()
      .from(identityLinks)
      .where(inArray(identityLinks.status, LIVE))
      .all();
    for (const l of live) {
      const ra = find(l.leftId);
      const rb = find(l.rightId);
      if (ra !== rb) parent.set(ra, rb);
    }
    const groups = new Map<string, string[]>();
    for (const id of new Set(live.flatMap((l) => [l.leftId, l.rightId]))) {
      const root = find(id);
      groups.set(root, [...(groups.get(root) ?? []), id]);
    }
    const byMember = new Map<string, string[]>();
    for (const members of groups.values()) {
      const sorted = this.sortMembers(members);
      for (const m of sorted) byMember.set(m, sorted);
    }
    this.cache = byMember;
    return byMember;
  }

  private sortMembers(members: string[]): string[] {
    const info = members.map((id) => ({ id, meta: this.entities.meta(id) }));
    return info
      .sort(
        (a, b) =>
          this.priority(a.meta?.sourceId) - this.priority(b.meta?.sourceId) ||
          (a.meta?.createdAt ?? '').localeCompare(b.meta?.createdAt ?? '') ||
          a.id.localeCompare(b.id),
      )
      .map((x) => x.id);
  }

  /** All ids denoting the same entity (incl. id itself), canonical first. */
  expand(id: string): string[] {
    return this.components().get(id) ?? [id];
  }

  /** Representative id of the group. */
  canonical(id: string): string {
    return this.expand(id)[0] ?? id;
  }

  /** Forget cached components (call after writing links through another instance). */
  invalidate(): void {
    this.cache = undefined;
  }
}
