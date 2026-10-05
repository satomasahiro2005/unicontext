import { normalizeGroupLabel, type SessionRuleValue } from '@unicontext/canonical-model';
import { dayOfWeekOfDate } from '@unicontext/core';

/**
 * Parser for "date × group" schedule tables distributed as a PDF or posted as text: one meeting per
 * line, each line a date with its weekday, the group it is for and optionally a room, a meeting
 * number and a topic. Two layouts seen in real tables:
 *
 *   2026年度情報科学実験B実施スケジュール
 *   10/02(金) B 科学実験室 #01          ← date, group, room, number
 *   10/12(月) スポーツの日               ← nobody meets
 *   11/25(水) A #07（月曜授業）
 *
 *   回 日付 備考 実習内容 実施班
 *   1 10/2（金） H1 FPGAと論理合成ツールと論理回路(1) A   ← number, date, topic, group last
 *   1 5（月） H1 FPGAと論理合成ツールと論理回路(1) B        ← month carried over
 *   6（金） テクノフェスタ準備のため休講
 *
 * Every row's weekday must match its date (the year comes from the academic year), so prose with
 * dates in it or a misread line is never taken as a row. A text is a table only with at least
 * {@link MIN_GROUP_ROWS} group rows over at least two groups.
 */

export const MIN_GROUP_ROWS = 4;

const WEEKDAYS = '日月火水木金土';
const ROW =
  /^\s*(?:(\d{1,2})\s+)?(?:(\d{1,2})\s*[/／月]\s*)?(\d{1,2})\s*日?\s*[（(]\s*([日月火水木金土])[^）)]{0,6}[）)]\s*(.*)$/u;
