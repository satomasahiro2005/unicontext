import { normalizeCourseTitle } from '@unicontext/identity';
import type { Citation } from '@unicontext/provenance';

/*
 * Course lineage: the earlier years' offerings of the course the student takes now. A teacher
 * gives the same course again and again, and last year's lessons, slides and Ed threads are the
 * best study material for this year's — but they are NOT this year's course. So lineage is only a
 * pointer (a derived fact on the current offering), never an identity link: the prior offering
 * stays a separate course, its assignments and deadlines never enter this year's views, and its
 * documents and threads are shown labelled 「前年度（2025）の参考資料」.
 */

export const LINEAGE_PREDICATE = 'course:lineage';

/** How an earlier offering was recognized as the same course. */
export type LineageBasis = 'title' | 'courseCode';

/** What the derived `course:lineage` fact holds (JSON). */
export interface LineageValue {
  /** Canonical ids of the earlier offerings, newest year first. */
  priorOfferingIds: string[];
  /** Why each one counts: the same normalized title and / or the same course code. */
  basis: Record<string, LineageBasis[]>;
}

/** An offering as lineage needs it. */
export interface LineageOffering {
  id: string;
  title: string;
  academicYear: number | undefined;
  courseCode: string | undefined;
}

/** 「前年度（2025）の参考資料」 */
export function priorYearLabel(year: number): string {
  return `前年度（${year}）の参考資料`;
}

/**
 * Same-title comparison key: the identity package's normalized course title (width and case
 * folded; years, terms, timetable brackets and punctuation dropped; 論 / 学 endings and the usual
 * abbreviations unified), so 「データベース システム論」 and 「2025 データベースシステム論」 are one.
 */
export function lineageTitleKey(title: string): string {
  return normalizeCourseTitle(title);
}

function normalizeCode(code: string | undefined): string | undefined {
  const c = code?.normalize('NFKC').trim().toUpperCase();
  return c && c.length >= 3 ? c : undefined;
}

/**
 * The earlier offerings of a course: any offering of another academic year before the current one
 * (from any source) that has the same normalized title or the same course code as one of the
 * course's linked offerings. Identity-linked earlier offerings (a 2025 LiveCampusU entry and the
 * 2025 Ed course, linked to each other) are one prior offering, named by their canonical id.
 *
 * @param current every linked offering of the current course
 * @param all every known offering
 * @param canonical identity canonical id (so linked earlier offerings collapse)
 */
export function computeLineage(
  current: readonly LineageOffering[],
  all: readonly LineageOffering[],
  canonical: (id: string) => string,
): LineageValue | undefined {
  const years = current.map((c) => c.academicYear).filter((y): y is number => y !== undefined);
  if (years.length === 0) return undefined;
  const year = Math.max(...years);
  const own = new Set(current.map((c) => c.id));
  const titles = new Set(current.map((c) => lineageTitleKey(c.title)).filter((t) => t.length >= 2));
  const codes = new Set(
    current.map((c) => normalizeCode(c.courseCode)).filter((c) => c !== undefined),
  );
  const found = new Map<string, { year: number; basis: Set<LineageBasis> }>();
  for (const o of all) {
    if (own.has(o.id) || o.academicYear === undefined || o.academicYear >= year) continue;
    const basis = new Set<LineageBasis>();
    if (titles.has(lineageTitleKey(o.title))) basis.add('title');
    const code = normalizeCode(o.courseCode);
    if (code && codes.has(code)) basis.add('courseCode');
    if (basis.size === 0) continue;
    const id = canonical(o.id);
    if (own.has(id)) continue;
    const prev = found.get(id);
    if (prev) {
      for (const b of basis) prev.basis.add(b);
      prev.year = Math.max(prev.year, o.academicYear);
    } else found.set(id, { year: o.academicYear, basis });
  }
  if (found.size === 0) return undefined;
  const ordered = [...found.entries()].sort(
    (a, b) => b[1].year - a[1].year || a[0].localeCompare(b[0]),
  );
  return {
    priorOfferingIds: ordered.map(([id]) => id),
    basis: Object.fromEntries(ordered.map(([id, v]) => [id, [...v.basis].sort()])),
  };
}

/** Reads a stored `course:lineage` value defensively. */
export function parseLineageValue(value: unknown): LineageValue | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const v = value as { priorOfferingIds?: unknown; basis?: unknown };
  if (!Array.isArray(v.priorOfferingIds)) return undefined;
  const ids = v.priorOfferingIds.filter((x): x is string => typeof x === 'string');
  const basisIn =
    typeof v.basis === 'object' && v.basis !== null && !Array.isArray(v.basis)
      ? (v.basis as Record<string, unknown>)
      : {};
  const basis: Record<string, LineageBasis[]> = {};
  for (const id of ids) {
    const b = basisIn[id];
    basis[id] = Array.isArray(b)
      ? b.filter((x): x is LineageBasis => x === 'title' || x === 'courseCode')
      : [];
  }
  return ids.length > 0 ? { priorOfferingIds: ids, basis } : undefined;
}

/** One earlier offering of the course (get_course `lineage`). */
export interface PriorOffering {
  id: string;
  /** Academic year of the offering. */
  year: number | undefined;
  title: string;
  /** Source ids that know this earlier offering (「edstem」「livecampusu」). */
  sources: string[];
  /** Why it counts as the same course. */
  basis: LineageBasis[];
}

export interface CourseLineageView {
  priorOfferings: PriorOffering[];
}

/**
 * A document / lesson / thread of an earlier offering, offered as study material for this year's
 * course. It is a reference only: nothing here is a deadline or an assignment of this year.
 */
export interface HistoricalResource {
  id: string;
  kind: 'document' | 'thread';
  title: string;
  /** Academic year of the offering it comes from. */
  academicYear: number | undefined;
  /** 「前年度（2025）の参考資料」 */
  label: string;
  /** The earlier offering. */
  course: { id: string; title: string };
  /** Library path (an Ed lesson: /Ed Lessons/<module>/<lesson>). */
  path?: string | undefined;
  url?: string | undefined;
  /** The first words of the text. */
  snippet?: string | undefined;
  citations: Citation[];
}

/** The most historical resources one course view lists. */
export const HISTORICAL_RESOURCE_LIMIT = 20;
