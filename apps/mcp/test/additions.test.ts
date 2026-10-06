import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { stableId } from '@unicontext/canonical-model';
import { createFakeConnector } from '../../../packages/connector-sdk/src/index.js';
import { createUniContext, type UniContext } from '@unicontext/context-engine';
import { ManualClock } from '@unicontext/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMcpServer,
  ProposalStore,
  ATTENDANCE_INSTRUCTION_JA,
  EXTERNAL_SIGNAL_INSTRUCTION_EN,
  EXTERNAL_SIGNAL_INSTRUCTION_JA,
  RECORDING_INSTRUCTION_EN,
  RECORDING_INSTRUCTION_JA,
  REMOTE_SERVER_INSTRUCTIONS,
  REMOTE_WRITE_SERVER_INSTRUCTIONS,
  type McpDeps,
  type ToolCallEvent,
} from '../src/index.js';

/* The record tools over the in-memory MCP transport, on the local and the remote surface. */

const WRITE_TOOL_NAMES = [
  'ingest_lecture',
  'record_lecture',
  'add_deadline',
  'add_note',
  'add_task',
  'set_course_condition',
  'add_session_rule',
  'list_my_additions',
  'retract_addition',
];
const MON = stableId('courseOffering', 'livecampusu', 'C-MON');
const LCU_REPORT = stableId('assignment', 'livecampusu', 'A-1');

let uc: UniContext;
let tmp: string;
let proposals: ProposalStore;
const events: ToolCallEvent[] = [];

async function connect(extra: Partial<McpDeps> = {}, name = 'chatgpt-test'): Promise<Client> {
  const server = createMcpServer({
    uc,
    proposals,
    onToolCall: (e) => void events.push(e),
    ...extra,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name, version: '0.0.0' });
  await client.connect(b);
  return client;
}

type Structured = Record<string, unknown> & {
  status: string;
  addition: Record<string, unknown> & { id: string; stored: Record<string, unknown> };
  answerHint: string;
};

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

beforeAll(async () => {
  const clock = new ManualClock('2026-11-10T00:00:00.000Z');
  uc = createUniContext({ profile: 'shizuoka-university', clock });
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
      ],
      assignments: [
        { id: 'A-1', courseId: 'C-MON', title: 'レポート課題2', due: '2026-11-27T23:59:00+09:00' },
      ],
    },
  });
  uc.sync.register({
    sourceId: 'livecampusu',
    adapter: lcu.adapter,
    normalizer: lcu.normalizer,
    metadata: lcu.metadata,
  });
  expect((await uc.sync.sync('livecampusu')).ok).toBe(true);
  clock.set('2026-11-16T03:00:00.000Z');
  tmp = mkdtempSync(path.join(tmpdir(), 'uc-mcp-additions-'));
  proposals = new ProposalStore(path.join(tmp, 'proposals'), { clock });
});

afterAll(async () => {
  await uc.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('record tools: registration', () => {
  it('local: write tools with honest annotations and output schemas', async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools;
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of WRITE_TOOL_NAMES) {
      const t = byName.get(name);
      expect(t, name).toBeDefined();
      expect(t?.annotations?.readOnlyHint, name).toBe(false);
      expect(t?.annotations?.destructiveHint, name).toBe(name === 'retract_addition');
      expect(t?.annotations?.openWorldHint, name).toBe(false);
      expect(t?.outputSchema, name).toBeDefined();
    }
    // Read tools stay read-only.
    expect(byName.get('get_today')?.annotations?.readOnlyHint).toBe(true);
  });

  it('remote without unicontext.write: no write tools at all', async () => {
    const client = await connect({ surface: 'remote', client: { id: 'ro-client' } });
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of WRITE_TOOL_NAMES) expect(names).not.toContain(name);
    expect(names).toContain('get_deadlines');
    expect(client.getInstructions()).toBe(REMOTE_SERVER_INSTRUCTIONS);
    const res = await call(client, 'add_deadline', {});
    expect(res.isError).toBe(true);
  });

  it('remote with unicontext.write: record tools, but never the propose-only tools', async () => {
    const client = await connect({
      surface: 'remote',
      allowWrite: true,
      client: { id: 'rw-client', name: 'ChatGPT' },
    });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(WRITE_TOOL_NAMES));
    expect(names).not.toContain('correct_fact');
    expect(names).not.toContain('propose_pace_slot');
    expect(client.getInstructions()).toBe(REMOTE_WRITE_SERVER_INSTRUCTIONS);
    // ChatGPT's connector safety scan flags such wording (docs/research/chatgpt-connector.md §4)
    for (const t of (await client.listTools()).tools)
      expect(`${t.title ?? ''} ${t.description ?? ''}`, t.name).not.toMatch(
        /personal information|no authentication|password|個人情報|propose/i,
      );
  });
});

