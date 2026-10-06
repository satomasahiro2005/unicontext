import { z } from 'zod';
import { DeploymentSettingsSchema } from './profiles/index.js';

/** One course the user wants the syllabus of (usually fed from the LCU timetable). */
export const SyllabusTargetSchema = z.object({
  year: z.number().int(),
  /** Faculty code resolved through the deployment's title table, e.g. "IN-B". */
  faculty: z.string().optional(),
  /** Search form `title` value (year x faculty), e.g. "2243". Overrides `faculty`. */
  titleCode: z.string().optional(),
  /** Bare subject code, e.g. "77403030". */
  subjectCode: z.string().min(1),
  /** Class, e.g. "1クラス" (matched against the result row's class). */
  classCode: z.string().optional(),
});
export type SyllabusTarget = z.infer<typeof SyllabusTargetSchema>;

/** A free search (bounded by `maxRows`): every found row is fetched in detail. */
export const SyllabusSearchSchema = z.object({
  year: z.number().int().optional(),
  faculty: z.string().optional(),
  /** Form `title` value; overrides year/faculty. */
  title: z.string().optional(),
  category: z.string().optional(),
  jikanwariSubjectName: z.string().optional(),
  staffName: z.string().optional(),
  practitionerFlag: z.string().optional(),
  semester: z.string().optional(),
  term: z.string().optional(),
  subjectCode: z.string().optional(),
  numbering: z.string().optional(),
  subjectName: z.string().optional(),
  subjectType: z.string().optional(),
  week: z.string().optional(),
  period: z.string().optional(),
  freeword: z.string().optional(),
  /** Safety cap on the number of detail pages fetched for this search. */
  maxRows: z.number().int().positive().default(10),
});
export type SyllabusSearch = z.infer<typeof SyllabusSearchSchema>;

/** `semester` as printed in config: '1' (前期) or '2' (後期); numbers are accepted too. */
const SemesterCodeSchema = z
  .union([z.literal('1'), z.literal('2'), z.literal(1), z.literal(2)])
  .transform((v): '1' | '2' => (String(v) === '2' ? '2' : '1'));

/**
 * One academic term of the catalog: `current` / `next` follow the clock, `year` is both semesters
 * of the current academic year (前期 stays listed during 後期), or name year + semester.
 */
export const SyllabusCatalogTermSchema = z.union([
  z.enum(['current', 'next', 'year']),
  z.object({ year: z.number().int(), semester: SemesterCodeSchema }),
]);
export type SyllabusCatalogTerm = z.infer<typeof SyllabusCatalogTermSchema>;

/**
 * Daily, polite catalog ingestion: one search per (faculty, term) puts every listed course into
 * the store from the result row alone; syllabus detail pages are opened only up to a budget per
 * run and cached (see docs/connectors/syllabus.md). Off unless configured.
 */
export const SyllabusCatalogSchema = z
  .object({
    /** Faculty codes of the deployment's title table (e.g. "IN-B"), looked up per year. */
    faculties: z.array(z.string().min(1)).default([]),
    /** Search form `title` values used directly (year is taken from the title table when known). */
    titleCodes: z.array(z.string().min(1)).default([]),
    /**
     * Default: the whole current academic year plus the next term, so the half of the year that
     * already ran (or is still to come) stays searchable for planning.
     */
    terms: z.array(SyllabusCatalogTermSchema).min(1).default(['year', 'next']),
    /**
     * Also list the 全学教育 (general education) catalog of each faculty's campus, from the
     * deployment's table (Shizuoka: IN-B / EN-B -> LA-H, the other faculties -> LA-S).
     */
    generalEducation: z.boolean().default(true),
    /** Max syllabus detail pages opened per sync run, shared by all catalog searches. */
    detailsPerRun: z.number().int().nonnegative().default(30),
    /** A cached detail older than this many days is opened again (budget permitting). */
    detailMaxAgeDays: z.number().positive().default(30),
    /** Safety cap of rows per (faculty, term) search. */
    maxRows: z.number().int().positive().default(1500),
  })
  .refine((c) => c.faculties.length + c.titleCodes.length > 0, {
    message: 'catalog needs at least one of faculties / titleCodes',
  });
export type SyllabusCatalog = z.infer<typeof SyllabusCatalogSchema>;

export const SyllabusConfigSchema = DeploymentSettingsSchema.extend({
  /** Strategy id, default "lcu-public". */
  strategy: z.string().default('lcu-public'),
  targets: z.array(SyllabusTargetSchema).default([]),
  searches: z.array(SyllabusSearchSchema).default([]),
  /** Units (targets/searches) processed per sync() page. */
  unitsPerPage: z.number().int().positive().default(5),
  /** Whole-term catalog ingestion (off when absent). */
  catalog: SyllabusCatalogSchema.optional(),
  /** Minimum gap between two HTTP requests of this connector (politeness), 0 disables. */
  minRequestIntervalMs: z.number().int().nonnegative().default(1000),
});
export type SyllabusConfig = z.infer<typeof SyllabusConfigSchema>;

