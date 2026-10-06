import {
  type Addition,
  type Assignment,
  type Exam,
  type Fact,
  type JsonValue,
  type SourceReference,
  stableId,
  type Task,
  type TaskStatus,
} from '@unicontext/canonical-model';
import { NotFoundError, sha256, stableStringify, ValidationError } from '@unicontext/core';
import { type FactStore, factId } from '@unicontext/provenance';
import {
  isStudentStatementStatus,
  latestTaskProgress,
  mergeProgressSteps,
  normalizeStepLabel,
  progressPercent,
  STUDENT_STATEMENT_STATUSES,
  type StudentStatementStatus,
  TASK_PROGRESS_PREDICATE,
  type TaskEngine,
  type TaskProgress,
  type TaskProgressValue,
  taskProgressSubject,
} from '@unicontext/task-engine';
import { classifyWork, stepsFor } from './next-action.js';

/*
 * record_task_progress: the student says they started, finished part of, or finished a piece of
 * work. UniContext holds it so nobody asks again and next actions stop proposing what is done.
 * The statement is a fact `task:progress` (the student's words as evidence) and, when it names a
 * status, the task's own status through TaskEngine.setStatus with the `student-statement` actor
 * (pending / in_progress / completed / cancelled; never submitted). It is an addition of kind
 * `progress`: stored unconfirmed but applied at once, and retracting it restores the earlier
 * status. Nothing is sent to a university system.
 */

/** Facts and tasks the writer needs (a slice of the additions service's dependencies). */
export interface TaskProgressDeps {
  tasks: TaskEngine;
  facts: FactStore;
  now: () => Date;
  /** Offering ids that count as the same course (identity expansion). */
  courseIds: (id: string) => string[];
  courseTitle: (id: string) => string | undefined;
  assignment: (id: string) => Assignment | undefined;
  exam: (id: string) => Exam | undefined;
}

export interface RecordTaskProgressInput {
  /** A task: or assignment: id, or the title of the task (with `courseOfferingId` to narrow). */
  task: string;
  courseOfferingId?: string | undefined;
  /** The status the student states; omitted = unchanged (done steps imply in_progress). */
  status?: StudentStatementStatus | undefined;
  /** The whole step list with what is done. */
  steps?: { label: string; done: boolean }[] | undefined;
  /** Steps (labels) the student says they finished; added when the list has no such step. */
  doneSteps?: string[] | undefined;
  /** The student's own words, verbatim. */
  statement: string;
  via?: 'recording' | 'chat' | undefined;
  lectureDate?: string | undefined;
  source?: string | undefined;
  idempotencyKey?: string | undefined;
}

export const TASK_PROGRESS_LIMITS = {
  steps: 30,
  label: 200,
  doneSteps: 30,
  statement: 1000,
} as const;

/** What `apply` returns to the additions service (same shape as its private `Applied`). */
export interface TaskProgressApplied {
  entityIds: string[];
  ownEntityIds: string[];
  factIds: string[];
  stored: Record<string, JsonValue>;
}

/** What the additions service needs to write one statement as an addition. */
export interface PreparedTaskProgress {
  /** The input as the idempotency key sees it (includes what was recorded before). */
  input: RecordTaskProgressInput & { after: string };
  course: string | undefined;
  title: string;
  dedupeKey: string;
  data: Record<string, JsonValue>;
  apply: (a: Addition, ref: SourceReference) => TaskProgressApplied;
  /** The task the statement is about. */
  task: Task;
}

const OPEN_FIRST: TaskStatus[] = ['pending', 'in_progress', 'unknown'];

/** Title for matching: width, case, spaces and punctuation ignored. */
function titleKey(s: string): string {
  return normalizeStepLabel(s).replace(/[「」『』【】、,:：・\-ー]/gu, '');
}

