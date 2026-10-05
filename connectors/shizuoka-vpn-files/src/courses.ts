import type { ShizuokaVpnFilesConfig } from './config.js';
import { splitYearPrefix, stripTeacherBracket } from './parse.js';

/**
 * Best-effort course attribution for a folder/file path. Never used to filter the walk — only to
 * propose a course link the student can confirm, and to mark folders for the opt-in mirror.
 */
export interface CourseHint {
  /** Path (relative to the root) of the folder the course was read from. */
  coursePath: string;
  title: string;
  year: number | undefined;
  teacher: string | undefined;
  /** An explicit config mapping value (a course offering id or a course title), if any. */
  explicitCourse: string | undefined;
}

/** Longest config `courseMap` entry matching this root+path, if any. */
function explicitMapping(
  cfg: ShizuokaVpnFilesConfig,
  rootKey: string,
  path: string,
  defaultRoot: string,
): { path: string; course: string } | undefined {
  let best: { path: string; course: string } | undefined;
  for (const m of cfg.courseMap) {
    const mRoot = m.root ?? defaultRoot;
    if (mRoot !== rootKey) continue;
    const prefix = m.path.replace(/^\/+|\/+$/g, '');
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      if (!best || prefix.length > best.path.length) best = { path: prefix, course: m.course };
    }
  }
  return best;
}

/**
 * The course a path belongs to, or undefined. Priority: an explicit `courseMap` mapping, else the
 * shallowest ancestor segment whose name begins with a year (e.g. "2024コンピュータ入門（…）").
 */
export function courseHintForPath(
  cfg: ShizuokaVpnFilesConfig,
  rootKey: string,
  path: string,
  defaultRoot: string,
): CourseHint | undefined {
  const explicit = explicitMapping(cfg, rootKey, path, defaultRoot);
  const segments = path.split('/').filter(Boolean);
  // The shallowest year-prefixed segment defines the course folder.
  let coursePath: string | undefined;
  let title = '';
  let year: number | undefined;
  let teacher: string | undefined;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const yp = splitYearPrefix(seg);
    if (yp.year !== undefined) {
      const name = stripTeacherBracket(yp.rest);
      coursePath = segments.slice(0, i + 1).join('/');
      title = name.title;
      year = yp.year;
      teacher = name.teacher;
      break;
    }
  }
  if (explicit) {
    // The mapped prefix is the course folder; keep a parsed title/year/teacher when available.
    return {
      coursePath: explicit.path,
      title: title || explicit.course,
      year,
      teacher,
      explicitCourse: explicit.course,
    };
  }
  if (coursePath === undefined || !title) return undefined;
  return { coursePath, title, year, teacher, explicitCourse: undefined };
}

/** Does this path sit under any configured prefetch prefix (within the root)? */
export function isPrefetchPath(cfg: ShizuokaVpnFilesConfig, path: string): boolean {
  return cfg.prefetch.some((p) => {
    const prefix = p.replace(/^\/+|\/+$/g, '');
    return prefix === '' || path === prefix || path.startsWith(`${prefix}/`);
  });
}