describe('record tools: calls', () => {
  const chatgpt = {
    surface: 'remote' as const,
    allowWrite: true,
    client: { id: 'oauth-chatgpt', name: 'ChatGPT' },
  };

  it('add_deadline resolves 次回, echoes what was stored and audits ids only', async () => {
    const client = await connect(chatgpt);
    events.length = 0;
    const res = await call(client, 'add_deadline', {
      course: 'ソフトウェア',
      title: '課題3 クラス図',
      dueAt: '次回',
      kind: 'assignment',
      evidence: '次回までにクラス図を描いてきてください',
      recordingTimestamp: '00:42:18',
      lectureDate: '2026-11-16',
      idempotencyKey: 'rec-1-deadline-1',
    });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    const out = res.structuredContent as Structured;
    expect(out.status).toBe('created');
    expect(out.addition).toMatchObject({
      tool: 'add_deadline',
      kind: 'assignment',
      status: 'unconfirmed',
      dueAt: '2026-11-25T01:20:00.000Z',
      dueText: '11/25 10:20',
      source: 'ChatGPT Record',
      recordingTimestamp: '00:42:18',
      course: { id: MON, title: 'ソフトウェア工学' },
    });
    expect(out.answerHint).toContain('11/25 10:20');
    expect(out.answerHint).toContain('大学のシステムには何も送っていません');

    const e = events.find((x) => x.tool === 'add_deadline');
    expect(e).toMatchObject({
      ok: true,
      write: { status: 'created', additionId: out.addition.id },
    });
    expect(e?.write?.entityIds.length).toBeGreaterThan(0);
    expect(JSON.stringify(e)).not.toContain('クラス図');

    // Retrying the same call is a replay, not a second deadline.
    const again = await call(client, 'add_deadline', {
      course: 'ソフトウェア',
      title: '課題3 クラス図',
      dueAt: '次回',
      kind: 'assignment',
      evidence: '次回までにクラス図を描いてきてください',
      lectureDate: '2026-11-16',
      idempotencyKey: 'rec-1-deadline-1',
    });
    expect((again.structuredContent as Structured).status).toBe('replayed');

    // Shown on Today's deadlines as 「録音から」.
    const today = await call(client, 'get_deadlines', {});
    expect(JSON.stringify(today.structuredContent)).toContain('録音から');
  });

  it('add_deadline that disagrees with LiveCampusU reports the conflict', async () => {
    const client = await connect(chatgpt);
    const res = await call(client, 'add_deadline', {
      course: 'ソフトウェア工学',
      title: 'レポート課題2',
      dueAt: '2026-12-04',
      kind: 'report',
      evidence: 'レポート2の締切は12月4日にします',
    });
    const out = res.structuredContent as Structured;
    expect(out.addition.attachedTo).toMatchObject({ id: LCU_REPORT });
    expect(out.addition.conflicts).toHaveLength(1);
    expect(out.answerHint).toContain('食い違っています');
    const conflicts = await call(client, 'get_conflicts', {});
    expect(JSON.stringify(conflicts.structuredContent)).toContain('レポート課題2');
  });

  it('record_lecture, add_note, add_task; list and retract only own additions', async () => {
    const client = await connect(chatgpt);
    const lecture = await call(client, 'record_lecture', {
      course: 'ソフトウェア工学',
      date: '2026-11-16',
      summary: 'クラス図と多重度',
      keyPoints: ['クラス図'],
      segments: [{ at: '00:42:18', text: '次回までにクラス図を描いてきてください' }],
    });
    expect((lecture.structuredContent as Structured).addition.stored).toMatchObject({
      segmentCount: 1,
    });
    const note = await call(client, 'add_note', {
      course: 'ソフトウェア工学',
      text: '来週はオンライン',
      lectureDate: '2026-11-16',
    });
    expect((note.structuredContent as Structured).status).toBe('created');
    const task = await call(client, 'add_task', {
      course: 'ソフトウェア工学',
      title: 'JDKを入れる',
    });
    const taskOut = task.structuredContent as Structured;
    expect(taskOut.addition.kind).toBe('task');

    const mine = await call(client, 'list_my_additions', {});
    const list = (mine.structuredContent as { additions: { id: string }[] }).additions;
    expect(list.map((a) => a.id)).toContain(taskOut.addition.id);

    const other = await connect({
      surface: 'remote',
      allowWrite: true,
      client: { id: 'oauth-claude', name: 'claude.ai' },
    });
    const otherList = await call(other, 'list_my_additions', {});
    expect((otherList.structuredContent as { additions: unknown[] }).additions).toEqual([]);
    const denied = await call(other, 'retract_addition', { additionId: taskOut.addition.id });
    expect(denied.isError).toBe(true);

    const retracted = await call(client, 'retract_addition', { additionId: taskOut.addition.id });
    expect((retracted.structuredContent as Structured).status).toBe('retracted');
    expect(uc.tasks.get(taskOut.addition.stored.taskId as string)?.status).toBe('cancelled');
  });

  it('set_course_condition and add_session_rule store the group and its schedule', async () => {
    const client = await connect(chatgpt);
    const cond = await call(client, 'set_course_condition', {
      course: 'ソフトウェア工学',
      value: 'B班',
      evidence: '演習はB班です',
    });
    const condOut = cond.structuredContent as Structured;
    expect(condOut.status).toBe('created');
    expect(condOut.addition).toMatchObject({ kind: 'condition', tool: 'set_course_condition' });
    expect(condOut.addition.stored).toMatchObject({ value: 'B' });
    const rule = await call(client, 'add_session_rule', {
      course: 'ソフトウェア工学',
      sessions: [
        { date: '2026-11-16', group: 'A', room: '演習室1' },
        { date: '2026-11-20', group: 'B', room: '演習室2', periods: [2] },
      ],
      evidence: '11/16(月) A 演習室1 / 11/20(金) B 演習室2',
      sourceDocument: '演習スケジュール.pdf',
    });
    expect((rule.structuredContent as Structured).addition.kind).toBe('session_rule');
    // Monday is group A's: not the student's class today; Friday the 20th is.
    const today = uc.context.today();
    expect(today.classes.some((c) => c.course.title === 'ソフトウェア工学')).toBe(false);
    expect(today.notAttending?.[0]?.effectiveSchedule.reason).toContain('Aグループの実施日');
    const fri = uc.context
      .classesOn('2026-11-20')
      .filter((c) => c.course.title === 'ソフトウェア工学');
    expect(
      fri.map((c) => [c.period, c.effectiveSchedule.status, c.effectiveSchedule.room]),
    ).toEqual([[2, 'attending', '演習室2']]);
    const bad = await call(client, 'set_course_condition', {
      course: 'ソフトウェア工学',
      value: '前半',
      evidence: 'x',
    });
    expect(bad.isError).toBe(true);
    for (const r of [rule, cond])
      await call(client, 'retract_addition', {
        additionId: (r.structuredContent as Structured).addition.id,
      });
    expect(uc.context.today().classes.some((c) => c.course.title === 'ソフトウェア工学')).toBe(
      true,
    );
  });

  it('set_course_condition enrollment=not_taking hides a course the system still lists', async () => {
    const client = await connect(chatgpt);
    const listed = () =>
      uc.context.today().classes.some((c) => c.course.title === 'ソフトウェア工学');
    expect(listed()).toBe(true);
    const res = await call(client, 'set_course_condition', {
      course: 'ソフトウェア工学',
      condition: 'enrollment',
      value: 'not_taking',
      evidence: '本人: ソフトウェア工学は結局履修拒否された',
    });
    const out = res.structuredContent as Structured;
    expect(out.status).toBe('created');
    expect(out.addition).toMatchObject({
      kind: 'condition',
      status: 'unconfirmed',
      title: 'ソフトウェア工学: 履修していない（本人）',
    });
    expect(out.addition.stored).toMatchObject({
      predicate: 'condition:enrollment',
      value: 'not_taking',
    });
    expect(listed()).toBe(false);
    const view = await call(client, 'get_today', {});
    expect(JSON.stringify(view.structuredContent)).toContain(
      '学務では履修中、本人は履修していないと登録',
    );
    const bad = await call(client, 'set_course_condition', {
      course: 'ソフトウェア工学',
      condition: 'enrollment',
      value: 'B',
      evidence: 'x',
    });
    expect(bad.isError).toBe(true);
    await call(client, 'retract_addition', { additionId: out.addition.id });
    expect(listed()).toBe(true);
  });

  it('local clients are identified by their MCP client name', async () => {
    const client = await connect({}, 'Claude Desktop');
    const res = await call(client, 'add_task', { course: 'ソフトウェア工学', title: '復習する' });
    expect((res.structuredContent as Structured).addition).toMatchObject({
      client: { id: 'local:Claude Desktop', name: 'Claude Desktop' },
      source: 'Claudeとの会話',
      via: 'chat',
    });
    const heard = await call(client, 'add_task', {
      course: 'ソフトウェア工学',
      title: '教科書3章を読む',
      via: 'recording',
    });
    expect((heard.structuredContent as Structured).addition).toMatchObject({
      source: 'Claude Desktop',
      via: 'recording',
    });
  });

  it('rejects oversized input', async () => {
    const client = await connect(chatgpt);
    const res = await call(client, 'add_note', {
      course: 'ソフトウェア工学',
      text: 'あ'.repeat(20_001),
    });
    expect(res.isError).toBe(true);
  });
});

