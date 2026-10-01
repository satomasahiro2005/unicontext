import type { UniContext } from '@unicontext/context-engine';
import { findTerm, termForDate, zonedDateString } from '@unicontext/core';
import { ValidationError } from '@unicontext/core';
import type { CourseSummary, CoursesResponse, TermSummary } from './api-types.js';

export interface CourseListOptions {
  /**
   * Which term: undefined = the current term (academic calendar + today), "all" = every course
   * (also unregistered syllabus-only offerings), otherwise a term id ("2026-1"), its label
   * ("前期", "2026年度 前期") or "current".
   */
  term?: string | undefined;
}

/** Every identity-resolved course offering (§14), unfiltered. */
export function allCourseSummaries(uc: UniContext): CourseSummary[] {
  const courses: CourseSummary[] = [];
  for (const o of uc.sync.stores.entities.list('courseOffering')) {
    if (uc.identity.canonical(o.id) !== o.id) continue; // collapsed into another source's offering
    const c = uc.context.course(o.id);
    courses.push({
      id: c.course.id,
      title: c.course.title,
      courseCode: c.course.courseCode,
      instructors: c.instructors,
      academicYear: c.academicYear,
      term: c.term,
      termId: c.termId,
      scheduleType: c.scheduleType,
      enrolled: c.enrolled,
      retake: c.retake,
      schedule: c.schedule,
      room: c.room,
      linkedIds: c.course.linkedIds,
      openConflicts: c.conflicts.length,
    });
  }
  courses.sort(
    (a, b) =>
      (b.academicYear ?? 0) - (a.academicYear ?? 0) ||
      (a.termId ?? '').localeCompare(b.termId ?? '') ||
      a.title.localeCompare(b.title, 'ja'),
  );
  return courses;
}

/**
 * Courses of one term (default: the current one) — the shape of `GET /api/v1/courses` and
 * `unicontext courses`. Only courses the student registered are listed unless term=all (offerings
 * known only from the public syllabus are other classes of the same subject).
 */
export function listCourses(uc: UniContext, options: CourseListOptions = {}): CoursesResponse {
  const all = allCourseSummaries(uc);
  const cal = uc.profile?.academicCalendar;
  const anyEnrolled = all.some((c) => c.enrolled);
  const mine = anyEnrolled ? all.filter((c) => c.enrolled) : all;
  const today = zonedDateString(uc.clock.now(), uc.timezone);
  const currentTerm = cal ? termForDate(cal, today) : undefined;
  const terms: TermSummary[] = (cal?.terms ?? [])
    .map((t) => ({
      id: t.id,
      name: t.name,
      current: t.id === currentTerm?.id,
      courses: mine.filter((c) => c.termId === t.id).length,
    }))
    .filter((t) => t.current || t.courses > 0);
  const want = options.term?.trim();
  if (want === 'all') return { courses: all, terms };
  if (!cal || cal.terms.length === 0) return { courses: mine, terms };
  const term =
    !want || want === 'current'
      ? currentTerm
      : (cal.terms.find((t) => t.id === want || t.name === want) ??
        findTerm(cal, currentTerm?.year, want) ??
        findTerm(cal, undefined, want));
  if (!term) {
    if (want && want !== 'current')
      throw new ValidationError(`unknown term "${want}"`, {
        details: { known: cal.terms.map((t) => t.id) },
      });
    return { courses: mine, terms };
  }
  return {
    courses: mine.filter((c) => c.termId === term.id),
    term: { id: term.id, name: term.name, current: term.id === currentTerm?.id },
    terms,
  };
}
