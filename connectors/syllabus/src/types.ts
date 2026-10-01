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

export const SyllabusConfigSchema = DeploymentSettingsSchema.extend({
  /** Strategy id, default "lcu-public". */
  strategy: z.string().default('lcu-public'),
  targets: z.array(SyllabusTargetSchema).default([]),
  searches: z.array(SyllabusSearchSchema).default([]),
  /** Units (targets/searches) processed per sync() page. */
  unitsPerPage: z.number().int().positive().default(5),
});
export type SyllabusConfig = z.infer<typeof SyllabusConfigSchema>;

export type SyllabusUnit =
  { kind: 'target'; target: SyllabusTarget } | { kind: 'search'; search: SyllabusSearch };

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
  /** Strategy-private data needed to open the detail (query + row index). */
  handle: unknown;
}

export interface SyllabusSearchResult {
  rows: SyllabusSearchRow[];
  warnings: string[];
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
});
export type SyllabusEntryPayload = z.infer<typeof SyllabusEntryPayloadSchema>;

export const SYLLABUS_ENTRY = 'syllabus.entry';
