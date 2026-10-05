import {
  ENROLLMENT_CONDITION_PREDICATE,
  type EnrollmentDeclarationValue,
  normalizeEnrollmentDeclaration,
} from '@unicontext/canonical-model';
import type { FactStore, FactWithSource } from '@unicontext/provenance';

/**
 * What the student says about taking a course (condition:enrollment fact on the offering).
 *
 * Registration outcomes (履修の許可・不許可、抽選の結果、取消) reach the student by email at some
 * universities (静岡大学: the academic system keeps listing a rejected course as 履修中), so the
 * student's own word is the only source that knows. Semantics (docs/ARCHITECTURE.md §17):
 *
 * - `not_taking` hides the course from every view of the student's own schedule and work (today,
 *   week, next actions, attention, coverage, pace, notifications), confirmed or not. Unconfirmed,
 *   the views add a one-line note that the academic system still lists it.
 * - `taking` brings back a course the academic system marks dropped (same note while unconfirmed).
 * - Nothing is deleted: the enrollment record, its sessions and tasks stay in the database and the
 *   course view shows both the system's status and the declaration.
 *
 * Precedence among declarations: the newest confirmed one (origin user), else the newest
 * unconfirmed one (a chat or a recording).
 */
export interface EnrollmentDeclaration {
  value: EnrollmentDeclarationValue;
  /** The student confirmed it (`unicontext additions confirm`), or entered it as a correction. */
  confirmed: boolean;
  provenance: 'student' | 'chat' | 'recording';
  factId: string;
  evidence: string | undefined;
  observedAt: string;
  /** Source label of the declaration (「Claudeとの会話」, 「本人による確認」). */
  source: string;
  sourceReferenceId: string;
}

export function provenanceOfDeclaration(f: FactWithSource): EnrollmentDeclaration['provenance'] {
  if (f.fact.origin === 'user') return 'student';
  return f.source?.authority === 'transcript' ? 'recording' : 'chat';
}

/** The deciding declaration among active condition:enrollment facts (see the precedence above). */
export function decideEnrollmentDeclaration(
  facts: readonly FactWithSource[],
): EnrollmentDeclaration | undefined {
  const parsed = facts
    .map((f) => ({
      f,
      value:
        typeof f.fact.value === 'string' ? normalizeEnrollmentDeclaration(f.fact.value) : undefined,
    }))
    .filter((x): x is { f: FactWithSource; value: EnrollmentDeclarationValue } => !!x.value);
  if (parsed.length === 0) return undefined;
  const newest = (list: typeof parsed): (typeof parsed)[number] | undefined =>
    [...list].sort(
      (a, b) =>
        b.f.fact.observedAt.localeCompare(a.f.fact.observedAt) ||
        b.f.fact.id.localeCompare(a.f.fact.id),
    )[0];
  const pick = newest(parsed.filter((x) => x.f.fact.origin === 'user')) ?? newest(parsed);
  if (!pick) return undefined;
  const provenance = provenanceOfDeclaration(pick.f);
  return {
    value: pick.value,
    confirmed: provenance === 'student',
    provenance,
    factId: pick.f.fact.id,
    evidence: pick.f.fact.evidence,
    observedAt: pick.f.fact.observedAt,
    source: pick.f.source?.sourceLabel ?? pick.f.source?.sourceSystem ?? 'unknown',
    sourceReferenceId: pick.f.fact.sourceReferenceId,
  };
}

/** Declarations for many offerings at once: one query, grouped by the caller's id sets. */
export function enrollmentDeclarations(
  facts: FactStore,
  groups: readonly (readonly string[])[],
): (EnrollmentDeclaration | undefined)[] {
  const all = [...new Set(groups.flat())];
  if (all.length === 0) return groups.map(() => undefined);
  const active = facts.withSources(
    facts.active({ subjects: all, predicate: ENROLLMENT_CONDITION_PREDICATE }),
  );
  if (active.length === 0) return groups.map(() => undefined);
  return groups.map((ids) => {
    const set = new Set(ids);
    return decideEnrollmentDeclaration(active.filter((f) => set.has(f.fact.subject)));
  });
}