describe('registrations from any chat are shared with every client and session', () => {
  type Env = { data: Record<string, unknown>; citations: { label: string }[] };
  type Marked = {
    title: string;
    summary?: string;
    course?: { title: string };
    recorded?: { label: string; via: string; source: string };
  };

  it('a deadline, a to-do and a note told in one ChatGPT chat are seen by another client', async () => {
    const writer = await connect({
      surface: 'remote',
      allowWrite: true,
      client: { id: 'oauth-chatgpt-shared', name: 'ChatGPT' },
    });
    const course = await call(writer, 'add_deadline', {
      course: 'ソフトウェア工学',
      title: '中間レポート',
      dueAt: '2026-11-20T17:00:00+09:00',
      kind: 'report',
      evidence: '中間レポートの締切11/20の17時って登録しといて',
    });
    expect(course.isError, JSON.stringify(course.content)).toBeFalsy();
    const added = (course.structuredContent as Structured).addition;
    expect(added).toMatchObject({
      via: 'chat',
      label: 'チャットで登録',
      source: 'ChatGPTとの会話',
    });
    expect((course.structuredContent as Structured).answerHint).toContain('他の会話');
    expect((course.structuredContent as Structured).answerHint).not.toContain('録音');
    const personal = await call(writer, 'add_deadline', {
      title: '奨学金の継続手続き',
      dueAt: '11月19日17時',
      kind: 'assignment',
      evidence: '奨学金の継続手続きが19日の17時まで',
    });
    expect(personal.isError, JSON.stringify(personal.content)).toBeFalsy();
    expect((personal.structuredContent as Structured).addition).not.toHaveProperty('course');
    const todo = await call(writer, 'add_task', {
      title: 'TOEICの単語を30分',
      evidence: '毎日TOEICの単語をやることにする',
    });
    expect(todo.isError, JSON.stringify(todo.content)).toBeFalsy();
    const note = await call(writer, 'add_note', {
      title: '就活メモ',
      text: 'ESは12月に3社出す。締切は各社のマイページで確認。',
    });
    expect(note.isError, JSON.stringify(note.content)).toBeFalsy();

    // A different client (claude.ai, read-only grant) in another session.
    const reader = await connect({
      surface: 'remote',
      client: { id: 'claude-ro', name: 'claude.ai' },
    });
    const read = async (name: string, args: Record<string, unknown> = {}): Promise<Env> => {
      const r = await call(reader, name, args);
      expect(r.isError, `${name}: ${JSON.stringify(r.content)}`).toBeFalsy();
      return r.structuredContent as unknown as Env;
    };
    const titles = (list: unknown): string[] => (list as Marked[]).map((x) => x.title);
    const find = (list: unknown, title: string): Marked | undefined =>
      (list as Marked[]).find((x) => x.title === title);

    const week = await read('get_week');
    expect(titles(week.data.deadlines)).toEqual(
      expect.arrayContaining(['中間レポート', '奨学金の継続手続き']),
    );
    const report = find(week.data.deadlines, '中間レポート');
    expect(report?.recorded).toMatchObject({ label: 'チャットで登録', via: 'chat' });
    expect(report?.summary).toMatch(/^【チャットで登録】ソフトウェア工学: 中間レポート/);
    expect(report?.summary).not.toContain('録音');
    expect(find(week.data.deadlines, '奨学金の継続手続き')?.course).toBeUndefined();

    const today = await read('get_today');
    expect(titles(today.data.deadlines)).toEqual(
      expect.arrayContaining(['中間レポート', '奨学金の継続手続き']),
    );
    expect(titles(today.data.tasks)).toContain('TOEICの単語を30分');

    const deadlines = await read('get_deadlines');
    expect(titles(deadlines.data.upcoming)).toEqual(
      expect.arrayContaining(['中間レポート', '奨学金の継続手続き']),
    );
    expect(deadlines.citations.map((c) => c.label).join(' ')).toContain('ChatGPTとの会話');

    const tasks = await read('get_tasks');
    const toeic = find(tasks.data.tasks, 'TOEICの単語を30分');
    expect(toeic?.course).toBeUndefined();
    expect(toeic?.recorded).toMatchObject({
      label: 'チャットで登録',
      source: 'ChatGPTとの会話',
    });

    const courseView = await read('get_course', { courseOfferingId: 'ソフトウェア工学' });
    expect(titles(courseView.data.deadlines)).toContain('中間レポート');
    expect(titles(courseView.data.deadlines)).not.toContain('奨学金の継続手続き');

    const notes = await read('get_notes');
    const memo = find(notes.data.notes, '就活メモ') as
      (Marked & { via: string; label: string; id: string }) | undefined;
    expect(memo).toMatchObject({ via: 'chat', label: 'チャットで登録' });
    expect(memo?.course).toBeUndefined();
    expect(titles((await read('get_notes', { personal: true })).data.notes)).toContain('就活メモ');
    expect(titles((await read('get_notes', { query: 'マイページ' })).data.notes)).toEqual([
      '就活メモ',
    ]);
    expect(
      titles((await read('get_notes', { course: 'ソフトウェア工学' })).data.notes),
    ).not.toContain('就活メモ');
    const one = await read('get_notes', { id: memo?.id });
    expect((one.data.notes as { text: string }[])[0]?.text).toContain('マイページ');
    const hits = await read('search', { query: 'マイページ' });
    expect(JSON.stringify(hits.data)).toContain('就活メモ');
  });

  it('get_notes is a read tool on every surface', async () => {
    const reader = await connect({ surface: 'remote', client: { id: 'ro-notes' } });
    const t = (await reader.listTools()).tools.find((x) => x.name === 'get_notes');
    expect(t?.annotations?.readOnlyHint).toBe(true);
  });
});

