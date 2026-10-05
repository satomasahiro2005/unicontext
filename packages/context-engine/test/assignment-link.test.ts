import { stableId } from '@unicontext/canonical-model';
import { createFakeConnector } from '@unicontext/connector-sdk';
import { ManualClock } from '@unicontext/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type AdditionClient, createUniContext, type UniContext } from '../src/index.js';

/*
 * The 2026-10 データベースシステム論 case: after the 10/1 (Thu 2限) class the student told ChatGPT
 * 「レポート1：レンタル店のER図を作成する（提出期限は現時点で未確認）」 (add_task, via chat), while
 * Ed already had 「当日課題 (小レポート1)」 due 10/6 17:00. Kept apart, the to-do got an estimated
 * deadline (10/8 10:20 = the next class) and ChatGPT told the student the deadline was unknown.
 * Ed's 2025 offering of the course (not linked) has an assignment with the very same title.
 */

const CHATGPT: AdditionClient = { id: 'https://chatgpt.com/oauth/client.json', name: 'ChatGPT' };
const LCU_DB = stableId('courseOffering', 'livecampusu', 'C-DB');
const ED_2026 = stableId('courseOffering', 'edstem', 'db2026');
const ED_2025 = stableId('courseOffering', 'edstem', 'db2025');
const ED_REPORT1 = stableId('assignment', 'edstem', 'lesson-119755');
const ED_REPORT1_2025 = stableId('assignment', 'edstem', 'lesson-92580');
const ED_TASK = stableId('task', 'assignment', ED_REPORT1);
const DUE = '2026-10-06T17:00:00+09:00'; // as Ed states it

const NOTES =
  'レンタル店の業務を想定してER図を作成する。必要な実体・属性・関連・主キー・多重度を整理する。モデリング上の前提や仮定があれば文章で補足する。授業のポイント／感想をEd Discussionに投稿し、そのスレッド番号をレポートに記載する。提出期限は現時点で未確認。';

const told = (over: Record<string, string> = {}) => ({
  courseOfferingId: LCU_DB,
  title: 'レポート1：レンタル店のER図を作成する',
  notes: NOTES,
  via: 'chat' as const,
  source: 'ChatGPT Record',
  lectureDate: '2026-10-01',
  ...over,
});

const open: UniContext[] = [];
afterEach(async () => {
  for (const uc of open.splice(0)) await uc.close();
});

function setup(): { uc: UniContext; clock: ManualClock; syncEd: () => Promise<void> } {
  const clock = new ManualClock('2026-09-20T00:00:00.000Z');
  const uc = createUniContext({ profile: 'shizuoka-university', clock });
  open.push(uc);
  const lcu = createFakeConnector({
    product: 'livecampusu',
    sourceLabel: '学務情報システム',
    authority: 'academic-system',
    capabilities: ['courses', 'enrollments', 'timetable', 'assignments'],
    dataset: {
      courses: [
        {
          id: 'C-DB',
          code: '77403030',
          title: 'データベースシステム論',
          year: 2026,
          term: '後期',
          teacher: '山本 泰生',
          enrolled: true,
          schedule: [{ day: 4, period: 2, room: '共通講義棟31' }],
        },
      ],
    },
  });
  uc.sync.register({
    sourceId: 'livecampusu',
    adapter: lcu.adapter,
    normalizer: lcu.normalizer,
    metadata: lcu.metadata,
  });
  const ed = createFakeConnector({
    product: 'edstem',
    sourceLabel: 'Ed Discussion',
    authority: 'lms',
    capabilities: ['courses', 'assignments'],
    dataset: {
      courses: [
        { id: 'db2026', code: 'db2026', title: 'データベースシステム論', year: 2026, term: '後期' },
        { id: 'db2025', code: 'db2025', title: 'データベースシステム論', year: 2025 },
      ],
      assignments: [
        {
          id: 'lesson-119755',
          courseId: 'db2026',
          title: '当日課題 (小レポート1)',
          due: '2026-10-06T17:00:00+09:00',
          url: 'https://edstem.org/au/courses/41566/lessons/119755',
        },
        {
          id: 'lesson-92580',
          courseId: 'db2025',
          title: '当日課題 (小レポート1)',
          due: '2025-10-07T17:00:00+09:00',
          url: 'https://edstem.org/au/courses/28169/lessons/92580',
        },
      ],
    },
  });
  uc.sync.register({
    sourceId: 'edstem',
    adapter: ed.adapter,
    normalizer: ed.normalizer,
    metadata: ed.metadata,
  });
  const syncEd = async (): Promise<void> => {
    expect((await uc.sync.sync('edstem')).ok).toBe(true);
    await uc.runPipeline();
  };
  return { uc, clock, syncEd };
}

