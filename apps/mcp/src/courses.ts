import { isIdOf, type CourseOffering } from '@unicontext/canonical-model';
import { NotFoundError, ValidationError } from '@unicontext/core';
import type { CourseRef, UniContext } from '@unicontext/context-engine';

function norm(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length < 2) {
    if (s) out.add(s);
    return out;
  }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function dice(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let n = 0;
  for (const g of x) if (y.has(g)) n++;
  return (2 * n) / (x.size + y.size);
}

/** How well a user-typed course name or code matches an offering (0 = no match). */
export function matchScore(
  query: string,
  offering: Pick<CourseOffering, 'title' | 'courseCode'>,
): number {
  const q = norm(query);
  if (!q) return 0;
  const title = norm(offering.title);
  const code = offering.courseCode ? norm(offering.courseCode) : '';
  if (code && q === code) return 1;
  if (q === title) return 1;
  if (code && code.includes(q) && q.length >= 3) return 0.9;
  if (title.includes(q) && q.length >= 2) return 0.85 + Math.min(0.1, q.length / title.length / 10);
  if (q.includes(title) && title.length >= 3) return 0.8;
  const d = dice(q, title);
  return d >= 0.5 ? d * 0.75 : 0;
}

export interface ResolvedCourse {
  ref: CourseRef;
  offering: CourseOffering | undefined;
}

/**
 * Accepts a course offering id (any linked id) or a fuzzy title / course code, and returns the
 * canonical course (identity-resolved, §14). Throws NotFoundError/ValidationError.
 */
export function resolveCourse(
  uc: UniContext,
  input: string,
  options: {
    /** Writes: when a name matches several offerings, prefer the ones the student takes. */
    preferEnrolled?: boolean;
  } = {},
): ResolvedCourse {
  const text = input.trim();
  if (!text) throw new ValidationError('courseOfferingId is empty');
  const entities = uc.sync.stores.entities;
  if (isIdOf('courseOffering', text)) {
    const found = entities.getOfKind('courseOffering', text);
    if (!found) throw new NotFoundError(`course offering ${text}`);
    const ref = uc.context.courseRef(text);
    if (!ref) throw new NotFoundError(`course offering ${text}`);
    return { ref, offering: entities.getOfKind('courseOffering', ref.id) ?? found };
  }
  const scored = new Map<string, { score: number; offering: CourseOffering; ref: CourseRef }>();
  for (const offering of entities.list('courseOffering')) {
    const score = matchScore(text, offering);
    if (score <= 0) continue;
    const ref = uc.context.courseRef(offering.id);
    if (!ref) continue;
    const prev = scored.get(ref.id);
    if (!prev || score > prev.score) scored.set(ref.id, { score, offering, ref });
  }
  let ranked = [...scored.values()].sort((a, b) => b.score - a.score);
  if (options.preferEnrolled) {
    const enrolled = ranked.filter((r) => uc.context.enrollmentOf(r.ref.id).enrolled);
    if (enrolled.length > 0) ranked = enrolled;
  }
  const best = ranked[0];
  if (!best)
    throw new NotFoundError(`course "${text}" (no course offering matches that id, title or code)`);
  const second = ranked[1];
  if (second && second.score >= best.score - 0.001)
    throw new ValidationError(
      `course "${text}" is ambiguous: ${ranked
        .slice(0, 5)
        .map((r) => `${r.ref.title} (${r.ref.id})`)
        .join(', ')}. Use the exact courseOfferingId.`,
    );
  return {
    ref: best.ref,
    offering: uc.sync.stores.entities.getOfKind('courseOffering', best.ref.id) ?? best.offering,
  };
}

/** All canonical courses (one entry per identity-linked group). */
export function listCourses(uc: UniContext): ResolvedCourse[] {
  const seen = new Map<string, ResolvedCourse>();
  for (const offering of uc.sync.stores.entities.list('courseOffering')) {
    const ref = uc.context.courseRef(offering.id);
    if (!ref || seen.has(ref.id)) continue;
    seen.set(ref.id, {
      ref,
      offering: uc.sync.stores.entities.getOfKind('courseOffering', ref.id) ?? offering,
    });
  }
  return [...seen.values()].sort((a, b) => a.ref.title.localeCompare(b.ref.title, 'ja'));
}