describe('ingest_lecture: one call for a whole lecture recording', () => {
  const writer = (id: string) => ({
    surface: 'remote' as const,
    allowWrite: true,
    client: { id, name: 'ChatGPT' },
  });
  type Ingested = {
    outcome: string;
    ingestionId: string;
    course: { id: string; title: string };
    lectureDate: string;
    period?: number;
    counts: Record<string, number>;
    lecture: Record<string, unknown> & { status: string; additionId?: string };
    items: (Record<string, unknown> & {
      type: string;
      status: string;
      title: string;
      dueText?: string;
      error?: { code: string; message: string };
      conflicts?: unknown[];
    })[];
    answerHint: string;
  };
  const transcript = {
    lectureDate: '2026-11-09',
    summary: 'シーケンス図とメッセージの種類。同期と非同期の違い。',
    keyPoints: ['シーケンス図', '同期メッセージ'],
    segments: [{ at: '01:02:03', text: '来週の金曜までにシーケンス図を1枚出してください' }],
    recordingRef: 'chatgpt-record:conv-ingest-1',
    deadlines: [
      {
        key: 'sequence-diagram',
        title: 'シーケンス図の提出',
        dueAt: '来週の金曜',
        kind: 'assignment',
        evidence: '来週の金曜までにシーケンス図を1枚出してください',
        recordingTimestamp: '01:02:03',
      },
      {
        title: 'レポート課題2',
        dueAt: '12月11日',
        kind: 'report',
        evidence: 'レポート課題2は12月11日まで延ばします',
        recordingTimestamp: '01:05:00',
      },
    ],
    tasks: [
      {
        title: 'astahをインストールする',
        evidence: 'astahを入れておいてください',
        recordingTimestamp: '01:06:00',
      },
    ],
    notes: [
      {
        title: '出席の取り方',
        text: '出席は授業の最後に出す小レポートで取る',
        evidence: '出席は最後の小レポートで取ります',
        recordingTimestamp: '00:01:30',
      },
    ],
  };

  it('is a write tool with honest hints, an assertive description and the documented schema', async () => {
    const client = await connect(writer('oauth-ingest-meta'));
    const tools = new Map((await client.listTools()).tools.map((x) => [x.name, x]));
    const t = tools.get('ingest_lecture');
    expect(t?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(t?.outputSchema).toBeDefined();
    expect(t?.description).toContain(
      '講義の録音・文字起こし（ChatGPT Record など）が入力として与えられ、科目と日付を合理的に特定できる場合は、ユーザーから保存依頼がなくても ingest_lecture を呼ぶ',
    );
    expect(t?.description).toMatch(/ユーザーに確かめない/);
    expect(t?.description).toMatch(/聞き直さない/);
    expect(t?.description).toMatch(/文字起こしをそのまま入れない/);
    expect(t?.description).toMatch(/他の学生どうしの会話は入れない/);
    expect(t?.description).toMatch(/次の授業があるというだけでは締切にしない/);
    expect(t?.description).toMatch(/call ingest_lecture even if the user did not ask/);
    expect(t?.description).not.toMatch(/\bmay\b|consider/i);
    const props = Object.keys((t?.inputSchema as { properties: object }).properties);
    expect(props).toEqual(
      expect.arrayContaining([
        'course',
        'lectureDate',
        'period',
        'summary',
        'keyPoints',
        'segments',
        'recordingRef',
        'source',
        'deadlines',
        'tasks',
        'notes',
      ]),
    );
    expect((t?.inputSchema as { required?: string[] }).required).toEqual(['summary']);
    // The single tools point recordings at ingest_lecture; chat registrations keep their wording.
    for (const name of ['record_lecture', 'add_deadline', 'add_task', 'add_note'])
      expect(tools.get(name)?.description, name).toContain('ingest_lecture');
    expect(tools.get('add_deadline')?.description).toContain(
      'ユーザーが頼んでいなくても、UniContextにまだない締切が話に出たら登録を提案する',
    );
    expect(client.getInstructions()).toContain(RECORDING_INSTRUCTION_JA);
    expect(client.getInstructions()).toContain(RECORDING_INSTRUCTION_EN);
    const local = await connect();
    expect(local.getInstructions()).toContain(RECORDING_INSTRUCTION_JA);
    // Mail / calendar findings and attendance are in the server-level instructions too.
    for (const instructions of [client.getInstructions(), local.getInstructions()]) {
      expect(instructions).toContain(EXTERNAL_SIGNAL_INSTRUCTION_JA);
      expect(instructions).toContain(ATTENDANCE_INSTRUCTION_JA);
    }
    expect(local.getInstructions()).toContain(EXTERNAL_SIGNAL_INSTRUCTION_EN);
    expect(EXTERNAL_SIGNAL_INSTRUCTION_JA).toContain('ingest_external_signal');
    expect(EXTERNAL_SIGNAL_INSTRUCTION_JA).toContain('聞かない');
    expect(EXTERNAL_SIGNAL_INSTRUCTION_JA).toContain('Gmail（本人のメール）');
    expect(EXTERNAL_SIGNAL_INSTRUCTION_JA).toContain('Googleカレンダー');
    expect(EXTERNAL_SIGNAL_INSTRUCTION_JA).toContain('duplicate');
  });

  it('rejects input outside the schema before writing anything', async () => {
    const client = await connect(writer('oauth-ingest-schema'));
    const tooMany = await call(client, 'ingest_lecture', {
      ...transcript,
      deadlines: Array.from({ length: 11 }, (_, i) => ({
        title: `d${i}`,
        dueAt: '次回',
        kind: 'prep',
        evidence: 'x',
      })),
    });
    expect(tooMany.isError).toBe(true);
    const noSummary = await call(client, 'ingest_lecture', { ...transcript, summary: '' });
    expect(noSummary.isError).toBe(true);
    const badKey = await call(client, 'ingest_lecture', {
      ...transcript,
      tasks: [{ key: 'a b', title: 'x', evidence: 'x' }],
    });
    expect(badKey.isError).toBe(true);
    expect(uc.additions.listFor({ id: 'oauth-ingest-schema' })).toEqual([]);
  });

  it('stores everything, reports per part and conflicts, and other clients read it', async () => {
    const client = await connect(writer('oauth-ingest-e2e'));
    events.length = 0;
    // No course: Monday 2限 on 11-16 is ソフトウェア工学.
    const res = await call(client, 'ingest_lecture', transcript);
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    const out = res.structuredContent as unknown as Ingested;
    expect(out).toMatchObject({
      outcome: 'stored',
      course: { id: MON, title: 'ソフトウェア工学' },
      lectureDate: '2026-11-09',
      period: 2,
      counts: { created: 5, updated: 0, unchanged: 0, failed: 0 },
      lecture: { type: 'lecture', status: 'created' },
    });
    expect(out.ingestionId).toMatch(/^ingestion:/);
    expect(out.items.map((x) => [x.type, x.status])).toEqual([
      ['deadline', 'created'],
      ['deadline', 'created'],
      ['task', 'created'],
      ['note', 'created'],
    ]);
    expect(out.items[0]).toMatchObject({ key: 'sequence-diagram', dueText: '11/20 23:59' });
    expect(out.items[1]).toMatchObject({ attachedTo: { id: LCU_REPORT } });
    expect(out.items[1]?.conflicts).toHaveLength(1);
    expect(out.answerHint).toContain('講義「ソフトウェア工学 11/9 2限」の記録を保存しました');
    expect(out.answerHint).toContain('締切2件・やること1件・メモ1件');
    expect(out.answerHint).toContain('11/20 23:59');
    expect(out.answerHint).toContain('食い違う');
    // Audit: one event, ids only.
    const e = events.find((x) => x.tool === 'ingest_lecture');
    expect(e).toMatchObject({
      ok: true,
      write: { status: 'stored', additionId: out.lecture.additionId },
    });
    expect(JSON.stringify(e)).not.toContain('シーケンス図');

    // list_my_additions by ingestion.
    const mine = await call(client, 'list_my_additions', { ingestionId: out.ingestionId });
    const listed = (mine.structuredContent as { additions: { ingestionId: string }[] }).additions;
    expect(listed).toHaveLength(5);
    expect(listed.every((a) => a.ingestionId === out.ingestionId)).toBe(true);

    // A read-only claude.ai session sees all of it.
    const reader = await connect({ surface: 'remote', client: { id: 'claude-ro-ingest' } });
    const read = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
      const r = await call(reader, name, args);
      expect(r.isError, `${name}: ${JSON.stringify(r.content)}`).toBeFalsy();
      return JSON.stringify(r.structuredContent);
    };
    expect(await read('get_deadlines')).toContain('シーケンス図の提出');
    expect(await read('get_tasks')).toContain('astahをインストールする');
    expect(await read('get_notes', { course: 'ソフトウェア工学' })).toContain('出席の取り方');
    expect(await read('get_conflicts')).toContain('レポート課題2');
    const review = await read('review_class', { courseOfferingId: MON, date: '2026-11-09' });
    expect(review).toContain('同期メッセージ');
    expect(review).toContain('01:02:03');

    // The same call again: nothing new.
    const again = await call(client, 'ingest_lecture', transcript);
    const out2 = again.structuredContent as unknown as Ingested;
    expect(out2.outcome).toBe('unchanged');
    expect(out2.counts).toMatchObject({ created: 0, updated: 0, unchanged: 5, failed: 0 });
    expect(out2.answerHint).toContain('二重には登録していません');
    expect(uc.additions.listFor({ id: 'oauth-ingest-e2e' })).toHaveLength(5);
  });

  it('a failing part is reported and the rest is stored', async () => {
    const client = await connect(writer('oauth-ingest-partial'));
    const res = await call(client, 'ingest_lecture', {
      course: 'ソフトウェア工学',
      lectureDate: '2026-11-02',
      summary: '状態遷移図',
      deadlines: [
        {
          title: '状態遷移図の課題',
          dueAt: 'いつか',
          kind: 'assignment',
          evidence: 'いつか出して',
        },
      ],
      tasks: [{ title: '状態遷移図を見直す', evidence: '見直しておいてください' }],
    });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as unknown as Ingested;
    expect(out.outcome).toBe('partial');
    expect(out.counts).toMatchObject({ created: 2, failed: 1 });
    expect(out.items[0]).toMatchObject({ status: 'failed', error: { code: 'validation' } });
    expect(out.items[1]).toMatchObject({ status: 'created' });
    expect(out.answerHint).toContain('保存できなかった項目: 締切「状態遷移図の課題」');
  });

  it('is not registered without unicontext.write', async () => {
    const client = await connect({ surface: 'remote', client: { id: 'ro-ingest' } });
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('ingest_lecture');
    expect((await call(client, 'ingest_lecture', transcript)).isError).toBe(true);
  });
});
