import { load } from 'cheerio';
import { cleanLines, cleanText, fragmentText, htmlText } from '../html.js';
import { parseTable } from './table.js';

/** One row of 連絡一覧 (SC_17001B00_01), hidden sort columns included. */
export interface NoticeListRow {
  /** DataTables row index (only meaningful for the list page it came from). */
  rowIndex: number;
  /**
   * LCU's own read state. Every row carries `tr.is-unread`, so the class says nothing: the server
   * marks unread rows in the inline 「検索結果一覧の未読行のスタイル適用」 script (bold + background
   * per `_index`, the same set the 「未読のみ」 search returns). Opening an unread notice's detail
   * marks it read, and LCU has no way back to unread, so unread rows are never opened. Fail-safe:
   * a row the script does not mention (or a page without the script) counts as unread.
   */
  unread: boolean;
  /** The row shows the attachment clip (hidden toDoAttachmentOrder `x1`). */
  hasAttachment?: boolean;
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

/** Comment that heads LCU's inline unread-row styling script on 連絡一覧. */
export const UNREAD_STYLE_MARKER = '未読行のスタイル適用';

export interface NoticeReadState {
  /** Row indexes the styling script marks unread (bold). */
  unread: Set<number>;
  /** Row indexes the script mentions at all (every listed row gets a `.text().trim()` line). */
  known: Set<number>;
}

/**
 * Read state from the inline styling script of 連絡一覧 (observed 2026-10-02: the bold set equals
 * the rows returned by the 「未読のみ」 search, and opening a notice removes its index from it).
 * Returns undefined when the script is missing (callers then treat every row as unread).
 */
export function parseNoticeReadState(html: string): NoticeReadState | undefined {
  const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1] ?? '')
    .find((body) => body.includes(UNREAD_STYLE_MARKER));
  if (script === undefined) return undefined;
  const unread = new Set<number>();
  const known = new Set<number>();
  // $("[_index='12']").css("font-weight", "bold");  — only on unread rows.
  const bold =
    /\$\(\s*["']\[_index=['"]?(\d+)['"]?\]["']\s*\)\s*\.css\(\s*["']font-weight["']\s*,\s*["']bold["']\s*\)/g;
  // $("[_index='12'] td:nth-child(7)").text(…)  — every listed row (and any other selector).
  const any = /\$\(\s*["']\[_index=['"]?(\d+)['"]?\]/g;
  for (const m of script.matchAll(bold)) unread.add(Number(m[1]));
  for (const m of script.matchAll(any)) known.add(Number(m[1]));
  return { unread, known };
}

export function parseNoticeList(html: string): NoticeListRow[] {
  const $ = load(html);
  const table = parseTable($, 'table#dataTable01');
  if (!table) return [];
  const readState = parseNoticeReadState(html);
  const out: NoticeListRow[] = [];
  for (const row of table.rows) {
    if (row.index === undefined) continue;
    const c = row.cells;
    const unread = !readState || !readState.known.has(row.index) || readState.unread.has(row.index);
    const attachOrder = cleanText(c.toDoAttachmentOrder);
    const hasAttachment =
      /ico_clip/i.test(row.html.toDo ?? '') || /^\d1$/.test(attachOrder) || undefined;
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
      unread,
      ...(hasAttachment ? { hasAttachment } : {}),
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

/** One attachment of a notice (from the detail screen's file widget JSON). */
export interface NoticeAttachment {
  name: string;
  size?: number;
}

/** 連絡詳細 (SC_17001B00_02). */
export interface NoticeDetail {
  title: string;
  category?: string;
  /** 講義名 targets (「科目名(クラス)」). */
  courses: string[];
  /** Plain text of 内容 (block elements and <br> become line breaks). */
  body: string;
  importance?: string;
  contactDateTime?: string;
  /** 連絡元. */
  sender?: string;
  /** Filled from `fileUpload/load/<id>` (the HTML only has the empty dropzone template). */
  attachments: NoticeAttachment[];
  /** http(s) links in the body. */
  links: string[];
}

/** Text of a rich-text fragment: <br> and the end of block elements become line breaks. */
export function richText(innerHtml: string | null | undefined): string {
  const marked = (innerHtml ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|table|ul|ol)\s*>/gi, '\n$&');
  return fragmentText(marked);
}

const URL_RE = /https?:\/\/[^\s<>"'（）「」、。]+/g;

export function parseNoticeDetail(html: string): NoticeDetail | undefined {
  const $ = load(html);
  const main = $('main').length ? $('main').first() : $('body').first();
  const title = cleanText(main.find('.c-fixed-heading-main h2.c-heading-h3').first().text());
  if (!title) return undefined;
  const labelled: Record<string, string[]> = {};
  main.find('.c-fixed-heading-main dl.c-fixed-heading-submission-item').each((_, dl) => {
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
  let bodyCell: ReturnType<typeof $> | undefined;
  // Only the outer table's own rows: the body may contain tables of its own.
  const table = main.find('table.c-table-line').first();
  table
    .children('tbody')
    .add(table)
    .children('tr')
    .each((_, tr) => {
      const label = cleanText($(tr).children('th').first().text());
      const td = $(tr).children('td').first();
      if (!label || label in rows) return;
      if (label === '内容') {
        bodyCell = td;
        rows[label] = richText(td.html());
      } else rows[label] = htmlText(td.html());
    });
  const links = new Set<string>();
  bodyCell?.find('a[href]').each((_, a) => {
    const href = ($(a).attr('href') ?? '').trim();
    if (/^https?:\/\//i.test(href)) links.add(href);
  });
  for (const m of (rows['内容'] ?? '').matchAll(URL_RE)) links.add(m[0]);
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
    attachments: [],
    links: [...links],
  };
}

/**
 * Path of the detail screen's read-only file-list call (`$.ajax({url: "/lcu-web/fileUpload/load/fi02",
 * type: "POST"})`, made by the browser on every detail view). Undefined when the page has none.
 */
export function noticeAttachmentLoadPath(html: string): string | undefined {
  const m = /url:\s*["']\/[^"'/]+\/(fileUpload\/load\/[A-Za-z0-9]+)["']/.exec(html);
  return m?.[1];
}

/**
 * Attachments from the `fileUpload/load/<id>` JSON (`temporaryFileList[]`: physicalFileName,
 * fileSize, temporaryId, fileStatusType). temporaryId / prefix are session-bound and not kept.
 */
export function parseNoticeAttachments(json: unknown): NoticeAttachment[] | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const list = (json as { temporaryFileList?: unknown }).temporaryFileList;
  if (list === null) return [];
  if (!Array.isArray(list)) return undefined;
  const out: NoticeAttachment[] = [];
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const r = f as Record<string, unknown>;
    if (r.fileStatusType === 'DELETE') continue;
    const name = typeof r.physicalFileName === 'string' ? r.physicalFileName.trim() : '';
    if (!name) continue;
    out.push({
      name,
      ...(typeof r.fileSize === 'number' && Number.isFinite(r.fileSize)
        ? { size: r.fileSize }
        : {}),
    });
  }
  return out;
}
