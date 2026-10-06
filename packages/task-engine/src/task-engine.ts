import {
  type Announcement,
  type Assignment,
  type EntityId,
  type Exam,
  type Fact,
  GROUP_CONDITION_PREDICATE,
  type Material,
  type Message,
  stableId,
  type Task,
  type TaskStatus,
} from '@unicontext/canonical-model';
import {
  addLocalDays,
  classWindow,
  type Clock,
  DEFAULT_TIMEZONE,
  formatShortJa,
  halvesWindow,
  isWholeTerm,
  NotFoundError,
  parseZonedDate,
  PolicyViolationError,
  type StudentScope,
  systemClock,
  type UniversityProfile,
  zonedDateString,
  zonedParts,
  zonedTime,
} from '@unicontext/core';
import {
  EntityStore,
  rowToTask,
  SourceReferenceStore,
  taskToRow,
  tasks,
  type UniContextDatabase,
} from '@unicontext/database';
import { type ConflictResolver, factId, FactStore } from '@unicontext/provenance';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  type AssignmentMatch,
  type MatchableAssignment,
  matchAssignment,
  notesAsDetails,
} from './assignment-match.js';
import { ClassSchedule } from './class-schedule.js';
import { doneMarker, groupAddress, shortDeadlineTitle } from './deadline-context.js';
import { extractDeadlines } from './deadline-extractor.js';
import { extractSessionRuleFacts } from './session-rules.js';
import {
  isStudentStatementStatus,
  latestTaskProgress,
  TASK_PROGRESS_PREDICATE,
  type TaskProgress,
  taskProgressSubject,
} from './progress.js';
import { paceStatus, type PaceStatus, weekStartOf, weekStartOfDue } from './pace.js';

export const DEADLINE_PREDICATE = 'deadline';
/**
 * Something to do that an AI client heard in a lecture (add_task, add_deadline kind prep): one
 * fact per item on the course offering, value {@link TodoValue}. Multi-valued (never a Conflict).
 */
export const TODO_PREDICATE = 'todo';

export interface TodoValue {
  /** The addition that wrote it; keeps the task id stable when the owner confirms it. */
  additionId?: string;
  title: string;
  dueAt?: string;
  kind?: string;
  courseOfferingId?: string;
  notes?: string;
  /** The lecture it was heard in / told about (YYYY-MM-DD): when the item was given. */
  lectureDate?: string;
  /**
   * The assignment it is the same work as, decided when it was stored (or named by the client):
   * the to-do is then part of that assignment's task (see {@link TaskEngine.todoMatch}).
   */
  assignmentId?: string;
}

/**
 * A linked to-do's notes in its assignment task's notes: one block per to-do, 「〔チャットで登録
 * 「<title>」〕<notes>」, rebuilt on every derive (blocks are separated by a blank line; the rest is
 * the student's own).
 */
const linkedTodoBlock = (authority: string | undefined, title: string, notes: string): string =>
  `〔${authority === 'student-statement' ? 'チャットで登録' : '録音から'}「${title}」〕${notes.replace(/\n{2,}/gu, '\n')}`;
const LINKED_TODO_BLOCK = /^〔(?:チャットで登録|録音から)「/u;

/**
 * What the student told / a recording said about an assignment a to-do was linked to: the
 * 「〔チャットで登録「…」〕…」 blocks of its task's notes (undefined when there are none).
 */
export function linkedTodoDetails(notes: string | undefined): string | undefined {
  const blocks = (notes ?? '').split(/\n{2,}/u).filter((b) => LINKED_TODO_BLOCK.test(b));
  return blocks.length > 0 ? blocks.join('\n\n') : undefined;
}

export const EXTRACTOR_ID = 'ja-deadline-rules';

/** The fact a student's own status rests on survives re-derivation (record_task_progress). */
const keepStudentEvidence = (
  prev: Task | undefined,
): { statusEvidenceFactId?: Task['statusEvidenceFactId'] } =>
  prev?.statusSetBy === 'user' && prev.statusEvidenceFactId
    ? { statusEvidenceFactId: prev.statusEvidenceFactId }
    : {};

/**
 * Who is asking to change a task status. AI may never mark work as submitted/completed (§19).
 * `student-statement` is the student's own word relayed by an AI client (record_task_progress):
 * it may set pending / in_progress / completed / cancelled and is stored as the student's own
 * status, but never `submitted` (submission systems only) or `expired_past_term`.
 */
export type StatusActor = 'user' | 'ai' | 'system' | 'student-statement';

export interface TaskEngineOptions {
  db: UniContextDatabase;
  clock?: Clock;
  timezone?: string;
  /** Used to read resolved due dates (§12). Without it entity fields are used. */
  resolver?: ConflictResolver;
  /** Identity expansion of course offering ids (§14). */
  expandCourse?: (id: string) => string[];
  /** Authority that may confirm submissions. Default "submission-system". */
  submissionAuthority?: string;
  /** Academic calendar (terms, periods, class days) for generated class sessions. */
  profile?: UniversityProfile;
  /** Campus/faculty of the student for scoped calendar exceptions. */
  student?: StudentScope;
  /** Canonical id of a course offering (§14). */
  canonicalCourse?: (id: string) => string;
}

/**
 * How a deadline found in free text relates to the student:
 * - personal: about the student's own course, the academic system's personal deadline widget, or a
 *   message addressed to them → a task, kept (and shown overdue) after the deadline, unless it
 *   belongs to a term that has ended (then it is `expired_past_term`, see pastTermReason);
 * - general: a university-wide notice that asks every student to do something (履修登録, 申請 …) →
 *   a task only while the deadline is ahead; it is not kept as an overdue task;
 * - informational: campaigns and general information → no task (the fact stays searchable).
 */
export type DeadlineActionability = 'personal' | 'general' | 'informational';

const ACTION_WORDS =
  /履修|登録|申請|申込|申し込|提出|手続|納付|納入|受取|受け取|回答|返却|更新|予約|届出|届け出|確認してください|必ず/;

export interface DeriveReport {
  created: number;
  updated: number;
  cancelled: number;
  extractedFacts: number;
}

/** Why an unfinished assignment is classified as `expired_past_term`. */
export type PastTermReason = 'term_ended' | 'past_academic_year' | 'before_current_term';

