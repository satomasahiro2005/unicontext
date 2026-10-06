import type { JsonValue } from '@unicontext/canonical-model';
import {
  type Citation,
  type FactWithSource,
  toCitation,
  uniqueCitations,
} from '@unicontext/provenance';
import type { CoverageHealth } from './coverage.js';

/*
 * Attendance (出欠) as the academic system publishes it: the counts LiveCampusU shows per course
 * (出席・欠席・遅刻・早退・公欠・無効 and the 公開状況), stored by the connector as one `attendance`
 * fact per enrolled offering. Raw counts come first and are never turned into a warning here:
 * UniContext does not know a course's attendance rule, so the only derived numbers are shares of a
 * total the university itself gave, and "absences so far" is the university's 欠席 count.
 */

export const ATTENDANCE_PREDICATE = 'attendance';

/** Labels of the counts LiveCampusU lists (keys of the fact value). */
export const ATTENDANCE_COUNT_LABELS: Record<string, string> = {
  attended: '出席',
  absent: '欠席',
  late: '遅刻',
  earlyLeave: '早退',
  excused: '公欠',
  invalid: '無効',
  total: '合計',
};

/** Keys that hold the number of meetings the university counts (only then is a share derived). */
const TOTAL_KEYS = ['total', '合計', '授業回数'] as const;

/** One course's attendance, as the university states it. */
export interface CourseAttendance {
  /** Raw counts exactly as the source gives them (attended / absent / late / earlyLeave / …). */
  counts: Record<string, number>;
  /** 公開状況 as shown (「公開」「非公開」). */
  published?: string | undefined;
  /** When UniContext read it from the source (ISO). */
  asOf: string;
  /** The university's 欠席 count: absences so far (absent when the source gives none). */
  absencesSoFar?: number | undefined;
  /**
   * Shares of the university's own total — present only when the counts include a total. Never a
   * judgement of whether the student may still be absent.
   */
  derived?: { total: number; attendedShare?: number; absentShare?: number } | undefined;
  /** 「出席 8・欠席 1・遅刻 0」 */
  text: string;
  citations: Citation[];
}

function isRecord(v: JsonValue): v is Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The counts and the publication state of one attendance fact value (undefined when it is not one). */
export function parseAttendanceValue(
  value: JsonValue,
): { counts: Record<string, number>; published: string | undefined } | undefined {
  if (!isRecord(value)) return undefined;
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(value))
    if (typeof v === 'number' && Number.isFinite(v)) counts[k] = v;
  const published = typeof value.published === 'string' ? value.published : undefined;
  if (Object.keys(counts).length === 0 && published === undefined) return undefined;
  return { counts, published };
}

const share = (n: number, d: number): number => Math.round((n / d) * 1000) / 1000;

function countsText(counts: Record<string, number>): string {
  const known = Object.keys(ATTENDANCE_COUNT_LABELS).filter((k) => counts[k] !== undefined);
  const other = Object.keys(counts).filter((k) => !(k in ATTENDANCE_COUNT_LABELS));
  return [...known, ...other]
    .map((k) => `${ATTENDANCE_COUNT_LABELS[k] ?? k} ${counts[k]}`)
    .join('・');
}

/**
 * The attendance of a course from its `attendance` facts (every linked offering): the newest one
 * the source still stands behind. Undefined when the university gave no row for the course.
 */
export function readAttendance(
  facts: readonly FactWithSource[],
  timezone: string,
): CourseAttendance | undefined {
  const rows = facts
    .filter((f) => !f.fact.retractedAt && f.fact.predicate === ATTENDANCE_PREDICATE)
    .flatMap((f) => {
      const v = parseAttendanceValue(f.fact.value);
      return v ? [{ f, v }] : [];
    })
    .sort(
      (a, b) =>
        b.f.fact.observedAt.localeCompare(a.f.fact.observedAt) ||
        a.f.fact.id.localeCompare(b.f.fact.id),
    );
  const pick = rows[0];
  if (!pick) return undefined;
  const { counts, published } = pick.v;
  const totalKey = TOTAL_KEYS.find((k) => typeof counts[k] === 'number');
  const total = totalKey ? counts[totalKey] : undefined;
  const derived =
    total !== undefined && total > 0
      ? {
          total,
          ...(counts.attended !== undefined
            ? { attendedShare: share(counts.attended, total) }
            : {}),
          ...(counts.absent !== undefined ? { absentShare: share(counts.absent, total) } : {}),
        }
      : undefined;
  const citations = uniqueCitations(
    rows.flatMap((r) => (r.f.source ? [toCitation(r.f.source, timezone)] : [])),
  );
  return {
    counts,
    ...(published !== undefined ? { published } : {}),
    asOf: pick.f.fact.observedAt,
    ...(counts.absent !== undefined ? { absencesSoFar: counts.absent } : {}),
    ...(derived ? { derived } : {}),
    text: countsText(counts) || (published ? `公開状況: ${published}` : ''),
    citations,
  };
}

/** One course in the attendance overview. */
export interface AttendanceCourseItem {
  course: { id: string; title: string };
  /** Absent when the university has no attendance row for the course. */
  attendance: CourseAttendance | undefined;
  /** Why there is nothing (never a warning about absences). */
  note?: string | undefined;
}

/** How fresh the academic system's data is (the source of the attendance rows). */
export interface AttendanceSourceState {
  sourceId: string;
  label: string;
  health: CoverageHealth;
  lastSuccessAt?: string | undefined;
}

export interface AttendanceOverview {
  view: 'attendance';
  generatedAt: string;
  timezone: string;
  courses: AttendanceCourseItem[];
  coverage: {
    /** Every listed course has a row. */
    complete: boolean;
    /** Courses without a row. */
    missing: number;
    sources: AttendanceSourceState[];
    /** What to tell the student about the freshness and the gaps. */
    note: string;
  };
}
