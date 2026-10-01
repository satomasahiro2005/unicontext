import { classifyGradeLabel, type GradeOutcome } from '@unicontext/canonical-model';
import { type CheerioAPI, load } from 'cheerio';
import { cleanText } from '../html.js';
import { parseTable } from './table.js';

/*
 * 成績情報 (SC_10004B00_01) and 単位修得情報 (SC_10004B00_02), observed 2026-10-01
 * (docs/research/shizuoka.md §1.9). The header 学籍番号 / 学生氏名 is never read.
 */

/** A 成績マーカー: a symbol LCU prefixes to the course title, explained in the marker table. */
export interface GradeMarker {
  symbol: string;
  label?: string;
}

/** One row of the 成績マーカー table (e.g. 「+オンライン科目」 with its credit cap and total). */
export interface GradeMarkerSummary extends GradeMarker {
  capCredits?: number;
  totalCredits?: number;
}

export interface GradeRow {
  subjectCode: string;
  /** Title without the 成績マーカー prefix. */
  subjectName: string;
  /** 成績マーカー found in front of the title. */
  markers?: GradeMarker[];
  staffName?: string;
  /** 科目区分 (e.g. 必修, 教養領域Ａ 人文). */
  category?: string;
  /** Display order of 科目区分 (hidden column kubunDispOrder). */
  categoryOrder?: number;
  /** 単位区分 label (必 / 選必 / 選択). */
  creditType?: string;
  /** 単位区分 code (hidden column subjectReqCode). */
  creditTypeCode?: string;
  credits?: number;
  score?: number;
  /** 評価, verbatim (秀/優/良/可/不可/合/否/再試 …). Empty while the course is in progress. */
  mark?: string;
  /** 評価 code (hidden column markCode). */
  markCode?: string;
  /** The page highlights the evaluation in red (`span.fontBoldRed`; 不可/否/再試 on 2026-10-01). */
  markHighlighted?: boolean;
  gradePoint?: number;
  /**
   * 中間点: the page paints score / evaluation yellow (`span.backYellow`) for an interim result of
   * a running course. Not final, so the outcome is in_progress whatever the label says.
   */
  interim?: boolean;
  /** 成績報告時期, verbatim (e.g. 「2026年度 前期 前期後半」). */
  reportTerm?: string;
  academicYear?: number;
  /** Semester of reportTerm (前期 / 後期 / 通年 …). */
  term?: string;
  /** Rest of reportTerm (前期後半 …). */
  termPart?: string;
  reportDate?: string;
  /** 読替前科目名 (credit transfer: the original course). */
  replacedSubjectName?: string;
  /** 試験種別 (本試験 / 再試験 …). */
  examType?: string;
  examTypeCode?: string;
  /** Normalized outcome of `mark` (unknown labels stay `unknown`). */
  outcome: GradeOutcome;
}

function nonEmpty(v: string | undefined): string | undefined {
  const s = cleanText(v);
  return s ? s : undefined;
}

function num(v: string | undefined): number | undefined {
  const s = cleanText(v).normalize('NFKC');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return undefined;
  return Number(s);
}

/** Outcome of an LCU grade row: the label's outcome, except that interim results are in progress. */
export function lcuGradeOutcome(r: {
  mark?: string | undefined;
  interim?: boolean | undefined;
}): GradeOutcome {
  return r.interim ? 'in_progress' : classifyGradeLabel(r.mark);
}

/** Visible columns of the grade table, in page order. */
export const GRADE_COLUMNS = [
  'subjectCode',
  'subjectName',
  'staffName',
  'kubunName',
  'reqName',
  'unit',
  'score',
  'marks',
  'subjectGp',
  'reportYearSemesterTerm',
  'reportDate',
  'replaceName',
  'examType',
] as const;

/** Hidden (`_visible="false"`) columns of the grade table: sort keys and codes. */
export const GRADE_HIDDEN_COLUMNS = [
  'subjectKanaName',
  'teacherCode',
  'kubunDispOrder',
  'subjectReqCode',
  'sortScore',
  'markCode',
  'replaceKana',
  'examTypeCode',
] as const;

/** Column ids present in the grade table, in page order (shape check without values). */
export function gradeTableColumns(html: string): string[] {
  const $ = load(html);
  const th = $('table th#subjectCode').first();
  if (th.length === 0) return [];
  return th
    .closest('tr')
    .children('th')
    .map((_, el) => $(el).attr('id') ?? '')
    .get();
}

/** 「2026年度 前期 前期後半」 → { academicYear: 2026, term: 前期, termPart: 前期後半 }. */
export function parseLcuReportTerm(text: string | undefined): {
  academicYear?: number;
  term?: string;
  termPart?: string;
} {
  const s = cleanText(text).normalize('NFKC');
  const m = /^(\d{4})\s*年?度?\s*(.*)$/.exec(s);
  if (!m) return {};
  const [term, ...rest] = (m[2] ?? '').split(' ').filter(Boolean);
  return {
    academicYear: Number(m[1]),
    ...(term ? { term } : {}),
    ...(rest.length ? { termPart: rest.join(' ') } : {}),
  };
}