const SUBMITTED_VALUES = new Set(['submitted', 'late', 'graded', 'returned']);

/**
 * Task engine (§19, §20): derives tasks from assignments, exams and extracted deadline facts.
 * Status "submitted" is only set when a submission-system fact confirms it, or by the user.
 */
export class TaskEngine {
  private readonly db: UniContextDatabase;
  private readonly clock: Clock;
  private readonly tz: string;
  private readonly entities: EntityStore;
  private readonly refs: SourceReferenceStore;
  private readonly facts: FactStore;
  private readonly resolver: ConflictResolver | undefined;
  private readonly expandCourse: (id: string) => string[];
  private readonly submissionAuthority: string;
  /** Class sessions (stored + generated from the timetable and academic calendar). */
  readonly schedule: ClassSchedule;

  constructor(options: TaskEngineOptions) {
    this.db = options.db;
    this.clock = options.clock ?? systemClock;
    this.tz = options.timezone ?? DEFAULT_TIMEZONE;
    this.entities = new EntityStore(this.db, { clock: this.clock });
    this.refs = new SourceReferenceStore(this.db);
    this.facts = options.resolver?.facts ?? new FactStore(this.db, this.clock);
    this.resolver = options.resolver;
    this.expandCourse = options.expandCourse ?? ((id) => [id]);
    this.submissionAuthority = options.submissionAuthority ?? 'submission-system';
    this.schedule = new ClassSchedule({
      db: this.db,
      clock: this.clock,
      timezone: this.tz,
      facts: this.facts,
      expand: this.expandCourse,
      ...(options.canonicalCourse ? { canonical: options.canonicalCourse } : {}),
      ...(options.profile ? { profile: options.profile } : {}),
      ...(options.student ? { student: options.student } : {}),
    });
  }

  get(id: string): Task | undefined {
    const r = this.db.orm.select().from(tasks).where(eq(tasks.id, id)).get();
    return r ? rowToTask(r) : undefined;
  }

  list(
    options: {
      statuses?: TaskStatus[];
      dueFrom?: string;
      dueTo?: string;
      courseOfferingId?: string;
      includeUndated?: boolean;
    } = {},
  ): Task[] {
    const conds = [];
    if (options.statuses?.length) conds.push(inArray(tasks.status, options.statuses));
    if (options.dueFrom)
      conds.push(
        sql`(${tasks.dueAt} IS NULL OR julianday(${tasks.dueAt}) >= julianday(${options.dueFrom}))`,
      );
    if (options.dueTo)
      conds.push(
        sql`(${tasks.dueAt} IS NULL OR julianday(${tasks.dueAt}) < julianday(${options.dueTo}))`,
      );
    if (options.includeUndated === false) conds.push(sql`${tasks.dueAt} IS NOT NULL`);
    if (options.courseOfferingId)
      conds.push(inArray(tasks.courseOfferingId, this.expandCourse(options.courseOfferingId)));
    return this.db.orm
      .select()
      .from(tasks)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(sql`${tasks.dueAt} IS NULL`, sql`julianday(${tasks.dueAt})`, asc(tasks.id))
      .all()
      .map(rowToTask);
  }

  private save(task: Task): { status: 'created' | 'updated' | 'unchanged' } {
    const prev = this.get(task.id);
    if (prev) {
      const { updatedAt: _a, ...p } = prev;
      const { updatedAt: _b, ...n } = task;
      if (JSON.stringify(p) === JSON.stringify(n)) return { status: 'unchanged' };
    }
    const row = taskToRow(task);
    this.db.orm.insert(tasks).values(row).onConflictDoUpdate({ target: tasks.id, set: row }).run();
    return { status: prev ? 'updated' : 'created' };
  }

  /**
   * Change status with policy checks: AI cannot set submitted/completed; the system cannot set
   * submitted (that only comes from submission-system facts during derive()); the student's own
   * statement (`student-statement`) sets pending / in_progress / completed / cancelled as the
   * student's own status with the fact that quotes them (`evidenceFactId`), never submitted.
   */
  setStatus(
    taskId: string,
    status: TaskStatus,
    options: { actor: StatusActor; note?: string; evidenceFactId?: string },
  ): Task {
    const t = this.get(taskId);
    if (!t) throw new NotFoundError(`task ${taskId}`);
    if (status === 'expired_past_term') {
      throw new PolicyViolationError(
        'expired_past_term is derived from the academic calendar; it cannot be set by hand',
      );
    }
    if (options.actor === 'ai' && (status === 'submitted' || status === 'completed')) {
      throw new PolicyViolationError(
        `AI cannot mark a task as ${status}; only the user or the submission system can (§19)`,
      );
    }
    if (options.actor === 'system' && status === 'submitted') {
      throw new PolicyViolationError(
        'The system marks tasks submitted only from submission-system facts',
      );
    }
    if (options.actor === 'student-statement' && !isStudentStatementStatus(status)) {
      throw new PolicyViolationError(
        status === 'submitted'
          ? 'A student statement cannot mark a task submitted; only the submission system does'
          : `A student statement cannot set a task to ${status}`,
      );
    }
    const own = options.actor === 'user' || options.actor === 'student-statement';
    const next: Task = {
      ...t,
      status,
      statusSetBy: own ? 'user' : 'system',
      ...(options.note ? { notes: options.note } : {}),
      updatedAt: this.clock.now().toISOString(),
    };
    if (options.actor === 'student-statement' && options.evidenceFactId)
      next.statusEvidenceFactId = options.evidenceFactId as Task['statusEvidenceFactId'];
    else if (options.actor !== 'user' || this.restsOnStudentStatement(t))
      // The owner's own choice replaces what the student once said in chat.
      delete next.statusEvidenceFactId;
    this.save(next);
    return next;
  }

  /**
   * Put a task's status fields back to an earlier snapshot (a retracted student statement).
   * Only the status, who set it and its evidence fact change.
   */
  restoreStatus(
    taskId: string,
    previous: {
      status: TaskStatus;
      statusSetBy: Task['statusSetBy'];
      statusEvidenceFactId?: string | undefined;
    },
  ): Task {
    const t = this.get(taskId);
    if (!t) throw new NotFoundError(`task ${taskId}`);
    const next: Task = {
      ...t,
      status: previous.status,
      statusSetBy: previous.statusSetBy,
      updatedAt: this.clock.now().toISOString(),
    };
    if (previous.statusEvidenceFactId)
      next.statusEvidenceFactId = previous.statusEvidenceFactId as Task['statusEvidenceFactId'];
    else delete next.statusEvidenceFactId;
    this.save(next);
    return next;
  }

