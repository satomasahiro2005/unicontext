import {
  classifyGradeLabel,
  type CourseOffering,
  GRADE_OUTCOMES,
  type Grade,
  type GradeOutcome,
  isEarnedOutcome,
  isGradeOutcome,
  isReexamLabel,
} from '@unicontext/canonical-model';
import type { UniContext } from './runtime.js';

/*
 * The student's grade history (every attempt of every year), grouped per course and per term.
 * The evaluation label of the university system is kept verbatim (`evaluation`); `outcome` is the
 * normalized category used for credit totals. Unknown labels stay `unknown` and are never counted
 * as passed or failed.
 */

export interface GradeMarkerView {
  symbol: string;
  label?: string;
}

/** One graded (or registered, not yet graded) attempt of a course. */
export interface GradeAttempt {
  /** Grade entity id. */
  id: string;
  subjectCode?: string;
  title: string;
  academicYear?: number;
  /** 前期 / 後期 / … */
  term?: string;
  /** Finer period (前期後半 …). */
  termPart?: string;
  /** 成績報告時期 verbatim. */
  reportTerm?: string;
  credits?: number;
  /** Evaluation label exactly as the source shows it ('' when there is none). */
  evaluation: string;
  outcome: GradeOutcome;
  /** 再試: failed the regular exam, waiting for the re-examination. */
  pendingReexam?: boolean;
  /** Interim result of a running course (not final; outcome in_progress). */
  interim?: boolean;
  score?: number;
  gradePoint?: number;
  /** 本試験 / 再試験 … */
  examType?: string;
  reportDate?: string;
  /** 科目区分. */
  category?: string;
  /** 単位区分 (必 / 選必 / 選択). */
  creditType?: string;
  markers?: GradeMarkerView[];
  replacedSubjectName?: string;
  courseOfferingId?: string;
  sourceId?: string;
  /** 1-based attempt number within the course (oldest first). */
  attemptNo: number;
}

/** All attempts of one course (grouped by course code, else by title). */
export interface GradeCourse {
  key: string;
  subjectCode?: string;
  title: string;
  credits?: number;
  category?: string;
  creditType?: string;
  markers?: GradeMarkerView[];
  /** Oldest first. */
  attempts: GradeAttempt[];
  failedAttempts: number;
  latest: GradeAttempt;
  /** Credit earned by some attempt (passed or transferred). */
  earned: boolean;
  /** The earning attempt's outcome when earned, else the latest attempt's outcome. */
  status: GradeOutcome;
  /** Evaluation label behind `status`. */
  statusEvaluation: string;
}

export type OutcomeNumbers = Record<GradeOutcome, number>;

export interface GradePeriodTotals {
  /** "2026 前期", "2026", or "不明". */
  key: string;
  academicYear?: number;
  term?: string;
  attempts: number;
  /** Earned credits (passed + transferred). */
  earnedCredits: number;
  failedCredits: number;
  /** Credits per outcome. */
  credits: OutcomeNumbers;
  /** Attempts per outcome. */
  counts: OutcomeNumbers;
}

export interface GradeLabelCount {
  evaluation: string;
  outcome: GradeOutcome;
  count: number;
}

export interface RequirementCourseView {
  title: string;
  creditType?: string;
  credits?: number;
  /** 合格 / 不合格 verbatim; absent when not taken yet. */
  status?: string;
}

export interface RequirementRowView {
  depth: number;
  name: string;
  creditType?: string;
  required?: number;
  /** 修得見込単位: earned credits plus those of registered, not yet graded courses. */
  expected?: number;
  /** 充足 / 不足 verbatim. */
  status?: string;
  /** required - expected when positive. */
  shortfall?: number;
  courses: RequirementCourseView[];
}

export interface CreditRequirementsView {
  requirementType?: { code: string; name: string };
  rows: RequirementRowView[];
  markers?: (GradeMarkerView & { capCredits?: number; totalCredits?: number })[];
  sourceReferenceId?: string;
  observedAt?: string;
}

export interface GradeReportOptions {
  /** Only attempts of this academic year (totals included). */
  year?: number | undefined;
  /** Only list attempts whose outcome or evaluation label is one of these. */
  statuses?: readonly string[] | undefined;
  /** Only list failed attempts. */
  failedOnly?: boolean | undefined;
}

