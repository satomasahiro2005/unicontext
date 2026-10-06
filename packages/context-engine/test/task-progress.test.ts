import type { Task } from '@unicontext/canonical-model';
import { NotFoundError, PolicyViolationError, ValidationError } from '@unicontext/core';
import {
  latestTaskProgress,
  TASK_PROGRESS_PREDICATE,
  taskProgressSubject,
} from '@unicontext/task-engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdditionClient, UniContext } from '../src/index.js';
import { circuit, createNextActionScenario, db as dbCourse } from './next-action-scenario.js';

/* record_task_progress at the engine level: the student's own word on how far a task has come. */

const client: AdditionClient = { id: 'local:test', name: 'test' };
let uc: UniContext;

beforeEach(async () => {
  ({ uc } = await createNextActionScenario());
});
afterEach(async () => {
  await uc.close();
});

const taskTitled = (title: string): Task => {
  const t = uc.tasks.list().find((x) => x.title.includes(title));
  if (!t) throw new Error(`no task ${title}`);
  return t;
};
const stepsOf = (title: string): string[] | undefined =>
  uc.context
    .nextActions({ count: 10 })
    .next.concat(uc.context.nextActions().top ?? [])
    .find((a) => a.title.includes(title))?.steps;

describe('record_task_progress', () => {
  it('completed with a statement: the task is completed by the student, the fact quotes them', async () => {
    const t = taskTitled('Lesson 3');
    expect(t).toMatchObject({ status: 'pending', statusSetBy: 'system' });
    const r = await uc.additions.recordTaskProgress(client, {
      task: t.id,
      status: 'completed',
      statement: 'Lesson 3 は終わった',
    });
    expect(r.status).toBe('created');
    expect(r.addition).toMatchObject({
      tool: 'record_task_progress',
      kind: 'progress',
      status: 'unconfirmed',
      stored: { taskId: t.id, previousStatus: 'pending', status: 'completed', statusChanged: true },
    });
    const after = uc.tasks.get(t.id) as Task;
    expect(after).toMatchObject({ status: 'completed', statusSetBy: 'user' });
    const fact = uc.resolver.facts.getMany([after.statusEvidenceFactId as string])[0];
    expect(fact).toMatchObject({
      predicate: TASK_PROGRESS_PREDICATE,
      evidence: 'Lesson 3 は終わった',
      subject: taskProgressSubject(t.id),
    });
    expect(fact?.retractedAt).toBeUndefined();
    // The pipeline that ran after the write kept it, and the task is no longer proposed.
    await uc.runPipeline();
    expect(uc.tasks.get(t.id)).toMatchObject({ status: 'completed', statusSetBy: 'user' });
    expect(uc.context.nextActions().top?.title).not.toContain('Lesson 3');
  });

  it('a retry with the same idempotencyKey is replayed, so the undo still restores the status', async () => {
    const t = taskTitled('Lesson 3');
    const input = {
      task: t.id,
      status: 'completed' as const,
      statement: 'Lesson 3 は終わった',
      idempotencyKey: 'retry-1',
    };
    const first = await uc.additions.recordTaskProgress(client, input);
    // The client timed out and sends it again after the commit.
    const again = await uc.additions.recordTaskProgress(client, input);
    expect(first.status).toBe('created');
    expect(again.status).toBe('replayed');
    expect(again.addition.id).toBe(first.addition.id);
    expect(uc.additions.list().filter((a) => a.kind === 'progress')).toHaveLength(1);
    await uc.additions.retract(client, first.addition.id);
    expect(uc.tasks.get(t.id)).toMatchObject({ status: 'pending', statusSetBy: 'system' });
  });

  it('writes and retracts without running the pipeline', async () => {
    const t = taskTitled('Lesson 3');
    const derive = uc.tasks.derive.bind(uc.tasks);
    let runs = 0;
    const spy = vi.spyOn(uc.tasks, 'derive').mockImplementation(() => {
      runs++;
      return derive();
    });
    try {
      const r = await uc.additions.recordTaskProgress(client, {
        task: t.id,
        status: 'in_progress',
        statement: '始めた',
      });
      await uc.additions.retract(client, r.addition.id);
    } finally {
      spy.mockRestore();
    }
    expect(runs).toBe(0);
    expect(uc.tasks.get(t.id)).toMatchObject({ status: 'pending', statusSetBy: 'system' });
  });

  it('rejects submitted, and anything but the four statuses, before writing anything', async () => {
    const t = taskTitled('Lesson 3');
    await expect(
      uc.additions.recordTaskProgress(client, {
        task: t.id,
        status: 'submitted' as never,
        statement: '提出した',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      uc.additions.recordTaskProgress(client, { task: t.id, statement: '何か言った' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      uc.additions.recordTaskProgress(client, { task: t.id, status: 'completed', statement: '  ' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(uc.tasks.get(t.id)?.status).toBe('pending');
    expect(uc.additions.listFor(client)).toHaveLength(0);
  });

  it('retracting restores the previous status, also through a chain of statements', async () => {
    const t = taskTitled('Lesson 3');
    const first = await uc.additions.recordTaskProgress(client, {
      task: t.id,
      status: 'in_progress',
      statement: '始めた',
    });
    const second = await uc.additions.recordTaskProgress(client, {
      task: t.id,
      status: 'completed',
      statement: '終わった',
    });
    expect(uc.tasks.get(t.id)?.status).toBe('completed');
    await uc.additions.retract(client, second.addition.id);
    expect(uc.tasks.get(t.id)).toMatchObject({
      status: 'in_progress',
      statusSetBy: 'user',
      statusEvidenceFactId: first.audit.factIds[0],
    });
    await uc.additions.retract(client, first.addition.id);
    const back = uc.tasks.get(t.id) as Task;
    expect(back).toMatchObject({ status: 'pending', statusSetBy: 'system' });
    expect(back.statusEvidenceFactId).toBeUndefined();
    expect(uc.tasks.progressOf(t.id)).toBeUndefined();
    await uc.runPipeline();
    expect(uc.tasks.get(t.id)).toMatchObject({ status: 'pending', statusSetBy: 'system' });
  });

  it('retracting an older statement does not undo a newer one', async () => {
    const t = taskTitled('Lesson 3');
    const first = await uc.additions.recordTaskProgress(client, {
      task: t.id,
      status: 'in_progress',
      statement: '始めた',
    });
    await uc.additions.recordTaskProgress(client, {
      task: t.id,
      status: 'completed',
      statement: '終わった',
    });
    await uc.additions.retract(client, first.addition.id);
    expect(uc.tasks.get(t.id)?.status).toBe('completed');
  });

  it('keeps the plain ai actor from setting completed', () => {
    const t = taskTitled('Lesson 3');
    expect(() => uc.tasks.setStatus(t.id, 'completed', { actor: 'ai' })).toThrow(
      PolicyViolationError,
    );
  });

  it('finds the task by a title inside a course, and says when it is ambiguous or unknown', async () => {
    const r = await uc.additions.recordTaskProgress(client, {
      task: '実験レポート',
      courseOfferingId: circuit,
      status: 'in_progress',
      statement: '実験レポート書き始めた',
    });
    expect(r.addition.stored).toMatchObject({ taskTitle: '実験レポート: 回路設計' });
    await expect(
      uc.additions.recordTaskProgress(client, {
        task: '存在しない課題',
        courseOfferingId: dbCourse,
        status: 'in_progress',
        statement: '始めた',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      uc.additions.recordTaskProgress(client, {
        task: 'レポート',
        status: 'in_progress',
        statement: '始めた',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('accepts an assignment: id', async () => {
    const t = taskTitled('Lesson 3');
    const r = await uc.additions.recordTaskProgress(client, {
      task: t.assignmentId as string,
      status: 'in_progress',
      statement: '始めた',
    });
    expect(r.addition.stored.taskId).toBe(t.id);
  });

  it('never changes work the submission system reports as submitted (the steps are still kept)', async () => {
    const t = taskTitled('小レポート1');
    expect(t.status).toBe('submitted');
    const r = await uc.additions.recordTaskProgress(client, {
      task: t.id,
      status: 'in_progress',
      doneSteps: ['課題文を開いて設問を読む'],
      statement: 'もう一度見直した',
    });
    expect(r.addition.stored).toMatchObject({ status: 'submitted', statusChanged: false });
    expect(uc.tasks.get(t.id)).toMatchObject({
      status: 'submitted',
      statusSetBy: 'submission-system',
    });
  });
});

describe('next actions follow the recorded steps', () => {
  it('removes the steps the student did, keeps all steps without a record', async () => {
    const t = taskTitled('実験レポート');
    const all = stepsOf('実験レポート') as string[];
    expect(all).toHaveLength(5);
    // in_progress alone says nothing about which step is done: all steps stay.
    uc.tasks.setStatus(t.id, 'in_progress', { actor: 'user' });
    expect(stepsOf('実験レポート')).toEqual(all);

    await uc.additions.recordTaskProgress(client, {
      task: t.id,
      doneSteps: ['実験データとテンプレートを開く', '目的と方法を書く'],
      statement: 'データを開いて、目的と方法は書いた',
    });
    const left = stepsOf('実験レポート') as string[];
    expect(left).toHaveLength(3);
    expect(left[0]).toContain('結果の表とグラフを作る');
    expect(uc.context.nextActions().top?.what ?? '').not.toContain('目的と方法');
  });

  it('done steps alone start the task; the student’s own step names are kept', async () => {
    const t = taskTitled('実験レポート');
    const r = await uc.additions.recordTaskProgress(client, {
      task: t.id,
      doneSteps: ['グラフはもう作った'],
      statement: 'グラフはもう作った',
    });
    expect(r.addition.stored).toMatchObject({ previousStatus: 'pending', status: 'in_progress' });
    const progress = uc.tasks.progressOf(t.id);
    expect(progress?.value.steps?.at(-1)).toEqual({ label: 'グラフはもう作った', done: true });
    expect(progress?.value.percent).toBe(Math.round((1 / 6) * 100));
    // The plan has no step of that name: nothing is dropped from it.
    expect(stepsOf('実験レポート')).toHaveLength(5);
  });

  it('with every step done but the task still open, the last step remains', async () => {
    const t = taskTitled('Lesson 3');
    await uc.additions.recordTaskProgress(client, {
      task: t.id,
      doneSteps: ['課題を開いて問題を確認する', '解いて提出する'],
      statement: '解き終わった',
    });
    expect(stepsOf('Lesson 3')).toHaveLength(1);
  });

  it('puts the latest statement first', async () => {
    const t = taskTitled('実験レポート');
    await uc.additions.recordTaskProgress(client, {
      task: t.id,
      steps: [
        { label: '実験データとテンプレートを開く', done: true },
        { label: '目的と方法を書く', done: true },
      ],
      statement: '二つ終わった',
    });
    await uc.additions.recordTaskProgress(client, {
      task: t.id,
      steps: [{ label: '実験データとテンプレートを開く', done: true }],
      statement: 'やっぱり目的と方法はまだ',
    });
    const latest = latestTaskProgress(
      uc.resolver.facts.active({
        subjects: [taskProgressSubject(t.id)],
        predicate: TASK_PROGRESS_PREDICATE,
      }),
    );
    expect(latest?.value.statement).toBe('やっぱり目的と方法はまだ');
    expect(stepsOf('実験レポート')).toHaveLength(4);
  });
});
