/**
 * Decision material for an AI client that does the judging (ChatGPT scheduled tasks and chats):
 *
 * - `studentState(uc)`: one compact snapshot of "now" (classes, unsubmitted work with effort and
 *   links, exams, tasks, changes that matter, the student's own notes, coverage gaps) with the
 *   deterministic next actions as a suggestion the AI may re-rank.
 * - `attentionRequired(uc, client)`: only what needs telling the student now, deduplicated per
 *   client: an alert repeats only when its severity rises.
 * - `briefing(uc, client, kind)`: a morning / evening digest over the two (thin wrapper).
 *
 * Per-client marks live in the `client_marks` table (created on first use).
 */
import type { Announcement, ClassSession, Task } from '@unicontext/canonical-model';
import {
  formatDateJa,
  formatShortJa,
  parseZonedDate,
  sha256,
  startOfZonedWeek,
  zonedDateString,
  zonedParts,
} from '@unicontext/core';
import type { UniContextDatabase } from '@unicontext/database';
import type { CoverageGap, CoverageHealth, CoverageSource } from './coverage.js';
import type { EstimatedDue } from './estimate.js';
import {
  classifyWork,
  coverageGapText,
  DEFAULT_EFFORT_MINUTES,
  leftText,
  type NextAction,
  type NextActionHost,
  type NextActionLink,
  type NextActionsContext,
  WORK_KIND_LABELS,
} from './next-action.js';
import type { UniContext } from './runtime.js';
import type {
  AttendanceStatus,
  Citation,
  ClassItem,
  ConflictItem,
  PaceItem,
  TermOfDate,
} from './types.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OPEN: Task['status'][] = ['pending', 'in_progress', 'unknown'];
const SUBMITTED = new Set(['submitted', 'late', 'graded', 'returned']);
/** Longest look-back for "since the last call" on a client's first call. */
const FIRST_CALL_LOOKBACK_HOURS = 24;
/** Ready-to-send text is cut near this many characters. */
export const ATTENTION_TEXT_LIMIT = 300;

// ---------- per-client marks ----------

export interface ClientMark {
  lastCallAt: string | undefined;
  /** Alert key → severity rank already told to this client. */
  alerted: Record<string, number>;
  /** attentionId → when this client first saw it, when it last changed, and its last signature. */
  seen?: Record<string, { first: string; changed: string; sig: string }>;
}

/** Per-client bookkeeping of what was already told (attention / briefing). */
export class ClientMarkStore {
  private ready = false;
  constructor(private readonly db: UniContextDatabase) {}

  private ensure(): void {
    if (this.ready) return;
    this.db.sqlite.exec(
      `CREATE TABLE IF NOT EXISTS client_marks (
         client_id TEXT NOT NULL,
         scope TEXT NOT NULL,
         data_json TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         PRIMARY KEY (client_id, scope)
       )`,
    );
    this.ready = true;
  }

  get(clientId: string, scope: string): ClientMark {
    try {
      this.ensure();
      const row = this.db.sqlite
        .prepare('SELECT data_json FROM client_marks WHERE client_id = ? AND scope = ?')
        .get(clientId, scope) as { data_json: string } | undefined;
      if (row) {
        const v = JSON.parse(row.data_json) as Partial<ClientMark>;
        return { lastCallAt: v.lastCallAt, alerted: v.alerted ?? {}, seen: v.seen ?? {} };
      }
    } catch {
      // read-only database or a damaged row: behave as a first call
    }
    return { lastCallAt: undefined, alerted: {}, seen: {} };
  }

  /** False when the database cannot be written (read-only): the caller just does not dedupe. */
  set(clientId: string, scope: string, mark: ClientMark, at: string): boolean {
    try {
      this.ensure();
      this.db.sqlite
        .prepare(
          `INSERT INTO client_marks (client_id, scope, data_json, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(client_id, scope) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`,
        )
        .run(clientId, scope, JSON.stringify(mark), at);
      return true;
    } catch {
      return false;
    }
  }
}

// ---------- compact items ----------

/** One class, compact: what the AI needs to say where to go. */
export interface BriefClass {
  sessionId: string;
  course: string;
  courseId: string;
  date: string;
  period: number | undefined;
  startsAt: string | undefined;
  endsAt: string | undefined;
  room: string | undefined;
  /** Room values of disagreeing sources (say both, never pick one). */
  roomConflict?: string[] | undefined;
  cancelled: boolean;
  selfStudy?: true | undefined;
  note?: string | undefined;
  termPart?: string | undefined;
  /**
   * The meeting for this student after personal conditions (group …): attending, unknown (depends
   * on a group the student has not registered). Another group's day is not listed as a class.
   */
  effectiveSchedule: { status: AttendanceStatus; reason?: string | undefined; group?: string };
  /** What the timetable says when it differs (another day / room), or null = not in the timetable. */
  rawSchedule?: { date: string; period: number | undefined; room: string | undefined } | null;
  citations: Citation[];
}

/** A timetable meeting the student does not attend (another group's day), with the reason. */
export interface BriefNotAttending {
  course: string;
  date: string;
  period: number | undefined;
  reason: string | undefined;
}

