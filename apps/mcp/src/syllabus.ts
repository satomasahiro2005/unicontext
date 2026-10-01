import {
  isIdOf,
  type Course,
  type CourseOffering,
  type Enrollment,
  type Grade,
} from '@unicontext/canonical-model';
import type { UniContext } from '@unicontext/context-engine';
import { NotFoundError, ValidationError } from '@unicontext/core';
import { uniqueCitations, type Citation } from '@unicontext/provenance';
import { z } from 'zod';
import { matchScore } from './courses.js';
import type { EnvelopeOptions } from './envelope.js';

/*
 * Read-only syllabus tools (search_syllabus, get_syllabus, get_credit_summary). Plain functions,
 * zod raw shapes and description strings; apps/mcp/src/server.ts registers them.
 *
 * The course catalog is whatever the syllabus connector stored: courseOffering entities owned by a
 * raw source whose connector is "@unicontext/syllabus" (for a daily catalog sync that is every
 * course of the current and the next term, most of them from the list row alone).
 */

export interface SyllabusToolOutput {
  data: unknown;
  options?: EnvelopeOptions;
}

/** Connector name of the syllabus package (raw_sources.connector). */
export const SYLLABUS_CONNECTOR = '@unicontext/syllabus';

export const SEARCH_SYLLABUS_LIMIT_DEFAULT = 20;
export const SEARCH_SYLLABUS_LIMIT_MAX = 50;
export const SYLLABUS_SECTION_LIMIT = 1500;
export const SYLLABUS_TOTAL_LIMIT = 8000;
const CITATION_LIMIT = 5;
const DOC_HIT_LIMIT = 3000;

// ---------------------------------------------------------------------------------------------
// tool metadata
// ---------------------------------------------------------------------------------------------

export const SEARCH_SYLLABUS_TITLE = 'シラバス検索';
export const GET_SYLLABUS_TITLE = 'シラバス詳細';
export const CREDIT_SUMMARY_TITLE = '単位の状況';

export const SEARCH_SYLLABUS_DESCRIPTION =
  '今学期・来学期に開講される科目をシラバスの一覧から検索する（履修中の科目に限らない）。キーワード（科目名・科目コード・教員名・シラバス本文）、曜日・時限、学年、必修/選択、単位数、学期、年度、学部で絞り込める。「木曜3限の選択科目は？」「1年生向けの2単位の科目」に使う。結果は短い一覧で、授業の内容は get_syllabus で読む。 / Search the course catalog (syllabus list) of the current and upcoming terms, not only the courses the student is taking. Filter by keyword, day and period, grade year, required/elective, credits, term, year and faculty. Use get_syllabus for the full syllabus of one course.';

export const GET_SYLLABUS_DESCRIPTION =
  '1科目のシラバス（担当・曜日時限・単位・授業の目標・学修内容・授業計画・成績評価・テキストなど）を返す。course には search_syllabus の id、科目コード、科目名（一部可）を使える。同じ名前の科目が複数あるときは候補の一覧を返す。 / The syllabus of one course (instructors, schedule, credits, goals, content, weekly plan, grading, textbook). `course` accepts an id from search_syllabus, a course code or a (partial) title; several matches return a candidate list.';

export const CREDIT_SUMMARY_DESCRIPTION =
  '学期ごとの履修登録中の単位数と修得済みの単位数、今学期の登録上限（わかる場合）と残りの目安を返す。「今学期あと何単位とれる？」「ここまでに何単位とった？」に使う。上限は履修制限科目にだけかかる場合があるので残りは目安。 / Credits registered per term, credits earned so far, the registration cap of the current term (when known) and an approximate remainder. The cap may apply to restricted courses only, so the remainder is a guide.';

// ---------------------------------------------------------------------------------------------
// input shapes
// ---------------------------------------------------------------------------------------------

export const searchSyllabusShape = {
  query: z
    .string()
    .max(200)
    .nullish()
    .describe(
      'キーワード（空白区切りは AND）。科目名・科目コード・ナンバリング・教員名・シラバス本文にあたる / Keywords (space = AND): title, code, numbering, instructor, syllabus text',
    ),
  year: z
    .number()
    .int()
    .min(2000)
    .max(2100)
    .nullish()
    .describe(
      '年度（例: 2026）。省略すると全年度（新しい順）/ Academic year; omit for all years, newest first',
    ),
  term: z
    .string()
    .max(20)
    .nullish()
    .describe('学期: 前期 / 後期（部分一致。1 = 前期, 2 = 後期）/ Term: 前期 or 後期'),
  dayOfWeek: z
    .union([z.number().int().min(0).max(6), z.string().max(10)])
    .nullish()
    .describe('曜日: 月〜日（0 = 日曜 … 6 = 土曜も可）/ Day of week: 月..日 or 0 (Sunday) to 6'),
  period: z
    .number()
    .int()
    .min(1)
    .max(7)
    .nullish()
    .describe(
      '時限（90分単位の1〜7限。3 = 3限）/ Period 1-7 (90-minute classes; 3 = third period)',
    ),
  slot: z
    .string()
    .max(20)
    .nullish()
    .describe(
      '曜日と時限を一度に: 「月3」（月曜3限）、シラバス表記の「木3・4」（= 木曜2限）/ Day + period, e.g. "月3" (Monday, period 3) or the printed "木3・4"',
    ),
  grade: z
    .number()
    .int()
    .min(1)
    .max(6)
    .nullish()
    .describe('対象学年（例: 2 = 2年生が履修できる科目）/ Grade year the course is open to'),
  requirement: z
    .string()
    .max(10)
    .nullish()
    .describe('必修 / 選択 / 選択必修 / 自由 / Required, elective, ...'),
  credits: z.number().min(0).max(30).nullish().describe('単位数（一致）/ Exact credits'),
  minCredits: z.number().min(0).max(30).nullish().describe('単位数の下限 / Minimum credits'),
  maxCredits: z.number().min(0).max(30).nullish().describe('単位数の上限 / Maximum credits'),
  faculty: z
    .string()
    .max(60)
    .nullish()
    .describe(
      '学部・開講区分の一部（例: 情報学部, IN-B, 全学教育）/ Faculty or title part, e.g. 情報学部, IN-B',
    ),
  category: z
    .string()
    .max(60)
    .nullish()
    .describe('カテゴリ（学科-区分）の一部 / Part of the category, e.g. 情報科学科'),
  limit: z
    .number()
    .int()
    .positive()
    .max(SEARCH_SYLLABUS_LIMIT_MAX)
    .nullish()
    .describe('件数（既定20、最大50）/ Max results (default 20, max 50)'),
};
export type SearchSyllabusArgs = z.infer<z.ZodObject<typeof searchSyllabusShape>>;

