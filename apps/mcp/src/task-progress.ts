import type { AdditionClient, AdditionResult, UniContext } from '@unicontext/context-engine';
import { z } from 'zod';
import { courseIdForWrite } from './additions.js';

/*
 * MCP write tool `record_task_progress`: the student said they started, finished part of, or
 * finished a piece of work. UniContext keeps it (the AI does not ask, the student never re-states
 * it): the task's own status follows the student's word, the steps they did stop being proposed
 * as next actions, and the quote is stored as evidence. UniContext only; nothing reaches a
 * university system and `submitted` never comes from here (submission systems only).
 */

export const TASK_PROGRESS_INSTRUCTION_JA =
  '学生が課題・やることを「始めた」「ここまで終わった」「終わった」と言ったら、聞き返さずに record_task_progress で記録してください（statement に学生の言葉をそのまま引用）。自分の推測では呼びません。「提出した」は提出システムからしか反映されないので、完了（completed）として記録し、提出は本人が提出先で行います。';
const STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;

export const recordTaskProgressShape = {
  task: z
    .string()
    .min(1)
    .max(300)
    .describe(
      'task:… または assignment:… の id（get_tasks・get_assignments・get_deadlines の結果）、または課題・やることの題名（科目を course で指定するとよい） / A task: or assignment: id, or the title of the task (with course)',
    ),
  course: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      '題名で指定するとき、その科目名（一部でよい）・科目コード・id / With a title: the course name, code or id',
    ),
  status: z
    .enum(STATUSES)
    .optional()
    .describe(
      'pending=まだ / in_progress=始めた・途中 / completed=終わった（本人の言葉。提出済みではない） / cancelled=やらないことにした。提出済み（submitted）は指定できない / The status the student states; submitted is not accepted',
    ),
  steps: z
    .array(z.object({ label: z.string().min(1).max(200), done: z.boolean() }))
    .max(30)
    .optional()
    .describe(
      '作業の段取り全体と、それぞれ終わったか。学生が自分で段取りを話したときだけ / The whole step list with what is done, only when the student gave it',
    ),
  doneSteps: z
    .array(z.string().min(1).max(200))
    .max(30)
    .optional()
    .describe(
      '学生が終えたと言った段取りの名前（「課題文を読んだ」など）。UniContextの段取りの名前でも学生の言葉でもよい / Steps the student says they finished',
    ),
  statement: z
    .string()
    .min(1)
    .max(1000)
    .describe(
      '根拠: 学生の言葉をそのまま引用（「ER図は書き終わった」など）。自分の推測や要約は入れない / Verbatim quote of what the student said, never your own inference',
    ),
};

export const TASK_PROGRESS_RESULT_SHAPE = {
  writeStatus: z.enum(['created', 'updated', 'duplicate', 'replayed', 'retracted']),
  taskId: z.string(),
  title: z.string(),
  previousStatus: z.string().optional(),
  status: z.string(),
  steps: z.array(z.looseObject({ label: z.string(), done: z.boolean() })),
  percent: z.number().optional(),
  additionId: z.string(),
  answerHint: z.string(),
};

type Args = {
  task: string;
  course?: string | undefined;
  status?: (typeof STATUSES)[number] | undefined;
  steps?: { label: string; done: boolean }[] | undefined;
  doneSteps?: string[] | undefined;
  statement: string;
};

export interface TaskProgressToolHost {
  uc: UniContext;
  caller: () => AdditionClient;
  writeTool: (
    name: 'record_task_progress',
    meta: { outputShape: z.ZodRawShape },
    shape: typeof recordTaskProgressShape,
    run: (a: Args) => Promise<{
      structured: Record<string, unknown>;
      write?: { status: string; additionId: string; entityIds: string[]; factIds: string[] };
    }>,
  ) => void;
}

const STATUS_JA: Record<string, string> = {
  pending: 'まだ',
  in_progress: '取りかかり中',
  completed: '完了',
  cancelled: 'やらない',
  submitted: '提出済み',
  unknown: '不明',
  expired_past_term: '終了した学期',
};

/** The tool's answer from the stored addition. */
export function taskProgressOutput(r: AdditionResult): Record<string, unknown> {
  const s = r.addition.stored;
  const steps = (Array.isArray(s.steps) ? s.steps : []).flatMap((x) =>
    typeof x === 'object' && x !== null && !Array.isArray(x) && typeof x.label === 'string'
      ? [{ label: x.label, done: x.done === true }]
      : [],
  );
  const status = typeof s.status === 'string' ? s.status : 'unknown';
  const previousStatus = typeof s.previousStatus === 'string' ? s.previousStatus : undefined;
  const hint: string[] = [];
  const title = typeof s.taskTitle === 'string' ? s.taskTitle : r.addition.title;
  if (r.status === 'created' || r.status === 'updated') {
    hint.push(`「${title}」の進み具合を記録しました（状態: ${STATUS_JA[status] ?? status}）。`);
    if (s.statusChanged !== true && status === 'submitted')
      hint.push('提出済みは提出システムの反映なので、状態は変えていません（段取りだけ記録）。');
    const left = steps.filter((x) => !x.done).length;
    if (steps.length > 0) hint.push(`段取り ${steps.length - left}/${steps.length} 完了。`);
    hint.push(
      '「今やること」からは終えた段取りが外れます。大学のシステムには何も送っていません。間違いなら retract_addition で前の状態に戻せます。',
    );
  } else {
    hint.push('同じ記録が既にあるため、何も変更していません。');
  }
  return {
    writeStatus: r.status === 'confirmed' || r.status === 'rejected' ? 'duplicate' : r.status,
    taskId: typeof s.taskId === 'string' ? s.taskId : '',
    title,
    ...(previousStatus ? { previousStatus } : {}),
    status,
    steps,
    ...(typeof s.percent === 'number' ? { percent: s.percent } : {}),
    additionId: r.addition.id,
    answerHint: hint.join(''),
  };
}

/** Registers record_task_progress (local; remote only with the write scope). */
export function registerTaskProgressTools(host: TaskProgressToolHost): void {
  const { uc, caller, writeTool } = host;
  writeTool(
    'record_task_progress',
    { outputShape: TASK_PROGRESS_RESULT_SHAPE },
    recordTaskProgressShape,
    async (a) => {
      const r = await uc.additions.recordTaskProgress(caller(), {
        task: a.task,
        courseOfferingId: courseIdForWrite(uc, a.course),
        status: a.status,
        steps: a.steps,
        doneSteps: a.doneSteps,
        statement: a.statement,
      });
      return {
        structured: taskProgressOutput(r),
        write: { status: r.status, ...r.audit },
      };
    },
  );
}
