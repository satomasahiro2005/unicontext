import { load } from 'cheerio';
import { cleanText } from '../html.js';
import { periodFromLabel } from '../text.js';

/** One `li.select-btn` cell of 時間割参照 (table.schedule-table). */
export interface TimetableEntry {
  /** LCU week number: 1=月 … 7=日. */
  week: number;
  /** LCU period pair index: 1 = 1・2 … 7 = 13・14. */
  period: number;
  year?: number;
  /** Semester code from the cell (displayPopup's first argument), e.g. "1" = 前期. */
  semesterCode?: string;
  subjectCode: string;
  classCode: string;
  title: string;
  teacher?: string;
  credits?: number;
  numbering?: string;
  campus?: string;
  room?: string;
  /** li classes such as compulsory / elective / confirm. */
  flags: string[];
  /** CSS-ish locator for provenance. */
  selector: string;
}

function quotedArgs(onclick: string): string[] {
  const m = /displayPopup\s*\(([^)]*)\)/.exec(onclick);
  if (!m) return [];
  return [...(m[1] ?? '').matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => (x[1] ?? x[2] ?? '').trim());
}

/** "（共通） 共通講義棟３１" → campus + room (split at the first whitespace). */
export function splitCampusRoom(text: string): { campus?: string; room?: string } {
  const t = cleanText(text);
  if (!t) return {};
  const m = /^(\S+)\s+(.+)$/.exec(t);
  if (m) return { campus: m[1], room: m[2] };
  return /^[（(].*[)）]$/.test(t) ? { campus: t } : { room: t };
}

/** "2.0単位 IN012160060" → credits + numbering. */
export function splitCreditsNumbering(text: string): { credits?: number; numbering?: string } {
  const t = cleanText(text).normalize('NFKC');
  const m = /^([\d.]+)\s*単位\s*(\S+)?/.exec(t);
  if (!m) return t ? { numbering: t } : {};
  const credits = Number(m[1]);
  return {
    ...(Number.isFinite(credits) ? { credits } : {}),
    ...(m[2] ? { numbering: m[2] } : {}),
  };
}

/**
 * Parse 時間割参照 (SC_18001B00_13). Cells carry `displayPopup(…, week, period, …, year,
 * subjectCode, classCode)`; when the arguments are missing the week comes from the column
 * (`td#weekN`) and the period from the row header (「1・2」).
 */
export function parseTimetable(html: string): TimetableEntry[] {
  const $ = load(html);
  const out: TimetableEntry[] = [];
  $('table.schedule-table tr').each((_, tr) => {
    const rowLabel = cleanText($(tr).children('th').first().text());
    const rowPeriod = periodFromLabel(rowLabel);
    $(tr)
      .children('td')
      .each((__, td) => {
        const colWeek = Number((/week(\d)/.exec($(td).attr('id') ?? '') ?? [])[1]);
        $(td)
          .find('li.select-btn')
          .each((___, li) => {
            const args = quotedArgs($(li).attr('onclick') ?? '');
            const week = Number(args[3] ?? colWeek);
            const period = Number(args[4] ?? rowPeriod);
            const subjectCode = args[7] ?? '';
            const classCode = args[8] ?? '';
            const title = cleanText($(li).find('h4').first().text());
            if (!title || !Number.isInteger(week) || !Number.isInteger(period) || !subjectCode)
              return;
            const ps = $(li).children('p');
            const teacher = cleanText(ps.eq(0).text());
            const cn = splitCreditsNumbering(ps.eq(1).text());
            const cr = splitCampusRoom(ps.eq(2).text());
            const year = Number(args[6]);
            out.push({
              week,
              period,
              ...(Number.isInteger(year) && year > 1900 ? { year } : {}),
              ...(args[0] ? { semesterCode: args[0] } : {}),
              subjectCode,
              classCode,
              title,
              ...(teacher ? { teacher } : {}),
              ...cn,
              ...cr,
              flags: ($(li).attr('class') ?? '')
                .split(/\s+/)
                .filter((c) => c && c !== 'select-btn'),
              selector: `li.select-btn[week=${week}][period=${period}][subject=${subjectCode}]`,
            });
          });
      });
  });
  return out;
}

/** A course of the 時間割外講義 (#lecture2) or 集中講義 (#lecture3) list: no weekly slot. */
export interface OffGridEntry {
  kind: 'unscheduled' | 'intensive';
  year?: number;
  semesterCode?: string;
  subjectCode: string;
  classCode: string;
  title: string;
  teacher?: string;
  credits?: number;
  numbering?: string;
  campus?: string;
  room?: string;
  flags: string[];
  selector: string;
}

export interface TimetablePage {
  /** Weekly grid cells (一般・抽選講義). */
  entries: TimetableEntry[];
  /** 時間割外講義 and 集中講義. */
  offGrid: OffGridEntry[];
  /** Semester shown, from the active 前期/後期 switch (label as displayed). */
  activeSemesterLabel?: string;
  /** "2026年度" header. */
  year?: number;
}

/** Parse the whole 時間割参照 page: grid, off-grid lists and which semester is shown. */
export function parseTimetablePage(html: string): TimetablePage {
  const $ = load(html);
  const entries = parseTimetable(html);
  const offGrid: OffGridEntry[] = [];
  const sections: [string, OffGridEntry['kind']][] = [
    ['#lecture2', 'unscheduled'],
    ['#lecture3', 'intensive'],
  ];
  for (const [sel, kind] of sections) {
    $(sel)
      .find('li.stady-lecture-list-item')
      .each((_, li) => {
        const args = quotedArgs($(li).attr('onclick') ?? '');
        const subjectCode = args[7] ?? '';
        const classCode = args[8] ?? '';
        const title = cleanText($(li).find('p.lecture-ttl').first().text());
        if (!title || !subjectCode) return;
        const ps = $(li).children('p').not('.lecture-ttl');
        const teacher = cleanText(ps.eq(0).text());
        const cn = splitCreditsNumbering(ps.eq(1).text());
        const cr = splitCampusRoom(ps.eq(2).text());
        const year = Number(args[6]);
        offGrid.push({
          kind,
          ...(Number.isInteger(year) && year > 1900 ? { year } : {}),
          ...(args[0] ? { semesterCode: args[0] } : {}),
          subjectCode,
          classCode,
          title,
          ...(teacher ? { teacher } : {}),
          ...cn,
          ...cr,
          flags: ($(li).attr('class') ?? '')
            .split(/\s+/)
            .filter((c) => c && c !== 'stady-lecture-list-item'),
          selector: `${sel} li.stady-lecture-list-item[subject=${subjectCode}][class=${classCode}]`,
        });
      });
  }
  const active = cleanText($('.c-half-btn a.is-active').first().text());
  const ym = /(\d{4})\s*年度/.exec(cleanText($('p.year').first().text()));
  return {
    entries,
    offGrid,
    ...(active ? { activeSemesterLabel: active } : {}),
    ...(ym ? { year: Number(ym[1]) } : {}),
  };
}

/**
 * The semester a page shows (前期/後期 switch with `a.is-active`, used by 時間割 and 試験時間割), as a
 * label; undefined when the page has no switch.
 */
export function activeSemesterLabel(html: string): string | undefined {
  const $ = load(html);
  const labels = $('a.is-active')
    .map((_, a) => cleanText($(a).text()))
    .get()
    .filter((t) => /^(前期|後期|通年|前学期|後学期|第[1-4１-４]クォーター|[1-4１-４]Q)$/.test(t));
  return labels[0];
}