export const getSyllabusShape = {
  course: z
    .string()
    .min(1)
    .max(200)
    .describe(
      '科目の id（courseOffering:...）、科目コード、または科目名（一部可）/ Offering id, course code or (partial) title',
    ),
  year: z
    .number()
    .int()
    .min(2000)
    .max(2100)
    .nullish()
    .describe('年度。省略すると最も新しい年度 / Academic year (default: the newest)'),
};
export type GetSyllabusArgs = z.infer<z.ZodObject<typeof getSyllabusShape>>;

export const creditSummaryShape = {
  year: z
    .number()
    .int()
    .min(2000)
    .max(2100)
    .nullish()
    .describe('年度で絞る（例: 2026）。省略すると全年度 / Only this academic year (default: all)'),
};
export type CreditSummaryArgs = z.infer<z.ZodObject<typeof creditSummaryShape>>;

// ---------------------------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------------------------

const DAY_CHARS = '日月火水木金土';
const DAY_EN = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** NFKC, lower case, no whitespace: the form used for every substring comparison. */
function norm(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Term text -> comparison key: "前期", "後期", or the normalized free text. */
function termKey(text: string): string {
  const t = norm(text);
  if (t === '1' || t.startsWith('前期') || t.startsWith('春')) return '前期';
  if (t === '2' || t.startsWith('後期') || t.startsWith('秋')) return '後期';
  return t;
}

function termRank(term: string | undefined): number {
  const k = term ? termKey(term) : '';
  return k === '後期' ? 2 : k === '前期' ? 1 : 0;
}

export function parseDay(input: number | string): number {
  if (typeof input === 'number') return input;
  const t = input.normalize('NFKC').trim();
  if (/^[0-6]$/.test(t)) return Number(t);
  const first = t.charAt(0);
  const jp = DAY_CHARS.indexOf(first);
  if (jp >= 0) return jp;
  const en = DAY_EN.indexOf(t.slice(0, 3).toLowerCase());
  if (en >= 0) return en;
  throw new ValidationError(`dayOfWeek must be 月..日 or 0-6: ${input}`);
}

/**
 * "月3" = Monday 3rd period (90-minute index); "木3・4" = the printed 45-minute units 3・4, which
 * is the 2nd period. Several slots may be given ("月3 木3・4").
 */
export function parseSlotText(text: string): { dayOfWeek: number; period: number }[] {
  const out: { dayOfWeek: number; period: number }[] = [];
  const re = /([日月火水木金土])\s*(\d{1,2})(?:\s*[・･]\s*(\d{1,2}))?/g;
  for (const m of text.normalize('NFKC').matchAll(re)) {
    const day = DAY_CHARS.indexOf(m[1] ?? '');
    const first = Number(m[2]);
    if (day < 0 || !Number.isFinite(first) || first < 1) continue;
    out.push({ dayOfWeek: day, period: m[3] ? Math.ceil(first / 2) : first });
  }
  if (out.length === 0)
    throw new ValidationError(`slot not understood: ${text} (e.g. 月3, 木3・4)`);
  return out;
}

/** Grade years a "学年" text allows: "2年、3年、4年", "1年,2年", "2〜4", "全学年". `all` = no limit. */
export function parseGradeYears(text: string): Set<number> | 'all' {
  const t = text.normalize('NFKC');
  if (/全|all/i.test(t)) return 'all';
  const years = new Set<number>();
  for (const m of t.matchAll(/(\d+)\s*[~〜～\-–]\s*(\d+)/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    for (let y = Math.min(a, b); y <= Math.max(a, b) && y <= 12; y++) years.add(y);
  }
  for (const m of t.replace(/(\d+)\s*[~〜～\-–]\s*(\d+)/g, ' ').matchAll(/\d+/g))
    years.add(Number(m[0]));
  return years;
}

const REQUIREMENT_RE = /選択必修|必修|選択|自由/g;

/** The syllabus page abbreviates 必修選択区分 ("選必" = 選択必修); spell it out. */
export function expandRequirement(text: string): string {
  const t = text.normalize('NFKC').trim();
  if (t === '必') return '必修';
  if (t === '選') return '選択';
  if (t === '自') return '自由';
  return t.replace(/選必/g, '選択必修');
}

function requirementTokens(text: string): Set<string> {
  return new Set(text.normalize('NFKC').match(REQUIREMENT_RE) ?? []);
}

// ---------------------------------------------------------------------------------------------
// the syllabus catalog
// ---------------------------------------------------------------------------------------------

interface SyllabusEntry {
  offering: CourseOffering;
  course: Course | undefined;
  extra: Record<string, unknown>;
  /** Credits another class / year of the same subject code states (the credits belong to the subject). */
  siblingCredits?: number | undefined;
}

function syllabusSourceIds(uc: UniContext): string[] {
  return uc.sync.stores.raw
    .listSources()
    .filter((s) => s.connector === SYLLABUS_CONNECTOR)
    .map((s) => s.id);
}

function loadCatalog(uc: UniContext): SyllabusEntry[] {
  const entities = uc.sync.stores.entities;
  const courses = new Map<string, Course | undefined>();
  const out: SyllabusEntry[] = [];
  for (const sourceId of syllabusSourceIds(uc)) {
    for (const offering of entities.list('courseOffering', { sourceId })) {
      let course: Course | undefined;
      if (offering.courseId) {
        if (!courses.has(offering.courseId))
          courses.set(offering.courseId, entities.getOfKind('course', offering.courseId));
        course = courses.get(offering.courseId);
      }
      out.push({ offering, course, extra: (offering.extra ?? {}) as Record<string, unknown> });
    }
  }
  const byCode = new Map<string, number>();
  for (const e of out) {
    const c = num(e.extra['credits']) ?? e.course?.credits;
    if (c !== undefined && e.offering.courseCode && !byCode.has(e.offering.courseCode))
      byCode.set(e.offering.courseCode, c);
  }
  for (const e of out)
    if (e.offering.courseCode) e.siblingCredits = byCode.get(e.offering.courseCode);
  return out;
}

function creditsOf(e: SyllabusEntry): number | undefined {
  return num(e.extra['credits']) ?? e.course?.credits ?? e.siblingCredits;
}

function categoriesOf(e: SyllabusEntry): string[] {
  return strList(e.extra['categories']);
}

/** 必修選択区分 from the syllabus page, else the "（必修）" printed behind the list-row category. */
function requirementOf(e: SyllabusEntry): { text: string; fromCategory: boolean } | undefined {
  const own = str(e.extra['requirement']);
  if (own) return { text: expandRequirement(own), fromCategory: false };
  const tokens = new Set<string>();
  for (const c of categoriesOf(e))
    for (const m of c.normalize('NFKC').matchAll(/\((選択必修|必修|選択|自由)\)/g))
      tokens.add(m[1] ?? '');
  tokens.delete('');
  return tokens.size ? { text: [...tokens].join('、'), fromCategory: true } : undefined;
}

function slotsOf(e: SyllabusEntry): string | undefined {
  const raw = str(e.extra['rawSchedule']);
  if (raw) return raw;
  const parts = e.offering.schedule
    .filter((s) => s.period !== undefined)
    .map((s) => {
      const p = s.period ?? 0;
      return `${DAY_CHARS.charAt(s.dayOfWeek)}${p * 2 - 1}・${p * 2}`;
    });
  return parts.length ? parts.join(' ') : undefined;
}

function detailFetched(e: SyllabusEntry): boolean {
  return e.extra['detailFetched'] !== false;
}

function numberingOf(e: SyllabusEntry): string | undefined {
  return str(e.extra['numbering']) ?? str(e.course?.extra?.['numbering']);
}

/** Offerings of the self person's active enrollments, as `code|year|term` keys and linked ids. */
function enrolledMarkers(uc: UniContext): { ids: Set<string>; keys: Set<string> } {
  const ids = new Set<string>();
  const keys = new Set<string>();
  const entities = uc.sync.stores.entities;
  for (const enr of selfEnrollments(uc)) {
    for (const id of uc.identity.expand(enr.courseOfferingId)) {
      ids.add(id);
      const o = entities.getOfKind('courseOffering', id);
      if (o?.courseCode && o.academicYear !== undefined)
        keys.add(`${o.courseCode}|${o.academicYear}|${o.term ? termKey(o.term) : ''}`);
    }
  }
  return { ids, keys };
}

function isEnrolled(e: SyllabusEntry, marks: { ids: Set<string>; keys: Set<string> }): boolean {
  if (marks.ids.has(e.offering.id)) return true;
  const o = e.offering;
  if (!o.courseCode || o.academicYear === undefined) return false;
  return (
    marks.keys.has(`${o.courseCode}|${o.academicYear}|${o.term ? termKey(o.term) : ''}`) ||
    marks.keys.has(`${o.courseCode}|${o.academicYear}|`)
  );
}

function compareEntries(a: SyllabusEntry, b: SyllabusEntry): number {
  const ya = a.offering.academicYear ?? 0;
  const yb = b.offering.academicYear ?? 0;
  if (ya !== yb) return yb - ya;
  const ta = termRank(a.offering.term);
  const tb = termRank(b.offering.term);
  if (ta !== tb) return tb - ta;
  const sa = a.offering.schedule[0];
  const sb = b.offering.schedule[0];
  const da = sa ? sa.dayOfWeek * 10 + (sa.period ?? 0) : 999;
  const db = sb ? sb.dayOfWeek * 10 + (sb.period ?? 0) : 999;
  if (da !== db) return da - db;
  return (a.offering.courseCode ?? '').localeCompare(b.offering.courseCode ?? '');
}

/** One Citation per distinct label (the first), at most CITATION_LIMIT of them. */
function conciseCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of uniqueCitations(citations)) {
    if (seen.has(c.label)) continue;
    seen.add(c.label);
    out.push(c);
    if (out.length >= CITATION_LIMIT) break;
  }
  return out;
}