const GENERIC_MARKER = /^[+＋*＊#＃※◎○●◇◆□■△▲▽▼☆★§]/u;

/** The 成績マーカー table above the grade list (columns 成績マーカー / 上限単位数 / 合計単位数). */
export function parseGradeMarkers(html: string): GradeMarkerSummary[] {
  const $ = load(html);
  const table = $('table')
    .filter((_, t) => cleanText($(t).find('thead th').first().text()) === '成績マーカー')
    .first();
  if (table.length === 0) return [];
  const out: GradeMarkerSummary[] = [];
  table.find('tbody tr').each((_, tr) => {
    const td = $(tr).children('td');
    const text = cleanText(td.eq(0).text());
    const m = /^([^\p{L}\p{N}\s]+)\s*(.*)$/u.exec(text);
    if (!m?.[1]) return;
    const cap = num(td.eq(1).text());
    const total = num(td.eq(2).text());
    out.push({
      symbol: m[1],
      ...(m[2] ? { label: m[2] } : {}),
      ...(cap !== undefined ? { capCredits: cap } : {}),
      ...(total !== undefined ? { totalCredits: total } : {}),
    });
  });
  return out;
}

/** Split leading 成績マーカー off a title (symbols of the marker table first, then common ones). */
export function splitGradeMarkers(
  title: string,
  known: readonly GradeMarker[] = [],
): { title: string; markers: GradeMarker[] } {
  let rest = title.trim();
  const markers: GradeMarker[] = [];
  for (let guard = 0; guard < 5 && rest; guard++) {
    const hit = known.find((k) => k.symbol && rest.startsWith(k.symbol));
    if (hit) {
      markers.push({ symbol: hit.symbol, ...(hit.label ? { label: hit.label } : {}) });
      rest = rest.slice(hit.symbol.length).trim();
      continue;
    }
    const g = GENERIC_MARKER.exec(rest);
    if (!g) break;
    const label = known.find((k) => k.symbol === g[0])?.label;
    markers.push({ symbol: g[0], ...(label ? { label } : {}) });
    rest = rest.slice(g[0].length).trim();
  }
  return rest ? { title: rest, markers } : { title: title.trim(), markers: [] };
}

/** Which tab of 成績情報 is shown: 修得成績 (default) or 履修中含む. */
export function gradeViewKind(html: string): 'earned' | 'includingInProgress' | undefined {
  const $ = load(html);
  const active = cleanText($('.c-half-btn a.is-active').first().text());
  if (active.includes('履修中')) return 'includingInProgress';
  if (active.includes('修得')) return 'earned';
  return undefined;
}

/** The selected option of a select (requirementTypeCode on 成績情報 / 単位修得情報). */
export function selectedOption(
  html: string,
  name: string,
): { value: string; label: string } | undefined {
  const $ = load(html);
  const sel = $(`select[name="${name}"]`).first();
  if (sel.length === 0) return undefined;
  const picked = sel.find('option[selected]').first();
  const opt = picked.length ? picked : sel.find('option').first();
  const value = opt.attr('value');
  return value === undefined ? undefined : { value, label: cleanText(opt.text()) };
}

export function parseGrades(html: string, markers?: readonly GradeMarker[]): GradeRow[] {
  const $ = load(html);
  const th = $('table th#subjectCode').first();
  if (th.length === 0) return [];
  const id = th.closest('table').attr('id');
  const parsed = parseTable($, id ? `table[id="${id}"]` : 'table:has(th#subjectCode)');
  if (!parsed) return [];
  const known = markers ?? parseGradeMarkers(html);
  const out: GradeRow[] = [];
  for (const row of parsed.rows) {
    const c = row.cells;
    const subjectCode = cleanText(c.subjectCode);
    const displayed = cleanText(c.subjectName);
    if (!subjectCode || !displayed) continue;
    const { title: subjectName, markers: found } = splitGradeMarkers(displayed, known);
    const opt = (k: string): string | undefined => nonEmpty(c[k]);
    const credits = num(c.unit);
    const score = num(c.score);
    const gradePoint = num(c.subjectGp);
    const categoryOrder = num(c.kubunDispOrder);
    const mark = opt('marks');
    const markHighlighted = /fontBoldRed/.test(row.html.marks ?? '');
    const interim = /backYellow/.test(`${row.html.marks ?? ''}${row.html.score ?? ''}`);
    const reportTerm = opt('reportYearSemesterTerm');
    out.push({
      subjectCode,
      subjectName,
      ...(found.length ? { markers: found } : {}),
      ...(opt('staffName') ? { staffName: opt('staffName') } : {}),
      ...(opt('kubunName') ? { category: opt('kubunName') } : {}),
      ...(categoryOrder !== undefined ? { categoryOrder } : {}),
      ...(opt('reqName') ? { creditType: opt('reqName') } : {}),
      ...(opt('subjectReqCode') ? { creditTypeCode: opt('subjectReqCode') } : {}),
      ...(credits !== undefined ? { credits } : {}),
      ...(score !== undefined ? { score } : {}),
      ...(mark ? { mark } : {}),
      ...(opt('markCode') ? { markCode: opt('markCode') } : {}),
      ...(markHighlighted ? { markHighlighted } : {}),
      ...(gradePoint !== undefined ? { gradePoint } : {}),
      ...(interim ? { interim } : {}),
      ...(reportTerm ? { reportTerm } : {}),
      ...parseLcuReportTerm(reportTerm),
      ...(opt('reportDate') ? { reportDate: opt('reportDate') } : {}),
      ...(opt('replaceName') ? { replacedSubjectName: opt('replaceName') } : {}),
      ...(opt('examType') ? { examType: opt('examType') } : {}),
      ...(opt('examTypeCode') ? { examTypeCode: opt('examTypeCode') } : {}),
      outcome: lcuGradeOutcome({ mark, interim }),
    });
  }
  return out;
}

/** One course listed under a requirement of 単位修得情報. */
export interface RequirementCourse {
  title: string;
  markers?: GradeMarker[];
  /** 必 / 選必 / 選択 … */
  creditType?: string;
  credits?: number;
  /** 合格 / 不合格, verbatim; absent when not taken or not graded yet. */
  status?: string;
}

/** One requirement (区分) row of 単位修得情報 (SC_10004B00_02). */
export interface RequirementRow {
  /** Nesting depth (leading em spaces on the page). */
  depth: number;
  name: string;
  creditType?: string;
  /** 必要単位 (absent on subtotal rows). */
  required?: number;
  /** 修得見込単位: earned credits plus those of registered, not yet graded courses. */
  expected?: number;
  /** 充足状況 (充足 / 不足), verbatim. */
  status?: string;
  courses: RequirementCourse[];
}

export interface CreditRequirements {
  requirementType?: { code: string; name: string };
  rows: RequirementRow[];
}

/** Parse 単位修得情報 (SC_10004B00_02): the requirement tree with required / expected credits. */
export function parseCreditRequirements(html: string): CreditRequirements | undefined {
  const $ = load(html);
  const table = $('table')
    .filter((_, t) => cleanText($(t).find('thead th').first().text()).startsWith('要件区分'))
    .first();
  if (table.length === 0) return undefined;
  const rows: RequirementRow[] = [];
  const byToggle = new Map<string, RequirementRow>();
  const nameOf = (td: ReturnType<CheerioAPI>): { depth: number; name: string; type?: string } => {
    const left = td.find('.inner-side-left').first();
    const raw = (left.length ? left.text() : td.text()).replace(/^[\r\n\t ]+/, '');
    let depth = 0; // leading em spaces (&emsp;, U+2003) = nesting depth
    while (raw.charCodeAt(depth) === 0x2003) depth++;
    const type = cleanText(td.find('.inner-side-center').first().text());
    return { depth, name: cleanText(raw), ...(type ? { type } : {}) };
  };
  table.find('tbody tr').each((_, tr) => {
    const $tr = $(tr);
    const td = $tr.children('td');
    if (td.length < 3) return;
    const { depth, name, type } = nameOf(td.eq(0));
    if (!name) return;
    const toggle = ($tr.attr('class') ?? '').split(/\s+/).find((c) => /^topToggle\w+$/.test(c));
    if (toggle) {
      const parent = byToggle.get(toggle) ?? rows[rows.length - 1];
      if (!parent) return;
      const { title, markers } = splitGradeMarkers(name);
      const credits = num(td.eq(1).text());
      const status = cleanText(td.eq(2).text());
      parent.courses.push({
        title,
        ...(markers.length ? { markers } : {}),
        ...(type ? { creditType: type } : {}),
        ...(credits !== undefined ? { credits } : {}),
        ...(status ? { status } : {}),
      });
      return;
    }
    const required = num(td.eq(1).text());
    const expected = num(td.eq(2).text());
    const status = cleanText(td.eq(3).text());
    const row: RequirementRow = {
      depth,
      name,
      ...(type ? { creditType: type } : {}),
      ...(required !== undefined ? { required } : {}),
      ...(expected !== undefined ? { expected } : {}),
      ...(status ? { status } : {}),
      courses: [],
    };
    rows.push(row);
    const m = /tr\.(topToggle\w+)/.exec(td.eq(0).find('[onclick]').attr('onclick') ?? '');
    if (m?.[1]) byToggle.set(m[1], row);
  });
  const sel = selectedOption(html, 'requirementTypeCode');
  return { ...(sel ? { requirementType: { code: sel.value, name: sel.label } } : {}), rows };
}
