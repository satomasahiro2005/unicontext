import { stableId } from '@unicontext/canonical-model';
import { createFakeConnector } from '@unicontext/connector-sdk';
import { ManualClock } from '@unicontext/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AdditionClient,
  createUniContext,
  INGEST_LIMITS,
  type IngestLectureInput,
  type UniContext,
} from '../src/index.js';

/*
 * ingest_lecture (AdditionsService.ingestLecture): one lecture recording stored at once — the
 * lecture, the deadlines, to-dos and notes said in it — through the same write path as the single
 * tools. 2026-11-16 is a Monday; ソフトウェア工学 is Monday 2限, the next class is 11-25 (Wed,
 * Monday timetable, since 11-23 is a holiday). 実験 runs Friday 5・6限 as one block; 演習 has two
 * separate classes on Wednesday (1限 and 3限).
 */

const CHATGPT: AdditionClient = { id: 'https://chatgpt.com/oauth/client-1', name: 'ChatGPT' };
const CLAUDE: AdditionClient = { id: 'claude-client', name: 'claude.ai' };
const MON = stableId('courseOffering', 'livecampusu', 'C-MON');
const LAB = stableId('courseOffering', 'livecampusu', 'C-LAB');
const SEM = stableId('courseOffering', 'livecampusu', 'C-SEM');
const LCU_REPORT = stableId('assignment', 'livecampusu', 'A-1');

const open: UniContext[] = [];
afterEach(async () => {
  for (const uc of open.splice(0)) await uc.close();
});