function sourceLabelOf(uc: UniContext, id: string): string | undefined {
  return uc.context.citationsFor([id])[0]?.label;
}

// ---------------------------------------------------------------------------------------------
// search_syllabus
// ---------------------------------------------------------------------------------------------

interface SearchFilters {
  terms: string[];
  year: number | undefined;
  term: string | undefined;
  slots: { dayOfWeek: number | undefined; period: number | undefined }[] | undefined;
  grade: number | undefined;
  requirement: string | undefined;
  minCredits: number | undefined;
  maxCredits: number | undefined;
  faculty: string | undefined;
  category: string | undefined;
}

function filtersOf(args: SearchSyllabusArgs): SearchFilters {
  let slots: SearchFilters['slots'];
  const day =
    args.dayOfWeek === null || args.dayOfWeek === undefined ? undefined : parseDay(args.dayOfWeek);
  const period = args.period ?? undefined;
  if (args.slot) slots = parseSlotText(args.slot);
  else if (day !== undefined || period !== undefined) slots = [{ dayOfWeek: day, period }];
  if (args.slot && (day !== undefined || period !== undefined))
    slots = slots?.filter(
      (s) =>
        (day === undefined || s.dayOfWeek === day) && (period === undefined || s.period === period),
    );
  const exact = args.credits ?? undefined;
  return {
    terms: (args.query ?? '').split(/\s+/).filter(Boolean),
    year: args.year ?? undefined,
    term: args.term ? termKey(args.term) : undefined,
    slots,
    grade: args.grade ?? undefined,
    requirement: args.requirement ? args.requirement.normalize('NFKC').trim() : undefined,
    minCredits: exact ?? args.minCredits ?? undefined,
    maxCredits: exact ?? args.maxCredits ?? undefined,
    faculty: args.faculty ? norm(args.faculty) : undefined,
    category: args.category ? norm(args.category) : undefined,
  };
}