  /** The student's newest statement about how far a task has come (record_task_progress). */
  progressOf(taskId: string): TaskProgress | undefined {
    return latestTaskProgress(
      this.facts.active({
        subjects: [taskProgressSubject(taskId)],
        predicate: TASK_PROGRESS_PREDICATE,
      }),
    );
  }

  createManualTask(input: {
    title: string;
    dueAt?: string;
    courseOfferingId?: string;
    notes?: string;
  }): Task {
    const now = this.clock.now().toISOString();
    const task: Task = {
      id: stableId('task', 'manual', input.title, input.dueAt ?? '', now),
      title: input.title,
      ...(input.courseOfferingId
        ? { courseOfferingId: input.courseOfferingId as Task['courseOfferingId'] }
        : {}),
      sourceFactIds: [],
      ...(input.dueAt ? { dueAt: input.dueAt } : {}),
      status: 'pending',
      createdBy: 'user',
      taskKind: 'manual',
      origin: 'user',
      statusSetBy: 'user',
      ...(input.notes ? { notes: input.notes } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.save(task);
    return task;
  }

  /** Start of the next non-cancelled class of a course after `after` (for 「次回まで」). */
  nextClassAt(courseOfferingId: string, after: Date): Date | undefined {
    const ids = this.expandCourse(courseOfferingId);
    const from = zonedDateString(after, this.tz);
    const sessions = [
      ...this.entities.list('classSession', { where: { courseOfferingId: ids } }),
      ...this.schedule
        .generated(from, addLocalDays(from, 120), [courseOfferingId])
        .filter((s) => s.sessionKind !== 'self_study'),
    ];
    const starts = sessions
      .filter((s) => s.status !== 'cancelled' && s.startsAt)
      .map((s) => new Date(s.startsAt as string))
      .filter((d) => d.getTime() > after.getTime())
      .sort((a, b) => a.getTime() - b.getTime());
    return starts[0];
  }

  /**
   * Run the rule-based extractor over announcements and messages and store results as
   * origin=extracted "deadline" facts with the sentence as evidence (§20). Idempotent.
   */
  extractDeadlineFacts(): number {
    let added = 0;
    const texts: (Announcement | Message)[] = [
      ...this.entities.list('announcement'),
      ...this.entities.list('message'),
    ];
    for (const e of texts) {
      const body = e.kind === 'announcement' ? `${e.title}\n${e.body}` : e.body;
      const refTime =
        (e.kind === 'announcement' ? e.publishedAt : e.sentAt) ??
        this.entities.meta(e.id)?.createdAt ??
        this.clock.now().toISOString();
      const reference = new Date(refTime);
      const next = e.courseOfferingId ? this.nextClassAt(e.courseOfferingId, reference) : undefined;
      const found = withoutRestatedDays(
        extractDeadlines(body, {
          reference,
          timezone: this.tz,
          ...(next ? { nextClassAt: next } : {}),
        }),
        this.tz,
      );
      const ref = this.refs.forEntity(e.id)[0];
      if (!ref) continue;
      const keep = new Set<string>();
      for (const d of found) {
        const value = {
          dueAt: d.dueAt,
          phrase: d.phrase,
          rule: d.rule,
          ...(e.courseOfferingId ? { courseOfferingId: e.courseOfferingId } : {}),
        };
        const id = factId(ref.id, e.id, DEADLINE_PREDICATE, value);
        keep.add(id);
        // A retracted copy must be re-asserted: re-normalizing the raw item (an edit, reprocess())
        // retracts every fact hanging off its source reference, including these extracted ones.
        const existing = this.facts.get(id);
        if (existing && !existing.retractedAt) continue;
        this.facts.put({
          id,
          subject: e.id as EntityId,
          predicate: DEADLINE_PREDICATE,
          value,
          origin: 'extracted',
          confidence: d.confidence,
          observedAt: refTime,
          sourceReferenceId: ref.id,
          producer: { type: 'rule', id: EXTRACTOR_ID },
          evidence: d.evidence,
        });
        added++;
      }
      const stale = this.facts
        .active({ subjects: [e.id], predicate: DEADLINE_PREDICATE })
        .filter((f) => f.producer.id === EXTRACTOR_ID && !keep.has(f.id));
      this.facts.retract(stale.map((f) => f.id));
    }
    return added;
  }

  /** See {@link DeadlineActionability}. `subject` is the announcement/message the deadline is in. */
  deadlineActionability(
    subject: string,
    value: { phrase?: string; courseOfferingId?: string },
  ): DeadlineActionability {
    const e = this.entities.get(subject);
    if (!e || e.kind === 'message') return 'personal';
    if (e.kind !== 'announcement') return 'personal';
    if (e.courseOfferingId || value.courseOfferingId || e.scope === 'course') return 'personal';
    // Deadlines the academic system tracks for this student (LiveCampusU 警告/期限 widget).
    if (e.category === '期限') return 'personal';
    if (e.importance === 'low') return 'informational';
    const text = `${e.title}\n${value.phrase ?? ''}`.normalize('NFKC');
    return ACTION_WORDS.test(text) ? 'general' : 'informational';
  }

  private submissionEvidence(assignmentIds: string[]): Fact | undefined {
    const subs = this.entities.list('submission', { where: { assignmentId: assignmentIds } });
    const facts = this.facts.withSources(
      this.facts.active({ subjects: subs.map((s) => s.id), predicate: 'submission_status' }),
    );
    const ok = facts
      .filter(
        (f) =>
          f.fact.origin === 'authoritative' &&
          f.source?.authority === this.submissionAuthority &&
          typeof f.fact.value === 'string' &&
          SUBMITTED_VALUES.has(f.fact.value),
      )
      .sort((a, b) => b.fact.observedAt.localeCompare(a.fact.observedAt));
    return ok[0]?.fact;
  }

  private dueOf(a: Assignment): {
    dueAt: string | undefined;
    factIds: string[];
    /** The fact the presented due date comes from (its origin becomes the task's origin). */
    winner?: Fact;
  } {
    if (this.resolver) {
      const r = this.resolver.resolve(a.id, 'assignment_due');
      const value = r.status === 'resolved' ? r.value : r.winner?.fact.value;
      if (typeof value === 'string')
        return {
          dueAt: value,
          factIds: r.candidates.map((c) => c.fact.id),
          ...(r.winner ? { winner: r.winner.fact } : {}),
        };
    }
    const facts = this.facts.active({ subjects: [a.id], predicate: 'assignment_due' });
    return { dueAt: a.dueAt, factIds: facts.map((f) => f.id) };
  }

  /**
   * Assignments of a course (every linked offering) as the to-do matcher sees them. `dues`: due
   * dates already computed (derive); otherwise the assignment's task, then its resolved due.
   */
  private matchableAssignments(
    courseOfferingId: string,
    referenceMs: number | undefined,
    dues?: ReadonlyMap<string, string | undefined>,
  ): MatchableAssignment[] {
    const ids = [...new Set([courseOfferingId, ...this.expandCourse(courseOfferingId)])];
    return this.entities.list('assignment', { where: { courseOfferingId: ids } }).map((a) => {
      const dueAt = dues?.has(a.id)
        ? dues.get(a.id)
        : (this.get(stableId('task', 'assignment', a.id))?.dueAt ?? this.dueOf(a).dueAt);
      return {
        id: a.id,
        title: a.title,
        ...(a.description ? { description: a.description } : {}),
        ...(dueAt ? { dueAt } : {}),
        appearedAt: [a.availableFrom, this.moduleDate(a, referenceMs)],
      };
    });
  }

  /** 「第1回: ガイダンス・導入 (10/1)」: the lesson / module date an LMS files the item under. */
  private moduleDate(a: Assignment, referenceMs: number | undefined): string | undefined {
    const extra = (a as { extra?: Record<string, unknown> }).extra;
    const text = typeof extra?.module === 'string' ? extra.module : undefined;
    const m = text
      ? /[(（]\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*[)）]/.exec(text.normalize('NFKC'))
      : null;
    if (!m) return undefined;
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
    const ref = referenceMs ?? this.clock.now().getTime();
    const year = zonedParts(new Date(ref), this.tz).year;
    const options = [year - 1, year, year + 1].map((y) =>
      zonedTime({ year: y, month, day, hour: 12, minute: 0 }, this.tz).getTime(),
    );
    const best = options.sort((x, y) => Math.abs(x - ref) - Math.abs(y - ref))[0] as number;
    return new Date(best).toISOString();
  }

  /** When a to-do was given: its lecture date (local noon), else when it was written. */
  private todoReference(f: Fact, v: Partial<TodoValue>): number | undefined {
    if (typeof v.lectureDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.lectureDate)) {
      const [y, m, d] = v.lectureDate.split('-').map(Number) as [number, number, number];
      return zonedTime({ year: y, month: m, day: d, hour: 12, minute: 0 }, this.tz).getTime();
    }
    const t = Date.parse(f.observedAt);
    return Number.isNaN(t) ? undefined : t;
  }

  /**
   * The assignment a to-do fact (an AI addition) is — `linked` — or may be — `candidate` — the same
   * work as (see assignment-match.ts). An assignment named on the fact (decided when it was
   * stored) is linked while it exists in the to-do's course.
   */
  todoMatch(f: Fact, dues?: ReadonlyMap<string, string | undefined>): AssignmentMatch | undefined {
    if (f.predicate !== TODO_PREDICATE) return undefined;
    const v = f.value as Partial<TodoValue> | null;
    if (!v || typeof v.title !== 'string') return undefined;
    const course =
      typeof v.courseOfferingId === 'string'
        ? v.courseOfferingId
        : f.subject.startsWith('courseOffering:')
          ? f.subject
          : undefined;
    if (!course) return undefined;
    const ref = this.todoReference(f, v);
    // The client's own recorded assignment for the same addition is not "another" item.
    const list = this.matchableAssignments(course, ref, dues).filter(
      (a) =>
        typeof v.additionId !== 'string' ||
        (this.entities.get(a.id) as { extra?: { additionId?: unknown } } | undefined)?.extra
          ?.additionId !== v.additionId,
    );
    if (typeof v.assignmentId === 'string') {
      const named = list.find((a) => a.id === v.assignmentId);
      if (named)
        return {
          assignmentId: named.id,
          title: named.title,
          dueAt: named.dueAt,
          level: 'linked',
          score: 1,
          reasons: ['登録時に同じ課題として紐づけ'],
        };
    }
    return matchAssignment(
      {
        title: v.title,
        texts: [v.notes, f.evidence],
        ...(ref !== undefined ? { referenceAt: new Date(ref).toISOString() } : {}),
      },
      list,
    );
  }

  /** {@link todoMatch} for a stored to-do (as written, before it was ever derived). */
  todoMatchFor(input: {
    title: string;
    courseOfferingId: string | undefined;
    notes?: string | undefined;
    evidence?: string | undefined;
    lectureDate?: string | undefined;
    additionId?: string | undefined;
  }): AssignmentMatch | undefined {
    if (!input.courseOfferingId) return undefined;
    const now = this.clock.now().toISOString();
    return this.todoMatch({
      id: 'fact:probe',
      subject: input.courseOfferingId,
      predicate: TODO_PREDICATE,
      value: {
        title: input.title,
        courseOfferingId: input.courseOfferingId,
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.lectureDate ? { lectureDate: input.lectureDate } : {}),
        ...(input.additionId ? { additionId: input.additionId } : {}),
      },
      origin: 'extracted',
      confidence: 0.7,
      observedAt: now,
      sourceReferenceId: 'sourceReference:probe',
      producer: { type: 'ai', id: 'probe' },
      ...(input.evidence ? { evidence: input.evidence } : {}),
      createdAt: now,
    } as unknown as Fact);
  }

