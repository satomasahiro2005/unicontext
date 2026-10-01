import { extractYear } from '@unicontext/identity';

export interface CourseInference {
  courseFolder?: string;
  termFolder?: string;
}

/**
 * Infer the course folder of a file from its path below the root. Folders matching `termPattern`
 * (2026前期, 2026-1, R8後期 ...) are skipped; the `depth`-th remaining folder is the course.
 */
export function inferCourseFolder(
  relativePath: string,
  options: { termPattern: RegExp; depth: number },
): CourseInference {
  const dirs = relativePath.split('/').slice(0, -1);
  let termFolder: string | undefined;
  const rest: string[] = [];
  for (const d of dirs) {
    if (options.termPattern.test(d)) termFolder ??= d;
    else rest.push(d);
  }
  const courseFolder = rest[options.depth - 1];
  return {
    ...(courseFolder ? { courseFolder } : {}),
    ...(termFolder ? { termFolder } : {}),
  };
}

/** Academic year from a folder name: 2026前期, 2026-1, R8後期 (令和8 = 2026). */
export function academicYearFromFolder(name: string | undefined): number | undefined {
  if (!name) return undefined;
  const y = extractYear(name);
  if (y) return y;
  const m = /(?:令和|(?<![a-z])r)\s?(\d{1,2})/i.exec(name.normalize('NFKC'));
  if (m) return 2018 + Number(m[1]);
  return undefined;
}

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Date in a file name: `2026-10-01`, `2026_10_01`, `20261001`, `2026年10月1日`, `10月1日`
 * (year from `academicYear` - January to March roll into the following year - else `fallbackYear`).
 */
export function parseDateFromName(
  name: string,
  options: { fallbackYear?: number; academicYear?: number } = {},
): string | undefined {
  const s = name.normalize('NFKC');
  let m = /(?<!\d)((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(s);
  if (!m) m = /(?<!\d)((?:19|20)\d{2})[-_./](\d{1,2})[-_./](\d{1,2})(?!\d)/.exec(s);
  if (!m) m = /(?<!\d)((?:19|20)\d{2})(\d{2})(\d{2})(?!\d)/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validDate(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : undefined;
  }
  const md = /(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(s);
  if (md) {
    const mo = Number(md[1]);
    const d = Number(md[2]);
    let y = options.academicYear ?? options.fallbackYear;
    if (y === undefined) return undefined;
    if (options.academicYear !== undefined && mo < 4) y += 1;
    return validDate(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : undefined;
  }
  return undefined;
}
