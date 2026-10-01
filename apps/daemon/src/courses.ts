import type { UniContext } from '@unicontext/context-engine';
import type { CourseSummary } from './api-types.js';

/** Identity-resolved course offerings (§14), the shape of `GET /api/v1/courses` and `unicontext courses`. */
export function buildCourseSummaries(uc: UniContext): CourseSummary[] {
  const courses: CourseSummary[] = [];
  for (const o of uc.sync.stores.entities.list('courseOffering')) {
    if (uc.identity.canonical(o.id) !== o.id) continue; // collapsed into another source's offering
    const c = uc.context.course(o.id);
    courses.push({
      id: c.course.id,
      title: c.course.title,
      courseCode: c.course.courseCode,
      instructors: c.instructors,
      academicYear: o.academicYear,
      term: o.term,
      schedule: c.schedule,
      room: c.room,
      linkedIds: c.course.linkedIds,
      openConflicts: c.conflicts.length,
    });
  }
  courses.sort((a, b) => a.title.localeCompare(b.title, 'ja'));
  return courses;
}