/** One open piece of work (assignment, exam preparation, task), compact. */
export interface BriefWork {
  taskId: string;
  title: string;
  course: string | undefined;
  courseId: string | undefined;
  /** 小レポート, レポート, 試験勉強 … */
  workLabel: string;
  dueAt: string | undefined;
  /** 「10/6 17:00」; unknown: 「締切不明（推定10/8 10:20）」. */
  dueText: string;
  hoursLeft: number | undefined;
  overdue: boolean;
  /**
   * Unknown due date of work with a deadline: the earliest plausible one (「推定」, basis, range,
   * where to confirm). Plan against it; never present it as the deadline.
   */
  estimatedDue?: EstimatedDue | undefined;
  status: Task['status'];
  /** From the submission system; undefined when it reports nothing. */
  submission: string | undefined;
  /** Default effort for the kind (minutes). */
  effortMinutes: number;
  link: NextActionLink | undefined;
  /** 「録音から」/「チャットで登録」: registered by an AI client, unconfirmed. */
  recorded?: string | undefined;
  citations: Citation[];
}

export interface BriefChange {
  summary: string;
  type: string;
  entityKind: string;
  occurredAt: string;
  course: string | undefined;
}

export interface BriefNote {
  title: string;
  text: string;
  course: string | undefined;
  /** 「録音から」/「チャットで登録」 */
  label: string;
  createdAt: string;
}

export interface StudentStateContext {
  view: 'student-state';
  generatedAt: string;
  timezone: string;
  /** 「10月5日(月) 09:30」 */
  nowText: string;
  term?: TermOfDate | undefined;
  /** The class going on now, if any. */
  currentClass: BriefClass | undefined;
  /** The next class today (or the first one of a later day within a week). */
  nextClass: BriefClass | undefined;
  today: {
    date: string;
    classes: BriefClass[];
    noClassesReason?: string | undefined;
    notAttending?: BriefNotAttending[] | undefined;
  };
  tomorrow: {
    date: string;
    classes: BriefClass[];
    noClassesReason?: string | undefined;
    notAttending?: BriefNotAttending[] | undefined;
  };
  /** Open assignments: undated (with estimatedDue), overdue up to 14 days, due within 45 days; by due date or estimate. */
  assignments: BriefWork[];
  /** Upcoming exams (preparation tasks) within 60 days. */
  exams: BriefWork[];
  /** Other open tasks (今週分, to-dos, deadlines from notices), at most 20. */
  tasks: BriefWork[];
  changes: BriefChange[];
  importantAnnouncements: {
    id: string;
    title: string;
    publishedAt: string | undefined;
    importance: string;
    course: string | undefined;
  }[];
  /** Courses without a weekly class the student is behind in. */
  pacing: PaceItem[];
  /** The student's own notes registered from chats and lecture recordings (newest 10). */
  notes: BriefNote[];
  conflicts: ConflictItem[];
  coverage: NextActionsContext['coverage'];
  /** UniContext's deterministic ranking: a suggestion, the AI may re-rank with what it knows. */
  suggestion: { line: string; urgent: boolean; top: NextAction | undefined; next: NextAction[] };
}

export type AttentionSeverity = 'info' | 'warning' | 'critical';
const SEVERITY_RANK: Record<AttentionSeverity, number> = { info: 1, warning: 2, critical: 3 };

export type AttentionKind =
  | 'deadline'
  | 'class_soon'
  | 'cancellation'
  | 'room_change'
  | 'announcement'
  | 'pace'
  | 'source'
  | 'group_unknown';

/** Health of a source an attention item relies on (say 「取得できていない」 when it is not ok). */
export interface AttentionSourceHealth {
  sourceId: string;
  label: string;
  health: CoverageHealth | 'unknown';
  lastSuccessAt?: string | undefined;
}

export interface AttentionItem {
  /**
   * Stable id of the thing (a deadline, a class meeting, a notice, a source): the same across calls
   * and clients even when its due date, room or severity changes.
   */
  attentionId: string;
  /** Dedupe key (per client): changes when what is said changes. */
  key: string;
  kind: AttentionKind;
  severity: AttentionSeverity;
  /** Short, ready-to-send Japanese line. */
  line: string;
  course: string | undefined;
  at: string | undefined;
  link: NextActionLink | undefined;
  citations: Citation[];
  /** When this client first saw the item (this call when new). */
  firstSeenAt: string;
  /** When what the item says (key, severity, line) last changed for this client. */
  lastChangedAt: string;
  /** When the severity rises if nothing is done (6 h before a deadline, the class day …). */
  nextEscalationAt: string | undefined;
  /** One concrete thing to do now (「…を提出する」「教室は…」). */
  recommendedAction: string;
  /** Health of the sources the item relies on. */
  sourceHealth: AttentionSourceHealth[];
}

export interface AttentionContext {
  view: 'attention';
  generatedAt: string;
  timezone: string;
  /** Changes are looked at since this instant (the client's last call, at most 24 h back). */
  since: string;
  /** Nothing new to tell: the scheduled task should stay silent. */
  nothingImportant: boolean;
  /** New or escalated alerts, most severe first. */
  items: AttentionItem[];
  /** Ready-to-send notification text (≤ about 300 characters); empty when nothing is important. */
  text: string;
  /** Alerts still true but already told to this client at the same severity. */
  alreadyTold: number;
  /** False when this call could not be recorded (read-only database). */
  recorded: boolean;
}

