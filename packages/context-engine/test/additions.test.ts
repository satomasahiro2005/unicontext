import { ADDITIONS_SOURCE_ID, stableId } from '@unicontext/canonical-model';
import { createFakeConnector } from '@unicontext/connector-sdk';
import { ManualClock } from '@unicontext/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type AdditionClient, createUniContext, type UniContext } from '../src/index.js';

/*
 * AI additions (MCP write tools) against a Shizuoka-profile UniContext: a Monday 2限 course and a
 * Thursday course the student takes, with one LiveCampusU report deadline and one exam.
 * 2026-11-16 is a Monday; 11-23 (Mon) is 勤労感謝の日 and 11-25 (Wed) follows the Monday timetable.
 */

const CHATGPT: AdditionClient = { id: 'https://chatgpt.com/oauth/client-1', name: 'ChatGPT' };
const CLAUDE: AdditionClient = { id: 'claude-client', name: 'claude.ai' };
const MON = stableId('courseOffering', 'livecampusu', 'C-MON');
const THU = stableId('courseOffering', 'livecampusu', 'C-THU');
const LCU_REPORT = stableId('assignment', 'livecampusu', 'A-1');

const open: UniContext[] = [];
afterEach(async () => {
  for (const uc of open.splice(0)) await uc.close();
});

