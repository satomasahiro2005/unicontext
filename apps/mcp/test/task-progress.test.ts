import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createUniContext, type UniContext } from '@unicontext/context-engine';
import { ManualClock } from '@unicontext/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeConnector } from '../../../packages/connector-sdk/src/index.js';
import {
  createMcpServer,
  type McpDeps,
  ProposalStore,
  REMOTE_SERVER_INSTRUCTIONS,
  REMOTE_WRITE_SERVER_INSTRUCTIONS,
  SERVER_INSTRUCTIONS,
} from '../src/index.js';

/* record_task_progress over the in-memory MCP transport: local, and remote only with write. */

let uc: UniContext;
let tmp: string;
let proposals: ProposalStore;

async function connect(extra: Partial<McpDeps> = {}): Promise<Client> {
  const server = createMcpServer({ uc, proposals, ...extra });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'chatgpt-test', version: '0.0.0' });
  await client.connect(b);
  return client;
}

const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args });

const remoteWrite = {
  surface: 'remote' as const,
  allowWrite: true,
  client: { id: 'oauth-chatgpt', name: 'ChatGPT' },
};

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
  tmp = mkdtempSync(path.join(tmpdir(), 'uc-mcp-progress-'));
  proposals = new ProposalStore(path.join(tmp, 'proposals'), { clock });
});

afterAll(async () => {
  await uc.close();
  rmSync(tmp, { recursive: true, force: true });
});

const report = () => {
  const t = uc.tasks.list().find((x) => x.title === 'レポート課題2');
  if (!t) throw new Error('no task');
  return t;
};

describe('record_task_progress: registration', () => {
  it('is listed on the local surface as a write tool with an output schema', async () => {
    const client = await connect();
    const t = (await client.listTools()).tools.find((x) => x.name === 'record_task_progress');
    expect(t).toBeDefined();
    expect(t?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(t?.outputSchema).toBeDefined();
    expect(t?.description).toContain('聞き返さずに');
    expect(t?.description).toContain('推測');
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    expect(client.getInstructions()).toContain('record_task_progress');
  });

  it('is on the remote surface only with the write scope', async () => {
    const ro = await connect({ surface: 'remote', client: { id: 'ro-client' } });
    expect((await ro.listTools()).tools.map((t) => t.name)).not.toContain('record_task_progress');
    expect(ro.getInstructions()).toBe(REMOTE_SERVER_INSTRUCTIONS);
    expect(ro.getInstructions()).not.toContain('record_task_progress');
    expect((await call(ro, 'record_task_progress', { task: 'x', statement: 'y' })).isError).toBe(
      true,
    );

    const rw = await connect(remoteWrite);
    expect((await rw.listTools()).tools.map((t) => t.name)).toContain('record_task_progress');
    expect(rw.getInstructions()).toBe(REMOTE_WRITE_SERVER_INSTRUCTIONS);
    expect(rw.getInstructions()).toContain('record_task_progress');
    for (const t of (await rw.listTools()).tools)
      expect(`${t.title ?? ''} ${t.description ?? ''}`, t.name).not.toMatch(
        /personal information|no authentication|password|個人情報|propose/i,
      );
  });
});

describe('record_task_progress: calls', () => {
  it('records the student’s word by title and course, and retract restores the status', async () => {
    const client = await connect(remoteWrite);
    const before = report();
    expect(before.status).toBe('pending');
    const res = await call(client, 'record_task_progress', {
      task: 'レポート課題2',
      course: 'ソフトウェア',
      status: 'in_progress',
      doneSteps: ['課題文を開いて問題を確認する'],
      statement: 'レポート課題2、書き始めた',
    });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    const out = res.structuredContent as Record<string, unknown> & { steps: { done: boolean }[] };
    expect(out).toMatchObject({
      taskId: before.id,
      previousStatus: 'pending',
      status: 'in_progress',
      writeStatus: 'created',
    });
    expect(typeof out.additionId).toBe('string');
    expect(out.steps.some((s) => s.done)).toBe(true);
    expect(String(out.answerHint)).toContain('大学のシステムには何も送っていません');
    expect(report()).toMatchObject({ status: 'in_progress', statusSetBy: 'user' });

    // The same fact is what every other client sees through the read tools.
    const tasks = await call(client, 'get_tasks', { courseOfferingId: 'ソフトウェア' });
    expect(JSON.stringify(tasks.structuredContent)).toContain('in_progress');

    const done = await call(client, 'record_task_progress', {
      task: before.id,
      status: 'completed',
      statement: '終わった',
    });
    expect((done.structuredContent as { status: string }).status).toBe('completed');
    expect(report().status).toBe('completed');

    const undo1 = await call(client, 'retract_addition', {
      additionId: (done.structuredContent as { additionId: string }).additionId,
    });
    expect(undo1.isError).toBeFalsy();
    expect(report().status).toBe('in_progress');
    await call(client, 'retract_addition', { additionId: out.additionId });
    expect(report()).toMatchObject({ status: 'pending', statusSetBy: 'system' });
  });

  it('rejects submitted and an empty statement as validation errors', async () => {
    const client = await connect();
    const t = report();
    const submitted = await call(client, 'record_task_progress', {
      task: t.id,
      status: 'submitted',
      statement: '提出した',
    });
    expect(submitted.isError).toBe(true);
    const empty = await call(client, 'record_task_progress', {
      task: t.id,
      status: 'completed',
      statement: '',
    });
    expect(empty.isError).toBe(true);
    const unknownTask = await call(client, 'record_task_progress', {
      task: '存在しない課題',
      course: 'ソフトウェア',
      status: 'completed',
      statement: '終わった',
    });
    expect(unknownTask.isError).toBe(true);
    expect(report().status).toBe('pending');
  });
});