export type BriefingKind = 'morning' | 'evening' | 'check';

export interface BriefingContext {
  view: 'briefing';
  kind: BriefingKind;
  generatedAt: string;
  timezone: string;
  /** Classes of the day the briefing is about (today; tomorrow for the evening briefing). */
  day: { date: string; classes: BriefClass[]; noClassesReason?: string | undefined };
  topAction: NextAction | undefined;
  /** Open work due by the end of today (evening: tomorrow). */
  mustDo: BriefWork[];
  /** Unsubmitted assignments due within 72 hours. */
  dueSoon: BriefWork[];
  /** News since the last briefing of this client (休講・教室変更・重要なお知らせ …). */
  news: AttentionItem[];
  coverageGaps: CoverageGap[];
  nothingImportant: boolean;
  /** Ready-to-send notification text (≤ about 300 characters). */
  text: string;
}

// ---------- builders ----------

function classOf(c: ClassItem): BriefClass {
  const room = typeof c.room.value === 'string' ? c.room.value : undefined;
  const conflict =
    c.room.status === 'conflict'
      ? [...new Set(c.room.candidates.map((x) => String(x.value)))]
      : undefined;
  const eff = c.effectiveSchedule;
  const raw = c.rawSchedule;
  const rawDiffers =
    !raw || raw.date !== eff.date || (raw.room !== undefined && raw.room !== eff.room);
  return {
    sessionId: c.sessionId,
    course: c.course.title,
    courseId: c.course.id,
    date: c.date,
    period: c.period,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    room,
    ...(conflict ? { roomConflict: conflict } : {}),
    cancelled: c.cancelled,
    ...(c.sessionKind === 'self_study' ? { selfStudy: true as const } : {}),
    ...(c.note ? { note: c.note } : {}),
    ...(c.termPart ? { termPart: c.termPart } : {}),
    effectiveSchedule: {
      status: eff.status,
      ...(eff.reason ? { reason: eff.reason } : {}),
      ...(eff.group ? { group: eff.group.value } : {}),
    },
    ...(eff.reason && rawDiffers
      ? { rawSchedule: raw ? { date: raw.date, period: raw.period, room: raw.room } : null }
      : {}),
    citations: c.citations.slice(0, 2),
  };
}

function notAttendingOf(c: ClassItem): BriefNotAttending {
  return {
    course: c.course.title,
    date: c.date,
    period: c.period,
    reason: c.effectiveSchedule.reason,
  };
}

function hhmm(iso: string | undefined, tz: string): string {
  if (!iso) return '';
  const p = zonedParts(new Date(iso), tz);
  return `${p.hour}:${String(p.minute).padStart(2, '0')}`;
}

function classLabel(c: BriefClass, tz: string): string {
  const when = c.period ? `${c.period}限` : hhmm(c.startsAt, tz);
  const room = c.roomConflict
    ? `教室は${c.roomConflict.join('か')}（情報源で食い違い）`
    : c.room
      ? c.room
      : '';
  const unknown = c.effectiveSchedule.status === 'unknown' ? '［グループにより要確認］' : '';
  return `${when} ${c.course}${c.cancelled ? '（休講）' : room ? `（${room}）` : ''}${unknown}`;
}

function workOf(uc: UniContext, host: NextActionHost, t: Task): BriefWork | undefined {
  if (t.courseOfferingId && host.notTaken(t.courseOfferingId)) return undefined;
  const assignment = t.assignmentId ? host.assignment(t.assignmentId) : undefined;
  const sub = t.assignmentId ? host.submission(t.assignmentId) : undefined;
  if (sub && SUBMITTED.has(sub.status)) return undefined;
  const exam = t.examId ? host.exam(t.examId) : undefined;
  const kind = classifyWork(t, assignment, exam);
  const course = host.courseRef(t.courseOfferingId);
  const nowMs = uc.clock.now().getTime();
  const due = t.dueAt ? Date.parse(t.dueAt) : Number.NaN;
  const citations = host.citations(t);
  const recorded = host.recorded(t);
  const url = assignment?.url ?? citations.find((c) => c.url)?.url;
  const estimatedDue = Number.isFinite(due) ? undefined : host.estimate(t);
  return {
    taskId: t.id,
    title: t.title,
    course: course?.title,
    courseId: course?.id,
    workLabel: WORK_KIND_LABELS[kind],
    dueAt: t.dueAt,
    dueText: Number.isFinite(due)
      ? formatShortJa(new Date(due), uc.timezone)
      : estimatedDue
        ? `締切不明（推定${formatShortJa(new Date(estimatedDue.at), uc.timezone)}）`
        : '締切不明',
    hoursLeft: Number.isFinite(due) ? Math.round(((due - nowMs) / HOUR) * 10) / 10 : undefined,
    overdue: Number.isFinite(due) && due < nowMs,
    ...(estimatedDue ? { estimatedDue } : {}),
    status: t.status,
    submission: sub?.status,
    effortMinutes: DEFAULT_EFFORT_MINUTES[kind],
    link:
      url && /^https?:\/\//i.test(url)
        ? { url, label: citations[0]?.sourceLabel ?? citations[0]?.sourceSystem }
        : undefined,
    ...(recorded ? { recorded: recorded.label } : {}),
    citations: citations.slice(0, 2),
  };
}

