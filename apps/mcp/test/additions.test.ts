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
  REMOTE_SERVER_INSTRUCTIONS,
  REMOTE_WRITE_SERVER_INSTRUCTIONS,
  type McpDeps,
  type ToolCallEvent,
} from '../src/index.js';

/* The record tools over the in-memory MCP transport, on the local and the remote surface. */

const WRITE_TOOL_NAMES = [
  'record_lecture',
  'add_deadline',
  'add_note',
  'add_task',
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

  it('local clients are identified by their MCP client name', async () => {
    const client = await connect({}, 'Claude Desktop');
    const res = await call(client, 'add_task', { course: 'ソフトウェア工学', title: '復習する' });
    expect((res.structuredContent as Structured).addition).toMatchObject({
      client: { id: 'local:Claude Desktop', name: 'Claude Desktop' },
      source: 'Claude Desktop',
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