  /**
   * For a task derived from a to-do: the assignment it may be (a `candidate`; linked ones have no
   * task of their own). Its known due date is what the to-do is planned against — never an
   * estimate.
   */
  candidateOf(t: Task): AssignmentMatch | undefined {
    if (t.taskKind !== 'extracted' || t.assignmentId || t.dueAt) return undefined;
    const f = this.facts
      .getMany(t.sourceFactIds)
      .find((x) => x.predicate === TODO_PREDICATE && !x.retractedAt);
    return f ? this.todoMatch(f) : undefined;
  }

  /**
   * Whether an assignment belongs to a term that has ended, so that leaving it unfinished is no
   * longer actionable. Only the calendar decides; the source system's submission state is not read.
   *
   * 1. The offering (any linked id) has a term in the profile's calendar: past iff that term ended.
   * 2. Otherwise a class team / offering of an earlier academic year is past.
   * 3. Otherwise (current year, no usable term, or no offering at all) it is past when its due date
   *    is before the start of the current term.
   * Current-term work is never past, so an overdue current-term assignment stays 期限切れ.
   */
  pastTermReason(input: {
    courseOfferingId?: string | undefined;
    dueAt?: string | undefined;
  }): PastTermReason | undefined {
    const today = zonedDateString(this.clock.now(), this.tz);
    const ids = input.courseOfferingId
      ? [...new Set([input.courseOfferingId, ...this.expandCourse(input.courseOfferingId)])]
      : [];
    const offerings = ids
      .map((id) => this.entities.getOfKind('courseOffering', id))
      .filter((o): o is NonNullable<typeof o> => o !== undefined);
    const term = offerings.map((o) => this.schedule.termOf(o)).find((t) => t !== undefined);
    if (term) return term.end < today ? 'term_ended' : undefined;
    const years = offerings.map((o) => o.academicYear).filter((y): y is number => y !== undefined);
    const current = this.schedule.currentTerm(today);
    if (years.length > 0) {
      const [y, m] = today.split('-').map(Number) as [number, number];
      const currentYear = current?.year ?? (m >= 4 ? y : y - 1);
      if (Math.max(...years) < currentYear) return 'past_academic_year';
    }
    if (input.dueAt && current) {
      const due = Date.parse(input.dueAt);
      if (!Number.isNaN(due) && due < parseZonedDate(current.start, this.tz).getTime())
        return 'before_current_term';
    }
    return undefined;
  }