export interface GradeReport {
  /** Listed attempts (after the filters), oldest term first. */
  attempts: GradeAttempt[];
  /** Courses with at least one listed attempt; each carries its full attempt history. */
  courses: GradeCourse[];
  /** Per term (year filter applied, status filters not applied). */
  terms: GradePeriodTotals[];
  /** Per academic year. */
  years: GradePeriodTotals[];
  totals: GradePeriodTotals;
  /** Every distinct evaluation label with its outcome and count. */
  labels: GradeLabelCount[];
  /** Labels whose outcome is unknown (shown, never counted as passed or failed). */
  unknownLabels: string[];
  requirements?: CreditRequirementsView;
  /** Grade entity ids (for citations). */
  gradeIds: string[];
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return undefined;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** "2026前期" / "2026年度 前期 前期後半" → year, term, rest. */
export function parseReportTermText(text: string | undefined): {
  academicYear?: number;
  term?: string;
  termPart?: string;
} {
  const s = (text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const m = /^(\d{4})\s*年?度?\s*(.*)$/.exec(s);
  if (!m) return {};
  const rest = (m[2] ?? '').trim();
  const t = /^(前期|後期|通年|春学期|秋学期|夏期|冬期|集中|第[1-4]クォーター|[1-4]Q)\s*(.*)$/.exec(
    rest,
  );
  if (t)
    return { academicYear: Number(m[1]), term: t[1], ...(t[2] ? { termPart: t[2].trim() } : {}) };
  const [term, ...more] = rest.split(' ').filter(Boolean);
  return {
    academicYear: Number(m[1]),
    ...(term ? { term } : {}),
    ...(more.length ? { termPart: more.join(' ') } : {}),
  };
}

function termOrder(term: string | undefined): number {
  const t = (term ?? '').normalize('NFKC');
  if (/^(前期|春|第1|1Q|第2|2Q)/.test(t)) return 1;
  if (/^(夏)/.test(t)) return 2;
  if (/^(後期|秋|第3|3Q|第4|4Q)/.test(t)) return 3;
  if (/^(冬)/.test(t)) return 4;
  if (/^通年/.test(t)) return 5;
  return t ? 6 : 9;
}

function attemptOrder(a: GradeAttempt, b: GradeAttempt): number {
  return (
    (a.academicYear ?? 9999) - (b.academicYear ?? 9999) ||
    termOrder(a.term) - termOrder(b.term) ||
    (a.termPart ?? '').localeCompare(b.termPart ?? '') ||
    (a.reportDate ?? '').localeCompare(b.reportDate ?? '') ||
    (a.examType === '再試験' ? 1 : 0) - (b.examType === '再試験' ? 1 : 0)
  );
}

function zero(): OutcomeNumbers {
  return Object.fromEntries(GRADE_OUTCOMES.map((o) => [o, 0])) as OutcomeNumbers;
}

function periodKey(year: number | undefined, term: string | undefined): string {
  if (year === undefined && !term) return '不明';
  return `${year ?? ''} ${term ?? ''}`.trim();
}

function emptyTotals(key: string, year?: number, term?: string): GradePeriodTotals {
  return {
    key,
    ...(year !== undefined ? { academicYear: year } : {}),
    ...(term ? { term } : {}),
    attempts: 0,
    earnedCredits: 0,
    failedCredits: 0,
    credits: zero(),
    counts: zero(),
  };
}

function addTo(t: GradePeriodTotals, a: GradeAttempt): void {
  t.attempts++;
  t.counts[a.outcome]++;
  const c = a.credits ?? 0;
  t.credits[a.outcome] = round1(t.credits[a.outcome] + c);
  if (isEarnedOutcome(a.outcome)) t.earnedCredits = round1(t.earnedCredits + c);
  if (a.outcome === 'failed') t.failedCredits = round1(t.failedCredits + c);
}

function markersOf(v: unknown): GradeMarkerView[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((m): m is { symbol: string; label?: unknown } => !!m && typeof m.symbol === 'string')
    .map((m) => ({ symbol: m.symbol, ...(typeof m.label === 'string' ? { label: m.label } : {}) }));
  return out.length ? out : undefined;
}

function toAttempt(uc: UniContext, g: Grade): Omit<GradeAttempt, 'attemptNo'> {
  const entities = uc.sync.stores.entities;
  const x = (g.extra ?? {}) as Record<string, unknown>;
  const offering: CourseOffering | undefined = g.courseOfferingId
    ? entities.getOfKind('courseOffering', g.courseOfferingId)
    : undefined;
  const reportTerm = str(x.reportTerm);
  const parsed = parseReportTermText(reportTerm);
  const academicYear = num(x.academicYear) ?? parsed.academicYear ?? offering?.academicYear;
  const term = str(x.term) ?? parsed.term ?? offering?.term;
  const termPart = str(x.termPart) ?? parsed.termPart;
  const evaluation =
    typeof x.evaluation === 'string' ? x.evaluation.trim() : (g.letter ?? '').trim();
  // The connector's outcome wins; other sources are classified from the label alone.
  const outcome = isGradeOutcome(x.outcome)
    ? x.outcome
    : classifyGradeLabel(evaluation, { emptyAs: 'unknown' });
  let credits = num(x.credits);
  if (credits === undefined && offering) {
    credits =
      num(offering.extra?.['credits']) ??
      (offering.courseId ? entities.getOfKind('course', offering.courseId)?.credits : undefined);
  }
  const title =
    str(x.subjectName) ??
    (offering?.courseId ? entities.getOfKind('course', offering.courseId)?.title : undefined) ??
    str(x.subjectCode) ??
    g.id;
  const markers = markersOf(x.markers);
  const sourceId = uc.sync.stores.sourceRefs.forEntity(g.id)[0]?.sourceId;
  return {
    id: g.id,
    ...(str(x.subjectCode) ? { subjectCode: str(x.subjectCode) } : {}),
    title,
    ...(academicYear !== undefined ? { academicYear } : {}),
    ...(term ? { term } : {}),
    ...(termPart ? { termPart } : {}),
    ...(reportTerm ? { reportTerm } : {}),
    ...(credits !== undefined ? { credits } : {}),
    evaluation,
    outcome,
    ...(x.pendingReexam === true || isReexamLabel(evaluation) ? { pendingReexam: true } : {}),
    ...(x.interim === true ? { interim: true } : {}),
    ...(g.score !== undefined ? { score: g.score } : {}),
    ...(g.gradePoint !== undefined ? { gradePoint: g.gradePoint } : {}),
    ...(str(x.examType) ? { examType: str(x.examType) } : {}),
    ...(str(x.reportDate) ? { reportDate: str(x.reportDate) } : {}),
    ...(str(x.category) ? { category: str(x.category) } : {}),
    ...(str(x.creditType) ? { creditType: str(x.creditType) } : {}),
    ...(markers ? { markers } : {}),
    ...(str(x.replacedSubjectName) ? { replacedSubjectName: str(x.replacedSubjectName) } : {}),
    ...(g.courseOfferingId ? { courseOfferingId: g.courseOfferingId } : {}),
    ...(sourceId ? { sourceId } : {}),
  };
}

function courseKey(a: Pick<GradeAttempt, 'subjectCode' | 'title'>): string {
  return a.subjectCode
    ? `code:${a.subjectCode}`
    : `title:${a.title.normalize('NFKC').replace(/\s+/g, '')}`;
}

function matchesStatus(a: GradeAttempt, statuses: readonly string[]): boolean {
  return statuses.some((s) => {
    const t = s.normalize('NFKC').trim();
    return t === a.outcome || t === a.evaluation.normalize('NFKC').trim();
  });
}

/** The 単位修得情報 fact (requirement status) of the student, when a source provides one. */
export function creditRequirements(uc: UniContext): CreditRequirementsView | undefined {
  const selfIds = uc.sync.stores.entities
    .list('person')
    .filter((p) => p.isSelf)
    .map((p) => p.id);
  if (selfIds.length === 0) return undefined;
  const facts = uc.resolver.facts
    .active({ subjects: selfIds, predicate: 'credit_requirements' })
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  const fact = facts[0];
  const v = fact?.value as Record<string, unknown> | undefined;
  if (!fact || !v || !Array.isArray(v.rows)) return undefined;
  const rows: RequirementRowView[] = (v.rows as Record<string, unknown>[]).map((r) => {
    const required = num(r.required);
    const expected = num(r.expected);
    const shortfall =
      required !== undefined && expected !== undefined && required > expected
        ? round1(required - expected)
        : undefined;
    const courses = (Array.isArray(r.courses) ? (r.courses as Record<string, unknown>[]) : []).map(
      (c) => ({
        title: String(c.title ?? ''),
        ...(str(c.creditType) ? { creditType: str(c.creditType) } : {}),
        ...(num(c.credits) !== undefined ? { credits: num(c.credits) } : {}),
        ...(str(c.status) ? { status: str(c.status) } : {}),
      }),
    );
    return {
      depth: num(r.depth) ?? 0,
      name: String(r.name ?? ''),
      ...(str(r.creditType) ? { creditType: str(r.creditType) } : {}),
      ...(required !== undefined ? { required } : {}),
      ...(expected !== undefined ? { expected } : {}),
      ...(str(r.status) ? { status: str(r.status) } : {}),
      ...(shortfall !== undefined ? { shortfall } : {}),
      courses,
    };
  });
  const rt = v.requirementType as { code?: unknown; name?: unknown } | undefined;
  return {
    ...(rt && typeof rt.code === 'string' && typeof rt.name === 'string'
      ? { requirementType: { code: rt.code, name: rt.name } }
      : {}),
    rows,
    ...(Array.isArray(v.markers)
      ? { markers: v.markers as CreditRequirementsView['markers'] }
      : {}),
    sourceReferenceId: fact.sourceReferenceId,
    observedAt: fact.observedAt,
  };
}

/** Build the grade report from the canonical grades (all sources). */
export function buildGradeReport(uc: UniContext, options: GradeReportOptions = {}): GradeReport {
  const all = uc.sync.stores.entities
    .list('grade')
    .map((g) => toAttempt(uc, g))
    .map((a) => ({ ...a, attemptNo: 0 }) as GradeAttempt);

  // Courses over the whole history (attempt numbers and "earned later" ignore the filters).
  const byCourse = new Map<string, GradeAttempt[]>();
  for (const a of all) {
    const k = courseKey(a);
    byCourse.set(k, [...(byCourse.get(k) ?? []), a]);
  }
  const courses = new Map<string, GradeCourse>();
  for (const [key, list] of byCourse) {
    list.sort(attemptOrder);
    list.forEach((a, i) => {
      a.attemptNo = i + 1;
    });
    const latest = list[list.length - 1] as GradeAttempt;
    const earning = [...list].reverse().find((a) => isEarnedOutcome(a.outcome));
    const info = [...list].reverse().find((a) => a.credits !== undefined) ?? latest;
    courses.set(key, {
      key,
      ...(latest.subjectCode ? { subjectCode: latest.subjectCode } : {}),
      title: latest.title,
      ...(info.credits !== undefined ? { credits: info.credits } : {}),
      ...(latest.category ? { category: latest.category } : {}),
      ...(latest.creditType ? { creditType: latest.creditType } : {}),
      ...(latest.markers ? { markers: latest.markers } : {}),
      attempts: list,
      failedAttempts: list.filter((a) => a.outcome === 'failed').length,
      latest,
      earned: earning !== undefined,
      status: (earning ?? latest).outcome,
      statusEvaluation: (earning ?? latest).evaluation,
    });
  }

  const inYear = all.filter((a) => options.year === undefined || a.academicYear === options.year);
  inYear.sort(attemptOrder);

  const terms = new Map<string, GradePeriodTotals>();
  const years = new Map<string, GradePeriodTotals>();
  const totals = emptyTotals(options.year !== undefined ? String(options.year) : '全期間');
  const labels = new Map<string, GradeLabelCount>();
  for (const a of inYear) {
    const tk = periodKey(a.academicYear, a.term);
    if (!terms.has(tk)) terms.set(tk, emptyTotals(tk, a.academicYear, a.term));
    addTo(terms.get(tk) as GradePeriodTotals, a);
    const yk = a.academicYear !== undefined ? String(a.academicYear) : '不明';
    if (!years.has(yk)) years.set(yk, emptyTotals(yk, a.academicYear));
    addTo(years.get(yk) as GradePeriodTotals, a);
    addTo(totals, a);
    const lk = `${a.evaluation}\u0000${a.outcome}`;
    const l = labels.get(lk) ?? { evaluation: a.evaluation, outcome: a.outcome, count: 0 };
    l.count++;
    labels.set(lk, l);
  }

  let listed = inYear;
  if (options.failedOnly) listed = listed.filter((a) => a.outcome === 'failed');
  if (options.statuses?.length) {
    const statuses = options.statuses;
    listed = listed.filter((a) => matchesStatus(a, statuses));
  }
  const listedCourses = [...new Set(listed.map((a) => courseKey(a)))]
    .map((k) => courses.get(k))
    .filter((c): c is GradeCourse => c !== undefined)
    .sort(
      (a, b) =>
        attemptOrder(a.attempts[0] as GradeAttempt, b.attempts[0] as GradeAttempt) ||
        a.title.localeCompare(b.title, 'ja'),
    );

  const sortPeriods = (xs: GradePeriodTotals[]): GradePeriodTotals[] =>
    xs.sort(
      (a, b) =>
        (a.academicYear ?? 9999) - (b.academicYear ?? 9999) ||
        termOrder(a.term) - termOrder(b.term),
    );
  const requirements = creditRequirements(uc);
  return {
    attempts: listed,
    courses: listedCourses,
    terms: sortPeriods([...terms.values()]),
    years: sortPeriods([...years.values()]),
    totals,
    labels: [...labels.values()].sort(
      (a, b) =>
        GRADE_OUTCOMES.indexOf(a.outcome) - GRADE_OUTCOMES.indexOf(b.outcome) || b.count - a.count,
    ),
    unknownLabels: [
      ...new Set(inYear.filter((a) => a.outcome === 'unknown').map((a) => a.evaluation)),
    ],
    ...(requirements ? { requirements } : {}),
    gradeIds: listed.map((a) => a.id),
  };
}
