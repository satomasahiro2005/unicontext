import { load } from 'cheerio';
import { cleanText } from '../html.js';
import { parseTable, pick, type TableRow } from './table.js';

export const EXAM_EMPTY_MARKER = '対象の科目はありません';

/** One row of 試験時間割 (SC_18001B00_19). Column layout is unobserved, so fields are heuristic. */
export interface ExamRow {
  subject: string;
  date?: string;
  period?: string;
  time?: string;
  room?: string;
  teacher?: string;
  /** Every cell keyed by header label (raw). */
  cells: Record<string, string>;
}

function firstTable(html: string, ...selectors: string[]): ReturnType<typeof parseTable> {
  const $ = load(html);
  const scope = $('main').length ? 'main ' : '';
  for (const sel of selectors) {
    const t = parseTable($, `${scope}${sel}`);
    if (t && t.rows.length > 0) return t;
  }
  return undefined;
}

function nonEmpty(v: string | undefined): string | undefined {
  const s = cleanText(v);
  return s ? s : undefined;
}

/** Parse 試験時間割. 「対象の科目はありません」 → []. */
export function parseExamTimetable(html: string): ExamRow[] {
  const $ = load(html);
  const visible = ($('main').length ? $('main') : $('body')).text();
  if (visible.includes(EXAM_EMPTY_MARKER)) return [];
  const table = firstTable(html, 'table#dataTable01', 'table.c-table', 'table');
  if (!table) return [];
  const out: ExamRow[] = [];
  for (const row of table.rows) {
    const subject = nonEmpty(pick(row, '科目名', '講義名', '授業科目', 'subjectName'));
    if (!subject) continue;
    const date = nonEmpty(pick(row, '試験日', '日付', '実施日', 'examDate'));
    const period = nonEmpty(pick(row, '時限', 'period'));
    const time = nonEmpty(pick(row, '時間', 'time'));
    const room = nonEmpty(pick(row, '教室', '講義室', '試験室', 'room'));
    const teacher = nonEmpty(pick(row, '担当教員', '教員', 'staffName'));
    out.push({
      subject,
      ...(date ? { date } : {}),
      ...(period ? { period } : {}),
      ...(time ? { time } : {}),
      ...(room ? { room } : {}),
      ...(teacher ? { teacher } : {}),
      cells: labelCells(table.columns, row),
    });
  }
  return out;
}

function labelCells(
  columns: { id: string; label: string }[],
  row: TableRow,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row.cells)) {
    const col = columns.find((c) => c.id === k || c.label === k);
    out[col?.label || k] = cleanText(v);
  }
  return out;
}

/** 出欠 (SC_13002B00_01): counts per course. */
export interface AttendanceRow {
  subject: string;
  /** Subject code from the hidden classSubjectCode column, when present. */
  subjectCode?: string;
  /** 学期/曜日・時限 text. */
  schedule: string;
  published?: string;
  counts: {
    attended?: number;
    absent?: number;
    late?: number;
    earlyLeave?: number;
    excused?: number;
    invalid?: number;
  };
}

const ATTENDANCE_COLUMNS: [keyof AttendanceRow['counts'], string][] = [
  ['attended', '出席'],
  ['absent', '欠席'],
  ['late', '遅刻'],
  ['earlyLeave', '早退'],
  ['excused', '公欠'],
  ['invalid', '無効'],
];

function count(v: string | undefined): number | undefined {
  const s = cleanText(v)
    .normalize('NFKC')
    .replace(/[回件]$/, '');
  if (!/^\d+$/.test(s)) return undefined;
  return Number(s);
}

export function parseAttendance(html: string): AttendanceRow[] {
  const table = firstTable(html, 'table#dataTable01', 'table.c-table', 'table');
  if (!table) return [];
  const byLabel = (row: TableRow, label: string): string | undefined => {
    const col = table.columns.findIndex((c) => cleanText(c.label) === label);
    if (col < 0) return undefined;
    const c = table.columns[col];
    return c ? (row.cells[c.id || c.label] ?? row.cells[`col${col}`]) : undefined;
  };
  const out: AttendanceRow[] = [];
  for (const row of table.rows) {
    const subject = nonEmpty(byLabel(row, '講義名') ?? pick(row, '講義名'));
    if (!subject) continue;
    const counts: AttendanceRow['counts'] = {};
    for (const [key, label] of ATTENDANCE_COLUMNS) {
      const n = count(byLabel(row, label));
      if (n !== undefined) counts[key] = n;
    }
    const published = nonEmpty(byLabel(row, '公開状況'));
    const code = /^(?:\d{4})?(\d{8})(?:\D|$)/.exec(cleanText(row.cells.classSubjectCode))?.[1];
    out.push({
      ...(code ? { subjectCode: code } : {}),
      subject: (byLabel(row, '講義名') ?? subject).split('\n')[0]?.trim() ?? subject,
      schedule: cleanText(byLabel(row, '学期/曜日・時限') ?? pick(row, '曜日・時限') ?? ''),
      ...(published ? { published } : {}),
      counts,
    });
  }
  return out;
}

// 成績 parsers live in grades.ts (re-exported for existing imports).
export * from './grades.js';