function matchesStructured(e: SyllabusEntry, f: SearchFilters): boolean {
  const o = e.offering;
  if (f.year !== undefined && o.academicYear !== f.year) return false;
  if (f.term !== undefined) {
    const t = o.term ? termKey(o.term) : '';
    if (t !== f.term && !(t && norm(o.term ?? '').includes(f.term))) return false;
  }
  if (f.slots) {
    const hit = f.slots.some((want) =>
      o.schedule.some(
        (s) =>
          (want.dayOfWeek === undefined || s.dayOfWeek === want.dayOfWeek) &&
          (want.period === undefined || s.period === want.period),
      ),
    );
    if (!hit) return false;
  }
  if (f.grade !== undefined) {
    const text = str(e.extra['grade']);
    if (!text) return false;
    const years = parseGradeYears(text);
    if (years !== 'all' && !years.has(f.grade)) return false;
  }
  if (f.requirement !== undefined) {
    const req = requirementOf(e);
    if (!req) return false;
    const want = f.requirement;
    const canonical = ['必修', '選択', '選択必修', '自由'].includes(want);
    if (canonical ? !requirementTokens(req.text).has(want) : !req.text.includes(want)) return false;
  }
  if (f.minCredits !== undefined || f.maxCredits !== undefined) {
    const c = creditsOf(e);
    if (c === undefined) return false;
    if (f.minCredits !== undefined && c < f.minCredits) return false;
    if (f.maxCredits !== undefined && c > f.maxCredits) return false;
  }
  if (f.faculty !== undefined) {
    const hay = norm(`${str(e.extra['title']) ?? ''} ${e.course?.department ?? ''}`);
    if (!hay.includes(f.faculty)) return false;
  }
  if (f.category !== undefined && !norm(categoriesOf(e).join(' ')).includes(f.category))
    return false;
  return true;
}

/** Score of one keyword against the list-row fields (0 = no match). */
function keywordScore(e: SyllabusEntry, term: string): number {
  const t = norm(term);
  if (!t) return 0;
  const title = norm(`${e.offering.title} ${e.course?.titleEn ?? ''}`);
  if (title.includes(t)) return 3;
  const codes = norm(`${e.offering.courseCode ?? ''} ${numberingOf(e) ?? ''}`);
  if (codes.includes(t)) return 3;
  if (norm(e.offering.instructorNames.join(' ')).includes(t)) return 2;
  const other = norm(
    `${categoriesOf(e).join(' ')} ${str(e.extra['className']) ?? ''} ${str(e.extra['title']) ?? ''} ${e.course?.department ?? ''}`,
  );
  return other.includes(t) ? 1 : 0;
}

/** Offering ids whose syllabus text contains `term` (FTS over the syllabus documents). */
function documentHits(uc: UniContext, term: string): Set<string> {
  const out = new Set<string>();
  try {
    for (const hit of uc.search.lexical([term], { kinds: ['document'], limit: DOC_HIT_LIMIT }))
      if (hit.courseOfferingId) out.add(hit.courseOfferingId);
  } catch {
    // an unusual term the index cannot parse: the list-row fields still answer
  }
  return out;
}