/** One-call snapshot for an AI that decides what to tell the student (< ~30 KB). */
export function studentState(uc: UniContext): StudentStateContext {
  const tz = uc.timezone;
  const now = uc.clock.now();
  const nowMs = now.getTime();
  const today = uc.context.today();
  const tomorrow = uc.context.tomorrow();
  const next = uc.context.nextActions({ count: 4 });
  const host = uc.context.nextActionHost();
  const todayClasses = today.classes.map(classOf);
  const tomorrowClasses = tomorrow.classes.map(classOf);
  const live = todayClasses.filter((c) => !c.cancelled && !c.selfStudy && c.startsAt);
  const currentClass = live.find(
    (c) =>
      Date.parse(c.startsAt ?? '') <= nowMs && nowMs < Date.parse(c.endsAt ?? c.startsAt ?? ''),
  );
  let nextClass = live.find((c) => Date.parse(c.startsAt ?? '') > nowMs);
  if (!nextClass) {
    const from = zonedDateString(new Date(nowMs + DAY), tz);
    const to = zonedDateString(new Date(nowMs + 7 * DAY), tz);
    const later = host
      .classes(from, to)
      .find((c) => !c.cancelled && c.sessionKind === 'class' && c.startsAt);
    nextClass = later ? classOf(later) : undefined;
  }

  const open = uc.tasks.list({ statuses: OPEN });
  const assignments: BriefWork[] = [];
  const exams: BriefWork[] = [];
  const tasks: BriefWork[] = [];
  for (const t of open) {
    const due = t.dueAt ? Date.parse(t.dueAt) : Number.NaN;
    if (t.taskKind === 'assignment') {
      if (Number.isFinite(due) && (due < nowMs - 14 * DAY || due > nowMs + 45 * DAY)) continue;
      const w = workOf(uc, host, t);
      if (w) assignments.push(w);
    } else if (t.taskKind === 'exam_preparation') {
      if (!Number.isFinite(due) || due < nowMs || due > nowMs + 60 * DAY) continue;
      const w = workOf(uc, host, t);
      if (w) exams.push(w);
    } else {
      if (Number.isFinite(due) && (due < nowMs - 14 * DAY || due > nowMs + 30 * DAY)) continue;
      if (tasks.length >= 20) continue;
      const w = workOf(uc, host, t);
      if (w) tasks.push(w);
    }
  }
  // Unknown due dates sort by their estimate (earliest plausible), not last.
  const dueOf = (w: BriefWork): number =>
    w.dueAt
      ? Date.parse(w.dueAt)
      : w.estimatedDue
        ? Date.parse(w.estimatedDue.at)
        : Number.POSITIVE_INFINITY;
  const byDue = (a: BriefWork, b: BriefWork): number => dueOf(a) - dueOf(b);
  assignments.sort(byDue);

  let notes: BriefNote[];
  try {
    notes = uc.additions.notes({ limit: 10 }).notes.map((n) => ({
      title: n.title,
      text: n.text.length > 200 ? `${n.text.slice(0, 200)}…` : n.text,
      course: n.course?.title,
      label: n.label,
      createdAt: n.createdAt,
    }));
  } catch {
    notes = [];
  }

  return {
    view: 'student-state',
    generatedAt: now.toISOString(),
    timezone: tz,
    nowText: `${formatDateJa(now, tz)} ${hhmm(now.toISOString(), tz)}`,
    ...(today.term ? { term: today.term } : {}),
    currentClass,
    nextClass,
    today: {
      date: today.date,
      classes: todayClasses,
      ...(today.noClassesReason ? { noClassesReason: today.noClassesReason } : {}),
      ...(today.notAttending?.length
        ? { notAttending: today.notAttending.map(notAttendingOf) }
        : {}),
    },
    tomorrow: {
      date: tomorrow.date,
      classes: tomorrowClasses,
      ...(tomorrow.noClassesReason ? { noClassesReason: tomorrow.noClassesReason } : {}),
      ...(tomorrow.notAttending?.length
        ? { notAttending: tomorrow.notAttending.map(notAttendingOf) }
        : {}),
    },
    assignments,
    exams,
    tasks,
    changes: today.changes.slice(0, 15).map((c) => ({
      summary: c.summary,
      type: c.type,
      entityKind: c.entityKind,
      occurredAt: c.occurredAt,
      course: c.course?.title,
    })),
    importantAnnouncements: today.importantAnnouncements.slice(0, 8).map((a) => ({
      id: a.id,
      title: a.title,
      publishedAt: a.publishedAt,
      importance: a.importance,
      course: a.course?.title,
    })),
    pacing: today.pacing,
    notes,
    conflicts: today.conflicts.slice(0, 10),
    coverage: next.coverage,
    suggestion: { line: next.line, urgent: next.urgent, top: next.top, next: next.next },
  };
}

