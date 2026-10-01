import type { CourseOffering } from '@unicontext/canonical-model';
import {
  extractYear,
  normalizeCourseCode,
  normalizeTerm,
  personNamesMatch,
  titleSimilarity,
  type TitleNormalizeOptions,
} from './normalize.js';

export interface OfferingCandidate {
  id: string;
  sourceId: string | undefined;
  title: string;
  courseCode: string | undefined;
  academicYear: number | undefined;
  term: string | undefined;
  instructorNames: string[];
  schedule: { dayOfWeek: number; period?: number }[];
}

export function toCandidate(o: CourseOffering, sourceId?: string): OfferingCandidate {
  return {
    id: o.id,
    sourceId,
    title: o.title,
    courseCode: o.courseCode,
    academicYear: o.academicYear ?? extractYear(o.title),
    term: o.term,
    instructorNames: o.instructorNames,
    schedule: o.schedule.map((s) => ({
      dayOfWeek: s.dayOfWeek,
      ...(s.period ? { period: s.period } : {}),
    })),
  };
}

export interface MatchThresholds {
  /** Score at or above which a link is created automatically. */
  link: number;
  /** Score at or above which a link is suggested for user confirmation. */
  suggest: number;
}

export const DEFAULT_THRESHOLDS: MatchThresholds = { link: 0.75, suggest: 0.5 };

export interface MatchResult {
  score: number;
  decision: 'link' | 'suggest' | 'none';
  evidence: string[];
  veto: string | undefined;
}

/**
 * Weighted evidence (§14): course code, normalized title similarity, teacher, term/year, timetable.
 * A year or term mismatch vetoes the match (different CourseOfferings of the same Course, §8).
 */
export function scoreOfferingMatch(
  a: OfferingCandidate,
  b: OfferingCandidate,
  options: { thresholds?: MatchThresholds; glossary?: TitleNormalizeOptions['glossary'] } = {},
): MatchResult {
  const t = options.thresholds ?? DEFAULT_THRESHOLDS;
  const evidence: string[] = [];
  const none = (veto: string): MatchResult => ({
    score: 0,
    decision: 'none',
    evidence: [veto],
    veto,
  });

  if (a.academicYear && b.academicYear && a.academicYear !== b.academicYear)
    return none(`year differs (${a.academicYear} vs ${b.academicYear})`);
  const ta = normalizeTerm(a.term);
  const tb = normalizeTerm(b.term);
  if (ta && tb && ta !== tb) return none(`term differs (${a.term} vs ${b.term})`);

  let score = 0;
  let codeMatch = false;
  if (a.courseCode && b.courseCode) {
    if (normalizeCourseCode(a.courseCode) === normalizeCourseCode(b.courseCode)) {
      score += 0.4;
      codeMatch = true;
      evidence.push(`course code ${a.courseCode}`);
    } else {
      score -= 0.2;
      evidence.push(`course code differs (${a.courseCode} vs ${b.courseCode})`);
    }
  }
  const sim = titleSimilarity(
    a.title,
    b.title,
    options.glossary ? { glossary: options.glossary } : {},
  );
  score += 0.5 * sim;
  evidence.push(`title similarity ${sim.toFixed(2)} ("${a.title}" ~ "${b.title}")`);

  if (a.instructorNames.length && b.instructorNames.length) {
    const hit = a.instructorNames.find((x) =>
      b.instructorNames.some((y) => personNamesMatch(x, y)),
    );
    if (hit) {
      score += 0.2;
      evidence.push(`teacher ${hit}`);
    } else {
      score -= 0.1;
      evidence.push('teachers differ');
    }
  }
  if (a.academicYear && b.academicYear) {
    score += 0.05;
    evidence.push(`year ${a.academicYear}`);
  }
  if (ta && tb) {
    score += 0.05;
    evidence.push(`term ${ta}`);
  }
  if (a.schedule.length && b.schedule.length) {
    const overlap = a.schedule.some((x) =>
      b.schedule.some(
        (y) =>
          x.dayOfWeek === y.dayOfWeek &&
          (x.period === undefined || y.period === undefined || x.period === y.period),
      ),
    );
    if (overlap) {
      score += 0.15;
      evidence.push('timetable slot overlaps');
    } else {
      score -= 0.1;
      evidence.push('timetable differs');
    }
  }
  score = Math.max(0, Math.min(1, score));
  const strongEnough = codeMatch || sim >= 0.5;
  const decision =
    score >= t.link && strongEnough
      ? 'link'
      : score >= t.suggest && strongEnough
        ? 'suggest'
        : 'none';
  return { score: Math.round(score * 1000) / 1000, decision, evidence, veto: undefined };
}