/** The task a client means: by id (task: / assignment:) or by title, narrowed by course. */
export function resolveProgressTask(
  deps: Pick<TaskProgressDeps, 'tasks' | 'courseIds'>,
  ref: string,
  course?: string | undefined,
): Task {
  const text = ref.trim();
  if (!text) throw new ValidationError('task is empty: give a task id or the title of the task');
  if (text.startsWith('task:')) {
    const t = deps.tasks.get(text);
    if (!t) throw new NotFoundError(`task ${text}`);
    return t;
  }
  if (text.startsWith('assignment:')) {
    const t = deps.tasks.get(stableId('task', 'assignment', text));
    if (!t) throw new NotFoundError(`task of ${text} (see get_tasks)`);
    return t;
  }
  const ids = course ? new Set(deps.courseIds(course)) : undefined;
  const key = titleKey(text);
  const pool = deps.tasks
    .list()
    .filter((t) => t.status !== 'expired_past_term' || ids !== undefined)
    .filter((t) => !ids || (t.courseOfferingId !== undefined && ids.has(t.courseOfferingId)));
  const exact = pool.filter((t) => titleKey(t.title) === key);
  const near =
    exact.length > 0
      ? exact
      : key.length >= 3
        ? pool.filter((t) => {
            const k = titleKey(t.title);
            return k.includes(key) || (k.length >= 3 && key.includes(k));
          })
        : [];
  if (near.length === 0)
    throw new NotFoundError(
      `no task titled 「${text}」${course ? ' in that course' : ''}: look it up with get_tasks and use its task: id`,
    );
  // Several with the same title: the one still open (the others are earlier, finished ones).
  const open = near.filter((t) => OPEN_FIRST.includes(t.status));
  const pick = open.length > 0 ? open : near;
  if (pick.length > 1)
    throw new ValidationError(
      `several tasks match 「${text}」: ${pick
        .slice(0, 5)
        .map((t) => `${t.id} 「${t.title}」`)
        .join(' / ')}. Use the task: id`,
    );
  return pick[0] as Task;
}

function validate(input: RecordTaskProgressInput): { statement: string } {
  const statement = input.statement.trim();
  if (!statement)
    throw new ValidationError(
      'statement is empty: quote what the student said (verbatim), never your own inference',
    );
  if (input.status !== undefined && !isStudentStatementStatus(input.status))
    throw new ValidationError(
      input.status === ('submitted' as string)
        ? 'status submitted cannot be recorded: only the submission system reports submissions'
        : `status must be one of ${STUDENT_STATEMENT_STATUSES.join(' / ')}`,
    );
  if ((input.steps?.length ?? 0) > TASK_PROGRESS_LIMITS.steps)
    throw new ValidationError(`at most ${TASK_PROGRESS_LIMITS.steps} steps`);
  if ((input.doneSteps?.length ?? 0) > TASK_PROGRESS_LIMITS.doneSteps)
    throw new ValidationError(`at most ${TASK_PROGRESS_LIMITS.doneSteps} doneSteps`);
  for (const s of input.steps ?? [])
    if (!s.label.trim() || s.label.length > TASK_PROGRESS_LIMITS.label)
      throw new ValidationError('each step needs a label of up to 200 characters');
  if (input.status === undefined && !input.steps?.length && !input.doneSteps?.length)
    throw new ValidationError('give a status, steps or doneSteps: nothing to record');
  return { statement: statement.slice(0, TASK_PROGRESS_LIMITS.statement) };
}

function activeProgress(deps: TaskProgressDeps, taskId: string): TaskProgress | undefined {
  return latestTaskProgress(
    deps.facts.active({
      subjects: [taskProgressSubject(taskId)],
      predicate: TASK_PROGRESS_PREDICATE,
    }),
  );
}

/** The plan UniContext would propose for this task (labels without minutes). */
function defaultSteps(deps: TaskProgressDeps, t: Task): string[] {
  const kind = classifyWork(
    t,
    t.assignmentId ? deps.assignment(t.assignmentId) : undefined,
    t.examId ? deps.exam(t.examId) : undefined,
  );
  return stepsFor(kind)
    .map((s) => s.text)
    .filter((s) => s !== '');
}

/**
 * Validate a statement and build what the additions service writes: nothing is stored here, the
 * returned `apply` runs inside the write transaction.
 */
