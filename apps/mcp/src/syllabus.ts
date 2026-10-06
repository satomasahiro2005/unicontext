import {
  isIdOf,
  type Course,
  type CourseOffering,
  type Enrollment,
  GRADE_OUTCOME_LABELS,
} from '@unicontext/canonical-model';
import {
  buildGradeReport,
  type DetailFetchReport,
  type GradeAttempt,
  type GradePeriodTotals,
  type UniContext,
} from '@unicontext/context-engine';
import {
  NotFoundError,
  normalizeHalves,
  parseTermPartLabel,
  TERM_HALVES,
  type TermHalf,
  termPartLabel,
  ValidationError,
} from '@unicontext/core';
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
 * course of the current academic year and the next term, of the configured faculties and their
 * campus 全学教育, most of them from the list row alone).
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
  '今学期・来学期に開講される科目をシラバスの一覧から検索する（履修中の科目に限らない）。キーワード（科目名・科目コード・教員名・シラバス本文）、曜日・時限、学年、必修/選択、単位数、学期、学期の前半・後半（termPart）、年度、学部で絞り込める。各結果の termPart は授業のある期間（後期前半・後期後半は約8週だけの科目、後期（前半・後半）は学期を通しての科目）。fitsMyTimetable で登録済みの時間割と重ならない科目だけにできる。「木曜3限の選択科目は？」「1年生向けの2単位の科目」「後期後半の空いているコマで取れる科目は？」に使う。結果は短い一覧で、授業の内容は get_syllabus で読む。 / Search the course catalog (syllabus list) of the current and upcoming terms, not only the courses the student is taking. Filter by keyword, day and period, grade year, required/elective, credits, term, half of the term (termPart: each 前期/後期 is split into 前半 and 後半 of about 8 weeks; some courses meet in one half only), year and faculty; fitsMyTimetable keeps only courses that fit the free slots of the registered timetable. Use get_syllabus for the full syllabus of one course.';

export const GET_SYLLABUS_DESCRIPTION =
  '1科目のシラバス（担当・曜日時限・単位・授業の目標・学修内容・授業計画・成績評価・テキストなど）を返す。course には search_syllabus の id、科目コード、科目名（一部可）を使える。同じ名前の科目が複数あるときは候補の一覧を返す。シラバス詳細がまだ取り込まれていない科目は、その場で大学の公開シラバスから取得して返す（すぐ取得できないときは次の同期で最優先に取得し、notes でそう伝える）。 / The syllabus of one course (instructors, schedule, credits, goals, content, weekly plan, grading, textbook). `course` accepts an id from search_syllabus, a course code or a (partial) title; several matches return a candidate list. A course whose syllabus detail has not been stored yet is read from the public syllabus on the spot (when that is not possible right now it is queued first for the next sync, and notes say so).';

export const CREDIT_SUMMARY_DESCRIPTION =
  '過去の全年度・全学期の成績（科目ごとの全受験。不合格・再試・再履修も含む）、学期別・年度別・通算の修得単位、卒業要件の充足状況（学務情報システムの単位修得情報がある場合）、今学期の登録単位と上限の目安、今学期の時間割（科目ごとの前半・後半）と前半・後半それぞれの空きコマ（timetableThisTerm）を返す。各成績は大学の表示どおりの評価（秀・不可・合・否・再試など）をevaluationに、集計用の区分をoutcome（passed/failed/in_progress/not_graded/withdrawn/transferred/unknown）に持つ。修得単位はpassedとtransferredだけを数え、unknownは合否どちらにも数えない。「ここまでに何単位とった？」「落とした科目は？」「卒業要件で足りない区分は？」「今学期あと何単位とれる？」「後期後半に空いているコマは？」に使う。 / Full grade history of every year and term (every attempt per course, failed ones and re-exams included), earned credits per term, per year and in total, graduation requirement status when the academic system provides it, and the current term registration with its cap, plus the timetable of this term with the half of each course (前半/後半, about 8 weeks each) and the free slots of each half. Each grade keeps the verbatim evaluation label and a normalized outcome; only passed and transferred count as earned, unknown is never counted.';

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
  termPart: z
    .string()
    .max(20)
    .nullish()
    .describe(
      '学期の前半・後半（前期・後期はそれぞれ約8週の前半と後半に分かれる）: 「前半」「後半」「後期後半」。「後半」は後半に授業がある科目（学期を通しての科目も含む）、「後半のみ」は後半だけの科目 / Half of the term (each term has a first half 前半 and a second half 後半 of about 8 weeks): "後半" = meets in the second half (whole-term courses included), "後半のみ" = second half only',
    ),
  fitsMyTimetable: z
    .boolean()
    .nullish()
    .describe(
      'true: 登録済みの科目と曜日・時限が重ならない科目だけ（前半・後半を区別して判定。登録済みの科目自体は除く）/ Only courses whose slots are free in the registered timetable of that term, half by half',
    ),
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

