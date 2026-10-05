import type { CourseContext } from '@unicontext/context-engine';

/*
 * AI clients get the course view with its long lists cut to the newest items (the Web UI keeps the
 * full view): a course with a big Teams file library otherwise returns well over 100 KB.
 */

export const COURSE_LIMITS_FOR_AI = { materials: 10, files: 20, discussion: 10 } as const;

const newest = <T>(items: readonly T[], at: (x: T) => string | undefined, n: number): T[] =>
  [...items].sort((a, b) => (at(b) ?? '').localeCompare(at(a) ?? '')).slice(0, n);

export function trimCourseForAi(c: CourseContext): {
  data: CourseContext & { materialsTotal: number; discussionTotal: number };
  hint: string | undefined;
} {
  const L = COURSE_LIMITS_FOR_AI;
  const cut =
    c.materials.length > L.materials ||
    c.files.length > L.files ||
    c.discussion.length > L.discussion;
  return {
    data: {
      ...c,
      materials: newest(c.materials, (m) => m.publishedAt, L.materials),
      materialsTotal: c.materials.length,
      discussion: c.discussion.slice(0, L.discussion),
      discussionTotal: c.discussion.length,
      files: newest(c.files, (f) => f.modifiedAt, L.files),
    },
    hint: cut
      ? '資料・ファイル・投稿は新しいものだけを載せています（materialsTotal / filesTotal / discussionTotal が全件数）。ほかは list_course_files・get_teams_activity・search で調べてください。'
      : undefined,
  };
}