type Draft = Omit<
  AttentionItem,
  'attentionId' | 'firstSeenAt' | 'lastChangedAt' | 'sourceHealth'
> & {
  /** What the item is about, independent of what it says now (→ attentionId). */
  subject: string;
  /** Sources it relies on beyond its citations (a source alert names its own source). */
  sourceIds?: string[];
};

const iso = (ms: number): string => new Date(ms).toISOString();

/** Every alert that is true right now (before per-client dedupe). */
function currentAlerts(uc: UniContext, since: string): Draft[] {
  const tz = uc.timezone;
  const nowMs = uc.clock.now().getTime();
  const todayDate = zonedDateString(new Date(nowMs), tz);
  const tomorrowDate = zonedDateString(new Date(nowMs + DAY), tz);
  const host = uc.context.nextActionHost();
  const next = uc.context.nextActions({ count: 0 });
  const out: Draft[] = [];

  // Unsubmitted deadlines within 24 h / 6 h; unknown ones by their estimate (「推定」).
  for (const d of next.dueSoon) {
    if (d.hoursLeft > 24) continue;
    const est = d.estimated;
    if (est) {
      const passed = est.passed;
      const critical = !passed && d.hoursLeft <= 6;
      const estMs = Date.parse(est.at);
      const name = d.course ? `${d.course}「${d.title}」` : `「${d.title}」`;
      out.push({
        subject: `task:${d.taskId}`,
        key: `deadline-estimate:${d.taskId}:${est.at}`,
        kind: 'deadline',
        severity: critical ? 'critical' : 'warning',
        line: passed
          ? `【締切不明・推定を過ぎた可能性】${name}は締切が分かりません。推定${formatShortJa(new Date(estMs), tz)}をもう過ぎているかもしれません。${est.checkWhere}ですぐ確認`
          : `【締切不明・推定${critical ? '間近' : ''}】${name}は締切が分かりません。推定${formatShortJa(new Date(estMs), tz)}（あと${leftText(d.hoursLeft)}・${est.confidence === 'medium' ? 'これまでの例から' : '早めに見積もり'}）。${est.checkWhere}で確認`,
        course: d.course,
        at: est.at,
        link: d.link,
        citations: d.citations.slice(0, 2),
        nextEscalationAt: passed ? undefined : critical ? est.at : iso(estMs - 6 * HOUR),
        recommendedAction: `${est.checkWhere}で「${d.title}」の締切を確かめる（推定${formatShortJa(new Date(estMs), tz)}・根拠: ${est.basis}）`,
      });
      continue;
    }
    if (!d.unsubmitted) continue;
    const critical = d.hoursLeft <= 6;
    const dueMs = Date.parse(d.dueAt);
    out.push({
      subject: `task:${d.taskId}`,
      key: `deadline:${d.taskId}:${d.dueAt}`,
      kind: 'deadline',
      severity: critical ? 'critical' : 'warning',
      line: `【締切${critical ? '間近' : ''}】${d.course ? `${d.course}「${d.title}」` : `「${d.title}」`}が未提出です。締切${d.dueText}（あと${leftText(d.hoursLeft)}）`,
      course: d.course,
      at: d.dueAt,
      link: d.link,
      citations: d.citations.slice(0, 2),
      nextEscalationAt: Number.isFinite(dueMs)
        ? critical
          ? d.dueAt
          : iso(dueMs - 6 * HOUR)
        : undefined,
      recommendedAction: `「${d.title}」を${d.link ? `${d.link.label ?? '提出先'}で` : ''}提出する（締切${d.dueText}）`,
    });
  }

  // Classes today and tomorrow: starting within 60 minutes, and cancellations.
  const tomorrowStart = iso(parseZonedDate(tomorrowDate, tz).getTime());
  const groupAsked = new Set<string>();
  for (const c of host.classes(todayDate, tomorrowDate)) {
    if (c.sessionKind !== 'class') continue;
    const b = classOf(c);
    const start = c.startsAt ? Date.parse(c.startsAt) : Number.NaN;
    const day = c.date === todayDate ? '今日' : '明日';
    if (c.cancelled) {
      if (Number.isFinite(start) && start < nowMs) continue;
      out.push({
        subject: `class:${c.sessionId}`,
        key: `cancel:${c.sessionId}`,
        kind: 'cancellation',
        severity: c.date === todayDate ? 'warning' : 'info',
        line: `【休講】${day}の${classLabel({ ...b, cancelled: false, room: undefined }, tz).trim()}は休講です`,
        course: b.course,
        at: c.startsAt,
        link: undefined,
        citations: b.citations,
        nextEscalationAt: c.date === todayDate ? undefined : tomorrowStart,
        recommendedAction: `${day}の${b.course}には行かなくてよい（休講）`,
      });
      continue;
    }
    // The meeting depends on the group and the student's group is not registered: ask once.
    if (c.effectiveSchedule.status === 'unknown' && !groupAsked.has(c.course.id)) {
      if (Number.isFinite(start) && start < nowMs) continue;
      groupAsked.add(c.course.id);
      out.push({
        subject: `group:${c.course.id}`,
        key: `group:${c.course.id}:${c.date}`,
        kind: 'group_unknown',
        severity: c.date === todayDate ? 'warning' : 'info',
        line: `【要確認】${day}の${b.course}はグループで実施日が違います（${c.effectiveSchedule.reason ?? ''}）`,
        course: b.course,
        at: c.startsAt,
        link: undefined,
        citations: b.citations,
        nextEscalationAt: c.date === todayDate ? c.startsAt : tomorrowStart,
        recommendedAction: `${b.course}で自分がどのグループ（班）か確かめる（分かったら set_course_condition で登録）`,
      });
    }
    if (Number.isFinite(start) && start >= nowMs && start - nowMs <= 60 * 60_000) {
      out.push({
        subject: `class:${c.sessionId}`,
        key: `class:${c.sessionId}`,
        kind: 'class_soon',
        severity: b.roomConflict ? 'warning' : 'info',
        line: `【もうすぐ授業】${hhmm(c.startsAt, tz)}から${classLabel(b, tz)}`,
        course: b.course,
        at: c.startsAt,
        link: undefined,
        citations: b.citations,
        nextEscalationAt: undefined,
        recommendedAction: b.roomConflict
          ? `教室を確かめる（${b.roomConflict.join('か')}）`
          : `${b.room ? `${b.room}へ` : '教室へ'}向かう（${hhmm(c.startsAt, tz)}開始）`,
      });
    }
  }

  // New room changes / cancellations / important notices since the last call.
  const entities = uc.sync.stores.entities;
  const changes = uc.context.changesSince({ since, limit: 200 }).changes;
  for (const ch of changes) {
    if (ch.course && host.notTaken(ch.course.id)) continue;
    if (ch.entityKind === 'classSession') {
      const s = entities.getOfKind('classSession', ch.entityId) as ClassSession | undefined;
      if (!s || s.date < todayDate) continue;
      const when = formatDateJa(parseZonedDate(s.date, tz), tz);
      const title = ch.course?.title ?? '授業';
      if (s.status === 'cancelled') {
        out.push({
          subject: `class:${s.id}`,
          key: `cancel:${s.id}`,
          kind: 'cancellation',
          severity: s.date === todayDate ? 'warning' : 'info',
          line: `【休講】${when}${s.period ? ` ${s.period}限` : ''} ${title}は休講です`,
          course: ch.course?.title,
          at: s.startsAt,
          link: undefined,
          citations: ch.citations.slice(0, 2),
          nextEscalationAt:
            s.date === todayDate ? undefined : iso(parseZonedDate(s.date, tz).getTime()),
          recommendedAction: `${when}の${title}には行かなくてよい（休講）`,
        });
      } else if (ch.changedFields.includes('room') && s.room) {
        const soon = s.date === todayDate || s.date === tomorrowDate;
        out.push({
          subject: `class:${s.id}`,
          key: `room:${s.id}:${s.room}`,
          kind: 'room_change',
          severity: soon ? 'warning' : 'info',
          line: `【教室変更】${when}${s.period ? ` ${s.period}限` : ''} ${title}は${s.room}です`,
          course: ch.course?.title,
          at: s.startsAt,
          link: undefined,
          citations: ch.citations.slice(0, 2),
          nextEscalationAt: soon ? undefined : iso(parseZonedDate(s.date, tz).getTime() - DAY),
          recommendedAction: `${when}の${title}は${s.room}へ行く`,
        });
      }
    } else if (ch.entityKind === 'announcement' && ch.type === 'created') {
      const a = entities.getOfKind('announcement', ch.entityId) as Announcement | undefined;
      if (!a || (a.importance !== 'critical' && a.importance !== 'high')) continue;
      out.push({
        subject: `notice:${a.id}`,
        key: `notice:${a.id}`,
        kind: 'announcement',
        severity: a.importance === 'critical' ? 'warning' : 'info',
        line: `【お知らせ】${a.title}`,
        course: ch.course?.title,
        at: a.publishedAt,
        link: undefined,
        citations: ch.citations.slice(0, 2),
        nextEscalationAt: undefined,
        recommendedAction: `お知らせ「${a.title}」を開いて読む`,
      });
    }
  }

  // Falling behind in courses without a weekly class.
  const week = zonedDateString(startOfZonedWeek(new Date(nowMs), tz), tz);
  for (const p of host.pacing()) {
    if (p.behindWeeks < 1) continue;
    out.push({
      subject: `pace:${p.course.id}`,
      key: `pace:${p.course.id}:${week}:${p.behindWeeks}`,
      kind: 'pace',
      severity: p.behindWeeks >= 2 ? 'critical' : 'warning',
      line: `【遅れ】${p.message}${p.slots.length ? `（自習: ${p.slots.join('、')}）` : ''}`,
      course: p.course.title,
      at: undefined,
      link: undefined,
      citations: [],
      // One more week behind next week.
      nextEscalationAt:
        p.behindWeeks >= 2 ? undefined : iso(parseZonedDate(week, tz).getTime() + 7 * DAY),
      recommendedAction: `${p.course.title}を1週分進める${p.slots.length ? `（自習: ${p.slots[0]}）` : ''}`,
    });
  }

  // Sources whose login expired or that keep failing: their deadlines may be missing.
  for (const g of next.coverage.gaps) {
    if (g.kind !== 'source_unhealthy') continue;
    if (g.health !== 'auth_required' && g.health !== 'failing') continue;
    out.push({
      subject: `source:${g.sourceId}`,
      key: `source:${g.sourceId}:${g.health}`,
      kind: 'source',
      severity: 'warning',
      line: `【要確認】${coverageGapText(g, nowMs)}`,
      course: undefined,
      at: g.lastSuccessAt,
      link: undefined,
      citations: [],
      sourceIds: [g.sourceId],
      nextEscalationAt: undefined,
      recommendedAction:
        g.health === 'auth_required'
          ? `${g.label}にログインし直す（UniContextの画面から）`
          : `${g.label}の同期を確かめる（締切が取れていない可能性）`,
    });
  }

  // One alert per key (a cancellation can come from the timetable and from the change log).
  const byKey = new Map<string, Draft>();
  for (const d of out) {
    const prev = byKey.get(d.key);
    if (!prev || SEVERITY_RANK[d.severity] > SEVERITY_RANK[prev.severity]) byKey.set(d.key, d);
  }
  return [...byKey.values()];
}