function itemOf(e: SyllabusEntry, uc: UniContext, enrolled: boolean): Record<string, unknown> {
  const req = requirementOf(e);
  const credits = creditsOf(e);
  const source = sourceLabelOf(uc, e.offering.id);
  return {
    id: e.offering.id,
    courseCode: e.offering.courseCode ?? null,
    title: e.offering.title,
    term: e.offering.term ?? null,
    academicYear: e.offering.academicYear ?? null,
    instructors: e.offering.instructorNames,
    slots: slotsOf(e) ?? null,
    grade: str(e.extra['grade']) ?? null,
    requirement: req?.text ?? null,
    ...(req?.fromCategory ? { requirementFrom: 'category' } : {}),
    credits: credits ?? null,
    className: str(e.extra['className']) ?? null,
    detailFetched: detailFetched(e),
    enrolled,
    url: e.offering.url ?? null,
    ...(source ? { source } : {}),
  };
}

function coverageOf(catalog: SyllabusEntry[]): { term: string; count: number }[] {
  const counts = new Map<string, { year: number; term: string; count: number }>();
  for (const e of catalog) {
    const year = e.offering.academicYear ?? 0;
    const term = e.offering.term ?? '';
    const key = `${year}|${term}`;
    const c = counts.get(key) ?? { year, term, count: 0 };
    c.count++;
    counts.set(key, c);
  }
  return [...counts.values()]
    .sort((a, b) => b.year - a.year || termRank(b.term) - termRank(a.term))
    .slice(0, 8)
    .map((c) => ({ term: `${c.year ? `${c.year}年度 ` : ''}${c.term}`.trim(), count: c.count }));
}

