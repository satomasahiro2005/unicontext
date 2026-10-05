import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ConfigError, NotFoundError } from './errors.js';
import { TERM_HALVES } from './term-parts.js';

const HHMM = z.string().regex(/^\d{1,2}:\d{2}$/, 'expected HH:MM');

export const PeriodSchema = z.object({
  period: z.number().int().positive(),
  start: HHMM,
  end: HHMM,
});
export type PeriodDefinition = z.infer<typeof PeriodSchema>;

const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const DateRangeSchema = z.object({ start: YMD, end: YMD });

/**
 * One half of a term (前半 / 後半, about 8 class weeks each). Courses that meet in one half only
 * get classes inside it. Holidays shift the boundary per weekday (the 8th Monday class may come
 * after the 9th Thursday class), so `weekdays` gives each timetable weekday's own first and last
 * class day of the half; days not listed fall back to `start`/`end`.
 */
export const TermPartDefinitionSchema = z.object({
  half: z.enum(TERM_HALVES),
  /** Label as the academic system writes it (e.g. 後期前半). */
  name: z.string(),
  /** First … last class day of this half on any weekday, inclusive. */
  start: YMD,
  end: YMD,
  /** Per timetable weekday (0 = Sunday … 6 = Saturday, after 振替): its own first … last class day. */
  weekdays: z.record(z.string().regex(/^[0-6]$/), DateRangeSchema).optional(),
});
export type TermPartDefinition = z.infer<typeof TermPartDefinitionSchema>;

export const TermDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Academic year the term belongs to (April start in Japan). */
  year: z.number().int(),
  /** Term label as the academic system writes it (e.g. 前期 / 後期); matches CourseOffering.term. */
  termCode: z.string().optional(),
  /** Whole term (学年暦), inclusive. */
  start: YMD,
  end: YMD,
  /** Weeks with regular classes, inclusive (授業開始 … last regular class). Defaults to start/end. */
  classes: DateRangeSchema.optional(),
  /** Exam period (定期試験 incl. 予備日), inclusive. No regular classes are generated in it. */
  exams: DateRangeSchema.optional(),
  /** 前半 / 後半 when the university splits the term into halves. */
  parts: z.array(TermPartDefinitionSchema).optional(),
});
export type TermDefinition = z.infer<typeof TermDefinitionSchema>;

/**
 * A weekday without regular classes (holiday, 大学祭, 補講日, 対面授業なし …). `campus` / `faculty`
 * limit it to students whose config names that campus / faculty; `fromPeriod` makes it partial.
 */
export const NoClassDaySchema = z.object({
  date: YMD,
  note: z.string(),
  campus: z.string().optional(),
  faculty: z.string().optional(),
  fromPeriod: z.number().int().positive().optional(),
});
export type NoClassDay = z.infer<typeof NoClassDaySchema>;

/** A day that follows another weekday's timetable (e.g. 11/25(水) 月曜授業). Also marks it a class day. */
export const SubstituteDaySchema = z.object({
  date: YMD,
  /** Timetable followed: 0 = Sunday … 6 = Saturday. */
  dayOfWeek: z.number().int().min(0).max(6),
  note: z.string().optional(),
});
export type SubstituteDay = z.infer<typeof SubstituteDaySchema>;

/**
 * Registration limits of the university (履修登録の上限単位数). Only what the deployment states;
 * connectors and the credit summary never invent a cap.
 */
export const CreditCapSchema = z.object({
  /** Max credits per term (学期). */
  perTerm: z.number().positive().optional(),
  /** Max credits per academic year (年間). */
  perYear: z.number().positive().optional(),
  /** Where the value comes from and what it covers (shown next to the number). */
  note: z.string().optional(),
});
export type CreditCap = z.infer<typeof CreditCapSchema>;

/**
 * University deployment profile (§54). Settings only: product code lives in connectors.
 * `products` holds per-product deployment settings (base URLs, auth strategy) consumed by connectors.
 */
export const ProfileSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  locale: z.string().default('ja-JP'),
  academicCalendar: z.object({
    timezone: z.string().default('Asia/Tokyo'),
    periods: z.array(PeriodSchema).default([]),
    terms: z.array(TermDefinitionSchema).default([]),
    noClassDays: z.array(NoClassDaySchema).default([]),
    substituteDays: z.array(SubstituteDaySchema).default([]),
    /** Where these dates come from (document title / URL), shown in provenance. */
    source: z.string().optional(),
  }),
  /** Registration rules (履修登録). */
  registration: z.object({ creditCap: CreditCapSchema.optional() }).optional(),
  sources: z.record(z.string(), z.object({ product: z.string() }).passthrough()).default({}),
  products: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  /** Optional authority overrides merged over the default conflict rules (§12). */
  authorityRules: z.record(z.string(), z.array(z.string())).optional(),
  privacy: z
    .object({
      /** Regex source for the university's student ID format; redacted from logs (§60). */
      studentIdPattern: z.string().optional(),
    })
    .default({}),
});
export type UniversityProfile = z.infer<typeof ProfileSchema>;

export function parseProfile(text: string): UniversityProfile {
  const result = ProfileSchema.safeParse(parseYaml(text));
  if (!result.success) {
    throw new ConfigError(
      `Invalid profile: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  return result.data;
}

/** profiles/ directory shipped in the repository (resolved relative to this package). */
export function builtinProfilesDir(): string {
  // packages/core/{src|dist}/profile.(ts|js) -> repo root /profiles
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'profiles');
}

/** Look up profiles/<id>/profile.yaml in searchPaths (first match wins), then the builtin dir. */
export function loadProfile(
  id: string,
  options: { searchPaths?: string[] } = {},
): UniversityProfile {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new ConfigError(`Invalid profile id: ${id}`);
  const dirs = [...(options.searchPaths ?? []), builtinProfilesDir()];
  for (const dir of dirs) {
    const file = path.join(dir, id, 'profile.yaml');
    if (existsSync(file)) {
      const profile = parseProfile(readFileSync(file, 'utf8'));
      if (profile.id !== id) throw new ConfigError(`Profile id mismatch in ${file}: ${profile.id}`);
      return profile;
    }
  }
  throw new NotFoundError(`Profile not found: ${id}`, { details: { searched: dirs } });
}

/** Returns the period definition (e.g. 2限) from a profile, if defined. */
export function findPeriod(
  profile: UniversityProfile,
  period: number,
): PeriodDefinition | undefined {
  return profile.academicCalendar.periods.find((p) => p.period === period);
}