  /** `expired_past_term` for system-owned open work of an ended term; otherwise `status` as is. */
  /**
   * The student's group / 班 in a course (condition:group over every linked offering), when the
   * sources agree on one value; undefined when unknown or the sources disagree.
   */
  personalGroup(courseOfferingId: string): string | undefined {
    if (!this.resolver) return undefined;
    const r = this.resolver.resolve(this.expandCourse(courseOfferingId), GROUP_CONDITION_PREDICATE);
    return r.status === 'resolved' && typeof r.value === 'string' ? r.value : undefined;
  }

  private courseTitleOf(courseOfferingId: string): string | undefined {
    for (const id of this.expandCourse(courseOfferingId)) {
      const o = this.entities.getOfKind('courseOffering', id);
      if (o?.title) return o.title;
    }
    return undefined;
  }

  /**
   * The task's status is an open one (pending / in_progress) that the student only stated in chat
   * (record_task_progress: its evidence is a task:progress fact), not one the owner set.
   */
  private isOpenStudentStatement(t: Task): boolean {
    return (
      (t.status === 'pending' || t.status === 'in_progress') && this.restsOnStudentStatement(t)
    );
  }

  /** The task's own status was set by a student statement (its evidence is a task:progress fact). */
  private restsOnStudentStatement(t: Task): boolean {
    if (t.statusSetBy !== 'user' || !t.statusEvidenceFactId) return false;
    const f = this.facts.get(t.statusEvidenceFactId);
    return f?.predicate === TASK_PROGRESS_PREDICATE && f.subject === taskProgressSubject(t.id);
  }

  private expireIfPast(
    status: TaskStatus,
    prev: Task | undefined,
    input: { courseOfferingId?: string; dueAt?: string },
  ): TaskStatus {
    const open = status === 'pending' || status === 'in_progress' || status === 'unknown';
    return open && (prev?.statusSetBy ?? 'system') === 'system' && this.pastTermReason(input)
      ? 'expired_past_term'
      : status;
  }

  /** How far behind the student is in an offering (any linked id). */
  paceStatusOf(offeringId: string): PaceStatus {
    return paceStatus(this.list({ courseOfferingId: offeringId }), this.clock.now(), this.tz);
  }

  /**
   * One 「<科目> 今週分」 task per local week for offerings without a weekly class time (時間割外 /
   * 集中講義) that have self-study slots or any activity: the current week and the 2 before it,
   * limited to the offering's class weeks through its exams and to weeks ending after the offering
   * was first seen. Tasks of older weeks are kept as they are (the student may still owe them).
   */
  private deriveWeeklyPace(
    assignmentTasks: readonly Task[],
    derivedIds: Set<string>,
    revived: (prev: Task | undefined) => TaskStatus,
  ): ('created' | 'updated' | 'unchanged')[] {
    const results: ('created' | 'updated' | 'unchanged')[] = [];
    const nowDate = this.clock.now();
    const now = nowDate.toISOString();
    const currentWeek = weekStartOf(nowDate, this.tz);
    const windowStart = addLocalDays(currentWeek, -14);
    const weeks = [windowStart, addLocalDays(currentWeek, -7), currentWeek];
    for (const e of this.schedule.enrolledOfferings()) {
      if (e.scheduleType === 'regular') continue;
      const term = e.term ?? this.schedule.currentTerm();
      if (!term) continue;
      const classes = classWindow(term);
      // A half-term course (前半 / 後半) has weekly work only in its half.
      const range = isWholeTerm(e.termParts?.halves)
        ? { start: classes.start, end: term.exams?.end ?? classes.end }
        : halvesWindow(term, e.termParts?.halves);
      const where = { courseOfferingId: e.ids };
      const assignments = this.entities.list('assignment', { where });
      const announcements = this.entities.list('announcement', { where });
      const materials = this.entities.list('material', { where });
      const slots = this.schedule.paceSlots(e.ids);
      if (slots.length === 0 && assignments.length + announcements.length + materials.length === 0)
        continue;
      const firstSeen = this.entities.meta(e.offering.id)?.createdAt;
      const idSet = new Set<string>(e.ids);
      for (const ws of weeks) {
        const sunday = addLocalDays(ws, 6);
        if (ws > range.end || sunday < range.start) continue;
        const [y, m, d] = sunday.split('-').map(Number) as [number, number, number];
        const dueAt = zonedTime({ year: y, month: m, day: d, hour: 23, minute: 59 }, this.tz);
        if (firstSeen && dueAt.getTime() <= Date.parse(firstSeen)) continue;
        const id = stableId('task', 'weekly_pace', e.offering.id, ws);
        derivedIds.add(id);
        const prev = this.get(id);
        const notes = this.weeklyNotes({
          from: parseZonedDate(ws, this.tz),
          to: parseZonedDate(addLocalDays(ws, 7), this.tz),
          assignments,
          announcements,
          materials,
          tasks: assignmentTasks.filter(
            (t) => t.courseOfferingId !== undefined && idSet.has(t.courseOfferingId),
          ),
        });
        // Once the student has worked on the task its notes are theirs.
        const text = prev?.statusSetBy === 'user' && prev.notes !== undefined ? prev.notes : notes;
        results.push(
          this.save({
            id,
            title: `${e.offering.title} 今週分`,
            courseOfferingId: e.offering.id,
            sourceFactIds: [],
            dueAt: dueAt.toISOString(),
            status: revived(prev),
            createdBy: 'system',
            taskKind: 'weekly_pace',
            origin: 'inferred',
            statusSetBy: prev?.statusSetBy ?? 'system',
            ...keepStudentEvidence(prev),
            ...(text ? { notes: text } : {}),
            createdAt: prev?.createdAt ?? now,
            updatedAt: now,
          }).status,
        );
      }
    }
    // Weekly tasks outside the window stay as they are; inside it, only those whose offering no
    // longer qualifies are left to the sweep (and never one the student worked on).
    for (const t of this.list()) {
      if (t.taskKind !== 'weekly_pace' || derivedIds.has(t.id)) continue;
      const week = t.dueAt ? weekStartOfDue(t.dueAt, this.tz) : undefined;
      if (t.statusSetBy === 'user' || !week || week < windowStart) derivedIds.add(t.id);
    }
    return results;
  }

