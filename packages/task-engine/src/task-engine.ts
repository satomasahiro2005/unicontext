import {
  type Announcement,
  type Assignment,
  type EntityId,
  type Exam,
  type Fact,
  type Message,
  stableId,
  type Task,
  type TaskStatus,
} from '@unicontext/canonical-model';
import {
  type Clock,
  DEFAULT_TIMEZONE,
  NotFoundError,
  PolicyViolationError,
  systemClock,
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
import { extractDeadlines } from './deadline-extractor.js';

export const DEADLINE_PREDICATE = 'deadline';
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
}

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
    const sessions = this.entities.list('classSession', { where: { courseOfferingId: ids } });
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
        if (this.facts.get(id)) continue;
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

  private dueOf(a: Assignment): { dueAt: string | undefined; factIds: string[] } {
    if (this.resolver) {
      const r = this.resolver.resolve(a.id, 'assignment_due');
      const value = r.status === 'resolved' ? r.value : r.winner?.fact.value;
      if (typeof value === 'string')
        return { dueAt: value, factIds: r.candidates.map((c) => c.fact.id) };
    }
    const facts = this.facts.active({ subjects: [a.id], predicate: 'assignment_due' });
    return { dueAt: a.dueAt, factIds: facts.map((f) => f.id) };
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

    const assignmentTasks: Task[] = [];
    for (const a of this.entities.list('assignment')) {
      const id = stableId('task', 'assignment', a.id);
      derivedIds.add(id);
      const prev = this.get(id);
      const { dueAt, factIds } = this.dueOf(a);
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
        createdBy: 'system',
        taskKind: 'assignment',
        origin: 'authoritative',
        statusSetBy,
        ...(statusEvidenceFactId ? { statusEvidenceFactId } : {}),
        ...(prev?.notes ? { notes: prev.notes } : {}),
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      };
      assignmentTasks.push(task);
      count(this.save(task).status);
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
          status: prev?.status ?? 'pending',
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
          count(this.save({ ...dup, sourceFactIds: [...dup.sourceFactIds, f.id] }).status);
        continue;
      }
      const id = stableId('task', 'extracted', f.id);
      derivedIds.add(id);
      const prev = this.get(id);
      const evidence = f.evidence ?? v.phrase ?? '';
      count(
        this.save({
          id,
          title: evidence.length > 60 ? `${evidence.slice(0, 60)}…` : evidence || '期限のある作業',
          ...(course ? { courseOfferingId: course as Task['courseOfferingId'] } : {}),
          sourceFactIds: [f.id],
          dueAt: v.dueAt,
          status: prev?.status ?? 'pending',
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

    // Derived tasks whose origin disappeared are cancelled (never deleted: the user may have notes).
    for (const t of this.list()) {
      if (t.createdBy === 'user' || derivedIds.has(t.id) || t.status === 'cancelled') continue;
      this.save({ ...t, status: 'cancelled', statusSetBy: 'system', updatedAt: now });
      report.cancelled++;
    }
    return report;
  }
}
