import { type Fact, type JsonValue, stableId, type TaskStatus } from '@unicontext/canonical-model';

/*
 * What the student said about how far a task has come (record_task_progress). Stored without a
 * migration as a fact `task:progress` per task, so the next-action engine can drop the steps the
 * student already did instead of guessing, and the status the student stated survives every sync.
 */

/** Fact predicate of a student's statement about one task. */
export const TASK_PROGRESS_PREDICATE = 'task:progress';

/**
 * Statuses a student's own statement may set. Never `submitted` (that comes from the submission
 * system only) and never `expired_past_term` (derived from the academic calendar).
 */
export const STUDENT_STATEMENT_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'cancelled',
] as const satisfies readonly TaskStatus[];
export type StudentStatementStatus = (typeof STUDENT_STATEMENT_STATUSES)[number];

export function isStudentStatementStatus(s: string): s is StudentStatementStatus {
  return (STUDENT_STATEMENT_STATUSES as readonly string[]).includes(s);
}

export interface TaskProgressStep {
  label: string;
  done: boolean;
}

/** Value of a `task:progress` fact. */
export interface TaskProgressValue {
  /** The task's status after the statement. */
  status: TaskStatus;
  steps?: TaskProgressStep[];
  /** Share of the steps done (0-100); only with steps. */
  percent?: number;
  /** The student's own words, verbatim. */
  statement: string;
  /** When the student said it (ISO). */
  statedAt: string;
}

/** The newest statement about a task and the fact that holds it. */
export interface TaskProgress {
  value: TaskProgressValue;
  fact: Fact;
}

/**
 * Subject the facts of one task hang on. Tasks are records, not entities, so a fact cannot name
 * one directly: the subject is a stable pseudo person derived from the task id (one slot per task).
 */
export function taskProgressSubject(taskId: string): string {
  return stableId('person', 'task-progress', taskId);
}

/** A step label without its 「（10分）」 tail, width and case differences, trailing 。. */
export function normalizeStepLabel(label: string): string {
  return label
    .normalize('NFKC')
    .replace(/\s*[(（]\s*\d+\s*分\s*[)）]\s*$/u, '')
    .replace(/[。.]+$/u, '')
    .replace(/\s+/gu, '')
    .toLowerCase();
}

/** The same step spelled a little differently (one contains the other, at least 3 characters). */
export function stepsMatch(a: string, b: string): boolean {
  const x = normalizeStepLabel(a);
  const y = normalizeStepLabel(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 3 && long.includes(short);
}

/** `value` as a progress record, or undefined when it is not one. */
export function parseTaskProgress(value: JsonValue): TaskProgressValue | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, JsonValue>;
  if (typeof v.status !== 'string' || typeof v.statement !== 'string') return undefined;
  if (typeof v.statedAt !== 'string' || !Number.isFinite(Date.parse(v.statedAt))) return undefined;
  const steps: TaskProgressStep[] = [];
  if (Array.isArray(v.steps)) {
    for (const s of v.steps) {
      if (typeof s !== 'object' || s === null || Array.isArray(s)) continue;
      const step = s as Record<string, JsonValue>;
      if (typeof step.label === 'string' && step.label.trim() && typeof step.done === 'boolean')
        steps.push({ label: step.label, done: step.done });
    }
  }
  return {
    status: v.status as TaskStatus,
    ...(steps.length > 0 ? { steps } : {}),
    ...(typeof v.percent === 'number' ? { percent: v.percent } : {}),
    statement: v.statement,
    statedAt: v.statedAt,
  };
}

/** The newest statement (by when it was stated; later facts win a tie) among a task's facts. */
export function latestTaskProgress(facts: readonly Fact[]): TaskProgress | undefined {
  let best: TaskProgress | undefined;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const fact of facts) {
    if (fact.predicate !== TASK_PROGRESS_PREDICATE || fact.retractedAt) continue;
    const value = parseTaskProgress(fact.value);
    if (!value) continue;
    const at = Date.parse(value.statedAt);
    if (at >= bestAt) {
      best = { value, fact };
      bestAt = at;
    }
  }
  return best;
}

/**
 * The step list after a statement: `steps` (the whole list with its done flags) replaces what was
 * recorded; otherwise the earlier record, otherwise `defaults` (the plan UniContext suggests for
 * this kind of work). `doneSteps` then marks steps done; a label that matches no step is added as
 * a step the student did (their own word for what they finished).
 */
export function mergeProgressSteps(
  previous: readonly TaskProgressStep[] | undefined,
  defaults: readonly string[],
  input: {
    steps?: readonly TaskProgressStep[] | undefined;
    doneSteps?: readonly string[] | undefined;
  },
): TaskProgressStep[] | undefined {
  const base: TaskProgressStep[] = (
    input.steps ??
    previous ??
    defaults.filter((d) => d.trim() !== '').map((label) => ({ label, done: false }))
  ).map((s) => ({ label: s.label.trim(), done: s.done }));
  for (const label of input.doneSteps ?? []) {
    const text = label.trim();
    if (!text) continue;
    const hit = base.find((s) => stepsMatch(s.label, text));
    if (hit) hit.done = true;
    else base.push({ label: text, done: true });
  }
  const touched = input.steps !== undefined || (input.doneSteps?.length ?? 0) > 0;
  // Nothing was said about steps: keep only what was already recorded.
  if (!touched) return previous ? base : undefined;
  return base.length > 0 ? base : undefined;
}

export function progressPercent(
  steps: readonly TaskProgressStep[] | undefined,
): number | undefined {
  if (!steps || steps.length === 0) return undefined;
  return Math.round((steps.filter((s) => s.done).length / steps.length) * 100);
}

/** Of a plan's step texts, the ones the student has not marked done. */
export function remainingSteps<T extends { text: string }>(
  plan: readonly T[],
  progress: Pick<TaskProgressValue, 'steps'> | undefined,
): T[] {
  const done = (progress?.steps ?? []).filter((s) => s.done);
  if (done.length === 0) return [...plan];
  return plan.filter((p) => !done.some((d) => stepsMatch(p.text, d.label)));
}