const NO_CLASS = /休講|休み|休業|祝|の日|中止/u;
const GROUP_TOKEN =
  /(?:^|[\s,、])(?:グループ\s*([A-Za-z])|([A-Za-z])\s*(?:班|グループ|組)|([A-Za-z]))(?=$|[\s#(,、])/gu;

export interface ParsedScheduleRow extends SessionRuleValue {
  /** The line as it appears (evidence). */
  line: string;
}

export interface ParsedScheduleTable {
  rows: ParsedScheduleRow[];
  groups: string[];
  /** First line that looks like a title (「2026年度情報科学実験B実施スケジュール」). */
  heading: string | undefined;
  /** The lines that are not rows (titles, column names, footnotes): where the course is named. */
  context: string;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function yearFor(month: number, academicYear: number): number {
  // Japanese academic year: April–December in that year, January–March in the next one.
  return month >= 4 ? academicYear : academicYear + 1;
}

/** Group tokens of a row's remainder (standalone A/B, A班, Bグループ, グループA). */
function groupsIn(rest: string): { group: string; index: number; length: number }[] {
  const out: { group: string; index: number; length: number }[] = [];
  for (const m of rest.matchAll(GROUP_TOKEN)) {
    const raw = m[1] ?? m[2] ?? m[3];
    const g = raw ? normalizeGroupLabel(raw) : undefined;
    if (!g) continue;
    out.push({ group: g, index: m.index ?? 0, length: m[0].length });
  }
  return out;
}

function clean(s: string): string {
  return s
    .replace(/[#＃]\s*\d+/g, ' ')
    .replace(/[（(][^）)]*[）)]\s*$/u, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Rows of a date × group table in `text`, or undefined when the text is not such a table.
 * `academicYear` dates the rows (10/02 → 2026-10-02, 01/04 → 2027-01-04 for 2026).
 */
export function parseGroupScheduleTable(
  text: string,
  options: { academicYear: number },
): ParsedScheduleTable | undefined {
  const lines = text.normalize('NFKC').split(/\r?\n/);
  const rows: ParsedScheduleRow[] = [];
  let month: number | undefined;
  let lastDay = 0;
  let heading: string | undefined;
  const context: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = ROW.exec(line);
    if (!m) {
      if (!heading && rows.length === 0 && /スケジュール|日程|予定/u.test(line)) heading = line;
      context.push(line);
      continue;
    }
    const lead = m[1] ? Number(m[1]) : undefined;
    let mon = m[2] ? Number(m[2]) : undefined;
    const day = Number(m[3]);
    if (mon === undefined) {
      if (month === undefined) continue;
      mon = day < lastDay ? (month % 12) + 1 : month;
    }
    if (mon < 1 || mon > 12 || day < 1 || day > 31) continue;
    const date = `${yearFor(mon, options.academicYear)}-${pad(mon)}-${pad(day)}`;
    let weekday: number;
    try {
      weekday = dayOfWeekOfDate(date);
    } catch {
      continue;
    }
    // The weekday printed next to the date must be that date's weekday.
    if (WEEKDAYS[weekday] !== m[4]) continue;
    month = mon;
    lastDay = day;
    const rest = (m[5] ?? '').trim();
    const groups = groupsIn(rest);
    const footnoteNumber = /[#＃]\s*0*(\d+)/u.exec(rest);
    const note = /[（(]([^）)]*)[）)]\s*$/u.exec(rest)?.[1]?.trim();
    if (groups.length === 0) {
      if (!NO_CLASS.test(rest)) continue;
      rows.push({
        line,
        date,
        status: 'no_class',
        note: rest.slice(0, 200),
      });
      continue;
    }
    // Two different groups on one line: not a row of this kind of table.
    if (new Set(groups.map((g) => g.group)).size > 1) continue;
    const g = groups[0] as { group: string; index: number; length: number };
    const before = rest
      .slice(0, g.index)
      .replace(/[#＃]\s*\d+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const after = clean(rest.slice(g.index + g.length));
    const row: ParsedScheduleRow = { line, date, group: g.group, status: 'held' };
    // Layout 1 (date, group, room, #nn): the meeting number is the #nn after the group.
    // Layout 2 (no., date, topic, group): the leading number is the meeting number, a # after the
    // group is a footnote mark.
    if (lead !== undefined) row.number = lead;
    else if (footnoteNumber) row.number = Number(footnoteNumber[1]);
    if (row.number !== undefined && row.number <= 0) delete row.number;
    if (after && after.length <= 30 && !before) row.room = after;
    if (before) row.topic = before.slice(0, 200);
    if (note) row.note = note.slice(0, 200);
    rows.push(row);
  }
  const held = rows.filter((r) => r.status === 'held');
  const groups = [...new Set(held.map((r) => r.group as string))].sort();
  if (held.length < MIN_GROUP_ROWS || groups.length < 2) return undefined;
  return { rows, groups, heading, context: context.join('\n') };
}

/**
 * Which enrolled course a table is about: the course whose title the text names (the heading
 * first), else the course the document belongs to. A table in the 実験B team that is headed
 * 「情報科学実験C」 belongs to 実験C.
 */
export function courseOfTable<C extends { id: string; title: string }>(
  text: string,
  heading: string | undefined,
  own: C | undefined,
  courses: readonly C[],
  /** Non-row lines of the table (title, footnotes): a course named there wins over the rows. */
  context?: string,
): C | undefined {
  const norm = (s: string): string => s.normalize('NFKC').replace(/\s+/g, '');
  // Longest titles first so 「情報科学実験B」 is not taken for a shorter title it contains.
  const named = [...courses]
    .filter((c) => norm(c.title).length >= 3)
    .sort((a, b) => norm(b.title).length - norm(a.title).length);
  if (heading) {
    const h = norm(heading);
    const hit = named.find((c) => h.includes(norm(c.title)));
    if (hit) return hit;
  }
  // Rows name topics (「論理回路」 in 「FPGAと論理合成ツールと論理回路」), so the lines around the
  // table are asked first, then the whole text.
  for (const part of [context, text]) {
    if (!part) continue;
    const body = norm(part);
    if (own && body.includes(norm(own.title))) return own;
    const mentioned = named.filter((c) => body.includes(norm(c.title)));
    const titles = new Set(mentioned.map((c) => norm(c.title)));
    if (titles.size === 1) return mentioned[0];
    if (titles.size > 1) break;
  }
  return own;
}