/**
 * Health of the sources behind an item: the sources of its citations (matched to the configured
 * sources by id or label) and any it names itself. Unmatched citations are 'unknown'.
 */
function sourceHealthLookup(
  uc: UniContext,
): (citations: readonly Citation[], sourceIds?: readonly string[]) => AttentionSourceHealth[] {
  let sources: CoverageSource[] = [];
  try {
    sources = uc.context.nextActionHost().coverage().sources;
  } catch {
    sources = [];
  }
  const view = (s: CoverageSource): AttentionSourceHealth => ({
    sourceId: s.sourceId,
    label: s.label,
    health: s.health,
    ...(s.lastSuccessAt ? { lastSuccessAt: s.lastSuccessAt } : {}),
  });
  return (citations, sourceIds = []) => {
    const out = new Map<string, AttentionSourceHealth>();
    for (const id of sourceIds) {
      const s = sources.find((x) => x.sourceId === id);
      out.set(id, s ? view(s) : { sourceId: id, label: id, health: 'unknown' });
    }
    for (const c of citations) {
      const s = sources.find(
        (x) =>
          x.sourceId === c.sourceSystem ||
          (c.sourceLabel !== undefined && x.label === c.sourceLabel),
      );
      const id = s?.sourceId ?? c.sourceSystem;
      if (out.has(id)) continue;
      out.set(
        id,
        s ? view(s) : { sourceId: id, label: c.sourceLabel ?? c.sourceSystem, health: 'unknown' },
      );
    }
    return [...out.values()];
  };
}

