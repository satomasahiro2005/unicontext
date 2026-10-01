import { load } from 'cheerio';
import { cleanBlock } from '../lcu/parse.js';

/* Parser for the public 休講案内 screen (SC_90002szu_01 on Shizuoka's LiveCampusU). */

export interface CancellationRow {
  /** Full 授業科目 cell, e.g. "数学Ⅲ（微分積分Ｂ） (理２)". */
  title: string;
  courseTitle: string;
  className: string | undefined;
  month: number;
  day: number;
  /** As printed, e.g. "3・4". */
  period: string;
  /** 90-minute period index (1・2 -> 1, 3・4 -> 2 ...), when the text starts with a number. */
  periodIndex: number | undefined;
  instructors: string[];
}

export interface AsOf {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export interface ParsedCancellations {
  /** The screen looks like the 休講案内 screen (heading or table present). */
  recognized: boolean;
  /** The table exists but its columns are not the expected four. */
  headerMismatch: boolean;
  rows: CancellationRow[];
  asOf: AsOf | undefined;
}

const OPEN = new Set(['(', '（']);
const CLOSE = new Set([')', '）']);

/**
 * Split "<科目名> (<クラス名>)": the class is the LAST top-level parenthesis, so names such as
 * "数学Ⅲ（微分積分Ｂ） (理２)" and "教育の原理 (教（Ｃ組）)" are handled.
 */
export function splitTitleAndClass(text: string): { courseTitle: string; className?: string } {
  const t = text.replace(/\s+/g, ' ').trim();
  const chars = [...t];
  const last = chars[chars.length - 1];
  if (!last || !CLOSE.has(last)) return { courseTitle: t };
  let depth = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const c = chars[i] as string;
    if (CLOSE.has(c)) depth++;
    else if (OPEN.has(c)) {
      depth--;
      if (depth === 0) {
        const courseTitle = chars.slice(0, i).join('').trim();
        const className = chars
          .slice(i + 1, -1)
          .join('')
          .trim();
        if (!courseTitle) return { courseTitle: t };
        return className ? { courseTitle, className } : { courseTitle };
      }
    }
  }
  return { courseTitle: t };
}

function asOfOf(text: string): AsOf | undefined {
  const m = /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*(\d{1,2}):(\d{2})\s*(?:現在|時点)/.exec(
    text.normalize('NFKC'),
  );
  if (!m) return undefined;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
  };
}

export function parseCancellations(html: string): ParsedCancellations {
  const $ = load(html);
  const main = $('main').length ? $('main').first() : $('body');
  const heading = main.text().includes('休講案内');
  const table = $('table.c-table').first();
  const asOf = asOfOf(main.text());
  if (table.length === 0) return { recognized: heading, headerMismatch: false, rows: [], asOf };
  const headers = table
    .find('thead th')
    .map((_, th) => cleanBlock($(th).text()).replace(/\s+/g, ''))
    .get();
  const expected = ['授業科目', '休講日', '時限', '担当教員'];
  if (headers.length !== 4 || expected.some((h, i) => headers[i] !== h))
    return { recognized: true, headerMismatch: true, rows: [], asOf };
  const rows: CancellationRow[] = [];
  table.find('tbody tr').each((_, tr) => {
    const cells = $(tr)
      .children('td')
      .map((_i, td) => cleanBlock($(td).text()))
      .get();
    if (cells.length < 4) return;
    const [title = '', dateText = '', period = '', teacher = ''] = cells;
    const date = /(\d{1,2})\s*\/\s*(\d{1,2})/.exec(dateText.normalize('NFKC'));
    if (!date || !title) return;
    const { courseTitle, className } = splitTitleAndClass(title);
    const first = /^(\d{1,2})/.exec(period.normalize('NFKC'));
    rows.push({
      title,
      courseTitle,
      className,
      month: Number(date[1]),
      day: Number(date[2]),
      period: period.normalize('NFKC'),
      periodIndex: first ? Math.ceil(Number(first[1]) / 2) : undefined,
      instructors: teacher
        .split(/[、,，／/]/)
        .map((s) => s.replace(/\s+/g, ' ').trim())
        .filter(Boolean),
    });
  });
  return { recognized: true, headerMismatch: false, rows, asOf };
}

function validDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * The page prints MM/DD without a year. Pick the year (previous, same or next calendar year of the
 * "as of" time) that puts the date closest to it; this handles the Dec/Jan rollover.
 */
export function inferYear(
  month: number,
  day: number,
  asOf: { year: number; month: number; day: number },
): number {
  const ref = Date.UTC(asOf.year, asOf.month - 1, asOf.day);
  let best = asOf.year;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const y of [asOf.year, asOf.year - 1, asOf.year + 1]) {
    if (!validDate(y, month, day)) continue;
    const distance = Math.abs(Date.UTC(y, month - 1, day) - ref);
    if (distance < bestDistance) {
      best = y;
      bestDistance = distance;
    }
  }
  return best;
}