/** One catalog search: a (faculty, term) pair already resolved to a search form `title` value. */
export interface SyllabusCatalogUnit {
  /** Academic year; undefined for a bare `titleCodes` entry that the title table does not know. */
  year: number | undefined;
  /** '1' = 前期, '2' = 後期 (the search form's `semester` value). */
  semester: '1' | '2';
  faculty?: string;
  titleCode: string;
  maxRows: number;
}

export type SyllabusUnit =
  | { kind: 'target'; target: SyllabusTarget }
  | { kind: 'search'; search: SyllabusSearch }
  | { kind: 'catalog'; catalog: SyllabusCatalogUnit };

/** Strategy-independent description of one search result row. */
export interface SyllabusSearchRow {
  /** Dedupe key: subjectCode | class | title. */
  key: string;
  subjectCode: string;
  className: string;
  /** Title column, e.g. "2026年度 情報学部 [IN-B]". */
  title: string;
  year: number | undefined;
  /** Categories of all rows merged into this one (same subject listed under several departments). */
  categories: string[];
  /** Result columns by label (visible labels in Japanese, hidden columns by id). */
  columns: Record<string, string>;
  /** Human-openable entry point of the syllabus search (used when only the row is stored). */
  url?: string;
  /** The form `title` value the row was found with, when known. */
  titleCode?: string;
  /** Strategy-private data needed to open the detail (query + row index). */
  handle: unknown;
}

export interface SyllabusSearchResult {
  rows: SyllabusSearchRow[];
  warnings: string[];
  /** The result was cut at the unit's row cap: rows are missing, so it is not a full listing. */
  truncated?: boolean;
}

/** Parsed syllabus detail page. Unknown labels end up in `extra`. */
export const SyllabusDetailSchema = z.object({
  numbering: z.string().optional(),
  name: z.string().optional(),
  nameEn: z.string().optional(),
  className: z.string().optional(),
  instructors: z.array(z.string()),
  instructorsEn: z.array(z.string()),
  department: z.string().optional(),
  laboratory: z.string().optional(),
  coInstructors: z.array(z.string()),
  grade: z.string().optional(),
  campus: z.string().optional(),
  semester: z.string().optional(),
  termSpan: z.string().optional(),
  /** Raw "曜日・時限", e.g. "木3・4". */
  dayPeriod: z.string().optional(),
  slots: z.array(
    z.object({
      dayOfWeek: z.number().int(),
      /** 90-minute period index: 1・2 -> 1, 3・4 -> 2, ... 13・14 -> 7. */
      period: z.number().int(),
      /** As printed, e.g. "3・4". */
      rawPeriod: z.string(),
    }),
  ),
  room: z.string().optional(),
  requirement: z.string().optional(),
  credits: z.number().optional(),
  keywords: z.array(z.string()),
  goals: z.string().optional(),
  content: z.string().optional(),
  /** Free text printed under 授業計画 (usually 受講要件 / notes). */
  planNote: z.string().optional(),
  plan: z.array(z.object({ no: z.string(), content: z.string() })),
  prerequisites: z.string().optional(),
  textbook: z.string().optional(),
  references: z.string().optional(),
  preparation: z.string().optional(),
  evaluation: z.string().optional(),
  officeHours: z.string().optional(),
  message: z.string().optional(),
  activeLearning: z.array(z.object({ type: z.string(), note: z.string().optional() })),
  practicalExperience: z.array(z.string()),
  practicalExperienceNote: z.string().optional(),
  teacherTraining: z.string().optional(),
  delivery: z.array(z.string()),
  onlineDetail: z.string().optional(),
  extra: z.record(z.string(), z.string()),
});
export type SyllabusDetail = z.infer<typeof SyllabusDetailSchema>;

export function emptySyllabusDetail(): SyllabusDetail {
  return {
    instructors: [],
    instructorsEn: [],
    coInstructors: [],
    slots: [],
    keywords: [],
    plan: [],
    activeLearning: [],
    practicalExperience: [],
    delivery: [],
    extra: {},
  };
}

/** Raw type `syllabus.entry`: one course syllabus (list row + detail). */
export const SyllabusEntryPayloadSchema = z.object({
  strategy: z.string(),
  /** Human-openable entry point of the public syllabus search. */
  url: z.string(),
  title: z.string(),
  titleCode: z.string().optional(),
  year: z.number().int().optional(),
  subjectCode: z.string(),
  className: z.string(),
  categories: z.array(z.string()),
  row: z.record(z.string(), z.string()),
  detail: SyllabusDetailSchema,
  /**
   * False when only the list row is stored (catalog mode ran out of its detail budget): `detail`
   * is empty and everything comes from `row`. Absent means the detail page was read.
   */
  detailFetched: z.boolean().optional(),
});
export type SyllabusEntryPayload = z.infer<typeof SyllabusEntryPayloadSchema>;

export const SYLLABUS_ENTRY = 'syllabus.entry';
