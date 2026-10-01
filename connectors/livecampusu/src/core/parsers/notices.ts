import { load } from 'cheerio';
import { cleanLines, cleanText, htmlText } from '../html.js';
import { parseTable } from './table.js';

/** One row of 連絡一覧 (SC_17001B00_01), hidden sort columns included. */
export interface NoticeListRow {
  /** DataTables row index (only meaningful for the list page it came from). */
  rowIndex: number;
  /** `tr.is-unread`: opening the detail would mark it read, so it is never opened. */
  unread: boolean;
  /** "U04" from the hidden contactTypeOrder column ("U051" = code + importance digit). */
  typeCode?: string;
  importanceDigit?: string;
  /** Visible 連絡種別（カテゴリ）, e.g. 学内連絡(共通). */
  category: string;
  title: string;
  /** Hidden subjectCode column: year(4) + subject code(8) + class code(2+). */
  subjectKey?: { year: number; subjectCode: string; classCode: string; raw: string };
  /** 講義名 / 学期・曜日・時限 text (newline separated). */
  subjectText: string;
  /** 対象日 "YYYY/MM/DD" (休講・補講・試験・教室変更). */
  targetDate?: string;
  /** 連絡日 "YYYY/MM/DD HH:MM". */
  contactDateTime?: string;
}

/** "20267740122061" → {year: 2026, subjectCode: "77401220", classCode: "61"}. */
export function parseSubjectKey(raw: string | undefined): NoticeListRow['subjectKey'] | undefined {
  const s = cleanText(raw);
  const m = /^(\d{4})(\d{8})([0-9A-Za-z]{1,4})$/.exec(s);
  if (!m) return undefined;
  return { year: Number(m[1]), subjectCode: m[2] ?? '', classCode: m[3] ?? '', raw: s };
}

export function parseNoticeList(html: string): NoticeListRow[] {
  const $ = load(html);
  const table = parseTable($, 'table#dataTable01');
  if (!table) return [];
  const out: NoticeListRow[] = [];
  for (const row of table.rows) {
    if (row.index === undefined) continue;
    const c = row.cells;
    const order = cleanText(c.contactTypeOrder);
    const om = /^([A-Z]\d{2})(\d*)$/.exec(order);
    const titleOrder = cleanText(c.titleOrder);
    const title = cleanText(c.title);
    const importanceDigit =
      om?.[2] ||
      (titleOrder && title && titleOrder.endsWith(title)
        ? titleOrder.slice(0, titleOrder.length - title.length)
        : '');
    const subjectKey = parseSubjectKey(c.subjectCode);
    const targetDate = cleanText(c.targetDate);
    const contactDateTime = cleanText(c.contactDateTime);
    out.push({
      rowIndex: row.index,
      unread: row.classes.includes('is-unread'),
      ...(om?.[1] ? { typeCode: om[1] } : {}),
      ...(importanceDigit ? { importanceDigit } : {}),
      category: cleanText(c.contactTypeCategoryName),
      title,
      ...(subjectKey ? { subjectKey } : {}),
      subjectText: cleanLines(c.subjectClassSemesterWeekHour),
      ...(targetDate ? { targetDate } : {}),
      ...(contactDateTime ? { contactDateTime } : {}),
    });
  }
  return out;
}

/** 連絡詳細 (SC_17001B00_02). */
export interface NoticeDetail {
  title: string;
  category?: string;
  courses: string[];
  body: string;
  importance?: string;
  contactDateTime?: string;
  sender?: string;
  attachments: string[];
}

export function parseNoticeDetail(html: string): NoticeDetail | undefined {
  const $ = load(html);
  const main = $('main').length ? $('main').first() : $('body').first();
  const title = cleanText(main.find('.c-fixed-heading-main h2.c-heading-h3').first().text());
  if (!title) return undefined;
  const labelled: Record<string, string[]> = {};
  main.find('dl.c-fixed-heading-submission-item').each((_, dl) => {
    const dts = $(dl).children('dt');
    const label = cleanText(dts.first().text()).replace(/[：:]$/, '');
    const values = dts
      .slice(1)
      .find('p')
      .map((__, p) => cleanText($(p).text()))
      .get()
      .filter(Boolean);
    if (label) labelled[label] = values;
  });
  const rows: Record<string, string> = {};
  const rowHtml: Record<string, string> = {};
  main.find('table.c-table-line tr').each((_, tr) => {
    const label = cleanText($(tr).children('th').first().text());
    const td = $(tr).children('td').first();
    if (!label) return;
    rowHtml[label] = td.html() ?? '';
    rows[label] = htmlText(td.html());
  });
  const attachments = main
    .find('.fileList li')
    .map((_, li) => cleanText($(li).text()))
    .get()
    .filter(Boolean);
  const pickRow = (k: string): string | undefined => {
    const v = rows[k];
    return v !== undefined && v.length > 0 ? v : undefined;
  };
  const category = labelled['連絡種別']?.[0];
  const importance = pickRow('重要度');
  const contactDateTime = pickRow('連絡日時');
  const sender = pickRow('連絡元');
  return {
    title,
    ...(category ? { category } : {}),
    courses: labelled['講義名'] ?? [],
    body: rows['内容'] ?? '',
    ...(importance ? { importance } : {}),
    ...(contactDateTime ? { contactDateTime } : {}),
    ...(sender ? { sender } : {}),
    attachments,
  };
}