async function setup(now = '2026-11-16T03:00:00.000Z'): Promise<{
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
    capabilities: ['courses', 'enrollments', 'timetable', 'assignments', 'exams'],
    dataset: {
      courses: [
        {
          id: 'C-MON',
          code: 'J3101',
          title: 'ソフトウェア工学',
          year: 2026,
          term: '後期',
          teacher: '山田 太郎',
          enrolled: true,
          schedule: [{ day: 1, period: 2, room: '情報学部2号館21教室' }],
        },
        {
          id: 'C-THU',
          code: 'J3102',
          title: 'データベース論',
          year: 2026,
          term: '後期',
          enrolled: true,
          schedule: [{ day: 4, period: 2 }],
        },
        {
          id: 'C-OTHER',
          code: 'J3999',
          title: '他学部の講義',
          year: 2026,
          term: '後期',
          schedule: [{ day: 2, period: 3 }],
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
      exams: [
        {
          id: 'E-1',
          courseId: 'C-MON',
          title: 'ソフトウェア工学 期末試験',
          kind: 'final',
          startsAt: '2027-01-25T10:20:00+09:00',
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

const deadline = (over: Partial<Parameters<UniContext['additions']['addDeadline']>[1]> = {}) => ({
  courseOfferingId: MON,
  title: '課題3 クラス図',
  dueAt: '次回',
  kind: 'assignment' as const,
  evidence: '次回までにクラス図を描いてきてください',
  recordingTimestamp: '00:42:18',
  lectureDate: '2026-11-16',
  ...over,
});

describe('relative due dates (Shizuoka academic calendar + timetable)', () => {
  it('resolves 次回 to the next class, skipping a holiday and following 月曜授業', async () => {
    const { uc } = await setup();
    const r = uc.additions.resolveDue(MON, '次回', '2026-11-16');
    // 11-23 (Mon) is 勤労感謝の日; 11-25 (Wed) has the Monday timetable: 2限 10:20 JST.
    expect(r.dueAt).toBe('2026-11-25T01:20:00.000Z');
    expect(r.resolution).toMatchObject({ rule: 'next_class', timeAssumed: false });
  });

  it('resolves 来週の金曜 relative to the lecture date, and passes ISO through', async () => {
    const { uc } = await setup();
    expect(uc.additions.resolveDue(MON, '来週の金曜', '2026-11-16').dueAt).toBe(
      '2026-11-27T14:59:00.000Z',
    );
    expect(uc.additions.resolveDue(MON, '来週の金曜17時', '2026-11-16').dueAt).toBe(
      '2026-11-27T08:00:00.000Z',
    );
    expect(uc.additions.resolveDue(MON, '2026-12-01T17:00:00+09:00').dueAt).toBe(
      '2026-12-01T08:00:00.000Z',
    );
    expect(uc.additions.resolveDue(MON, '2026-12-01').dueAt).toBe('2026-12-01T14:59:00.000Z');
    expect(uc.additions.resolveDue(MON, '12月4日', '2026-11-16').dueAt).toBe(
      '2026-12-04T14:59:00.000Z',
    );
    expect(() => uc.additions.resolveDue(MON, 'そのうち')).toThrow(/could not be read/);
  });

  it('uses the lecture date, not the day the client writes, for 次回', async () => {
    // Written on Thursday 11-19 about Monday's lecture: still 11-25.
    const { uc } = await setup('2026-11-19T01:00:00.000Z');
    const res = await uc.additions.addDeadline(CHATGPT, deadline());
    expect(res.addition.dueAt).toBe('2026-11-25T01:20:00.000Z');
    expect(res.addition.dueResolution).toMatchObject({ input: '次回', rule: 'next_class' });
  });
});

describe('add_deadline', () => {
  it('stores an unconfirmed extracted deadline with the recording as its source', async () => {
    const { uc } = await setup();
    const res = await uc.additions.addDeadline(CHATGPT, deadline());
    expect(res.status).toBe('created');
    const a = res.addition;
    expect(a).toMatchObject({
      status: 'unconfirmed',
      kind: 'assignment',
      source: 'ChatGPT Record',
      recordingTimestamp: '00:42:18',
      evidence: '次回までにクラス図を描いてきてください',
      course: { id: MON, title: 'ソフトウェア工学' },
    });
    const assignmentId = a.stored.assignmentId as string;
    expect(uc.sync.stores.entities.meta(assignmentId)?.sourceId).toBe(ADDITIONS_SOURCE_ID);

    const [fact] = uc.resolver.facts.getMany(res.audit.factIds);
    expect(fact).toMatchObject({
      origin: 'extracted',
      predicate: 'assignment_due',
      producer: { type: 'ai' },
      evidence: '次回までにクラス図を描いてきてください',
    });
    const ref = uc.sync.stores.sourceRefs.get(fact?.sourceReferenceId ?? '');
    expect(ref).toMatchObject({
      sourceSystem: 'ChatGPT Record',
      sourceId: ADDITIONS_SOURCE_ID,
      authority: 'transcript',
      location: { timestamp: '00:42:18' },
    });
    expect(ref?.sourceItemId).toContain(CHATGPT.id);
    expect(ref?.retrievedAt).toBe('2026-11-16T03:00:00.000Z');

    // today / deadlines show it with 「録音から」 and the evidence.
    const item = uc.context
      .deadline({ days: 15 })
      .upcoming.find((d) => d.title === '課題3 クラス図');
    expect(item).toMatchObject({
      origin: 'extracted',
      dueAt: '2026-11-25T01:20:00.000Z',
      evidence: '次回までにクラス図を描いてきてください',
      recorded: { label: '録音から', source: 'ChatGPT Record', timestamp: '00:42:18' },
    });
    expect(item?.summary).toMatch(/^【録音から】/);
    expect(item?.citations[0]?.label).toContain('ChatGPT Record 00:42:18');
    expect(uc.context.today().deadlines.map((d) => d.title)).toContain('課題3 クラス図');
  });

  it('opens a conflict with a different LiveCampusU due date and never overrides it', async () => {
    const { uc } = await setup();
    const taskId = stableId('task', 'assignment', LCU_REPORT);
    uc.tasks.setStatus(taskId, 'in_progress', { actor: 'user' });
    const before = uc.sync.stores.entities.get(LCU_REPORT);

    const res = await uc.additions.addDeadline(
      CHATGPT,
      deadline({
        title: 'レポート課題2',
        dueAt: '12月4日',
        kind: 'report',
        evidence: 'レポート課題2の締切は12月4日に延ばします',
      }),
    );
    expect(res.addition.attachedTo).toMatchObject({ id: LCU_REPORT, source: 'livecampusu' });
    expect(res.addition.stored).toMatchObject({ assignmentId: LCU_REPORT, attached: true });
    expect(res.addition.conflicts).toHaveLength(1);
    expect(res.addition.conflicts[0]?.predicate).toBe('assignment_due');

    const conflicts = uc.resolver.listConflicts({ status: 'open' });
    expect(conflicts.map((c) => [c.subject, c.predicate])).toContainEqual([
      LCU_REPORT,
      'assignment_due',
    ]);
    const conflict = conflicts.find((c) => c.subject === LCU_REPORT);
    expect(conflict?.candidates.map((c) => c.origin).sort()).toEqual([
      'authoritative',
      'extracted',
    ]);

    // The academic system's value is still what the task shows; the entity and status are untouched.
    const task = uc.tasks.get(taskId);
    expect(task).toMatchObject({
      dueAt: '2026-11-27T23:59:00+09:00',
      origin: 'authoritative',
      status: 'in_progress',
      statusSetBy: 'user',
    });
    expect(uc.sync.stores.entities.get(LCU_REPORT)).toEqual(before);
    expect(uc.sync.stores.entities.meta(LCU_REPORT)?.sourceId).toBe('livecampusu');
    // …and the Today view tells the AI the sources disagree.
    expect(uc.context.today().conflicts.some((c) => c.subject === LCU_REPORT)).toBe(true);
  });

  it('agrees silently when the recording states the same day as LiveCampusU', async () => {
    const { uc } = await setup();
    const res = await uc.additions.addDeadline(
      CHATGPT,
      deadline({ title: 'レポート課題2', dueAt: '11月27日', kind: 'report' }),
    );
    // The heard date had no time: it adopts the system's 23:59 for the same day.
    expect(res.addition.conflicts).toEqual([]);
    expect(uc.resolver.resolve(LCU_REPORT, 'assignment_due')).toMatchObject({
      status: 'resolved',
      method: 'agreement',
    });
  });

  it('dedupes the same course + title + close due date, and replays an idempotency key', async () => {
    const { uc } = await setup();
    const first = await uc.additions.addDeadline(CHATGPT, deadline({ idempotencyKey: 'k1' }));
    const replay = await uc.additions.addDeadline(CHATGPT, deadline({ idempotencyKey: 'k1' }));
    expect(replay.status).toBe('replayed');
    expect(replay.addition.id).toBe(first.addition.id);

    // Same item, said again with a time: updated, not duplicated.
    const again = await uc.additions.addDeadline(
      CHATGPT,
      deadline({ dueAt: '2026-11-25T17:00', evidence: '25日の17時までです', idempotencyKey: 'k2' }),
    );
    expect(again.status).toBe('updated');
    expect(again.addition.id).toBe(first.addition.id);
    expect(again.addition.dueAt).toBe('2026-11-25T08:00:00.000Z');
    expect(uc.additions.listFor(CHATGPT)).toHaveLength(1);
    const tasks = uc.tasks.list().filter((t) => t.title === '課題3 クラス図');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.dueAt).toBe('2026-11-25T08:00:00.000Z');
    // Only the latest claim is live.
    expect(
      uc.resolver.facts
        .active({ subjects: [first.addition.stored.assignmentId as string] })
        .filter((f) => f.predicate === 'assignment_due'),
    ).toHaveLength(1);

    // Another client saying the same thing does not create a second item.
    const other = await uc.additions.addDeadline(CLAUDE, deadline());
    expect(other.status).toBe('duplicate');
    expect(uc.additions.list()).toHaveLength(1);

    // A clearly different date for the same title is a separate item.
    const later = await uc.additions.addDeadline(CHATGPT, deadline({ dueAt: '2027-01-20' }));
    expect(later.status).toBe('created');
  });

  it('stores exams and preparation items', async () => {
    const { uc } = await setup();
    const exam = await uc.additions.addDeadline(
      CHATGPT,
      deadline({
        title: '小テスト（UML）',
        dueAt: '次回',
        kind: 'quiz',
        evidence: '次回小テストをします',
      }),
    );
    const examId = exam.addition.stored.examId as string;
    expect(uc.sync.stores.entities.getOfKind('exam', examId)).toMatchObject({
      examKind: 'quiz',
      startsAt: '2026-11-25T01:20:00.000Z',
    });
    // The LiveCampusU final exam gets the recording's date as a second opinion.
    const final = await uc.additions.addDeadline(
      CHATGPT,
      deadline({
        title: '期末試験',
        dueAt: '2027-01-26T10:20:00+09:00',
        kind: 'exam',
        evidence: '期末試験は1月26日です',
      }),
    );
    expect(final.addition.attachedTo?.id).toBe(stableId('exam', 'livecampusu', 'E-1'));
    expect(final.addition.conflicts[0]?.predicate).toBe('exam_at');

    const prep = await uc.additions.addDeadline(
      CHATGPT,
      deadline({
        title: '教科書3章を読む',
        dueAt: '次回',
        kind: 'prep',
        evidence: '3章を読んでおくこと',
      }),
    );
    const task = uc.tasks.get(prep.addition.stored.taskId as string);
    expect(task).toMatchObject({
      title: '教科書3章を読む',
      origin: 'extracted',
      taskKind: 'extracted',
      courseOfferingId: MON,
      dueAt: '2026-11-25T01:20:00.000Z',
      evidence: '3章を読んでおくこと',
    });
    // Several preparation items on one course are separate tasks, not a conflict.
    await uc.additions.addTask(CHATGPT, {
      courseOfferingId: MON,
      title: 'Javaの環境を用意する',
      evidence: 'PCにJDKを入れてきてください',
    });
    expect(
      uc.resolver.listConflicts({ status: 'open' }).filter((c) => c.predicate === 'todo'),
    ).toEqual([]);
    expect(uc.tasks.list().filter((t) => t.taskKind === 'extracted')).toHaveLength(2);
  });
});

describe('owner decisions and client retraction', () => {
  it('confirm turns the claim into a user fact; reject removes it', async () => {
    const { uc } = await setup();
    const own = await uc.additions.addDeadline(CHATGPT, deadline());
    const conflicting = await uc.additions.addDeadline(
      CHATGPT,
      deadline({ title: 'レポート課題2', dueAt: '12月4日', kind: 'report' }),
    );
    expect(uc.resolver.listConflicts({ status: 'open' })).toHaveLength(1);

    const confirmed = await uc.additions.confirm(conflicting.addition.id);
    expect(confirmed.status).toBe('confirmed');
    expect(uc.resolver.listConflicts({ status: 'open' })).toHaveLength(0);
    const report = uc.tasks.get(stableId('task', 'assignment', LCU_REPORT));
    expect(report).toMatchObject({ origin: 'user', dueAt: '2026-12-04T14:59:00.000Z' });
    // Confirmed: the client can no longer take it back.
    await expect(uc.additions.retract(CHATGPT, conflicting.addition.id)).rejects.toThrow(
      /confirmed/,
    );

    const ownTaskId = stableId('task', 'assignment', own.addition.stored.assignmentId as string);
    expect(uc.tasks.get(ownTaskId)?.status).toBe('pending');
    const rejected = await uc.additions.reject(own.addition.id);
    expect(rejected.status).toBe('rejected');
    expect(uc.tasks.get(ownTaskId)?.status).toBe('cancelled');
    expect(uc.sync.stores.entities.get(own.addition.stored.assignmentId as string)).toBeUndefined();
    expect(uc.context.deadline({}).upcoming.some((d) => d.title === '課題3 クラス図')).toBe(false);
  });

  it('confirming a todo keeps its task and makes it the user’s', async () => {
    const { uc } = await setup();
    const prep = await uc.additions.addTask(CHATGPT, {
      courseOfferingId: MON,
      title: '教科書3章を読む',
      dueAt: '次回',
      lectureDate: '2026-11-16',
    });
    const taskId = prep.addition.stored.taskId as string;
    uc.tasks.setStatus(taskId, 'in_progress', { actor: 'user' });
    await uc.additions.confirm(prep.addition.id);
    expect(uc.tasks.get(taskId)).toMatchObject({ origin: 'user', status: 'in_progress' });
    const item = uc.context.deadline({}).upcoming.find((d) => d.taskId === taskId);
    expect(item?.recorded).toBeUndefined();
  });

  it('a client sees and retracts only its own unconfirmed additions', async () => {
    const { uc } = await setup();
    const mine = await uc.additions.addDeadline(CHATGPT, deadline());
    await uc.additions.addNote(CLAUDE, { courseOfferingId: THU, text: '来週は教室が変わるかも' });
    expect(uc.additions.listFor(CHATGPT).map((a) => a.id)).toEqual([mine.addition.id]);
    await expect(uc.additions.retract(CLAUDE, mine.addition.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    const r = await uc.additions.retract(CHATGPT, mine.addition.id);
    expect(r.addition.status).toBe('retracted');
    expect(uc.context.deadline({}).upcoming.some((d) => d.title === '課題3 クラス図')).toBe(false);
    // Sending the same thing again after withdrawing it adds it again.
    const again = await uc.additions.addDeadline(CHATGPT, deadline());
    expect(again.status).toBe('created');
    expect(again.addition.id).not.toBe(mine.addition.id);
  });
});

describe('record_lecture and notes', () => {
  it('stores a lecture linked to the class session, with summary, key points and timestamps', async () => {
    const { uc } = await setup();
    const res = await uc.additions.recordLecture(CHATGPT, {
      courseOfferingId: MON,
      date: '2026-11-16',
      summary: 'UMLのクラス図と関連の多重度を扱った。',
      keyPoints: ['クラス図', '多重度'],
      segments: [
        { at: '00:05:00', text: '今日はクラス図をやります' },
        { at: '00:42:18', text: '次回までにクラス図を描いてきてください' },
      ],
    });
    expect(res.status).toBe('created');
    const stored = res.addition.stored;
    expect(stored.classSessionId).toBe(
      stableId('classSession', 'timetable', MON, '2026-11-16', '2'),
    );
    const bundle = uc.context.lecture({ courseOfferingId: MON, date: '2026-11-16' });
    expect(bundle?.lectureId).toBe(stored.lectureId);
    expect(bundle?.notes[0]).toMatchObject({
      kind: 'summary',
      text: 'UMLのクラス図と関連の多重度を扱った。',
      keyPoints: ['クラス図', '多重度'],
      origin: 'extracted',
    });
    expect(bundle?.transcript.map((s) => s.timestamp)).toEqual(['00:05:00', '00:42:18']);
    expect(bundle?.transcript[1]?.citations[0]?.label).toContain('ChatGPT Record 00:42:18');
    const hits = await uc.search.search('多重度');
    expect(
      hits.hits.some((h) => h.citations.some((c) => c.sourceSystem === 'ChatGPT Record')),
    ).toBe(true);

    // Re-recording the same lecture updates it.
    const again = await uc.additions.recordLecture(CHATGPT, {
      courseOfferingId: MON,
      date: '2026-11-16',
      summary: 'クラス図と多重度、集約とコンポジション。',
    });
    expect(again.status).toBe('updated');
    expect(again.addition.id).toBe(res.addition.id);
    expect(uc.context.lecture({ courseOfferingId: MON, date: '2026-11-16' })?.transcript).toEqual(
      [],
    );

    const note = await uc.additions.addNote(CHATGPT, {
      courseOfferingId: MON,
      title: '連絡',
      text: '来週の授業はオンライン',
      lectureDate: '2026-11-16',
    });
    expect(note.addition.stored.lectureId).toBe(stored.lectureId);
    expect(
      uc.context.lecture({ courseOfferingId: MON, date: '2026-11-16' })?.notes.map((n) => n.kind),
    ).toEqual(['summary', 'note']);
  });
});

describe('safety', () => {
  it('limits writes per client', async () => {
    const { uc } = await setup();
    for (let i = 0; i < 30; i++)
      await uc.additions.addTask(CHATGPT, { courseOfferingId: MON, title: `やること${i}` });
    await expect(
      uc.additions.addTask(CHATGPT, { courseOfferingId: MON, title: 'もう1つ' }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    // Another client has its own budget.
    await expect(
      uc.additions.addTask(CLAUDE, { courseOfferingId: MON, title: '別のクライアント' }),
    ).resolves.toMatchObject({ status: 'created' });
  });

  it('rejects unknown courses and unreadable timestamps', async () => {
    const { uc } = await setup();
    await expect(
      uc.additions.addDeadline(
        CHATGPT,
        deadline({ courseOfferingId: 'courseOffering:00000000-0000-5000-8000-000000000000' }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      uc.additions.addDeadline(CHATGPT, deadline({ recordingTimestamp: 'あとで' })),
    ).rejects.toThrow(/HH:MM:SS/);
  });
});

describe('registrations from a chat (via chat)', () => {
  it('stores the student’s own statement as 「チャットで登録」 with its own authority', async () => {
    const { uc } = await setup();
    const res = await uc.additions.addDeadline(CHATGPT, {
      courseOfferingId: MON,
      title: '中間レポート',
      dueAt: '2026-11-20T17:00:00+09:00',
      kind: 'report',
      evidence: '中間レポートの締切11/20って登録しといて',
    });
    expect(res.addition).toMatchObject({
      via: 'chat',
      label: 'チャットで登録',
      source: 'ChatGPTとの会話',
      status: 'unconfirmed',
    });
    const [fact] = uc.resolver.facts.getMany(res.audit.factIds);
    expect(fact?.origin).toBe('extracted');
    const ref = uc.sync.stores.sourceRefs.get(fact?.sourceReferenceId ?? '');
    expect(ref).toMatchObject({ sourceSystem: 'ChatGPTとの会話', authority: 'student-statement' });
    expect(ref?.location).toBeUndefined();

    const item = uc.context.week().deadlines.find((d) => d.title === '中間レポート');
    expect(item?.recorded).toMatchObject({ label: 'チャットで登録', via: 'chat' });
    expect(item?.summary).toMatch(/^【チャットで登録】/);
    expect(item?.summary).toContain('（チャットで登録）');
    expect(item?.summary).not.toContain('録音');
    const created = uc.context
      .week()
      .changes.find((c) => c.entityId === res.addition.stored.assignmentId);
    expect(created?.summary).toMatch(/^チャットで登録: 課題「中間レポート」/);
  });

  it('never overrides LiveCampusU: a different date told in a chat opens a conflict', async () => {
    const { uc } = await setup();
    const before = uc.sync.stores.entities.get(LCU_REPORT);
    const res = await uc.additions.addDeadline(CHATGPT, {
      courseOfferingId: MON,
      title: 'レポート課題2',
      dueAt: '2026-11-30T23:59:00+09:00',
      kind: 'report',
      evidence: 'レポート課題2は30日までだったはず',
    });
    expect(res.addition.attachedTo?.id).toBe(LCU_REPORT);
    expect(res.addition.conflicts).toHaveLength(1);
    expect(uc.resolver.resolve(LCU_REPORT, 'assignment_due').status).toBe('conflict');
    // LiveCampusU's own entity is untouched.
    expect(uc.sync.stores.entities.get(LCU_REPORT)).toEqual(before);
  });

  it('defaults: recording with a timestamp, chat without; old rows read as recording', async () => {
    const { uc } = await setup();
    const heard = await uc.additions.addTask(CHATGPT, {
      courseOfferingId: MON,
      title: '教科書2章',
      recordingTimestamp: '00:10:00',
    });
    expect(heard.addition).toMatchObject({ via: 'recording', source: 'ChatGPT Record' });
    const told = await uc.additions.addTask(CLAUDE, { courseOfferingId: MON, title: '過去問' });
    expect(told.addition).toMatchObject({ via: 'chat', source: 'Claudeとの会話' });
    const row = uc.additions.store.get(told.addition.id);
    if (!row) throw new Error('missing');
    const { via: _drop, ...data } = row.data;
    expect(uc.additions.view({ ...row, data }).via).toBe('recording');
  });

  it('personal deadlines, to-dos and notes need no course', async () => {
    const { uc } = await setup();
    const d = await uc.additions.addDeadline(CHATGPT, {
      title: '奨学金の継続手続き',
      dueAt: '11月19日17時',
      kind: 'assignment',
      evidence: '奨学金の継続手続きが19日の17時まで',
    });
    expect(d.addition.course).toBeUndefined();
    expect(d.addition.dueAt).toBe('2026-11-19T08:00:00.000Z');
    const t = await uc.additions.addTask(CLAUDE, { title: 'TOEICの単語を30分' });
    const n = await uc.additions.addNote(CHATGPT, { text: '研究室見学は12月第1週に申し込む' });

    expect(uc.context.today().deadlines.map((x) => x.title)).toContain('奨学金の継続手続き');
    const task = uc.tasks.get(t.addition.stored.taskId as string);
    expect(task?.courseOfferingId).toBeUndefined();
    expect(
      uc.context.today().tasks.find((x) => x.title === 'TOEICの単語を30分')?.recorded,
    ).toMatchObject({
      label: 'チャットで登録',
    });
    const notes = uc.additions.notes({ personal: true });
    expect(notes.notes.map((x) => x.additionId)).toEqual([n.addition.id]);
    expect(notes.notes[0]).toMatchObject({ via: 'chat', course: undefined, kind: 'note' });
    const hits = await uc.search.search('研究室見学');
    expect(hits.hits.map((h) => h.id)).toContain(n.addition.stored.documentId);

    // 次回 needs a course to be resolved.
    await expect(
      uc.additions.addDeadline(CHATGPT, {
        title: '何かの提出',
        dueAt: '次回',
        kind: 'assignment',
        evidence: '次回までに',
      }),
    ).rejects.toThrow(/needs a course/);
    // The owner can still confirm a personal to-do (it becomes their own).
    await uc.additions.confirm(t.addition.id);
    expect(uc.tasks.get(t.addition.stored.taskId as string)?.origin).toBe('user');
  });
});
