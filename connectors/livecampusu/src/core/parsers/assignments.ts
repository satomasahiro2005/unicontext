import { load } from 'cheerio';
import { cleanLines, cleanText, fragmentText } from '../html.js';
import { richText } from './notices.js';
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

/**
 * 課題・アンケート詳細 (SC_14002B00_02) or the submission screen (SC_14002B00_03) a row opens: both
 * show the heading, the 本文 (`.c-contents-body.-small > p.text`, empty when the teacher wrote
 * none) and a 参考資料 file widget (`dl.question-reference-data`), whose files come from the
 * `fileUpload/load/<prefix>` call of that widget. The student's own upload area and the submission
 * history are other widgets and are never read.
 */
export interface AssignmentDetail {
  title: string;
  /** '' when the screen shows no text. */
  body: string;
  /** http(s) links in the body. */
  links: string[];
  /** 受付中 / 締切 / 期限切 … as the screen shows it. */
  statusText?: string;
  /** 「2026年10月27日 12時45分」. */
  deadlineText?: string;
  /** Whether the screen has a 参考資料 widget at all. */
  hasReferenceWidget: boolean;
}

const URL_RE = /https?:\/\/[^\s<>"'（）「」、。]+/g;

export function parseAssignmentDetail(html: string): AssignmentDetail | undefined {
  const $ = load(html);
  const heading = $('.question-heading-contents').first();
  const title = cleanText(heading.find('h2.c-heading').first().text());
  if (!title) return undefined;
  const bodyEl = $('.c-contents-body.-small').first().children('p.text').first();
  const body = richText(bodyEl.html());
  const links = new Set<string>();
  bodyEl.find('a[href]').each((_, a) => {
    const href = ($(a).attr('href') ?? '').trim();
    if (/^https?:\/\//i.test(href)) links.add(href);
  });
  for (const m of body.matchAll(URL_RE)) links.add(m[0]);
  const statusText = cleanText(heading.find('.status_box .text').first().text());
  const deadlineText = cleanText(heading.find('.deadline_box .date').first().text());
  return {
    title,
    body,
    links: [...links],
    ...(statusText ? { statusText } : {}),
    ...(deadlineText ? { deadlineText } : {}),
    hasReferenceWidget: assignmentReferenceLoadPath(html) !== undefined,
  };
}

/**
 * `fileUpload/load/<prefix>` of the 参考資料 widget only (its dropzone is `#prefix<prefix>_fileUpload`
 * inside `dl.question-reference-data`). The prefix differs per screen (reg02 on the submission
 * screen, submit on the detail screen); the other widgets of the page are never named here.
 */
export function assignmentReferenceLoadPath(html: string): string | undefined {
  const $ = load(html);
  const id = $('dl.question-reference-data [id^="prefix"][id$="_fileUpload"]').first().attr('id');
  const prefix = /^prefix([A-Za-z0-9]{1,16})_fileUpload$/.exec(id ?? '')?.[1];
  return prefix ? `fileUpload/load/${prefix}` : undefined;
}