  /** "新着: …" / "未提出: …" lines for one week of a course. */
  private weeklyNotes(input: {
    from: Date;
    to: Date;
    assignments: readonly Assignment[];
    announcements: readonly Announcement[];
    materials: readonly Material[];
    tasks: readonly Task[];
  }): string | undefined {
    const inWeek = (iso: string | undefined): boolean => {
      if (!iso) return false;
      const t = Date.parse(iso);
      return t >= input.from.getTime() && t < input.to.getTime();
    };
    const label = (kind: string, title: string): string =>
      `${kind}「${title.length > 28 ? `${title.slice(0, 28)}…` : title}」`;
    const MAX = 4;
    const list = (items: string[]): string =>
      items.length > MAX
        ? `${items.slice(0, MAX).join('、')} ほか${items.length - MAX}件`
        : items.join('、');
    const fresh: string[] = [];
    const freshAssignments = new Set<string>();
    for (const a of input.announcements)
      if (inWeek(a.publishedAt)) fresh.push(label('お知らせ', a.title));
    for (const m of input.materials) if (inWeek(m.publishedAt)) fresh.push(label('資料', m.title));
    for (const a of input.assignments) {
      if (inWeek(a.availableFrom ?? this.entities.meta(a.id)?.createdAt)) {
        fresh.push(label('課題', a.title));
        freshAssignments.add(a.id);
      }
    }
    const pending = input.tasks
      .filter(
        (t) =>
          t.taskKind === 'assignment' &&
          (t.status === 'pending' || t.status === 'in_progress' || t.status === 'unknown') &&
          t.dueAt !== undefined &&
          Date.parse(t.dueAt) >= input.from.getTime() &&
          !(t.assignmentId && freshAssignments.has(t.assignmentId)),
      )
      .map(
        (t) =>
          `${label('課題', t.title)}（${formatShortJa(new Date(t.dueAt as string), this.tz)}締切）`,
      );
    const lines = [
      ...(fresh.length ? [`新着: ${list(fresh)}`] : []),
      ...(pending.length ? [`未提出: ${list(pending)}`] : []),
    ];
    return lines.length ? lines.join('\n') : undefined;
  }

