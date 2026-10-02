import {
  type Announcement,
  type Assignment,
  type EntityId,
  type Exam,
  type Fact,
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
  NotFoundError,
  parseZonedDate,
  PolicyViolationError,
  type StudentScope,
  systemClock,
  type UniversityProfile,
  zonedDateString,
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
import { ClassSchedule } from './class-schedule.js';
import { extractDeadlines } from './deadline-extractor.js';
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
}
export const EXTRACTOR_ID = 'ja-deadline-rules';

/** Who is asking to change a task status. AI may never mark work as submitted/completed (§19). */
export type StatusActor = 'user' | 'ai' | 'system';

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
 *   message addressed to them → a task, kept (and shown overdue) after the deadline;
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
   * submitted (that only comes from submission-system facts during derive()).
   */
  setStatus(
    taskId: string,
    status: TaskStatus,
    options: { actor: StatusActor; note?: string },
  ): Task {
    const t = this.get(taskId);
    if (!t) throw new NotFoundError(`task ${taskId}`);
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
    const next: Task = {
      ...t,
      status,
      statusSetBy: options.actor === 'user' ? 'user' : 'system',
      ...(options.note ? { notes: options.note } : {}),
      updatedAt: this.clock.now().toISOString(),
    };
    if (options.actor !== 'user') delete next.statusEvidenceFactId;
    this.save(next);
    return next;
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
      const found = extractDeadlines(body, {
        reference,
        timezone: this.tz,
        ...(next ? { nextClassAt: next } : {}),
      });
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
      const range = { start: classes.start, end: term.exams?.end ?? classes.end };
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
    report.extractedFacts = this.extractDeadlineFacts();
    const now = this.clock.now().toISOString();
    const derivedIds = new Set<string>();
    const count = (s: 'created' | 'updated' | 'unchanged'): void => {
      if (s !== 'unchanged') report[s]++;
    };
    // A task the system cancelled because its origin disappeared comes back when the origin does.
    const revived = (prev: Task | undefined): TaskStatus =>
      !prev || (prev.status === 'cancelled' && prev.statusSetBy === 'system')
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
      if (evidence) {
        if (statusSetBy !== 'user') {
          status = 'submitted';
          statusSetBy = 'submission-system';
          statusEvidenceFactId = evidence.id as Task['statusEvidenceFactId'];
        }
      } else if (statusSetBy === 'submission-system') {
        status = 'pending';
        statusSetBy = 'system';
        statusEvidenceFactId = undefined;
      } else if (statusSetBy === 'system' && status === 'cancelled') {
        status = 'pending';
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
      derivedIds.add(id);
      const evidence = f.evidence ?? v.phrase ?? '';
      count(
        this.save({
          id,
          title: evidence.length > 60 ? `${evidence.slice(0, 60)}…` : evidence || '期限のある作業',
          ...(course ? { courseOfferingId: course as Task['courseOfferingId'] } : {}),
          sourceFactIds: [f.id],
          dueAt: v.dueAt,
          status: revived(prev),
          createdBy: 'extractor',
          taskKind: 'extracted',
          origin: 'extracted',
          statusSetBy: prev?.statusSetBy ?? 'system',
          evidence,
          ...(prev?.notes ? { notes: prev.notes } : {}),
          createdAt: prev?.createdAt ?? now,
          updatedAt: now,
        }).status,
      );
    }

    for (const t of assignmentTasks) count(this.save(t).status);

    // Things to do heard in a lecture (AI additions): one task per todo fact.
    const todoPairs = this.facts.activePairs().filter((p) => p.predicate === TODO_PREDICATE);
    for (const f of this.facts.active({
      subjects: [...new Set(todoPairs.map((p) => p.subject))],
      predicate: TODO_PREDICATE,
    })) {
      const v = f.value as Partial<TodoValue> | null;
      if (!v || typeof v.title !== 'string' || !v.title) continue;
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
          title: v.title,
          ...(course ? { courseOfferingId: course as Task['courseOfferingId'] } : {}),
          sourceFactIds: [f.id],
          ...(typeof v.dueAt === 'string' ? { dueAt: v.dueAt } : {}),
          status: revived(prev),
          createdBy: 'extractor',
          taskKind: 'extracted',
          origin: f.origin,
          statusSetBy: prev?.statusSetBy ?? 'system',
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