function joinText(lines: string[], limit = ATTENTION_TEXT_LIMIT): string {
  let text = '';
  let used = 0;
  for (const l of lines) {
    const candidate = text ? `${text}\n${l}` : l;
    if (candidate.length > limit && used > 0) {
      return `${text}\nほか${lines.length - used}件`;
    }
    text = candidate.length > limit ? `${candidate.slice(0, limit - 1)}…` : candidate;
    used++;
  }
  return text;
}

function sortAlerts<T extends Pick<Draft, 'severity' | 'at' | 'key'>>(items: T[]): T[] {
  return items.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (a.at ?? '9').localeCompare(b.at ?? '9') ||
      a.key.localeCompare(b.key),
  );
}

export interface AttentionOptions {
  /** Do not record this call (the same alerts come back next time). */
  dryRun?: boolean;
  /** Bookkeeping scope (default `attention`; the briefing keeps its own). */
  scope?: string;
}

/**
 * What needs telling the student now that this client has not told yet. Alerts that are still
 * true are repeated only when their severity rises (24 h → 6 h); `nothingImportant` lets an
 * unattended task stay silent.
 */
export function attentionRequired(
  uc: UniContext,
  clientId: string,
  options: AttentionOptions = {},
): AttentionContext {
  const scope = options.scope ?? 'attention';
  const now = uc.clock.now();
  const store = new ClientMarkStore(uc.db);
  const mark = store.get(clientId, scope);
  const floor = now.getTime() - FIRST_CALL_LOOKBACK_HOURS * HOUR;
  const since = new Date(
    Math.max(floor, mark.lastCallAt ? Date.parse(mark.lastCallAt) : floor),
  ).toISOString();
  const drafts = sortAlerts(currentAlerts(uc, since));
  const nowIso = now.toISOString();
  const health = sourceHealthLookup(uc);
  const seen: NonNullable<ClientMark['seen']> = {};
  const alerts: AttentionItem[] = drafts.map((d) => {
    const attentionId = `attention:${sha256(d.subject).slice(0, 24)}`;
    const sig = `${d.key}|${d.severity}|${d.line}`;
    const prev = mark.seen?.[attentionId];
    const entry = prev
      ? { first: prev.first, changed: prev.sig === sig ? prev.changed : nowIso, sig }
      : { first: nowIso, changed: nowIso, sig };
    seen[attentionId] = entry;
    const { subject: _subject, sourceIds, ...rest } = d;
    return {
      attentionId,
      ...rest,
      firstSeenAt: entry.first,
      lastChangedAt: entry.changed,
      sourceHealth: health(d.citations, sourceIds),
    };
  });
  const fresh = alerts.filter((a) => (mark.alerted[a.key] ?? 0) < SEVERITY_RANK[a.severity]);
  const alerted: Record<string, number> = {};
  for (const a of alerts)
    alerted[a.key] = Math.max(mark.alerted[a.key] ?? 0, SEVERITY_RANK[a.severity]);
  const recorded = options.dryRun
    ? false
    : store.set(clientId, scope, { lastCallAt: nowIso, alerted, seen }, nowIso);
  return {
    view: 'attention',
    generatedAt: now.toISOString(),
    timezone: uc.timezone,
    since,
    nothingImportant: fresh.length === 0,
    items: fresh,
    text: fresh.length ? joinText(fresh.map((a) => a.line)) : '',
    alreadyTold: alerts.length - fresh.length,
    recorded,
  };
}