async function start(withEd: boolean) {
  const s = setup();
  expect((await s.uc.sync.sync('livecampusu')).ok).toBe(true);
  if (withEd) await s.syncEd();
  else await s.uc.runPipeline();
  // Monday 10/5 12:56 JST, when the student told ChatGPT.
  s.clock.set('2026-10-05T03:56:00.000Z');
  return s;
}

/** Everything the student is shown about the work, in one string. */
function shown(uc: UniContext): string {
  return JSON.stringify([
    uc.context.nextActions(),
    uc.context.deadline({}),
    uc.context.today(),
    uc.context.estimatedDeadlines(),
  ]);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('a to-do told in a chat that Ed already has as an assignment', () => {
  it('the offerings: 2026 LiveCampusU + 2026 Ed linked, the 2025 Ed offering apart', async () => {
    const { uc } = await start(true);
    const ids = uc.identity.expand(LCU_DB);
    expect(ids).toContain(ED_2026);
    expect(ids).not.toContain(ED_2025);
  });

  it('links the to-do to 当日課題 (小レポート1) when it is stored: due 10/6 17:00 from Ed, no estimate, one entry', async () => {
    const { uc } = await start(true);
    const r = await uc.additions.addTask(CHATGPT, told());
    expect(r.addition.attachedTo).toMatchObject({
      id: ED_REPORT1,
      title: '当日課題 (小レポート1)',
    });
    expect(r.addition.stored).toMatchObject({ taskId: ED_TASK, assignmentId: ED_REPORT1 });

    // No task of its own; the Ed task carries the due date, its source and the notes as details.
    expect(uc.tasks.get(stableId('task', 'todo', r.addition.id))).toBeUndefined();
    const task = uc.tasks.get(ED_TASK);
    expect(task).toMatchObject({ assignmentId: ED_REPORT1, dueAt: DUE, status: 'pending' });
    expect(task?.notes).toContain('〔チャットで登録「レポート1：レンタル店のER図を作成する」〕');
    expect(task?.notes).toContain('レンタル店の業務を想定してER図を作成する');
    expect(task?.notes).not.toContain('未確認');
    expect(
      uc.tasks.list().filter((t) => t.status === 'pending' && /レポート1/.test(t.title)),
    ).toHaveLength(1);

    const d = uc.context.deadline({});
    const item = d.upcoming.find((x) => x.taskId === ED_TASK);
    expect(item).toMatchObject({ dueAt: DUE });
    expect(item?.recorded).toBeUndefined();
    expect(item?.details).toContain('レンタル店の業務を想定してER図を作成する');
    expect(item?.citations.some((c) => c.sourceLabel === 'Ed Discussion')).toBe(true);
    expect(d.estimated).toEqual([]);

    const all = shown(uc);
    expect(all).not.toContain(stableId('task', 'todo', r.addition.id));
    expect(all).not.toContain('10/8');
    expect(uc.context.nextActions().top?.title).toBe('当日課題 (小レポート1)');
  });

  it('links it on reprocess when Ed syncs after the chat (the live order), and the addition shows it', async () => {
    const { uc, syncEd } = await start(false);
    const r = await uc.additions.addTask(CHATGPT, told());
    const todoId = stableId('task', 'todo', r.addition.id);
    // Before Ed knows: its own task, estimated at the next class (10/8 10:20 JST).
    expect(uc.tasks.get(todoId)).toMatchObject({ status: 'pending' });
    expect(uc.context.estimatedDeadlines().map((e) => e.estimatedDue.at)).toEqual([
      '2026-10-08T01:20:00.000Z',
    ]);

    await syncEd();
    expect(uc.tasks.get(todoId)).toBeUndefined();
    const task = uc.tasks.get(ED_TASK);
    expect(task).toMatchObject({ dueAt: DUE, status: 'pending' });
    expect(task?.notes).toContain('ER図');
    expect(task?.sourceFactIds).toEqual(expect.arrayContaining(r.audit.factIds));
    expect(uc.context.estimatedDeadlines()).toEqual([]);
    expect(shown(uc)).not.toContain('10/8');

    const view = uc.additions.get(r.addition.id);
    expect(view?.attachedTo).toMatchObject({ id: ED_REPORT1 });
    expect(view?.stored).toMatchObject({ taskId: ED_TASK, linked: true });

    // Idempotent: another pipeline run changes nothing and does not repeat the notes.
    await uc.runPipeline();
    expect(count(uc.tasks.get(ED_TASK)?.notes ?? '', '〔チャットで登録')).toBe(1);
  });

  it('keeps the student’s own progress on the to-do when it is linked later', async () => {
    const { uc, syncEd } = await start(false);
    const r = await uc.additions.addTask(CHATGPT, told());
    uc.tasks.setStatus(stableId('task', 'todo', r.addition.id), 'in_progress', { actor: 'user' });
    await syncEd();
    expect(uc.tasks.get(ED_TASK)).toMatchObject({ status: 'in_progress', statusSetBy: 'user' });
  });

  it('never links another number (レポート2 is not 小レポート1)', async () => {
    const { uc } = await start(true);
    const r = await uc.additions.addTask(
      CHATGPT,
      told({ title: 'レポート2：ER図を正規化する', notes: '第3正規形まで' }),
    );
    expect(r.addition.attachedTo).toBeUndefined();
    expect(r.addition.possibleSameAs).toBeUndefined();
    expect(uc.tasks.get(stableId('task', 'todo', r.addition.id))).toMatchObject({
      status: 'pending',
    });
  });

  it('a weak match keeps both, marks the candidate, and plans by its due date instead of estimating', async () => {
    const { uc } = await start(true);
    const r = await uc.additions.addTask(
      CHATGPT,
      told({ title: 'ER図のレポート', notes: 'レンタル店のER図。提出期限は未確認。' }),
    );
    expect(r.addition.attachedTo).toBeUndefined();
    expect(r.addition.possibleSameAs).toMatchObject({ id: ED_REPORT1, dueAt: DUE });
    const todoId = stableId('task', 'todo', r.addition.id);
    expect(uc.tasks.get(todoId)).toMatchObject({ status: 'pending' });
    const est = uc.context.estimatedDeadlines().find((e) => e.taskId === todoId);
    expect(est?.estimatedDue).toMatchObject({
      method: 'candidate',
      at: '2026-10-06T08:00:00.000Z',
    });
    expect(est?.estimatedDue.basis).toContain('当日課題 (小レポート1)');
    expect(shown(uc)).not.toContain('10/8');
  });

  it('ingest_lecture tasks and add_deadline (kind report) of the same item link to it too', async () => {
    const { uc } = await start(true);
    const ing = await uc.additions.ingestLecture(CHATGPT, {
      courseOfferingId: LCU_DB,
      lectureDate: '2026-10-01',
      summary: 'ER図の書き方を扱った。',
      recordingRef: 'chatgpt-record:db-1001',
      tasks: [
        {
          title: 'レポート1 ER図',
          evidence: 'レポート1はレンタル店のER図です',
          notes: NOTES,
        },
      ],
    });
    const item = ing.items.find((x) => x.type === 'task');
    expect(item?.result?.addition.attachedTo).toMatchObject({ id: ED_REPORT1 });
    expect(uc.context.estimatedDeadlines()).toEqual([]);

    const dl = await uc.additions.addDeadline(CHATGPT, {
      courseOfferingId: LCU_DB,
      title: 'レポート1',
      dueAt: '10月6日17時',
      kind: 'report',
      evidence: 'レポート1は10/6の17時まで',
      lectureDate: '2026-10-01',
    });
    expect(dl.addition.attachedTo).toMatchObject({ id: ED_REPORT1 });
    expect(uc.resolver.listConflicts({ status: 'open' })).toEqual([]);
  });

  it('add_task with assignmentId attaches the to-do to that assignment', async () => {
    const { uc } = await start(true);
    const r = await uc.additions.addTask(CHATGPT, {
      title: 'ER図の主キーを見直す',
      assignmentId: ED_REPORT1,
      via: 'chat',
    });
    expect(r.addition.attachedTo).toMatchObject({ id: ED_REPORT1 });
    expect(uc.tasks.get(stableId('task', 'todo', r.addition.id))).toBeUndefined();
    expect(uc.tasks.get(ED_TASK)?.notes).toContain('ER図の主キーを見直す');
    void ED_REPORT1_2025;
  });
});
