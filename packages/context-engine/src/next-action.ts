/**
 * Next-action engine: decides the ONE thing the student should start right now, plus the next
 * few, without asking them to prioritise anything. Deterministic (no LLM): every action has a
 * numeric score built from deadline proximity, remaining effort against the student's free time
 * before the deadline, submission state, weight and kind (docs/ARCHITECTURE.md §3.13).
 *
 * The engine only reads; it never changes a task.
 */
import type { Assignment, Exam, Submission, Task, TaskStatus } from '@unicontext/canonical-model';
import { formatShortJa, redact, zonedParts } from '@unicontext/core';
import { uniqueCitations } from '@unicontext/provenance';
import { remainingSteps, type TaskProgressValue } from '@unicontext/task-engine';
import type { CoverageGap, DeadlineCoverage } from './coverage.js';
import type { EstimatedDue } from './estimate.js';
import { nextActionBusy } from './schedule-events.js';
import type {
  Citation,
  ClassItem,
  CourseRef,
  PaceItem,
  PreparationItem,
  RecordedMarker,
} from './types.js';

// ---------- effort model ----------

/** What kind of work an item is, for the effort estimate and the first steps. */
export const WORK_KINDS = [
  'quiz',
  'short_report',
  'report',
  'lab_report',
  'exercise',
  'exam_study',
  'quiz_study',
  'weekly',
  'prep',
  'todo',
  'check',
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export const WORK_KIND_LABELS: Record<WorkKind, string> = {
  quiz: '小テスト',
  short_report: '小レポート',
  report: 'レポート',
  lab_report: '実験レポート',
  exercise: '課題',
  exam_study: '試験勉強',
  quiz_study: '小テスト対策',
  weekly: '今週分',
  prep: '授業準備',
  todo: 'やること',
  check: '確認',
};

export interface WorkStep {
  text: string;
  minutes: number;
}

/**
 * First steps per kind: each one is startable right away. The largest step absorbs an effort
 * override; the sums are the default effort estimates (minutes).
 */
const STEPS: Record<WorkKind, WorkStep[]> = {
  quiz: [{ text: '開いて受ける', minutes: 20 }],
  short_report: [
    { text: '課題文を開いて設問を読む', minutes: 10 },
    { text: '書くことを3行メモする', minutes: 15 },
    { text: '本文を書いて提出する', minutes: 35 },
  ],
  report: [
    { text: '課題文と条件（字数・形式・提出方法）を確認する', minutes: 10 },
    { text: '構成を箇条書きで作る', minutes: 20 },
    { text: '本文を書く', minutes: 120 },
    { text: '見直して提出する', minutes: 30 },
  ],
  lab_report: [
    { text: '実験データとテンプレートを開く', minutes: 10 },
    { text: '目的と方法を書く', minutes: 40 },
    { text: '結果の表とグラフを作る', minutes: 90 },
    { text: '考察を書く', minutes: 180 },
    { text: '見直して提出する', minutes: 40 },
  ],
  exercise: [
    { text: '課題を開いて問題を確認する', minutes: 10 },
    { text: '解いて提出する', minutes: 50 },
  ],
  exam_study: [
    { text: '試験範囲と形式を確認する', minutes: 10 },
    { text: '講義資料を1回分見返す', minutes: 50 },
    { text: '範囲の資料を全部見返す', minutes: 300 },
    { text: '練習問題を解く', minutes: 120 },
  ],
  quiz_study: [
    { text: '範囲を確認する', minutes: 10 },
    { text: '資料を見返す', minutes: 20 },
  ],
  weekly: [
    { text: '今週分の教材を開く', minutes: 10 },
    { text: '今週分を進める', minutes: 80 },
  ],
  prep: [{ text: '資料を開いて目を通す', minutes: 15 }],
  todo: [{ text: '', minutes: 30 }],
  check: [{ text: '', minutes: 5 }],
};

/** Default effort per kind (minutes): 小テスト 20, 小レポート 60, レポート 180, 実験レポート 360, 試験勉強 480 … */
export const DEFAULT_EFFORT_MINUTES: Record<WorkKind, number> = Object.fromEntries(
  WORK_KINDS.map((k) => [k, STEPS[k].reduce((s, x) => s + x.minutes, 0)]),
) as Record<WorkKind, number>;

/** Steps of a kind for a total effort (the largest step absorbs the difference, ≥ 5 minutes). */
export function stepsFor(kind: WorkKind, totalMinutes?: number): WorkStep[] {
  const base = STEPS[kind].map((s) => ({ ...s }));
  if (totalMinutes === undefined) return base;
  const sum = base.reduce((s, x) => s + x.minutes, 0);
  let main = 0;
  base.forEach((s, i) => {
    if (s.minutes > (base[main]?.minutes ?? 0)) main = i;
  });
  const step = base[main];
  if (step) step.minutes = Math.max(5, step.minutes + Math.round(totalMinutes) - sum);
  return base;
}

/** Work kind of a task from its kind, title, assignment fields and exam kind. */
export function classifyWork(
  task: Pick<Task, 'taskKind' | 'title'>,
  assignment?: Pick<Assignment, 'title' | 'submissionType'>,
  exam?: Pick<Exam, 'examKind' | 'title'>,
): WorkKind {
  if (task.taskKind === 'weekly_pace') return 'weekly';
  if (task.taskKind === 'exam_preparation') {
    const t = `${exam?.title ?? ''} ${task.title}`;
    return exam?.examKind === 'quiz' || /小テスト|クイズ|quiz|確認テスト/i.test(t)
      ? 'quiz_study'
      : 'exam_study';
  }
  const text = `${assignment?.title ?? task.title} ${assignment?.submissionType ?? ''}`;
  if (/小テスト|クイズ|quiz|確認テスト/i.test(text)) return 'quiz';
  if (/実験/.test(text) && /レポート|報告/.test(text)) return 'lab_report';
  if (/小レポート|ミニレポート|リアクション|感想|コメントシート|ワークシート|振り返り/.test(text))
    return 'short_report';
  if (/レポート|report|論述|エッセイ|essay/i.test(text)) return 'report';
  if (task.taskKind === 'assignment') return 'exercise';
  // A deadline found in a notice or post that asks for work to be handed in.
  if (task.taskKind === 'extracted' && /課題|宿題|提出/.test(text)) return 'exercise';
  return 'todo';
}

/** Kinds of work that are handed in or sat: they have a deadline even when none is known. */
const DEADLINED_WORK = new Set<WorkKind>([
  'quiz',
  'short_report',
  'report',
  'lab_report',
  'exercise',
  'exam_study',
  'quiz_study',
]);

/**
 * The item has a deadline somewhere, known or not (assignments, exams, work to hand in found in
 * notices or chats): when its due date is unknown it gets an estimate (estimate.ts) instead of
 * being treated as 「期限なし」. The student's own to-dos (manual) and 今週分 are not.
 */
export function hasDeadline(task: Pick<Task, 'taskKind'>, workKind: WorkKind): boolean {
  if (task.taskKind === 'assignment' || task.taskKind === 'exam_preparation') return true;
  return task.taskKind === 'extracted' && DEADLINED_WORK.has(workKind);
}

// ---------- result shapes ----------

export type NextActionKind =
  | 'assignment'
  | 'exam'
  | 'weekly'
  | 'todo'
  | 'prep'
  | 'attend'
  | 'check_deadline'
  | 'check_late'
  | 'coverage';

export interface NextActionLink {
  url: string;
  /** Where the link goes: 学務情報システム, EdStem, Teams … */
  label: string | undefined;
}

export interface NextAction {
  /** Stable for the same item: `<kind>:<task / session / source id>`. */
  id: string;
  kind: NextActionKind;
  /** Concrete, startable within about 5 minutes: 「小レポート1: 課題文を開いて設問を読む（10分）」. */
  what: string;
  /** One short reason: 「締切まで27時間・未提出・配点10点」. */
  why: string;
  /** The whole item (assignment / exam / class title). */
  title: string;
  taskId: string | undefined;
  course: CourseRef | undefined;
  dueAt: string | undefined;
  /** 「10/6 17:00」, 「締切不明（推定10/8 10:20）」. */
  dueText: string;
  hoursLeft: number | undefined;
  overdue: boolean;
  workKind: WorkKind;
  /** 小レポート, 実験レポート, 試験勉強 … */
  workLabel: string;
  effort: {
    /** This first step. */
    stepMinutes: number;
    /** Everything left of the item (estimate). */
    remainingMinutes: number;
    totalMinutes: number;
    /** default = by kind; item = the item states it (extra.estimatedMinutes); override = options. */
    basis: 'default' | 'item' | 'override';
  };
  /** The remaining steps; the first one is `what`. */
  steps: string[];
  /** Free awake hours outside classes before the deadline (before the usable share). */
  freeHoursBeforeDue: number | undefined;
  link: NextActionLink | undefined;
  status: TaskStatus | undefined;
  /** Submission state from the submission system, when it reports one. */
  submission: Submission['status'] | undefined;
  score: number;
  /** Machine-readable reasons: due_24h, unsubmitted, cannot_finish, unknown_due, coverage_stale … */
  reasons: string[];
  recorded?: RecordedMarker | undefined;
  /**
   * The due date is unknown: the earliest plausible one, 「推定」 with its basis (never a stated
   * deadline). `dueAt` stays undefined; the ranking uses this.
   */
  estimatedDue?: EstimatedDue | undefined;
  citations: Citation[];
}

export interface DueSoonItem {
  taskId: string;
  title: string;
  course: string | undefined;
  courseId: string | undefined;
  /** The deadline, or for an unknown one the estimate (`estimated`). */
  dueAt: string;
  /** 「10/6 17:00」; an estimate reads 「推定10/8 10:20」. */
  dueText: string;
  hoursLeft: number;
  /** An assignment the submission system does not report as submitted. */
  unsubmitted: boolean;
  link: NextActionLink | undefined;
  /** The due date is unknown and `dueAt` is its estimate: always say 「推定」. */
  estimated?: EstimatedDue | undefined;
  citations: Citation[];
}

export interface NextActionsContext {
  view: 'next-action';
  generatedAt: string;
  timezone: string;
  /** Do this now. Undefined only when nothing at all is open. */
  top: NextAction | undefined;
  /** Then these (default 3). */
  next: NextAction[];
  /**
   * An unsubmitted assignment is due — or, with an unknown due date, estimated due — within 48
   * hours: open the conversation with `top`.
   */
  urgent: boolean;
  /** One line to say first: 「今やること: …（…）」. */
  line: string;
  /** Open deadlines within 72 hours (estimates of unknown ones included, marked), soonest first. */
  dueSoon: DueSoonItem[];
  /**
   * Whether the deadline sources can be trusted right now: the coverage gaps (coverage.ts) other
   * than undated assignments, which are actions of their own.
   */
  coverage: { trusted: boolean; gaps: CoverageGap[] };
  /** Open items looked at. */
  considered: number;
}

/** Compact form embedded in the today / week views (`next`). */
export interface NextActionSummary {
  line: string;
  urgent: boolean;
  top: NextAction | undefined;
  then: { what: string; dueText: string; course: string | undefined }[];
  coverageTrusted: boolean;
}

export interface NextActionOptions {
  /** How many actions after the top one (default 3, max 10). */
  count?: number;
  /** Effort per kind in minutes, overriding the defaults. */
  effortMinutes?: Partial<Record<WorkKind, number>>;
  /** Restrict to one course (any linked id). Coverage checks are left out then. */
  courseOfferingId?: string;
}

// ---------- host (what the engine reads) ----------

/** The slice of the context engine the next-action engine reads (built by ContextEngine). */
export interface NextActionHost {
  now: Date;
  timezone: string;
  openTasks(): Task[];
  assignment(id: string): Assignment | undefined;
  /** Latest submission of an assignment. */
  submission(assignmentId: string): Submission | undefined;
  exam(id: string): Exam | undefined;
  courseRef(id: string | undefined): CourseRef | undefined;
  citations(task: Task): Citation[];
  recorded(task: Task): RecordedMarker | undefined;
  /** What the student said about how far the task has come (record_task_progress), if anything. */
  progress?(task: Task): Pick<TaskProgressValue, 'steps'> | undefined;
  /** Estimated deadline of an item whose due date is unknown (estimate.ts), else undefined. */
  estimate(task: Task): EstimatedDue | undefined;
  /** A course the student does not take (syllabus catalog only, or dropped). */
  notTaken(courseId: string): boolean;
  /** The course meets only in a half of the term (前半/後半) that is over on `date`. */
  halfOver(courseId: string, date: string): boolean;
  /** Classes and self-study slots from `fromDate` through `toDate` (local dates, inclusive). */
  classes(fromDate: string, toDate: string): ClassItem[];
  preparation(item: ClassItem): PreparationItem;
  pacing(): PaceItem[];
  /** Deadline coverage of the student's current courses (coverage.ts). */
  coverage(): DeadlineCoverage;
  /** Where the student can look a source's work up (the platform origin), if known. */
  sourceUrl(sourceId: string): string | undefined;
  /** Label of the system an entity came from (EdStem, 学務情報システム …). */
  sourceLabelOf(entityId: string): string | undefined;
}

// ---------- tuning (deterministic) ----------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Look-ahead for class times when computing free time. */
const HORIZON_DAYS = 21;
/** Awake window for free time (local hours). */
const AWAKE_FROM = 8;
const AWAKE_TO = 24;
/** Share of free awake time a student actually spends on one item (meals, commute, rest …). */
const USABLE_SHARE = 0.5;
/**
 * An item with an unknown due date is ranked against its estimate (the earliest plausible time,
 * estimate.ts), never pushed down for being unknown. An estimate already past counts as due in
 * this many hours (confirming takes 5 minutes; a stated deadline in 3 hours still comes first).
 */
const PASSED_ESTIMATE_HOURS = 3;
/** An undated personal to-do is ranked as if due this many hours from now. */
const UNDATED_TODO_HOURS = 7 * 24;
/** Overdue items within this many days may still be accepted late. */
const LATE_WINDOW_DAYS = 7;
/** A class starting within this many minutes becomes 「…に出る」. */
const ATTEND_WITHIN_MIN = 45;
const SUBMITTED = new Set(['submitted', 'late', 'graded', 'returned']);

const KIND_FACTOR: Record<WorkKind, number> = {
  quiz: 1,
  short_report: 1,
  report: 1,
  lab_report: 1,
  exercise: 1,
  exam_study: 1,
  quiz_study: 0.9,
  weekly: 0.8,
  prep: 0.6,
  todo: 0.8,
  check: 1,
};

/** 1000 when due now, 500 at 6 h, 200 at 24 h, 111 at 48 h, 34 at a week. */
function deadlinePart(hoursLeft: number): number {
  return 1000 / (1 + Math.max(0, hoursLeft) / 6);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 「27時間」「3日」「40分」 */
export function leftText(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}分`;
  if (hours < 48) return `${Math.floor(hours)}時間`;
  return `${Math.floor(hours / 24)}日`;
}

function hhmm(iso: string, tz: string): string {
  const p = zonedParts(new Date(iso), tz);
  return `${p.hour}:${String(p.minute).padStart(2, '0')}`;
}

function safeLink(url: string | undefined, label: string | undefined): NextActionLink | undefined {
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  return { url: String(redact(url)), label };
}

function linkFromCitations(citations: readonly Citation[]): NextActionLink | undefined {
  for (const c of citations) {
    const l = safeLink(c.url, c.sourceLabel ?? c.sourceSystem);
    if (l) return l;
  }
  return undefined;
}

function localDate(d: Date, tz: string): string {
  const p = zonedParts(d, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

interface Busy {
  start: number;
  end: number;
}

/**
 * Free awake minutes between `from` and `to`: AWAKE_FROM–AWAKE_TO local time each day, minus
 * class times. Days are local midnights stepped by 24 h (DST-naive).
 */
export function freeMinutes(from: Date, to: Date, busy: readonly Busy[], tz: string): number {
  if (to <= from) return 0;
  const p = zonedParts(from, tz);
  const midnight =
    from.getTime() - ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 - (from.getTime() % 1000);
  const days = Math.min(HORIZON_DAYS + 1, Math.ceil((to.getTime() - midnight) / DAY));
  let total = 0;
  for (let i = 0; i < days; i++) {
    const d = midnight + i * DAY;
    const a = Math.max(from.getTime(), d + AWAKE_FROM * HOUR);
    const b = Math.min(to.getTime(), d + AWAKE_TO * HOUR);
    if (b <= a) continue;
    let free = b - a;
    for (const x of busy) {
      const s = Math.max(a, x.start);
      const e = Math.min(b, x.end);
      if (e > s) free -= e - s;
    }
    total += Math.max(0, free);
  }
  return total / 60_000;
}

function numberField(extra: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = extra?.[key];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

function dateField(
  extra: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const k of keys) {
    const v = extra?.[k];
    if (typeof v === 'string' && Number.isFinite(Date.parse(v))) return v;
  }
  return undefined;
}

// ---------- engine ----------

interface Candidate extends NextAction {
  sortDue: number;
}

/** Extra fields of an assignment that name a later cut-off for late submissions. */
const LATE_DUE_KEYS = ['lateDueAt', 'lateDue', 'cutoffAt', 'closesAt'] as const;

/**
 * Ranks what to do now. Pure over the host: the same data and `now` give the same answer.
 */
export function computeNextActions(
  host: NextActionHost,
  options: NextActionOptions = {},
): NextActionsContext {
  const now = host.now;
  const tz = host.timezone;
  const nowMs = now.getTime();
  const today = localDate(now, tz);
  const classes = host.classes(today, localDate(new Date(nowMs + HORIZON_DAYS * DAY), tz));
  // Classes, plus calendar events and the trips before meetings when the host knows them.
  const busy: Busy[] = nextActionBusy(
    host,
    classes,
    today,
    localDate(new Date(nowMs + HORIZON_DAYS * DAY), tz),
  );
  const effortOverride = options.effortMinutes ?? {};
  const wanted = options.courseOfferingId
    ? new Set(host.courseRef(options.courseOfferingId)?.linkedIds ?? [options.courseOfferingId])
    : undefined;
  const inCourse = (c: CourseRef | undefined): boolean =>
    !wanted || (c !== undefined && c.linkedIds.some((id) => wanted.has(id)));

  // A self-study slot running now (or within 30 minutes) pushes that course's 今週分 up.
  const studyNow = new Map<string, string>();
  for (const c of classes) {
    if (c.sessionKind !== 'self_study' || !c.startsAt) continue;
    const s = Date.parse(c.startsAt);
    const e = c.endsAt ? Date.parse(c.endsAt) : s + 90 * 60_000;
    if (s - 30 * 60_000 <= nowMs && nowMs < e)
      studyNow.set(
        c.course.id,
        `${hhmm(c.startsAt, tz)}${c.endsAt ? `-${hhmm(c.endsAt, tz)}` : ''}`,
      );
  }

  const candidates: Candidate[] = [];
  const dueSoon: DueSoonItem[] = [];
  let considered = 0;

  for (const t of host.openTasks()) {
    if (t.courseOfferingId && host.notTaken(t.courseOfferingId)) continue;
    const course = host.courseRef(t.courseOfferingId);
    if (!inCourse(course)) continue;
    const assignment = t.assignmentId ? host.assignment(t.assignmentId) : undefined;
    const sub = t.assignmentId ? host.submission(t.assignmentId) : undefined;
    // Done per the submission system even if the task has not caught up yet: never nag.
    if (sub && SUBMITTED.has(sub.status)) continue;
    const exam = t.examId ? host.exam(t.examId) : undefined;
    considered++;

    const workKind = classifyWork(t, assignment, exam);
    const itemMinutes = numberField(assignment?.extra, 'estimatedMinutes');
    const override = effortOverride[workKind];
    const total = override ?? itemMinutes ?? DEFAULT_EFFORT_MINUTES[workKind];
    const basis: NextAction['effort']['basis'] =
      override !== undefined ? 'override' : itemMinutes !== undefined ? 'item' : 'default';
    const steps = stepsFor(workKind, total);
    // The steps the student said they did are dropped; with no record all steps stay (an
    // in_progress status alone says nothing about which step is done).
    const remainingPlan = remainingSteps(steps, host.progress?.(t));
    // Everything done but the work is still open: the last step (hand in, check) remains.
    const left = remainingPlan.length > 0 ? remainingPlan : steps.slice(-1);
    const remaining = left.reduce((s, x) => s + x.minutes, 0);
    const first = left[0] ?? { text: '', minutes: remaining };
    // Titles of notice deadlines are sentences: drop the final 。 before 「: <step>」.
    const name = t.title.replace(/[。．.]+$/, '');
    const stepText = (s: WorkStep): string =>
      s.text ? `${name}: ${s.text}（${s.minutes}分）` : `${name}（${s.minutes}分）`;
    const citations = host.citations(t);
    const recorded = host.recorded(t);
    const link =
      safeLink(assignment?.url, t.assignmentId ? host.sourceLabelOf(t.assignmentId) : undefined) ??
      linkFromCitations(citations);
    const isWork = hasDeadline(t, workKind);
    const unsubmitted = t.taskKind === 'assignment';
    const lateDue = dateField(assignment?.extra, LATE_DUE_KEYS);

    let kind: NextActionKind =
      t.taskKind === 'exam_preparation'
        ? 'exam'
        : t.taskKind === 'weekly_pace'
          ? 'weekly'
          : t.taskKind === 'assignment'
            ? 'assignment'
            : 'todo';
    let dueMs = t.dueAt ? Date.parse(t.dueAt) : Number.NaN;
    const reasons: string[] = [];
    const why: string[] = [];
    let what = stepText(first);
    let stepMinutes = first.minutes;
    let score: number;
    let overdue = false;

    // A passed due date with a later cut-off: the cut-off becomes the deadline.
    if (Number.isFinite(dueMs) && dueMs < nowMs && lateDue && Date.parse(lateDue) > nowMs) {
      reasons.push('late_window');
      why.push(`期限切れ・遅れ提出は${formatShortJa(new Date(lateDue), tz)}まで`);
      dueMs = Date.parse(lateDue);
    }

    let estimated: EstimatedDue | undefined;
    if (!Number.isFinite(dueMs)) {
      estimated = isWork ? host.estimate(t) : undefined;
      if (estimated) {
        // Unknown deadline: plan against the earliest plausible one (推定), never as 「期限なし」.
        // The cheap first step is finding the real one out.
        const estMs = Date.parse(estimated.at);
        const hoursLeft = (estMs - nowMs) / HOUR;
        kind = 'check_deadline';
        reasons.push('unknown_due', 'estimated_due');
        why.push(
          estimated.passed
            ? `締切不明・推定${formatShortJa(new Date(estMs), tz)}をもう過ぎている可能性`
            : `締切不明・推定${formatShortJa(new Date(estMs), tz)}（あと${leftText(hoursLeft)}）`,
        );
        what = `${name}: ${estimated.checkWhere}で締切と内容を確認する（5分）`;
        stepMinutes = 5;
        // Past estimates: how much is left is not known either, so no effort pressure.
        const pressure =
          estMs > nowMs
            ? remaining / Math.max(freeMinutes(now, new Date(estMs), busy, tz) * USABLE_SHARE, 1)
            : 0;
        score =
          (deadlinePart(Math.max(hoursLeft, PASSED_ESTIMATE_HOURS)) + 300 * Math.min(pressure, 2)) *
            KIND_FACTOR[workKind] +
          20;
        if (pressure >= 1) reasons.push('cannot_finish');
        if (hoursLeft <= 72)
          dueSoon.push({
            taskId: t.id,
            title: t.title,
            course: course?.title,
            courseId: course?.id,
            dueAt: estimated.at,
            dueText: `推定${formatShortJa(new Date(estMs), tz)}`,
            hoursLeft: round1(hoursLeft),
            unsubmitted,
            link: link ?? safeLink(estimated.checkUrl, undefined),
            estimated,
            citations,
          });
      } else {
        reasons.push('undated');
        why.push('期限なし');
        score = deadlinePart(UNDATED_TODO_HOURS) * KIND_FACTOR[workKind];
      }
    } else if (dueMs < nowMs) {
      if (t.taskKind === 'exam_preparation') continue; // the exam is over
      // A half-term course whose half is over: its missed work is no longer actionable.
      if (t.courseOfferingId && host.halfOver(t.courseOfferingId, today)) continue;
      overdue = true;
      const hoursOver = (nowMs - dueMs) / HOUR;
      const daysOver = hoursOver / 24;
      reasons.push('overdue');
      if (t.taskKind === 'assignment') {
        kind = 'check_late';
        what = `${name}: 課題ページを開いて、遅れて提出できるか確認する（5分）`;
        stepMinutes = 5;
        why.push(`期限切れ（${leftText(hoursOver)}前）`, 'まだ受け付けている可能性');
        score = daysOver <= LATE_WINDOW_DAYS ? 180 * (1 - daysOver / (LATE_WINDOW_DAYS + 3)) : 40;
      } else {
        why.push(
          t.taskKind === 'weekly_pace'
            ? '先週までの分が未完了'
            : `期限切れ（${leftText(hoursOver)}前）`,
        );
        score = daysOver <= LATE_WINDOW_DAYS ? 120 : 40;
      }
    } else {
      const hoursLeft = (dueMs - nowMs) / HOUR;
      const free = freeMinutes(now, new Date(dueMs), busy, tz);
      const pressure = remaining / Math.max(free * USABLE_SHARE, 1);
      score = (deadlinePart(hoursLeft) + 300 * Math.min(pressure, 2)) * KIND_FACTOR[workKind];
      why.push(`締切まで${leftText(hoursLeft)}`);
      reasons.push(hoursLeft <= 24 ? 'due_24h' : hoursLeft <= 72 ? 'due_72h' : 'due_later');
      if (pressure >= 1) {
        reasons.push('cannot_finish');
        why.push('空き時間では足りない量');
      } else if (pressure >= 0.5) {
        reasons.push('tight');
        why.push(`空きは約${Math.round(free / 60)}時間`);
      }
      if (hoursLeft <= 72)
        dueSoon.push({
          taskId: t.id,
          title: t.title,
          course: course?.title,
          courseId: course?.id,
          dueAt: new Date(dueMs).toISOString(),
          dueText: formatShortJa(new Date(dueMs), tz),
          hoursLeft: round1(hoursLeft),
          unsubmitted,
          link,
          citations,
        });
    }

    if (unsubmitted) {
      reasons.push('unsubmitted');
      why.push('未提出');
      score += 50;
    }
    const points = assignment?.points;
    if (points !== undefined && points > 0) {
      reasons.push('weighted');
      why.push(`配点${points}点`);
      score += Math.min(points, 50);
    }
    if (exam && (exam.examKind === 'final' || exam.examKind === 'midterm')) {
      reasons.push('major_exam');
      // A midterm / final weighs most in its last week; further out it is one item among others.
      score += Number.isFinite(dueMs) && dueMs - nowMs <= 7 * DAY ? 150 : 50;
    } else if (exam?.examKind === 'quiz') score += 30;
    const slot = course ? studyNow.get(course.id) : undefined;
    if (t.taskKind === 'weekly_pace' && slot) {
      reasons.push('study_slot_now');
      why.unshift(`今は自習の時間（${slot}）`);
      score += 250;
    }
    if (recorded) why.push(recorded.label);

    candidates.push({
      id: `${kind}:${t.id}`,
      kind,
      what,
      why: why.slice(0, 3).join('・'),
      title: t.title,
      taskId: t.id,
      course,
      dueAt: Number.isFinite(dueMs) ? new Date(dueMs).toISOString() : undefined,
      dueText: Number.isFinite(dueMs)
        ? formatShortJa(new Date(dueMs), tz)
        : estimated
          ? `締切不明（推定${formatShortJa(new Date(estimated.at), tz)}）`
          : '締切不明',
      hoursLeft: Number.isFinite(dueMs) ? round1((dueMs - nowMs) / HOUR) : undefined,
      overdue,
      workKind,
      workLabel: WORK_KIND_LABELS[workKind],
      effort: { stepMinutes, remainingMinutes: remaining, totalMinutes: total, basis },
      steps: left.map((s) =>
        s.text ? `${s.text}（${s.minutes}分）` : `${t.title}（${s.minutes}分）`,
      ),
      freeHoursBeforeDue:
        Number.isFinite(dueMs) && dueMs > nowMs
          ? round1(freeMinutes(now, new Date(dueMs), busy, tz) / 60)
          : undefined,
      link,
      status: t.status,
      submission: sub?.status,
      score: Math.round(score),
      reasons,
      ...(recorded ? { recorded } : {}),
      ...(estimated ? { estimatedDue: estimated } : {}),
      citations,
      sortDue: Number.isFinite(dueMs)
        ? dueMs
        : estimated
          ? Date.parse(estimated.at)
          : Number.POSITIVE_INFINITY,
    });
  }

  // Classes: going to one that starts soon, and preparing for the next ones (today, tomorrow).
  const tomorrow = localDate(new Date(nowMs + DAY), tz);
  const prepared = new Set<string>();
  for (const c of classes) {
    if (c.cancelled || c.sessionKind !== 'class' || !c.startsAt) continue;
    if (!inCourse(c.course)) continue;
    const start = Date.parse(c.startsAt);
    const minutes = (start - nowMs) / 60_000;
    if (minutes < 0) continue;
    const room = typeof c.room.value === 'string' ? c.room.value : undefined;
    if (minutes <= ATTEND_WITHIN_MIN) {
      candidates.push(
        classAction(c, tz, nowMs, {
          id: `attend:${c.sessionId}`,
          kind: 'attend',
          what: `${c.period ? `${c.period}限 ` : ''}${c.course.title}に出る（${hhmm(c.startsAt, tz)}〜${room ? `・${room}` : ''}）`,
          why: `あと${Math.max(1, Math.round(minutes))}分で始まる${c.room.status === 'conflict' ? '・教室は情報源で食い違い' : ''}`,
          score: minutes <= 20 ? 700 : 500,
          reasons: ['class_soon'],
          stepMinutes: 0,
        }),
      );
      prepared.add(c.course.id);
      continue;
    }
    const day = c.date === today ? '今日' : c.date === tomorrow ? '明日' : undefined;
    if (!day || prepared.has(c.course.id)) continue;
    prepared.add(c.course.id);
    const prep = host.preparation(c);
    const material = prep.materials[0];
    const notice = prep.announcements[0];
    if (!material && !notice) continue;
    candidates.push(
      classAction(c, tz, nowMs, {
        id: `prep:${c.sessionId}`,
        kind: 'prep',
        what: material
          ? `${day}の${c.course.title}: 資料「${material.title}」を開いて目を通す（15分）`
          : `${day}の${c.course.title}: お知らせ「${notice?.title ?? ''}」を読む（5分）`,
        why: `${day}${hhmm(c.startsAt, tz)}の授業の準備`,
        score: Math.round(deadlinePart(minutes / 60) * KIND_FACTOR.prep),
        reasons: ['class_prep'],
        stepMinutes: material ? 15 : 5,
        link:
          safeLink(material?.url, material?.citations[0]?.sourceLabel) ??
          linkFromCitations([...(material?.citations ?? []), ...(notice?.citations ?? [])]),
        citations: uniqueCitations([...(material?.citations ?? []), ...(notice?.citations ?? [])]),
      }),
    );
  }

  // Coverage: when a source of deadlines is not up to date its deadlines cannot be trusted, so
  // looking at the platform itself may be the most useful thing to do.
  const gaps = host
    .coverage()
    .gaps.filter(
      (g): g is Exclude<CoverageGap, { kind: 'unknown_due' }> => g.kind !== 'unknown_due',
    );
  if (!wanted)
    for (const g of gaps) {
      const notSynced = g.kind === 'deadlines_not_synced';
      candidates.push({
        id: notSynced ? `coverage:${g.sourceId}:${g.course.id}` : `coverage:${g.sourceId}`,
        kind: 'coverage',
        what: notSynced
          ? `${g.label}で「${g.course.title}」の課題と締切を確認する（5分）`
          : `${g.label}の課題一覧を開いて、締切が漏れていないか確認する（5分）`,
        why: coverageGapText(g, nowMs),
        title: notSynced ? `${g.course.title}（${g.label}）` : `${g.label}の課題一覧`,
        taskId: undefined,
        course: notSynced ? host.courseRef(g.course.id) : undefined,
        dueAt: undefined,
        dueText: '—',
        hoursLeft: undefined,
        overdue: false,
        workKind: 'check',
        workLabel: WORK_KIND_LABELS.check,
        effort: { stepMinutes: 5, remainingMinutes: 5, totalMinutes: 5, basis: 'default' },
        steps: [`${g.label}の課題を確認する（5分）`],
        freeHoursBeforeDue: undefined,
        link: safeLink(host.sourceUrl(g.sourceId), g.label),
        status: undefined,
        submission: undefined,
        score: notSynced ? 150 : g.health === 'stale' ? 230 : 320,
        reasons: [notSynced ? 'coverage_not_synced' : `coverage_${g.health}`],
        citations: [],
        sortDue: Number.POSITIVE_INFINITY,
      });
    }

  candidates.sort((a, b) => b.score - a.score || a.sortDue - b.sortDue || a.id.localeCompare(b.id));
  const ranked = candidates.map(({ sortDue: _s, ...rest }): NextAction => rest);
  const count = Math.min(Math.max(options.count ?? 3, 0), 10);
  const top = ranked[0];
  dueSoon.sort((a, b) => a.hoursLeft - b.hoursLeft || a.title.localeCompare(b.title, 'ja'));
  return {
    view: 'next-action',
    generatedAt: now.toISOString(),
    timezone: tz,
    top,
    next: ranked.slice(1, 1 + count),
    urgent: dueSoon.some((d) => d.unsubmitted && d.hoursLeft <= 48),
    line: top
      ? `今やること: ${top.what}${top.why ? `（${top.why}）` : ''}`
      : '今やることは見つかりませんでした（未完了の課題・締切はありません）。',
    dueSoon,
    coverage: { trusted: gaps.length === 0, gaps },
    considered,
  };
}

/** Compact form for the today / week views. */
export function summarizeNextActions(r: NextActionsContext): NextActionSummary {
  return {
    line: r.line,
    urgent: r.urgent,
    top: r.top,
    then: r.next.map((a) => ({ what: a.what, dueText: a.dueText, course: a.course?.title })),
    coverageTrusted: r.coverage.trusted,
  };
}

/** One short line for a coverage gap: 「EdStemにログインできていない（締切が取れていない可能性）」. */
export function coverageGapText(g: CoverageGap, nowMs: number): string {
  if (g.kind === 'deadlines_not_synced') return `${g.label}の課題は同期していない`;
  if (g.kind === 'unknown_due') return '締切が分からない課題がある';
  switch (g.health) {
    case 'auth_required':
      return `${g.label}にログインできていない（締切が取れていない可能性）`;
    case 'failing':
      return `${g.label}の取得に失敗している（締切が古い可能性）`;
    case 'never_synced':
      return `${g.label}からまだ一度も取得していない`;
    case 'stale':
      return g.lastSuccessAt
        ? `${g.label}の情報が${leftText((nowMs - Date.parse(g.lastSuccessAt)) / HOUR)}更新されていない`
        : `${g.label}の情報が古い`;
  }
}

function classAction(
  c: ClassItem,
  tz: string,
  nowMs: number,
  a: {
    id: string;
    kind: NextActionKind;
    what: string;
    why: string;
    score: number;
    reasons: string[];
    stepMinutes: number;
    link?: NextActionLink | undefined;
    citations?: Citation[];
  },
): Candidate {
  const start = Date.parse(c.startsAt ?? '');
  const prep = a.kind === 'prep';
  return {
    id: a.id,
    kind: a.kind,
    what: a.what,
    why: a.why,
    title: c.course.title,
    taskId: undefined,
    course: c.course,
    dueAt: c.startsAt,
    dueText: c.startsAt ? formatShortJa(new Date(c.startsAt), tz) : c.date,
    hoursLeft: Number.isFinite(start) ? round1((start - nowMs) / HOUR) : undefined,
    overdue: false,
    workKind: prep ? 'prep' : 'check',
    workLabel: prep ? WORK_KIND_LABELS.prep : '授業',
    effort: {
      stepMinutes: a.stepMinutes,
      remainingMinutes: a.stepMinutes,
      totalMinutes: a.stepMinutes,
      basis: 'default',
    },
    steps: [a.what],
    freeHoursBeforeDue: undefined,
    link: a.link ?? linkFromCitations(c.citations),
    status: undefined,
    submission: undefined,
    score: a.score,
    reasons: a.reasons,
    citations: a.citations && a.citations.length > 0 ? a.citations : c.citations,
    sortDue: Number.isFinite(start) ? start : Number.POSITIVE_INFINITY,
  };
}