  /** Recompute all derived tasks. User-set statuses are preserved. */
  derive(): DeriveReport {
    const report: DeriveReport = { created: 0, updated: 0, cancelled: 0, extractedFacts: 0 };
    report.extractedFacts =
      this.extractDeadlineFacts() +
      extractSessionRuleFacts({
        db: this.db,
        clock: this.clock,
        facts: this.facts,
        refs: this.refs,
        enrolled: () => this.schedule.enrolledOfferings({ raw: true }),
      });
    const now = this.clock.now().toISOString();
    const derivedIds = new Set<string>();
    const count = (s: 'created' | 'updated' | 'unchanged'): void => {
      if (s !== 'unchanged') report[s]++;
    };
    // A task the system cancelled because its origin disappeared comes back when the origin does.
    const revived = (prev: Task | undefined): TaskStatus =>
      !prev ||
      ((prev.status === 'cancelled' || prev.status === 'expired_past_term') &&
        prev.statusSetBy === 'system')
        ? 'pending'
        : prev.status;

    const assignmentTasks: Task[] = [];
    for (const a of this.entities.list('assignment')) {
      const id = stableId('task', 'assignment', a.id);
      derivedIds.add(id);
      const prev = this.get(id);
      const { dueAt, factIds, winner } = this.dueOf(a);
      // A due date only heard in a lecture (an AI addition) stays extracted until the owner
      // confirms it (§11, §48); everything else keeps the connector's authority.
      const dueOrigin =
        winner && winner.origin !== 'authoritative' ? winner.origin : 'authoritative';
      const evidence = this.submissionEvidence([a.id]);
      let status: TaskStatus = prev?.status ?? 'pending';
      let statusSetBy: Task['statusSetBy'] = prev?.statusSetBy ?? 'system';
      let statusEvidenceFactId = prev?.statusEvidenceFactId;
      // An open status that only rests on what the student said in chat (「始めた」) gives way to
      // the submission system and to the end of the term; the owner's own choice, completed and
      // cancelled do not.
      const openStatement = prev !== undefined && this.isOpenStudentStatement(prev);
      if (evidence) {
        if (statusSetBy !== 'user' || openStatement) {
          status = 'submitted';
          statusSetBy = 'submission-system';
          statusEvidenceFactId = evidence.id as Task['statusEvidenceFactId'];
        }
      } else if (statusSetBy === 'submission-system') {
        status = 'pending';
        statusSetBy = 'system';
        statusEvidenceFactId = undefined;
      } else if (
        statusSetBy === 'system' &&
        (status === 'cancelled' || status === 'expired_past_term')
      ) {
        status = 'pending';
      }
      // An unfinished assignment of an ended term leaves the open lists (today, deadlines, week,
      // counts, notifications). The student's own status and the submission system's evidence win,
      // and the classification is lifted again when the calendar no longer says so.
      if (
        (statusSetBy === 'system' || (openStatement && !evidence)) &&
        (status === 'pending' || status === 'in_progress' || status === 'unknown') &&
        this.pastTermReason({
          ...(a.courseOfferingId ? { courseOfferingId: a.courseOfferingId } : {}),
          dueAt,
        })
      ) {
        status = 'expired_past_term';
        statusSetBy = 'system';
        statusEvidenceFactId = undefined;
      }
      const task: Task = {
        id,
        title: a.title,
        ...(a.courseOfferingId ? { courseOfferingId: a.courseOfferingId } : {}),
        assignmentId: a.id,
        sourceFactIds: [
          ...new Set([...factIds, ...(evidence ? [evidence.id] : [])]),
        ] as Task['sourceFactIds'],
        ...(dueAt ? { dueAt } : {}),
        status,
        createdBy: dueOrigin === 'extracted' ? 'extractor' : 'system',
        taskKind: 'assignment',
        origin: dueOrigin,
        statusSetBy,
        ...(statusEvidenceFactId ? { statusEvidenceFactId } : {}),
        ...(dueOrigin !== 'authoritative' && winner?.evidence ? { evidence: winner.evidence } : {}),
        ...(prev?.notes ? { notes: prev.notes } : {}),
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      };
      // Saved after the extracted deadlines below, which may add their fact ids to it.
      assignmentTasks.push(task);
    }

    for (const ex of this.entities.list('exam') as Exam[]) {
      if (!ex.startsAt) continue;
      const id = stableId('task', 'exam', ex.id);
      derivedIds.add(id);
      const prev = this.get(id);
      const factIds = this.facts
        .active({ subjects: [ex.id], predicate: 'exam_at' })
        .map((f) => f.id);
      count(
        this.save({
          id,
          title: `試験準備: ${ex.title}`,
          ...(ex.courseOfferingId ? { courseOfferingId: ex.courseOfferingId } : {}),
          examId: ex.id,
          sourceFactIds: factIds as Task['sourceFactIds'],
          dueAt: ex.startsAt,
          status: revived(prev),
          createdBy: 'system',
          taskKind: 'exam_preparation',
          origin: 'inferred',
          statusSetBy: prev?.statusSetBy ?? 'system',
          ...keepStudentEvidence(prev),
          ...(prev?.notes ? { notes: prev.notes } : {}),
          createdAt: prev?.createdAt ?? now,
          updatedAt: now,
        }).status,
      );
    }

    // Extracted deadlines become their own tasks unless they just restate an assignment's due date.
    const pairs = this.facts.activePairs().filter((p) => p.predicate === DEADLINE_PREDICATE);
    for (const f of this.facts.active({
      subjects: [...new Set(pairs.map((p) => p.subject))],
      predicate: DEADLINE_PREDICATE,
    })) {
      const v = f.value as { dueAt?: string; phrase?: string; courseOfferingId?: string } | null;
      if (!v || typeof v.dueAt !== 'string') continue;
      const course = v.courseOfferingId;
      const courseIds = course ? new Set(this.expandCourse(course)) : undefined;
      const dup = assignmentTasks.find(
        (t) =>
          t.dueAt &&
          Math.abs(new Date(t.dueAt).getTime() - new Date(v.dueAt as string).getTime()) <=
            3_600_000 &&
          (!courseIds || (t.courseOfferingId !== undefined && courseIds.has(t.courseOfferingId))),
      );
      if (dup) {
        if (!dup.sourceFactIds.includes(f.id))
          dup.sourceFactIds = [...dup.sourceFactIds, f.id as Task['sourceFactIds'][number]];
        continue;
      }
      const id = stableId('task', 'extracted', f.id);
      const prev = this.get(id);
      const userTouched = prev?.statusSetBy === 'user';
      const kind = this.deadlineActionability(f.subject, v);
      // Informational deadlines never become tasks; general ones only while still ahead. A task the
      // user already worked on is kept either way. Dropped tasks are cancelled by the sweep below.
      if (!userTouched) {
        if (kind === 'informational') continue;
        if (kind === 'general' && Date.parse(v.dueAt) < this.clock.now().getTime()) continue;
      }
      const evidence = f.evidence ?? v.phrase ?? '';
      // Addressed to another group / 班 only (「A班は…」) while the student's group is known: not
      // the student's deadline. 「A班の皆様も」 addresses everyone, the named group as well.
      const address = groupAddress(evidence);
      const group = course ? this.personalGroup(course) : undefined;
      if (!userTouched && address?.exclusive && group && !address.groups.includes(group)) continue;
      derivedIds.add(id);
      // 「(済)」 printed next to the date: already done (the sentence is the evidence).
      const done = doneMarker(evidence);
      const source = this.entities.get(f.subject) as { title?: string } | undefined;
      const short = shortDeadlineTitle(
        evidence,
        typeof source?.title === 'string' ? source.title : undefined,
        course ? this.courseTitleOf(course) : undefined,
      );
      const base = revived(prev);
      const status: TaskStatus =
        prev?.statusSetBy === 'user'
          ? prev.status
          : done
            ? 'completed'
            : base === 'completed' && prev?.statusSetBy === 'system'
              ? 'pending'
              : base;
      count(
        this.save({
          id,
          title:
            short ??
            (evidence.length > 60 ? `${evidence.slice(0, 60)}…` : evidence || '期限のある作業'),
          ...(course ? { courseOfferingId: course as Task['courseOfferingId'] } : {}),
          sourceFactIds: [f.id],
          dueAt: v.dueAt,
          // A deadline heard in a notice or post of an ended term is no longer actionable.
          status: this.expireIfPast(status, prev, {
            ...(course ? { courseOfferingId: course } : {}),
            dueAt: v.dueAt,
          }),
          createdBy: 'extractor',
          taskKind: 'extracted',
          origin: 'extracted',
          statusSetBy: prev?.statusSetBy ?? 'system',
          ...(done && prev?.statusSetBy !== 'user'
            ? { statusEvidenceFactId: f.id as Task['statusEvidenceFactId'] }
            : {}),
          ...keepStudentEvidence(prev),
          evidence,
          ...(prev?.notes ? { notes: prev.notes } : {}),
          createdAt: prev?.createdAt ?? now,
          updatedAt: now,
        }).status,
      );
    }

    // Things to do heard in a lecture or told in a chat (AI additions): one task per todo fact —
    // unless it is an assignment a system already knows (「レポート1」 told in a chat = Ed's
    // 「当日課題 (小レポート1)」): then it is part of that assignment's task, whose due date and status
    // come from the source, and its notes become details there.
    const todoPairs = this.facts.activePairs().filter((p) => p.predicate === TODO_PREDICATE);
    const todoFacts = this.facts.active({
      subjects: [...new Set(todoPairs.map((p) => p.subject))],
      predicate: TODO_PREDICATE,
    });
    const dues = new Map<string, string | undefined>(
      assignmentTasks.map((t) => [t.assignmentId as string, t.dueAt]),
    );
    const byAssignment = new Map(assignmentTasks.map((t) => [t.assignmentId as string, t]));
    const linkedNotes = new Map<string, string[]>();
    const separate: Fact[] = [];
    for (const f of todoFacts) {
      const v = f.value as Partial<TodoValue> | null;
      if (!v || typeof v.title !== 'string' || !v.title) continue;
      const match = this.todoMatch(f, dues);
      const target = match?.level === 'linked' ? byAssignment.get(match.assignmentId) : undefined;
      if (!target) {
        separate.push(f);
        continue;
      }
      const todoId = stableId(
        'task',
        'todo',
        typeof v.additionId === 'string' ? v.additionId : f.id,
      );
      if (!target.sourceFactIds.includes(f.id as Task['sourceFactIds'][number]))
        target.sourceFactIds = [...target.sourceFactIds, f.id as Task['sourceFactIds'][number]];
      const details = notesAsDetails(typeof v.notes === 'string' ? v.notes : undefined);
      const authority = this.refs.get(f.sourceReferenceId)?.authority;
      const blocks = linkedNotes.get(target.id) ?? [];
      blocks.push(linkedTodoBlock(authority, v.title, details ?? ''));
      linkedNotes.set(target.id, blocks);
      // The to-do's own task (stored before the assignment was known) is the same work: the
      // student's progress on it carries over, then it goes (no second entry anywhere).
      const own = this.get(todoId);
      if (own) {
        if (
          own.statusSetBy === 'user' &&
          target.statusSetBy === 'system' &&
          (own.status === 'in_progress' || own.status === 'completed')
        ) {
          target.status = own.status;
          target.statusSetBy = 'user';
        }
        this.db.orm.delete(tasks).where(eq(tasks.id, todoId)).run();
      }
    }
    for (const t of assignmentTasks) {
      const own = (t.notes ?? '')
        .split(/\n{2,}/u)
        .filter((b) => b.trim() && !LINKED_TODO_BLOCK.test(b))
        .join('\n\n');
      const blocks = linkedNotes.get(t.id) ?? [];
      const notes = [own, ...blocks].filter((x) => x.trim()).join('\n\n');
      if (notes) t.notes = notes;
      else delete t.notes;
    }

    for (const t of assignmentTasks) count(this.save(t).status);

    for (const f of separate) {
      const v = f.value as Partial<TodoValue>;
      const title = v.title as string;
      const id = stableId('task', 'todo', typeof v.additionId === 'string' ? v.additionId : f.id);
      if (derivedIds.has(id)) continue;
      derivedIds.add(id);
      const prev = this.get(id);
      const course =
        typeof v.courseOfferingId === 'string'
          ? v.courseOfferingId
          : f.subject.startsWith('courseOffering:')
            ? f.subject
            : undefined;
      count(
        this.save({
          id,
          title,
          ...(course ? { courseOfferingId: course as Task['courseOfferingId'] } : {}),
          sourceFactIds: [f.id],
          ...(typeof v.dueAt === 'string' ? { dueAt: v.dueAt } : {}),
          status: revived(prev),
          createdBy: 'extractor',
          taskKind: 'extracted',
          origin: f.origin,
          statusSetBy: prev?.statusSetBy ?? 'system',
          ...keepStudentEvidence(prev),
          ...(f.evidence ? { evidence: f.evidence } : {}),
          ...(prev?.notes
            ? { notes: prev.notes }
            : typeof v.notes === 'string' && v.notes
              ? { notes: v.notes }
              : {}),
          createdAt: prev?.createdAt ?? now,
          updatedAt: now,
        }).status,
      );
    }

    for (const status of this.deriveWeeklyPace(assignmentTasks, derivedIds, revived)) count(status);

    // Derived tasks whose origin disappeared are cancelled (never deleted: the user may have notes).
    for (const t of this.list()) {
      if (t.createdBy === 'user' || derivedIds.has(t.id) || t.status === 'cancelled') continue;
      this.save({ ...t, status: 'cancelled', statusSetBy: 'system', updatedAt: now });
      report.cancelled++;
    }
    return report;
  }
}

/**
 * One deadline stated twice in one text is one deadline: 「12:00まで」 and 「12:00が締め切り」 for the
 * same instant keep the first match, and 「4月15日まで」 next to 「4月15日の17時00分までに」 is not
 * a second one at 23:59 — a date-only match (end of day assumed) is dropped when the text also
 * gives a time on that local date.
 */
export function withoutRestatedDays<T extends { dueAt: string; timeAssumed: boolean }>(
  found: readonly T[],
  timezone: string,
): T[] {
  const timedDays = new Set(
    found.filter((d) => !d.timeAssumed).map((d) => zonedDateString(new Date(d.dueAt), timezone)),
  );
  const seen = new Set<string>();
  return found.filter((d) => {
    if (d.timeAssumed && timedDays.has(zonedDateString(new Date(d.dueAt), timezone))) return false;
    const at = new Date(d.dueAt).getTime();
    if (seen.has(String(at))) return false;
    seen.add(String(at));
    return true;
  });
}
