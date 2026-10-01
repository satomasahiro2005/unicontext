import { load } from 'cheerio';
import { cleanLines, cleanText, fragmentText } from '../html.js';
import { parseTable } from './table.js';

/** Column ids of 課題・アンケートリスト (SC_14002B00_01) in server order. */
export const ASSIGNMENT_COLUMNS = [
  'submissionTypeName',
  'submissionSeq',
  'subjectName',
  'title',
  'statusName',
  'statusCode',
  'submittalTerm',
  'submittalStatusName',
] as const;

export interface AssignmentRow {
  rowIndex?: number;
  submissionSeq: string;
  /** 小テスト / レポート / 授業アンケート / 学内アンケート … */
  submissionType: string;
  /** 「科目名(クラス)\n前期後半/月1・2, …」 ('' for university-wide questionnaires). */
  subjectText: string;
  title: string;
  /** 受付中 / 締切 / … */
  statusName: string;
  statusCode: string;
  /** 「YYYY/MM/DD HH:MM ～ YYYY/MM/DD HH:MM」. */
  submittalTerm: string;
  /** 未提出 / 提出済. */
  submittalStatus: string;
}

function fromCells(
  get: (id: string) => string | undefined,
  rowIndex?: number,
): AssignmentRow | undefined {
  const submissionSeq = cleanText(get('submissionSeq'));
  const title = cleanText(get('title'));
  if (!submissionSeq || !title) return undefined;
  return {
    ...(rowIndex !== undefined ? { rowIndex } : {}),
    submissionSeq,
    submissionType: cleanText(get('submissionTypeName')),
    subjectText: cleanLines(get('subjectName')),
    title,
    statusName: cleanText(get('statusName')),
    statusCode: cleanText(get('statusCode')),
    submittalTerm: cleanText(get('submittalTerm')),
    submittalStatus: cleanText(get('submittalStatusName')),
  };
}

/** Rows as returned by DataTables `rows().data()` (cell inner HTML in column order). */
export function parseAssignmentCells(
  cells: readonly string[],
  columns: readonly string[] = ASSIGNMENT_COLUMNS,
  rowIndex?: number,
): AssignmentRow | undefined {
  return fromCells((id) => {
    const i = columns.indexOf(id);
    const html = i >= 0 ? cells[i] : undefined;
    return html === undefined ? undefined : fragmentText(html);
  }, rowIndex);
}

/** Parse the server HTML of the assignment list (`table#dataTable01`, th ids as column keys). */
export function parseAssignmentList(html: string): AssignmentRow[] {
  const $ = load(html);
  const table = parseTable($, 'table#dataTable01');
  if (!table) return [];
  const out: AssignmentRow[] = [];
  for (const row of table.rows) {
    const r = fromCells((id) => row.cells[id], row.index);
    if (r) out.push(r);
  }
  return out;
}