export function prepareTaskProgress(
  deps: TaskProgressDeps,
  input: RecordTaskProgressInput,
): PreparedTaskProgress {
  const { statement } = validate(input);
  const task = resolveProgressTask(deps, input.task, input.courseOfferingId);
  const latest = activeProgress(deps, task.id);
  const course = task.courseOfferingId;
  const title = `${task.title}: ${input.status ?? '進み具合'}（本人）`;
  const hash = sha256(
    stableStringify({
      task: task.id,
      status: input.status ?? null,
      steps: input.steps ?? null,
      doneSteps: input.doneSteps ?? null,
      statement,
    } as unknown as JsonValue),
  ).slice(0, 24);
  const after = latest?.fact.id ?? 'none';

  const apply = (a: Addition, ref: SourceReference): TaskProgressApplied => {
    const t = deps.tasks.get(task.id);
    if (!t) throw new NotFoundError(`task ${task.id}`);
    const prev = activeProgress(deps, t.id);
    const steps = mergeProgressSteps(prev?.value.steps, defaultSteps(deps, t), {
      steps: input.steps,
      doneSteps: input.doneSteps,
    });
    // A task the submission system reports as submitted stays submitted: only the steps are kept.
    const locked = t.status === 'submitted';
    const impliedStart =
      input.status === undefined &&
      !locked &&
      (t.status === 'pending' || t.status === 'unknown') &&
      steps?.some((s) => s.done) === true;
    const requested: StudentStatementStatus | undefined = locked
      ? undefined
      : (input.status ?? (impliedStart ? 'in_progress' : undefined));
    const status: TaskStatus = requested ?? t.status;
    const now = deps.now().toISOString();
    // Strictly after the statement before it, so the newest is never a tie.
    const statedAt = new Date(
      Math.max(
        Date.parse(now),
        prev ? Date.parse(prev.value.statedAt) + 1 : Number.NEGATIVE_INFINITY,
      ),
    ).toISOString();
    const percent = progressPercent(steps);
    const value: TaskProgressValue = {
      status,
      ...(steps ? { steps } : {}),
      ...(percent !== undefined ? { percent } : {}),
      statement,
      statedAt,
    };
    const fact = deps.facts.put({
      id: factId(
        ref.id,
        taskProgressSubject(t.id),
        TASK_PROGRESS_PREDICATE,
        value as unknown as JsonValue,
      ),
      subject: taskProgressSubject(t.id) as Fact['subject'],
      predicate: TASK_PROGRESS_PREDICATE,
      value: value as unknown as JsonValue,
      origin: 'extracted',
      confidence: 0.7,
      observedAt: now,
      sourceReferenceId: ref.id,
      producer: { type: 'ai', id: `mcp:${a.clientName ?? a.clientId}`.slice(0, 200) },
      evidence: statement,
    });
    const stored: Record<string, JsonValue> = {
      taskId: t.id,
      taskTitle: t.title,
      previousStatus: t.status,
      status,
      statusChanged: requested !== undefined,
      ...(steps ? { steps: steps as unknown as JsonValue } : {}),
      ...(percent !== undefined ? { percent } : {}),
    };
    if (requested !== undefined) {
      stored.previousStatusSetBy = t.statusSetBy;
      if (t.statusEvidenceFactId) stored.previousStatusEvidenceFactId = t.statusEvidenceFactId;
      deps.tasks.setStatus(t.id, requested, {
        actor: 'student-statement',
        evidenceFactId: fact.id,
      });
    }
    return { entityIds: [], ownEntityIds: [], factIds: [fact.id], stored };
  };

  return {
    input: { ...input, statement, after },
    course,
    title,
    dedupeKey: `progress|${task.id}|${hash}|${after}`,
    data: {
      taskId: task.id,
      evidence: statement,
      ...(input.status ? { status: input.status } : {}),
      ...(input.steps ? { steps: input.steps as unknown as JsonValue } : {}),
      ...(input.doneSteps ? { doneSteps: input.doneSteps } : {}),
    },
    apply,
    task,
  };
}

/**
 * Retracting (or the owner rejecting) a statement puts the task's status back to what it was,
 * unless a later statement has taken the status over since. The fact itself is retracted by the
 * additions service.
 */
export function undoTaskProgress(deps: Pick<TaskProgressDeps, 'tasks'>, a: Addition): void {
  const stored = a.data.stored;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
  const s = stored as Record<string, JsonValue>;
  if (s.statusChanged !== true || typeof s.taskId !== 'string') return;
  const t = deps.tasks.get(s.taskId);
  if (!t?.statusEvidenceFactId || !a.factIds.includes(t.statusEvidenceFactId)) return;
  deps.tasks.restoreStatus(t.id, {
    status: s.previousStatus as TaskStatus,
    statusSetBy: (s.previousStatusSetBy as Task['statusSetBy'] | undefined) ?? 'system',
    statusEvidenceFactId:
      typeof s.previousStatusEvidenceFactId === 'string'
        ? s.previousStatusEvidenceFactId
        : undefined,
  });
}