export function searchSyllabus(uc: UniContext, args: SearchSyllabusArgs): SyllabusToolOutput {
  const catalog = loadCatalog(uc);
  if (catalog.length === 0)
    return {
      data: {
        total: 0,
        returned: 0,
        items: [],
        notes: [
          'シラバスの情報がまだ取り込まれていません（シラバスの同期が未設定、または初回の同期前です）。',
        ],
      },
    };
  const limit = Math.min(args.limit ?? SEARCH_SYLLABUS_LIMIT_DEFAULT, SEARCH_SYLLABUS_LIMIT_MAX);
  const f = filtersOf(args);

  const hitSets = f.terms.map((t) => documentHits(uc, t));
  const scored: { e: SyllabusEntry; score: number }[] = [];
  for (const e of catalog) {
    if (!matchesStructured(e, f)) continue;
    let score = 0;
    let ok = true;
    for (const [i, term] of f.terms.entries()) {
      const s = keywordScore(e, term);
      if (s > 0) score += s;
      else if (hitSets[i]?.has(e.offering.id)) score += 0.5;
      else {
        ok = false;
        break;
      }
    }
    if (ok) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || compareEntries(a.e, b.e));

  const shown = scored.slice(0, limit).map((s) => s.e);
  const marks = enrolledMarkers(uc);
  const notes: string[] = [];
  if (scored.length > shown.length)
    notes.push(
      `${scored.length}件のうち先頭${shown.length}件だけを返しています。曜日・時限・学年・学期などで絞り込んでください。`,
    );
  const unfetched = shown.filter((e) => !detailFetched(e)).length;
  if (unfetched > 0)
    notes.push(
      `${unfetched}件はシラバスの詳細をまだ取得しておらず、一覧の情報（必修・選択や単位が空のものがある）だけです。内容は get_syllabus で確認できます。`,
    );
  if (scored.length === 0)
    notes.push('条件に合う科目はありません。条件をゆるめるか、coverage の範囲を確認してください。');
  return {
    data: {
      total: scored.length,
      returned: shown.length,
      items: shown.map((e) => itemOf(e, uc, isEnrolled(e, marks))),
      coverage: coverageOf(catalog),
      ...(notes.length ? { notes } : {}),
    },
    options: {
      citations: conciseCitations(uc.context.citationsFor(shown.map((e) => e.offering.id))),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// get_syllabus
// ---------------------------------------------------------------------------------------------

function candidateOf(e: SyllabusEntry): Record<string, unknown> {
  return {
    id: e.offering.id,
    courseCode: e.offering.courseCode ?? null,
    title: e.offering.title,
    academicYear: e.offering.academicYear ?? null,
    term: e.offering.term ?? null,
    className: str(e.extra['className']) ?? null,
    instructors: e.offering.instructorNames,
    slots: slotsOf(e) ?? null,
  };
}

function courseKey(e: SyllabusEntry): string {
  return e.offering.courseCode ?? norm(e.offering.title);
}

/** Syllabus offerings for an input: exact id, linked LCU id, exact code, then title. */
function findOfferings(uc: UniContext, catalog: SyllabusEntry[], input: string): SyllabusEntry[] {
  const text = input.trim();
  if (isIdOf('courseOffering', text)) {
    const direct = catalog.find((e) => e.offering.id === text);
    if (direct) return [direct];
    const linked = new Set(uc.identity.expand(text));
    const viaLink = catalog.filter((e) => linked.has(e.offering.id));
    if (viaLink.length) return viaLink;
    // An id of another source (the student's own timetable): same code, preferably same year.
    const other = uc.sync.stores.entities.getOfKind('courseOffering', text);
    if (!other) throw new NotFoundError(`course offering ${text}`);
    const sameCode = catalog.filter(
      (e) => other.courseCode !== undefined && e.offering.courseCode === other.courseCode,
    );
    const sameYear = sameCode.filter((e) => e.offering.academicYear === other.academicYear);
    return sameYear.length ? sameYear : sameCode;
  }
  const code = norm(text);
  const byCode = catalog.filter(
    (e) => e.offering.courseCode && norm(e.offering.courseCode) === code,
  );
  if (byCode.length) return byCode;
  const byNumbering = catalog.filter((e) => {
    const n = numberingOf(e);
    return n !== undefined && norm(n) === code;
  });
  if (byNumbering.length) return byNumbering;

  const scored = catalog
    .map((e) => ({ e, score: matchScore(text, e.offering) }))
    .filter((s) => s.score > 0);
  const best = Math.max(0, ...scored.map((s) => s.score));
  if (best === 0) return [];
  const floor = best >= 1 ? 1 : best >= 0.8 ? 0.8 : best - 0.05;
  return scored.filter((s) => s.score >= floor).map((s) => s.e);
}

function sectionsOf(
  uc: UniContext,
  e: SyllabusEntry,
): { heading: string; text: string; truncated?: boolean }[] {
  const entities = uc.sync.stores.entities;
  const doc = entities
    .list('document', { where: { courseOfferingId: e.offering.id } })
    .find((d) => d.title.startsWith('シラバス'));
  if (!doc) return [];
  const chunks = entities
    .list('documentChunk', { where: { documentId: doc.id } })
    .sort((a, b) => a.ordinal - b.ordinal);
  const out: { heading: string; text: string; truncated?: boolean }[] = [];
  let total = 0;
  for (const chunk of chunks) {
    const heading = chunk.heading ?? '';
    if (heading === '概要' || heading === '注記') continue;
    const remaining = SYLLABUS_TOTAL_LIMIT - total;
    if (remaining <= 0) break;
    const limit = Math.min(SYLLABUS_SECTION_LIMIT, remaining);
    const truncated = chunk.text.length > limit;
    out.push({
      heading,
      text: truncated ? `${chunk.text.slice(0, limit)}…` : chunk.text,
      ...(truncated ? { truncated: true } : {}),
    });
    total += Math.min(chunk.text.length, limit);
  }
  return out;
}

export function getSyllabus(uc: UniContext, args: GetSyllabusArgs): SyllabusToolOutput {
  const catalog = loadCatalog(uc);
  if (catalog.length === 0)
    throw new NotFoundError('syllabus (no syllabus data has been synced yet)');
  const year = args.year ?? undefined;
  let matches = findOfferings(uc, catalog, args.course);
  if (year !== undefined) matches = matches.filter((e) => e.offering.academicYear === year);
  if (matches.length === 0)
    throw new NotFoundError(
      `syllabus for "${args.course}"${year !== undefined ? ` (${year}年度)` : ''} (no syllabus matches that id, code or title; try search_syllabus)`,
    );

  // Newest academic year first (the one a student can still take), then the latest term.
  matches.sort(compareEntries);
  const newestYear = matches[0]?.offering.academicYear;
  const ofYear =
    year === undefined ? matches.filter((e) => e.offering.academicYear === newestYear) : matches;
  const courses = new Map<string, SyllabusEntry>();
  for (const e of ofYear) if (!courses.has(courseKey(e))) courses.set(courseKey(e), e);
  if (courses.size > 1) {
    return {
      data: {
        ambiguous: true,
        message: `「${args.course}」に当てはまる科目が複数あります。id か科目コードで指定し直してください。`,
        candidates: [...courses.values()].slice(0, 10).map(candidateOf),
      },
    };
  }

  // One course: its offerings of that year (classes / terms). Pick the first, list the rest.
  const picked = ofYear[0];
  if (!picked) throw new NotFoundError(`syllabus for "${args.course}"`);
  const same = matches.filter((e) => courseKey(e) === courseKey(picked));
  const others = same.filter((e) => e.offering.id !== picked.offering.id);
  const sections = sectionsOf(uc, picked);
  const o = picked.offering;
  const req = requirementOf(picked);
  const fetched = detailFetched(picked);
  const notes: string[] = [];
  if (!fetched)
    notes.push(
      'この科目のシラバス詳細はまだ取得していません（一覧の情報のみ）。授業の目標・計画などは大学のシラバス検索で確認してください。',
    );
  if (others.length)
    notes.push(
      'ほかに同じ科目の開講（クラス・学期・年度違い）があります。otherOfferings の id で指定できます。',
    );
  const docIds = uc.sync.stores.entities
    .list('document', { where: { courseOfferingId: o.id } })
    .map((d) => d.id);
  return {
    data: {
      ambiguous: false,
      syllabus: {
        id: o.id,
        courseCode: o.courseCode ?? null,
        numbering: numberingOf(picked) ?? null,
        title: o.title,
        titleEn: picked.course?.titleEn ?? null,
        academicYear: o.academicYear ?? null,
        term: o.term ?? null,
        className: str(picked.extra['className']) ?? null,
        instructors: o.instructorNames,
        slots: slotsOf(picked) ?? null,
        room: o.room ?? null,
        grade: str(picked.extra['grade']) ?? null,
        requirement: req?.text ?? null,
        credits: creditsOf(picked) ?? null,
        department: picked.course?.department ?? null,
        categories: categoriesOf(picked),
        detailFetched: fetched,
        url: o.url ?? null,
      },
      sections,
      ...(sections.some((s) => s.truncated) ||
      sections.reduce((n, s) => n + s.text.length, 0) >= SYLLABUS_TOTAL_LIMIT
        ? { sectionsTruncated: true }
        : {}),
      ...(others.length ? { otherOfferings: others.slice(0, 8).map(candidateOf) } : {}),
      ...(notes.length ? { notes } : {}),
    },
    options: {
      citations: conciseCitations(uc.context.citationsFor([o.id, ...docIds])),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// get_credit_summary
// ---------------------------------------------------------------------------------------------

function selfEnrollments(uc: UniContext): Enrollment[] {
  const entities = uc.sync.stores.entities;
  const selfIds = new Set(
    entities
      .list('person')
      .filter((p) => p.isSelf)
      .map((p) => p.id),
  );
  return entities
    .list('enrollment')
    .filter(
      (e) =>
        e.role === 'student' &&
        e.status === 'active' &&
        (selfIds.size === 0 || selfIds.has(e.personId)),
    );
}

const PASS_MARKS = new Set([
  '秀',
  '優',
  '良',
  '可',
  '合格',
  '認定',
  'S',
  'A',
  'B',
  'C',
  'AA',
  'A+',
]);
const FAIL_MARKS = new Set([
  '不可',
  '不合格',
  '欠席',
  '欠',
  '放棄',
  '失格',
  '未修得',
  '未受験',
  'F',
  'X',
  'W',
]);

/** passed / failed / unknown for one grade row (see docs: unknown marks pass only with gradePoint > 0). */
export function judgeGrade(
  g: Pick<Grade, 'letter' | 'gradePoint'>,
): 'passed' | 'failed' | 'unknown' {
  const letter = g.letter?.normalize('NFKC').trim() ?? '';
  const upper = letter.toUpperCase();
  if (
    letter &&
    (FAIL_MARKS.has(letter) || FAIL_MARKS.has(upper) || /不可|不合格|欠席|不認定/.test(letter))
  )
    return 'failed';
  if (g.gradePoint === 0) return 'failed';
  if (letter && (PASS_MARKS.has(letter) || PASS_MARKS.has(upper))) return 'passed';
  if (g.gradePoint !== undefined && g.gradePoint > 0) return 'passed';
  return 'unknown';
}

/** "2026前期" / "2026年度後期" -> year + term. */
export function parseReportTerm(text: string): {
  year: number | undefined;
  term: string | undefined;
} {
  const m = /(\d{4})\s*年?度?\s*(.*)$/.exec(text.normalize('NFKC'));
  if (!m) return { year: undefined, term: text.trim() || undefined };
  const rest = (m[2] ?? '').trim();
  return { year: Number(m[1]), term: rest || undefined };
}

function localDate(now: Date, timeZone: string): { date: string; year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    year: Number(get('year')),
    month: Number(get('month')),
  };
}

/** The term running now: the profile's 学年暦 when it has one, else April-September / October-March. */
export function currentAcademicTerm(uc: UniContext): { academicYear: number; term: string } {
  const now = localDate(uc.clock.now(), uc.timezone);
  const inCalendar = uc.profile?.academicCalendar.terms.find(
    (t) => t.start <= now.date && now.date <= t.end && t.termCode,
  );
  if (inCalendar?.termCode) return { academicYear: inCalendar.year, term: inCalendar.termCode };
  if (now.month >= 4 && now.month <= 9) return { academicYear: now.year, term: '前期' };
  if (now.month >= 10) return { academicYear: now.year, term: '後期' };
  return { academicYear: now.year - 1, term: '後期' };
}

interface TermRow {
  key: string;
  academicYear: number | undefined;
  term: string | undefined;
  registeredCredits: number;
  registeredCourses: number;
  unknownCreditCourses: number;
  earnedCredits: number;
  failedCredits: number;
  unjudgedCredits: number;
  gradedCourses: number;
}

function termLabel(year: number | undefined, term: string | undefined): string {
  if (year === undefined && !term) return '不明';
  return `${year ?? ''} ${term ?? ''}`.trim();
}

export function getCreditSummary(uc: UniContext, args: CreditSummaryArgs): SyllabusToolOutput {
  const entities = uc.sync.stores.entities;
  const rows = new Map<string, TermRow>();
  const row = (year: number | undefined, term: string | undefined): TermRow => {
    const key = termLabel(year, term ? termKey(term) : undefined);
    let r = rows.get(key);
    if (!r) {
      r = {
        key,
        academicYear: year,
        term: term ? termKey(term) : undefined,
        registeredCredits: 0,
        registeredCourses: 0,
        unknownCreditCourses: 0,
        earnedCredits: 0,
        failedCredits: 0,
        unjudgedCredits: 0,
        gradedCourses: 0,
      };
      rows.set(key, r);
    }
    return r;
  };
  const notes: string[] = [];
  const citedIds: string[] = [];

  // Registered: the student's active enrollments, one per identity-linked course group.
  const groups = new Map<string, Enrollment>();
  for (const enr of selfEnrollments(uc)) {
    const ref = uc.context.courseRef(enr.courseOfferingId);
    const key = ref?.id ?? enr.courseOfferingId;
    if (!groups.has(key)) groups.set(key, enr);
  }
  const current = currentAcademicTerm(uc);
  const currentKey = termLabel(current.academicYear, termKey(current.term));
  let noTerm = 0;
  for (const enr of groups.values()) {
    const linked = uc.context.courseRef(enr.courseOfferingId)?.linkedIds ?? [enr.courseOfferingId];
    const offerings = linked
      .map((id) => entities.getOfKind('courseOffering', id))
      .filter((o): o is CourseOffering => o !== undefined);
    const year = offerings.find((o) => o.academicYear !== undefined)?.academicYear;
    const term = offerings.find((o) => o.term)?.term;
    if (year === undefined || !term) {
      noTerm++;
      continue;
    }
    let credits: number | undefined;
    for (const o of offerings) {
      credits ??= num(o.extra?.['credits']);
      if (credits === undefined && o.courseId)
        credits = entities.getOfKind('course', o.courseId)?.credits;
    }
    const r = row(year, term);
    r.registeredCourses++;
    if (credits === undefined) r.unknownCreditCourses++;
    else r.registeredCredits = round1(r.registeredCredits + credits);
    if (r.key === currentKey) citedIds.push(enr.id);
  }

  // Earned: graded rows. Passed credits count, failed and not-yet-judged ones are listed apart.
  let earnedAll = 0;
  let unjudgedRows = 0;
  for (const g of entities.list('grade')) {
    const credits = num(g.extra?.['credits']);
    const linkedOffering = g.courseOfferingId
      ? entities.getOfKind('courseOffering', g.courseOfferingId)
      : undefined;
    const reported = str(g.extra?.['reportTerm']);
    const parsed = reported ? parseReportTerm(reported) : undefined;
    const year = parsed?.year ?? linkedOffering?.academicYear;
    const term = parsed?.term ?? linkedOffering?.term;
    const r = row(year, term);
    r.gradedCourses++;
    const verdict = judgeGrade(g);
    let c = credits;
    if (c === undefined && linkedOffering)
      c =
        num(linkedOffering.extra?.['credits']) ??
        (linkedOffering.courseId
          ? entities.getOfKind('course', linkedOffering.courseId)?.credits
          : undefined);
    c ??= 0;
    if (verdict === 'passed') {
      r.earnedCredits = round1(r.earnedCredits + c);
      earnedAll = round1(earnedAll + c);
    } else if (verdict === 'failed') r.failedCredits = round1(r.failedCredits + c);
    else {
      r.unjudgedCredits = round1(r.unjudgedCredits + c);
      unjudgedRows++;
    }
    if (citedIds.length < 40) citedIds.push(g.id);
  }

  const year = args.year ?? undefined;
  const sorted = [...rows.values()].sort(
    (a, b) =>
      (a.academicYear ?? 9999) - (b.academicYear ?? 9999) || termRank(a.term) - termRank(b.term),
  );
  const shown = year === undefined ? sorted : sorted.filter((r) => r.academicYear === year);
  const totals = shown.reduce(
    (t, r) => ({
      registeredCredits: round1(t.registeredCredits + r.registeredCredits),
      earnedCredits: round1(t.earnedCredits + r.earnedCredits),
      failedCredits: round1(t.failedCredits + r.failedCredits),
      unjudgedCredits: round1(t.unjudgedCredits + r.unjudgedCredits),
    }),
    { registeredCredits: 0, earnedCredits: 0, failedCredits: 0, unjudgedCredits: 0 },
  );

  const thisTerm = rows.get(currentKey);
  const registeredThisTerm = {
    credits: thisTerm?.registeredCredits ?? 0,
    courses: thisTerm?.registeredCourses ?? 0,
    unknownCreditCourses: thisTerm?.unknownCreditCourses ?? 0,
  };
  const capSetting = uc.profile?.registration?.creditCap;
  const cap = capSetting
    ? {
        perTerm: capSetting.perTerm ?? null,
        perYear: capSetting.perYear ?? null,
        note: capSetting.note ?? null,
      }
    : null;
  const remainingUnderCap =
    cap?.perTerm !== null && cap?.perTerm !== undefined
      ? round1(cap.perTerm - registeredThisTerm.credits)
      : null;

  notes.push(
    '「登録中」は学務情報システムの時間割にある科目の単位数です（履修登録の確定は学務情報システムで確認してください）。',
  );
  if (cap) {
    notes.push(
      '残りの単位数は目安です。上限は履修制限科目の登録単位にかかるため、履修制限外の科目はこの計算に含まれない場合があります。',
    );
  } else {
    notes.push('この大学の登録上限単位数はプロフィールに設定されていません（不明）。');
  }
  if (registeredThisTerm.unknownCreditCourses > 0)
    notes.push(
      `今学期の${registeredThisTerm.unknownCreditCourses}科目は単位数が不明のため合計に含めていません。`,
    );
  if (noTerm > 0) notes.push(`${noTerm}科目は年度・学期が不明のため学期別の集計に含めていません。`);
  if (unjudgedRows > 0)
    notes.push(`${unjudgedRows}件の成績は合否を判定できず、修得単位に含めていません。`);
  if (sorted.length === 0) notes.push('履修や成績のデータがまだ取り込まれていません。');

  return {
    data: {
      currentTerm: {
        academicYear: current.academicYear,
        term: current.term,
        label: termLabel(current.academicYear, current.term),
      },
      cap,
      registeredThisTerm,
      remainingUnderCap,
      terms: shown.map((r) => ({
        term: r.key,
        academicYear: r.academicYear ?? null,
        termName: r.term ?? null,
        registeredCredits: r.registeredCredits,
        registeredCourses: r.registeredCourses,
        earnedCredits: r.earnedCredits,
        failedCredits: r.failedCredits,
        unjudgedCredits: r.unjudgedCredits,
        gradedCourses: r.gradedCourses,
      })),
      totals,
      earnedCreditsAllYears: earnedAll,
      notes,
    },
    options: { citations: conciseCitations(uc.context.citationsFor(citedIds)) },
  };
}