async function setup(now = '2026-11-16T05:00:00.000Z'): Promise<{
  uc: UniContext;
  clock: ManualClock;
}> {
  const clock = new ManualClock(now);
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
          id: 'C-MON',
          code: 'J3101',
          title: 'ソフトウェア工学',
          year: 2026,
          term: '後期',
          enrolled: true,
          schedule: [{ day: 1, period: 2 }],
        },
        {
          id: 'C-LAB',
          code: 'J3201',
          title: '情報科学実験',
          year: 2026,
          term: '後期',
          enrolled: true,
          schedule: [
            { day: 5, period: 5 },
            { day: 5, period: 6 },
          ],
        },
        {
          id: 'C-SEM',
          code: 'J3301',
          title: 'プログラミング演習',
          year: 2026,
          term: '後期',
          enrolled: true,
          schedule: [
            { day: 3, period: 1 },
            { day: 3, period: 3 },
          ],
        },
      ],
      assignments: [
        {
          id: 'A-1',
          courseId: 'C-MON',
          title: 'レポート課題2',
          due: '2026-11-27T23:59:00+09:00',
          updatedAt: '2026-11-01T00:00:00Z',
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
  clock.set('2026-11-10T00:00:00.000Z');
  expect((await uc.sync.sync('livecampusu')).ok).toBe(true);
  clock.set(now);
  return { uc, clock };
}

const recording = (over: Partial<IngestLectureInput> = {}): IngestLectureInput => ({
  lectureDate: '2026-11-16',
  period: 2,
  summary: 'UMLのクラス図と関連の多重度。集約とコンポジションの違い。',
  keyPoints: ['クラス図', '多重度', '集約とコンポジション'],
  segments: [{ at: '00:42:18', text: '次回までにクラス図を描いてきてください' }],
  deadlines: [
    {
      title: '課題3 クラス図',
      dueAt: '次回',
      kind: 'assignment',
      evidence: '次回までにクラス図を描いてきてください',
      recordingTimestamp: '00:42:18',
    },
  ],
  tasks: [
    {
      title: '教科書4章を読む',
      evidence: '4章を読んでおいてください',
      recordingTimestamp: '00:50:02',
    },
  ],
  notes: [
    {
      title: 'グループ分け',
      text: '来週からの演習は出席番号順の4人グループ',
      evidence: '来週からは出席番号順に4人ずつのグループでやります',
      recordingTimestamp: '00:03:10',
    },
  ],
  ...over,
});

describe('ingestLecture', () => {
  it('stores the lecture and every part at once, unconfirmed and 「録音から」, course from the timetable', async () => {
    const { uc } = await setup();
    // No course: Monday 2限 is ソフトウェア工学.
    const r = await uc.additions.ingestLecture(CHATGPT, recording());
    expect(r.course).toEqual({ id: MON, title: 'ソフトウェア工学' });
    expect(r.period).toBe(2);
    expect(r.lecture.result?.status).toBe('created');
    expect(r.items.map((x) => [x.type, x.result?.status])).toEqual([
      ['deadline', 'created'],
      ['task', 'created'],
      ['note', 'created'],
    ]);
    for (const x of [r.lecture, ...r.items])
      expect(x.result?.addition).toMatchObject({
        status: 'unconfirmed',
        via: 'recording',
        label: '録音から',
        source: 'ChatGPT Record',
        ingestionId: r.ingestionId,
        course: { id: MON },
      });
    // 次回 from the lecture of 11-16 is 11-25 2限 (Monday timetable on Wednesday).
    const deadline = r.items[0]?.result?.addition;
    expect(deadline).toMatchObject({ dueAt: '2026-11-25T01:20:00.000Z', dueText: '11/25 10:20' });
    expect(deadline?.recordingTimestamp).toBe('00:42:18');

    // Shown at once in the views every client reads.
    expect(uc.context.today().deadlines.map((d) => d.title)).toContain('課題3 クラス図');
    expect(uc.context.today().tasks.map((t) => t.title)).toContain('教科書4章を読む');
    const bundle = uc.context.lecture({ courseOfferingId: MON, date: '2026-11-16' });
    expect(bundle?.notes.map((n) => n.kind)).toEqual(['summary', 'note']);
    expect(bundle?.transcript.map((s) => s.timestamp)).toEqual(['00:42:18']);
    expect(uc.additions.notes({ courseOfferingId: MON }).notes.map((n) => n.title)).toContain(
      'グループ分け',
    );

    // Everything from this recording, and nothing else.
    await uc.additions.addTask(CHATGPT, { courseOfferingId: MON, title: '別の会話のTODO' });
    expect(uc.additions.listFor(CHATGPT, { ingestionId: r.ingestionId })).toHaveLength(4);
    expect(uc.additions.listFor(CHATGPT)).toHaveLength(5);
  });

  it('re-ingesting the same lecture never duplicates; changed content updates it', async () => {
    const { uc } = await setup();
    const first = await uc.additions.ingestLecture(CHATGPT, recording());
    const again = await uc.additions.ingestLecture(CHATGPT, recording());
    expect([again.lecture, ...again.items].map((x) => x.result?.status)).toEqual([
      'replayed',
      'replayed',
      'replayed',
      'replayed',
    ]);
    expect(again.ingestionId).toBe(first.ingestionId);

    // Processed again with a better summary and a time for the deadline: updated in place.
    const better = await uc.additions.ingestLecture(
      CHATGPT,
      recording({
        summary: 'クラス図・多重度・集約とコンポジション。演習はグループで。',
        deadlines: [
          {
            title: '課題3 クラス図',
            dueAt: '2026-11-25T17:00:00+09:00',
            kind: 'assignment',
            evidence: '25日の17時までに出してください',
            recordingTimestamp: '00:43:00',
          },
        ],
      }),
    );
    expect(better.lecture.result?.status).toBe('updated');
    expect(better.lecture.result?.addition.id).toBe(first.lecture.result?.addition.id);
    expect(better.items[0]?.result).toMatchObject({
      status: 'updated',
      addition: { id: first.items[0]?.result?.addition.id, dueAt: '2026-11-25T08:00:00.000Z' },
    });
    expect(uc.additions.listFor(CHATGPT)).toHaveLength(4);
    expect(uc.tasks.list().filter((t) => t.title === '課題3 クラス図')).toHaveLength(1);
    expect(
      uc.context.lecture({ courseOfferingId: MON, date: '2026-11-16' })?.notes[0]?.text,
    ).toContain('演習はグループで');
  });

  it('derives item keys from recordingRef, so a renamed item updates instead of adding', async () => {
    const { uc } = await setup();
    const ref = 'chatgpt-record:conv-123';
    const withKey = recording({
      recordingRef: ref,
      deadlines: [
        {
          key: 'class-diagram',
          title: '課題3',
          dueAt: '次回',
          kind: 'assignment',
          evidence: '次回までにクラス図を描いてきてください',
        },
      ],
    });
    const first = await uc.additions.ingestLecture(CHATGPT, withKey);
    expect(first.lecture.idempotencyKey).toBe(`${ref}:lecture`);
    expect(first.items[0]?.idempotencyKey).toBe(`${ref}:deadline:class-diagram`);
    expect(first.items[1]?.idempotencyKey).toBe(`${ref}:task:教科書4章を読む`);
    expect(first.items[2]?.idempotencyKey).toBe(`${ref}:note:グループ分け`);
    expect(first.recordingRef).toBe(ref);

    const renamed = await uc.additions.ingestLecture(CHATGPT, {
      ...withKey,
      deadlines: [{ ...withKey.deadlines![0]!, title: '課題3 クラス図を描く' }],
    });
    expect(renamed.items[0]?.result).toMatchObject({
      status: 'updated',
      addition: { id: first.items[0]?.result?.addition.id, title: '課題3 クラス図を描く' },
    });
    expect(uc.additions.listFor(CHATGPT).filter((a) => a.tool === 'add_deadline')).toHaveLength(1);
  });

  it('reports each part: a failed part does not stop the others, and a re-run fills only the gap', async () => {
    const { uc } = await setup();
    const input = recording({
      deadlines: [
        {
          title: '課題3 クラス図',
          dueAt: '次回',
          kind: 'assignment',
          evidence: '次回までにクラス図を描いてきてください',
        },
        {
          title: '小テスト（UML）',
          dueAt: 'そのうち',
          kind: 'quiz',
          evidence: 'そのうち小テストをします',
        },
        {
          title: '中間レポート',
          dueAt: '12月4日',
          kind: 'report',
          evidence: '中間レポートは12月4日まで',
        },
      ],
      notes: [
        {
          title: '教室',
          text: '次回は情報学部2号館の演習室',
          evidence: '次回は演習室でやります',
          recordingTimestamp: 'あとで',
        },
      ],
    });
    const r = await uc.additions.ingestLecture(CHATGPT, input);
    expect(r.lecture.result?.status).toBe('created');
    expect(r.items.map((x) => x.result?.status ?? x.error?.code)).toEqual([
      'created',
      'validation',
      'created',
      'created',
      'validation',
    ]);
    expect(r.items[1]?.error?.message).toMatch(/could not be read/);
    expect(r.items[4]?.error?.message).toMatch(/HH:MM:SS/);
    expect(uc.additions.listFor(CHATGPT)).toHaveLength(4);

    // The whole call again, with the broken parts fixed: nothing stored twice.
    const fixed = await uc.additions.ingestLecture(CHATGPT, {
      ...input,
      deadlines: input.deadlines!.map((d) =>
        d.dueAt === 'そのうち'
          ? { ...d, dueAt: '来週の金曜', evidence: '来週の金曜に小テスト' }
          : d,
      ),
      notes: input.notes!.map((n) => ({ ...n, recordingTimestamp: '00:30:00' })),
    });
    expect([fixed.lecture, ...fixed.items].map((x) => x.result?.status)).toEqual([
      'replayed',
      'replayed',
      'created',
      'replayed',
      'replayed',
      'created',
    ]);
    expect(uc.additions.listFor(CHATGPT)).toHaveLength(6);
    expect(uc.tasks.list().filter((t) => t.title === '課題3 クラス図')).toHaveLength(1);
  });

  it('never overrides LiveCampusU: a different date becomes a conflict', async () => {
    const { uc } = await setup();
    const before = uc.sync.stores.entities.get(LCU_REPORT);
    const r = await uc.additions.ingestLecture(
      CHATGPT,
      recording({
        deadlines: [
          {
            title: 'レポート課題2',
            dueAt: '12月4日',
            kind: 'report',
            evidence: 'レポート課題2の締切は12月4日に延ばします',
            recordingTimestamp: '01:10:00',
          },
        ],
      }),
    );
    const a = r.items[0]?.result?.addition;
    expect(a?.attachedTo?.id).toBe(LCU_REPORT);
    // The conflict is visible in the result although the pipeline runs once, at the end.
    expect(a?.conflicts.map((c) => c.predicate)).toEqual(['assignment_due']);
    expect(uc.resolver.resolve(LCU_REPORT, 'assignment_due').status).toBe('conflict');
    expect(uc.sync.stores.entities.get(LCU_REPORT)).toEqual(before);
    expect(uc.tasks.get(stableId('task', 'assignment', LCU_REPORT))?.dueAt).toBe(
      '2026-11-27T23:59:00+09:00',
    );
  });

  it('keeps separate classes of one course on one day apart; a block of periods is one lecture', async () => {
    const { uc } = await setup('2026-11-20T12:00:00.000Z');
    // 演習 on Wednesday 11-18 has 1限 and 3限: without a period nothing is stored.
    await expect(
      uc.additions.ingestLecture(
        CHATGPT,
        recording({ courseOfferingId: SEM, lectureDate: '2026-11-18', period: undefined }),
      ),
    ).rejects.toThrow(/give the period/);
    const p1 = await uc.additions.ingestLecture(
      CHATGPT,
      recording({ courseOfferingId: SEM, lectureDate: '2026-11-18', period: 1, deadlines: [] }),
    );
    const p3 = await uc.additions.ingestLecture(
      CHATGPT,
      recording({
        courseOfferingId: SEM,
        lectureDate: '2026-11-18',
        period: 3,
        summary: '午後の回: 再帰',
        deadlines: [],
        tasks: [],
        notes: [],
      }),
    );
    expect(p3.lecture.result?.status).toBe('created');
    expect(p3.lecture.result?.addition.id).not.toBe(p1.lecture.result?.addition.id);
    expect(p3.ingestionId).not.toBe(p1.ingestionId);

    // 実験 Friday 5・6限 is one block: no period needed, and it is one lecture.
    const lab = await uc.additions.ingestLecture(
      CHATGPT,
      recording({
        courseOfferingId: LAB,
        lectureDate: '2026-11-20',
        period: undefined,
        deadlines: [],
      }),
    );
    expect(lab.period).toBe(5);
    expect(lab.lecture.result?.addition.stored.classSessionId).toBeDefined();

    // Without a course and with several classes that day: the error names them.
    await expect(
      uc.additions.ingestLecture(
        CHATGPT,
        recording({ lectureDate: '2026-11-18', period: undefined }),
      ),
    ).rejects.toThrow(/プログラミング演習/);
  });

  it('counts one call against the burst and each stored part against the write budget', async () => {
    const { uc } = await setup();
    for (let i = 0; i < 25; i++)
      await uc.additions.addTask(CHATGPT, { courseOfferingId: MON, title: `やること${i}` });
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      title: `準備${i}`,
      evidence: `準備${i}をしてきてください`,
    }));
    const r = await uc.additions.ingestLecture(
      CHATGPT,
      recording({ deadlines: [], notes: [], tasks }),
    );
    // 5 writes were left: the lecture and 4 tasks; the rest report rate_limited.
    expect(r.lecture.result?.status).toBe('created');
    const codes = r.items.map((x) => x.result?.status ?? x.error?.code);
    expect(codes.filter((c) => c === 'created')).toHaveLength(4);
    expect(codes.filter((c) => c === 'rate_limited')).toHaveLength(6);
    // No budget at all: one clear error, nothing stored.
    await expect(uc.additions.ingestLecture(CHATGPT, recording())).rejects.toMatchObject({
      code: 'rate_limited',
    });
    // Too many parts in one call.
    await expect(
      uc.additions.ingestLecture(
        CLAUDE,
        recording({
          tasks: Array.from({ length: INGEST_LIMITS.tasks }, (_, i) => ({
            title: `t${i}`,
            evidence: 'x',
          })),
          notes: Array.from({ length: INGEST_LIMITS.notes }, (_, i) => ({
            text: `n${i}`,
            evidence: 'x',
          })),
          deadlines: [{ title: 'd', dueAt: '次回', kind: 'prep', evidence: 'x' }],
        }),
      ),
    ).rejects.toThrow(/together per call/);
  });

  it('another client that already has the item gets duplicate; withdrawn parts are not re-added', async () => {
    const { uc } = await setup();
    const claude = await uc.additions.addDeadline(CLAUDE, {
      courseOfferingId: MON,
      title: '課題3 クラス図',
      dueAt: '次回',
      kind: 'assignment',
      evidence: '次回までにクラス図',
      lectureDate: '2026-11-16',
    });
    const r = await uc.additions.ingestLecture(CHATGPT, recording());
    expect(r.items[0]?.result).toMatchObject({
      status: 'duplicate',
      addition: { id: claude.addition.id },
    });
    const taskId = r.items[1]?.result?.addition.id as string;
    await uc.additions.retract(CHATGPT, taskId);
    const again = await uc.additions.ingestLecture(CHATGPT, recording());
    expect(again.items[1]?.result).toMatchObject({
      status: 'replayed',
      addition: { id: taskId, status: 'retracted' },
    });
  });
});