/** Default briefing kind by local time: before 11:00 morning, from 17:00 evening, else check. */
export function briefingKindAt(now: Date, timezone: string): BriefingKind {
  const h = zonedParts(now, timezone).hour;
  return h < 11 ? 'morning' : h >= 17 ? 'evening' : 'check';
}

/**
 * Morning / evening digest (and `check` = only what is new). A thin wrapper over the student
 * state and the attention alerts of this client's briefings.
 */
export function briefing(
  uc: UniContext,
  clientId: string,
  options: { kind?: BriefingKind; dryRun?: boolean } = {},
): BriefingContext {
  const now = uc.clock.now();
  const tz = uc.timezone;
  const kind = options.kind ?? briefingKindAt(now, tz);
  const state = studentState(uc);
  const attention = attentionRequired(uc, clientId, {
    scope: 'briefing',
    ...(options.dryRun ? { dryRun: true } : {}),
  });
  const evening = kind === 'evening';
  const day = evening ? state.tomorrow : state.today;
  const endMs = parseZonedDate(day.date, tz).getTime() + DAY;
  const mustDo = state.assignments
    .concat(state.tasks)
    .filter((w) => w.dueAt && !w.overdue && Date.parse(w.dueAt) < endMs);
  const dueSoon = state.assignments.filter(
    (w) => w.hoursLeft !== undefined && w.hoursLeft >= 0 && w.hoursLeft <= 72,
  );
  // Unknown due dates whose estimate (earliest plausible) is within 72 hours or already past.
  const estimatedSoon = state.assignments
    .concat(state.tasks)
    .filter((w) => w.estimatedDue && Date.parse(w.estimatedDue.at) - now.getTime() <= 72 * HOUR);
  const top = state.suggestion.top;
  const lines: string[] = [];
  if (kind !== 'check') {
    const live = day.classes.filter((c) => !c.selfStudy);
    lines.push(
      live.length
        ? `${evening ? '明日' : '今日'}の授業: ${live.map((c) => classLabel(c, tz)).join('、')}`
        : `${evening ? '明日' : '今日'}は授業なし${day.noClassesReason ? `（${day.noClassesReason}）` : ''}`,
    );
    if (top) lines.push(`まずこれ: ${top.what}`);
    if (dueSoon.length)
      lines.push(
        `72時間以内の未提出: ${dueSoon
          .slice(0, 3)
          .map((w) => `${w.title}（${w.dueText}）`)
          .join('、')}${dueSoon.length > 3 ? ` ほか${dueSoon.length - 3}件` : ''}`,
      );
    if (estimatedSoon.length)
      lines.push(
        `締切不明（早めの推定）: ${estimatedSoon
          .slice(0, 3)
          .map((w) => `${w.title}（${w.dueText.replace(/^締切不明（|）$/g, '')}）`)
          .join(
            '、',
          )}${estimatedSoon.length > 3 ? ` ほか${estimatedSoon.length - 3}件` : ''}。提出先で確認`,
      );
  }
  lines.push(...attention.items.map((a) => a.line));
  if (kind !== 'check' && !state.coverage.trusted)
    lines.push(
      `要確認: ${state.coverage.gaps.map((g) => coverageGapText(g, now.getTime())).join('、')}`,
    );
  const nothingImportant =
    kind === 'check'
      ? attention.nothingImportant
      : attention.nothingImportant &&
        dueSoon.length === 0 &&
        estimatedSoon.length === 0 &&
        mustDo.length === 0 &&
        state.coverage.trusted &&
        day.classes.filter((c) => !c.selfStudy).length === 0;
  return {
    view: 'briefing',
    kind,
    generatedAt: now.toISOString(),
    timezone: tz,
    day,
    topAction: top,
    mustDo,
    dueSoon,
    news: attention.items,
    coverageGaps: state.coverage.gaps,
    nothingImportant,
    text: nothingImportant ? '' : joinText(lines),
  };
}