/** Class name compared loosely ("1クラス" = "1", NFKC, no spaces). */
function classKey(text: string): string {
  return norm(text).replace(/クラス$/, '');
}

/**
 * The catalog offerings the student takes: for each active enrollment, the syllabus offerings of
 * the same course code, year and term (or identity-linked to it). When the student's own offering
 * names its class (LiveCampusU クラス) and the syllabus lists that class, only that class counts:
 * the same 全学教育 code is offered on both campuses (生命科学 16111007: 静岡 学部共通２ and 浜松
 * 情工１), and the identity resolver may have linked both to the student's course.
 */
function enrolledOfferingIds(uc: UniContext, catalog: readonly SyllabusEntry[]): Set<string> {
  const entities = uc.sync.stores.entities;
  const inCatalog = new Map<string, SyllabusEntry>(catalog.map((e) => [e.offering.id, e]));
  const out = new Set<string>();
  for (const enr of selfEnrollments(uc)) {
    const expanded = uc.identity.expand(enr.courseOfferingId);
    const own = expanded
      .filter((id) => !inCatalog.has(id) && isIdOf('courseOffering', id))
      .map((id) =>
        isIdOf('courseOffering', id) ? entities.getOfKind('courseOffering', id) : undefined,
      )
      .filter((o): o is CourseOffering => o !== undefined);
    const candidates = new Set<SyllabusEntry>();
    for (const id of expanded) {
      const linked = inCatalog.get(id);
      if (linked) candidates.add(linked);
    }
    for (const o of own) {
      if (!o.courseCode || o.academicYear === undefined) continue;
      for (const e of catalog)
        if (
          e.offering.courseCode === o.courseCode &&
          e.offering.academicYear === o.academicYear &&
          (!o.term || !e.offering.term || termKey(e.offering.term) === termKey(o.term))
        )
          candidates.add(e);
    }
    const classes = new Set(
      own
        .map((o) => str(o.extra?.['className']))
        .filter((c): c is string => !!c)
        .map(classKey),
    );
    let picked = [...candidates];
    if (classes.size) {
      const sameClass = picked.filter((e) =>
        classes.has(classKey(str(e.extra['className']) ?? '')),
      );
      if (sameClass.length) picked = sameClass;
    }
    for (const e of picked) out.add(e.offering.id);
  }
  return out;
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
// the student's timetable by half (前半 / 後半)
// ---------------------------------------------------------------------------------------------

interface MyTimetable {
  academicYear: number;
  term: string;
  courses: { title: string; termPart: string | null; slots: string; credits: number | null }[];
  /** `${half}|${dayOfWeek}|${period}` of every registered weekly slot. */
  occupied: Set<string>;
}

function slotLabel(dayOfWeek: number, period: number | undefined): string {
  return `${DAY_CHARS.charAt(dayOfWeek)}${period ?? ''}`;
}

/** Halves one slot meets in (per slot when the source says so); unknown = both. */
function halvesOfSlot(
  parts:
    | { halves: TermHalf[]; slots: { dayOfWeek: number; period?: number; halves: TermHalf[] }[] }
    | undefined,
  slot: { dayOfWeek: number; period?: number | undefined },
): TermHalf[] {
  if (!parts || parts.halves.length === 0) return [...TERM_HALVES];
  const own = parts.slots.filter(
    (s) =>
      s.dayOfWeek === slot.dayOfWeek &&
      (s.period === undefined || slot.period === undefined || s.period === slot.period),
  );
  return own.length ? normalizeHalves(own.flatMap((s) => s.halves)) : parts.halves;
}

/** Registered courses of one term with their halves and slots (from the timetable + 前半/後半). */
function myTimetable(uc: UniContext, academicYear: number, term: string): MyTimetable {
  const schedule = uc.tasks.schedule;
  const entities = uc.sync.stores.entities;
  const key = termKey(term);
  const out: MyTimetable = { academicYear, term: key, courses: [], occupied: new Set() };
  for (const e of schedule.enrolledOfferings()) {
    const o = e.offering;
    const year = e.term?.year ?? o.academicYear;
    const t = e.term?.termCode ?? o.term;
    if (year !== academicYear || !t || termKey(t) !== key) continue;
    const linked = e.ids
      .map((id) => entities.getOfKind('courseOffering', id))
      .filter((x): x is CourseOffering => x !== undefined);
    const slots = o.schedule.length
      ? o.schedule
      : (linked.find((x) => x.schedule.length > 0)?.schedule ?? []);
    let credits: number | undefined;
    for (const x of [o, ...linked]) {
      credits ??= num(x.extra?.['credits']);
      if (credits === undefined && x.courseId)
        credits = entities.getOfKind('course', x.courseId)?.credits;
    }
    const regular = e.scheduleType === 'regular';
    if (regular)
      for (const s of slots)
        for (const h of halvesOfSlot(e.termParts, s))
          out.occupied.add(`${h}|${s.dayOfWeek}|${s.period ?? ''}`);
    out.courses.push({
      title: o.title,
      termPart: schedule.termPartLabelOf(e) ?? null,
      slots: regular
        ? slots.map((s) => slotLabel(s.dayOfWeek, s.period)).join(' ')
        : e.scheduleType === 'intensive'
          ? '集中講義'
          : '時間割外',
      credits: credits ?? null,
    });
  }
  out.courses.sort((a, b) => a.slots.localeCompare(b.slots));
  return out;
}

/** True when none of the offering's slots collides with a registered slot of the same half. */
function fitsTimetable(o: CourseOffering, t: MyTimetable): boolean {
  if (o.schedule.length === 0) return true;
  const halves = o.termParts?.length ? o.termParts : [...TERM_HALVES];
  return o.schedule.every((s) =>
    halves.every((h) => !t.occupied.has(`${h}|${s.dayOfWeek}|${s.period ?? ''}`)),
  );
}

/** Weekday periods 1–5 (月1 … 金5) not taken in each half of the term. */
function freeSlotsByHalf(uc: UniContext, t: MyTimetable): Record<string, string> {
  const term = uc.tasks.schedule.profile?.academicCalendar.terms.find(
    (x) => x.year === t.academicYear && x.termCode !== undefined && termKey(x.termCode) === t.term,
  );
  const out: Record<string, string> = {};
  for (const h of TERM_HALVES) {
    const label = term?.parts?.find((p) => p.half === h)?.name ?? `${t.term}${h}`;
    const free: string[] = [];
    for (let day = 1; day <= 5; day++)
      for (let period = 1; period <= 5; period++)
        if (!t.occupied.has(`${h}|${day}|${period}`)) free.push(slotLabel(day, period));
    out[label] = free.join(' ');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// search_syllabus
// ---------------------------------------------------------------------------------------------

interface SearchFilters {
  terms: string[];
  year: number | undefined;
  term: string | undefined;
  /** 前半 / 後半 wanted; `only` = that half only (not whole-term courses). */
  half: { half: TermHalf; only: boolean } | undefined;
  fitsMyTimetable: boolean;
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
  // 「後期後半」 in either field names both the term and the half.
  const partText = (args.termPart ?? '').normalize('NFKC').trim();
  const only = /のみ|だけ|only/i.test(partText);
  const part =
    parseTermPartLabel(partText.replace(/のみ|だけ|only/gi, '')) ??
    (args.term ? parseTermPartLabel(args.term) : undefined);
  if (partText && !part)
    throw new ValidationError(`termPart must be 前半 or 後半 (e.g. 後期後半): ${args.termPart}`);
  const termText = args.term ?? part?.term;
  return {
    terms: (args.query ?? '').split(/\s+/).filter(Boolean),
    year: args.year ?? undefined,
    term: termText ? termKey(termText) : undefined,
    half: part ? { half: part.half, only } : undefined,
    fitsMyTimetable: args.fitsMyTimetable === true,
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
  if (f.half) {
    // Unknown halves (syllabus detail not fetched) never match a half filter.
    const halves = o.termParts;
    if (!halves?.includes(f.half.half)) return false;
    if (f.half.only && halves.length !== 1) return false;
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
    termPart: termPartLabel(e.offering.term, e.offering.termParts) ?? null,
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
  const enrolled = enrolledOfferingIds(uc, catalog);
  // A course the student already takes is no free-slot candidate in another class either.
  const courseTermKey = (o: CourseOffering): string =>
    `${o.courseCode ?? norm(o.title)}|${o.academicYear ?? ''}|${o.term ? termKey(o.term) : ''}`;
  const takenCourses = new Set(
    catalog.filter((e) => enrolled.has(e.offering.id)).map((e) => courseTermKey(e.offering)),
  );
  const timetables = new Map<string, MyTimetable>();
  const timetableOf = (year: number, term: string): MyTimetable => {
    const key = `${year}|${termKey(term)}`;
    let t = timetables.get(key);
    if (!t) timetables.set(key, (t = myTimetable(uc, year, term)));
    return t;
  };
  for (const e of catalog) {
    if (!matchesStructured(e, f)) continue;
    if (f.fitsMyTimetable) {
      const o = e.offering;
      if (takenCourses.has(courseTermKey(o)) || o.academicYear === undefined || !o.term) continue;
      if (!fitsTimetable(o, timetableOf(o.academicYear, o.term))) continue;
    }
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
  const notes: string[] = [];
  if (f.half)
    notes.push(
      'termPart で絞り込むと、開講時期（前半・後半）がシラバスで確認できない科目（詳細が未取得のもの）は含まれません。',
    );
  if (f.fitsMyTimetable)
    notes.push(
      '登録済みの時間割（学務情報システム）と曜日・時限が重ならない科目だけです。前半だけ・後半だけの科目は、その期間の時間割と比べています。',
    );
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
      items: shown.map((e) => itemOf(e, uc, enrolled.has(e.offering.id))),
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

/**
 * Syllabus offerings for an input: exact id, linked LCU id, exact code, then title. `preferred`
 * are the offerings of the class the student's own offering names (when the input is one).
 */
function findOfferings(
  uc: UniContext,
  catalog: SyllabusEntry[],
  input: string,
): { matches: SyllabusEntry[]; preferred?: Set<string> } {
  const text = input.trim();
  if (isIdOf('courseOffering', text)) {
    const direct = catalog.find((e) => e.offering.id === text);
    if (direct) return { matches: [direct] };
    const other = uc.sync.stores.entities.getOfKind('courseOffering', text);
    const ownClass = str(other?.extra?.['className']);
    const withClass = (
      matches: SyllabusEntry[],
    ): { matches: SyllabusEntry[]; preferred?: Set<string> } => {
      if (!ownClass) return { matches };
      const same = matches.filter(
        (e) => classKey(str(e.extra['className']) ?? '') === classKey(ownClass),
      );
      return same.length
        ? { matches, preferred: new Set(same.map((e) => e.offering.id)) }
        : { matches };
    };
    const linked = new Set(uc.identity.expand(text));
    const viaLink = catalog.filter((e) => linked.has(e.offering.id));
    if (viaLink.length) return withClass(viaLink);
    // An id of another source (the student's own timetable): same code, preferably same year.
    if (!other) throw new NotFoundError(`course offering ${text}`);
    const sameCode = catalog.filter(
      (e) => other.courseCode !== undefined && e.offering.courseCode === other.courseCode,
    );
    const sameYear = sameCode.filter((e) => e.offering.academicYear === other.academicYear);
    return withClass(sameYear.length ? sameYear : sameCode);
  }
  const code = norm(text);
  const byCode = catalog.filter(
    (e) => e.offering.courseCode && norm(e.offering.courseCode) === code,
  );
  if (byCode.length) return { matches: byCode };
  const byNumbering = catalog.filter((e) => {
    const n = numberingOf(e);
    return n !== undefined && norm(n) === code;
  });
  if (byNumbering.length) return { matches: byNumbering };

  const scored = catalog
    .map((e) => ({ e, score: matchScore(text, e.offering) }))
    .filter((s) => s.score > 0);
  const best = Math.max(0, ...scored.map((s) => s.score));
  if (best === 0) return { matches: [] };
  const floor = best >= 1 ? 1 : best >= 0.8 ? 0.8 : best - 0.05;
  return { matches: scored.filter((s) => s.score >= floor).map((s) => s.e) };
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

type Resolved =
  | { kind: 'ambiguous'; output: SyllabusToolOutput }
  | { kind: 'one'; picked: SyllabusEntry; others: SyllabusEntry[] };

/** The one course `args` names (its offering to show and the others), or the candidates. */
function resolveSyllabus(uc: UniContext, args: GetSyllabusArgs, preferId?: string): Resolved {
  const catalog = loadCatalog(uc);
  if (catalog.length === 0)
    throw new NotFoundError('syllabus (no syllabus data has been synced yet)');
  const year = args.year ?? undefined;
  const found = findOfferings(uc, catalog, args.course);
  let matches = found.matches;
  if (year !== undefined) matches = matches.filter((e) => e.offering.academicYear === year);
  if (matches.length === 0)
    throw new NotFoundError(
      `syllabus for "${args.course}"${year !== undefined ? ` (${year}年度)` : ''} (no syllabus matches that id, code or title; try search_syllabus)`,
    );

  // Newest academic year first (the one a student can still take), then the latest term; the
  // class of the student's own offering (or the one just fetched) before the other classes.
  const preferred = (e: SyllabusEntry): number =>
    e.offering.id === preferId ? 0 : found.preferred?.has(e.offering.id) ? 1 : 2;
  matches.sort((a, b) => {
    const ya = a.offering.academicYear ?? 0;
    const yb = b.offering.academicYear ?? 0;
    return yb - ya || preferred(a) - preferred(b) || compareEntries(a, b);
  });
  const newestYear = matches[0]?.offering.academicYear;
  const ofYear =
    year === undefined ? matches.filter((e) => e.offering.academicYear === newestYear) : matches;
  const courses = new Map<string, SyllabusEntry>();
  for (const e of ofYear) if (!courses.has(courseKey(e))) courses.set(courseKey(e), e);
  if (courses.size > 1) {
    return {
      kind: 'ambiguous',
      output: {
        data: {
          ambiguous: true,
          message: `「${args.course}」に当てはまる科目が複数あります。id か科目コードで指定し直してください。`,
          candidates: [...courses.values()].slice(0, 10).map(candidateOf),
        },
      },
    };
  }

  // One course: its offerings of that year (classes / terms). Pick the first, list the rest.
  const picked = ofYear[0];
  if (!picked) throw new NotFoundError(`syllabus for "${args.course}"`);
  const same = matches.filter((e) => courseKey(e) === courseKey(picked));
  return { kind: 'one', picked, others: same.filter((e) => e.offering.id !== picked.offering.id) };
}

const NOT_FETCHED_NOTE =
  'この科目のシラバス詳細はまだ取得していません（一覧の情報のみ）。授業の目標・計画などは大学のシラバス検索で確認してください。';

function renderSyllabus(
  uc: UniContext,
  picked: SyllabusEntry,
  others: SyllabusEntry[],
  detailNote: string | undefined,
): SyllabusToolOutput {
  const sections = sectionsOf(uc, picked);
  const o = picked.offering;
  const req = requirementOf(picked);
  const fetched = detailFetched(picked);
  const notes: string[] = [];
  if (detailNote) notes.push(detailNote);
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
        termPart: termPartLabel(o.term, o.termParts) ?? null,
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

/** get_syllabus from the stored data only (no request to the university). */
export function getSyllabus(uc: UniContext, args: GetSyllabusArgs): SyllabusToolOutput {
  const r = resolveSyllabus(uc, args);
  if (r.kind === 'ambiguous') return r.output;
  return renderSyllabus(
    uc,
    r.picked,
    r.others,
    detailFetched(r.picked) ? undefined : NOT_FETCHED_NOTE,
  );
}

/** How get_syllabus reads a detail the daily sync has not opened yet. */
export interface SyllabusDetailFetcher {
  /** Fetch these entities' details (in the daemon, or in-process) and ingest them. */
  fetch: (ids: string[]) => Promise<DetailFetchReport>;
  /** How long the answer waits for the fetch (default SYLLABUS_FETCH_WAIT_MS). */
  waitMs?: number;
}

/** About six paced requests take well under this; longer means a sync holds the source. */
export const SYLLABUS_FETCH_WAIT_MS = 45_000;

const TIMED_OUT = Symbol('timeout');

/**
 * get_syllabus: when the course's syllabus detail has not been read yet, read it now from the
 * public syllabus (one course, about six requests paced like the sync) and answer with it. When
 * that is not possible right now, the connector queues it for its next sync, before every other
 * course, and the answer says so.
 */
export async function getSyllabusFetching(
  uc: UniContext,
  args: GetSyllabusArgs,
  fetcher: SyllabusDetailFetcher | undefined,
): Promise<SyllabusToolOutput> {
  const first = resolveSyllabus(uc, args);
  if (first.kind === 'ambiguous') return first.output;
  if (detailFetched(first.picked) || !fetcher) return getSyllabus(uc, args);
  const id = first.picked.offering.id;
  const running = fetcher.fetch([id]);
  running.catch(() => undefined); // keeps running after a timeout; errors are reported below
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outcome: DetailFetchReport | typeof TIMED_OUT | Error;
  try {
    outcome = await Promise.race([
      running,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), fetcher.waitMs ?? SYLLABUS_FETCH_WAIT_MS);
      }),
    ]);
  } catch (e) {
    outcome = e instanceof Error ? e : new Error(String(e));
  } finally {
    if (timer) clearTimeout(timer);
  }
  const keep = (note: string): SyllabusToolOutput =>
    renderSyllabus(uc, first.picked, first.others, note);
  if (outcome === TIMED_OUT)
    return keep(
      'この科目のシラバス詳細を大学のシラバスからいま取得しています（大学のサーバーに負担をかけないよう1件ずつ取得します）。少し待ってからもう一度 get_syllabus を呼ぶと詳細が入ります。それまでは一覧の情報のみです。',
    );
  if (outcome instanceof Error)
    return keep(`${NOT_FETCHED_NOTE}（その場での取得に失敗しました: ${outcome.message}）`);
  const result = outcome.results.find((r) => r.id === id);
  const reason = result?.error ? `（理由: ${result.error}）` : '';
  switch (result?.status) {
    case 'fetched':
    case 'alreadyFetched': {
      const again = resolveSyllabus(uc, args, id);
      if (again.kind === 'one' && detailFetched(again.picked))
        return renderSyllabus(
          uc,
          again.picked,
          again.others,
          result.status === 'fetched'
            ? 'シラバス詳細は、いま大学のシラバスから取得しました。'
            : undefined,
        );
      return keep(NOT_FETCHED_NOTE);
    }
    case 'queued':
      return keep(
        `この科目のシラバス詳細はいま取得できなかったため、次のシラバスの同期で最優先に取得します${reason}。それまでは一覧の情報のみです。`,
      );
    case 'notFound':
      return keep(
        'この科目は大学のシラバス検索で見つかりませんでした（掲載が変わった可能性があります）。一覧の情報のみです。',
      );
    default:
      return keep(`${NOT_FETCHED_NOTE}${reason}`);
  }
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
}

function termLabel(year: number | undefined, term: string | undefined): string {
  if (year === undefined && !term) return '不明';
  return `${year ?? ''} ${term ?? ''}`.trim();
}

function outcomeCredits(t: GradePeriodTotals | undefined) {
  return {
    earnedCredits: t?.earnedCredits ?? 0,
    failedCredits: t?.failedCredits ?? 0,
    inProgressCredits: t?.credits.in_progress ?? 0,
    notGradedCredits: t?.credits.not_graded ?? 0,
    withdrawnCredits: t?.credits.withdrawn ?? 0,
    transferredCredits: t?.credits.transferred ?? 0,
    unknownCredits: t?.credits.unknown ?? 0,
  };
}

function attemptView(a: GradeAttempt) {
  return {
    academicYear: a.academicYear ?? null,
    term: a.term ?? null,
    ...(a.termPart ? { termPart: a.termPart } : {}),
    evaluation: a.evaluation,
    outcome: a.outcome,
    ...(a.pendingReexam ? { pendingReexam: true } : {}),
    ...(a.interim ? { interim: true } : {}),
    ...(a.score !== undefined ? { score: a.score } : {}),
    ...(a.gradePoint !== undefined ? { gradePoint: a.gradePoint } : {}),
    ...(a.examType ? { examType: a.examType } : {}),
    ...(a.reportDate ? { reportDate: a.reportDate } : {}),
  };
}

const MAX_OPEN_CANDIDATES = 30;

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

  // Grades: every attempt of every year, with the verbatim evaluation and its outcome.
  const year = args.year ?? undefined;
  const everything = buildGradeReport(uc, {});
  const report = year === undefined ? everything : buildGradeReport(uc, { year });
  const gradeTerms = new Map(
    report.terms.map((t) => [termLabel(t.academicYear, t.term ? termKey(t.term) : undefined), t]),
  );
  for (const t of report.terms) row(t.academicYear, t.term);
  citedIds.push(...report.gradeIds.slice(0, 40));

  const sorted = [...rows.values()].sort(
    (a, b) =>
      (a.academicYear ?? 9999) - (b.academicYear ?? 9999) || termRank(a.term) - termRank(b.term),
  );
  const shown = year === undefined ? sorted : sorted.filter((r) => r.academicYear === year);
  const registeredTotal = round1(shown.reduce((n, r) => n + r.registeredCredits, 0));

  const thisTerm = rows.get(currentKey);
  const registeredThisTerm = {
    credits: thisTerm?.registeredCredits ?? 0,
    courses: thisTerm?.registeredCourses ?? 0,
    unknownCreditCourses: thisTerm?.unknownCreditCourses ?? 0,
  };
  const thisTimetable = myTimetable(uc, current.academicYear, current.term);
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
  notes.push(
    'evaluationは大学の表示どおりの評価、outcomeは集計用の区分です。修得単位はpassed（合格）とtransferred（認定）だけを数えます。not_graded（再試待ち・未評価）とunknown（区分を判定できない評価）は修得にも不合格にも数えていません。',
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
  if (report.unknownLabels.length > 0)
    notes.push(
      `区分を判定できない評価があります（${report.unknownLabels.map((l) => l || '空欄').join('、')}）。outcomeはunknownで、修得単位にも不合格にも数えていません。`,
    );
  if (everything.totals.attempts === 0)
    notes.push(
      '成績はまだ取り込まれていません（学務情報システムの成績は、ソースの設定でgrades: trueにすると取り込みます）。',
    );
  if (sorted.length === 0) notes.push('履修や成績のデータがまだ取り込まれていません。');

  const courses = report.courses.map((c) => ({
    ...(c.subjectCode ? { subjectCode: c.subjectCode } : {}),
    title: c.title,
    credits: c.credits ?? null,
    ...(c.category ? { category: c.category } : {}),
    ...(c.creditType ? { creditType: c.creditType } : {}),
    ...(c.markers ? { markers: c.markers.map((m) => m.label ?? m.symbol) } : {}),
    status: c.status,
    statusEvaluation: c.statusEvaluation,
    earned: c.earned,
    attemptCount: c.attempts.length,
    failedAttempts: c.failedAttempts,
    latest: attemptView(c.latest),
    attempts: c.attempts.map(attemptView),
  }));
  const notEarned = everything.courses
    .filter((c) => !c.earned)
    .map((c) => ({
      ...(c.subjectCode ? { subjectCode: c.subjectCode } : {}),
      title: c.title,
      credits: c.credits ?? null,
      ...(c.creditType ? { creditType: c.creditType } : {}),
      ...(c.category ? { category: c.category } : {}),
      latestEvaluation: c.latest.evaluation,
      latestOutcome: c.latest.outcome,
      latestTerm: termLabel(c.latest.academicYear, c.latest.term),
      attemptCount: c.attempts.length,
      failedAttempts: c.failedAttempts,
    }));

  const req = everything.requirements;
  const requirements = req
    ? {
        ...(req.requirementType ? { requirementType: req.requirementType.name } : {}),
        note: '学務情報システムの「単位修得情報」。expected（修得見込単位）は修得済みの単位に履修登録中の単位を足した値です。',
        rows: req.rows.map((r) => {
          const passed = r.courses.filter((c) => c.status === '合格').map((c) => c.title);
          const failed = r.courses.filter((c) => c.status === '不合格').map((c) => c.title);
          const open = r.courses.filter((c) => !c.status);
          return {
            depth: r.depth,
            name: r.name,
            ...(r.creditType ? { creditType: r.creditType } : {}),
            required: r.required ?? null,
            expected: r.expected ?? null,
            status: r.status ?? null,
            ...(r.shortfall !== undefined ? { shortfall: r.shortfall } : {}),
            ...(passed.length ? { passedCourses: passed } : {}),
            ...(failed.length ? { failedCourses: failed } : {}),
            ...(r.status === '不足' && open.length
              ? {
                  openCourses: open.slice(0, MAX_OPEN_CANDIDATES).map((c) => c.title),
                  ...(open.length > MAX_OPEN_CANDIDATES ? { openCourseCount: open.length } : {}),
                }
              : {}),
          };
        }),
        ...(req.markers?.length ? { markers: req.markers } : {}),
      }
    : null;

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
      timetableThisTerm: {
        term: termLabel(current.academicYear, current.term),
        courses: thisTimetable.courses,
        freeSlots: freeSlotsByHalf(uc, thisTimetable),
        note: '各学期は約8週ずつの前半・後半に分かれる。termPart が「後期前半」「後期後半」の科目はその期間だけ、「後期（前半・後半）」は学期を通して授業がある。freeSlots は平日1〜5限のうち登録済みの科目が無いコマ（月3 = 月曜3限）。',
      },
      terms: shown.map((r) => {
        const g = gradeTerms.get(r.key);
        return {
          term: r.key,
          academicYear: r.academicYear ?? null,
          termName: r.term ?? null,
          registeredCredits: r.registeredCredits,
          registeredCourses: r.registeredCourses,
          ...outcomeCredits(g),
          gradedCourses: g?.attempts ?? 0,
          outcomeCounts: g?.counts ?? null,
        };
      }),
      years: report.years.map((y) => ({
        academicYear: y.academicYear ?? null,
        ...outcomeCredits(y),
        attempts: y.attempts,
        outcomeCounts: y.counts,
      })),
      totals: { registeredCredits: registeredTotal, ...outcomeCredits(report.totals) },
      earnedCreditsAllYears: everything.totals.earnedCredits,
      evaluationLabels: report.labels,
      outcomeLabels: GRADE_OUTCOME_LABELS,
      courses,
      coursesNotEarned: notEarned,
      requirements,
      notes,
    },
    options: { citations: conciseCitations(uc.context.citationsFor(citedIds)) },
  };
}
