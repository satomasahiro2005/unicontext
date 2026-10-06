import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { UniContext } from '@unicontext/context-engine';
import type { ManualClock } from '@unicontext/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNextActionScenario } from '../../../packages/context-engine/test/next-action-scenario.js';
import { createMcpServer, type McpEnvelope, ProposalStore } from '../src/index.js';

const TOOLS = ['get_next_action', 'get_student_state', 'get_attention_required', 'get_briefing'];

let uc: UniContext;
let clock: ManualClock;
let tmp: string;
const clients: Client[] = [];

async function connect(
  surface: 'local' | 'remote' = 'local',
  client?: { id: string; name?: string },
): Promise<Client> {
  const server = createMcpServer({
    uc,
    proposals: new ProposalStore(path.join(tmp, 'proposals'), { clock }),
    surface,
    ...(client ? { client } : {}),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: 'next-test', version: '0.0.0' });
  await c.connect(b);
  clients.push(c);
  return c;
}

async function call<T>(
  c: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpEnvelope<T>> {
  const res = await c.callTool({ name, arguments: args });
  const text = (res.content as { text: string }[])[0]?.text ?? '';
  expect(res.isError, text).not.toBe(true);
  return JSON.parse(text) as McpEnvelope<T>;
}

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'uc-next-'));
  const s = await createNextActionScenario();
  // The scenario is built from the context-engine sources; this package type-checks against dist.
  uc = s.uc as unknown as UniContext;
  clock = s.clock;
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  await uc.close();
  rmSync(tmp, { recursive: true, force: true });
});

type Action = { what: string; why: string; title: string; link?: { url: string } };

describe('next-action MCP tools', () => {
  it('are read-only on both surfaces, and the instructions route 何すればいい to get_next_action without interrupting other chats', async () => {
    for (const surface of ['local', 'remote'] as const) {
      const c = await connect(surface);
      const tools = (await c.listTools()).tools.filter((t) => TOOLS.includes(t.name));
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
      for (const t of tools) {
        expect(t.annotations?.readOnlyHint, t.name).toBe(true);
        expect(t.description, t.name).toMatch(/[ぁ-ん].* \/ [A-Za-z]/);
      }
      const instructions = c.getInstructions() ?? '';
      expect(instructions).toContain('get_next_action');
      expect(instructions).not.toContain('first reply');
      expect(instructions).not.toContain('会話の最初の返答');
      expect(instructions).toContain('nothingImportant');
    }
  });

  it('get_next_action answers 「何すればいい？」 with one startable step', async () => {
    const c = await connect();
    const env = await call<{ top: Action; next: Action[]; urgent: boolean; line: string }>(
      c,
      'get_next_action',
    );
    expect(env.data.top.what).toBe('Lesson 3: SQL演習: 課題を開いて問題を確認する（10分）');
    expect(env.data.top.link?.url).toBe('https://edstem.org/au/courses/1/lessons/lesson3');
    expect(env.data.next).toHaveLength(3);
    expect(env.data.urgent).toBe(true);
    expect(env.answerHint).toContain('top.what');
    expect(env.citations.length).toBeGreaterThan(0);
    const one = await call<{ top: Action; next: Action[] }>(c, 'get_next_action', {
      course: '電気回路',
      count: 0,
    });
    expect(one.data.top.title).toBe('実験レポート: 回路設計');
    expect(one.data.next).toEqual([]);
  });

  it('get_today and get_week carry a compact next field', async () => {
    const c = await connect();
    for (const tool of ['get_today', 'get_week']) {
      const env = await call<{ next: { line: string; top: Action; then: unknown[] } }>(c, tool);
      expect(env.data.next.top.title, tool).toBe('Lesson 3: SQL演習');
      expect(env.data.next.line, tool).toMatch(/^今やること: /);
    }
  });

  it('get_student_state is one compact call with the suggestion', async () => {
    const c = await connect('remote', { id: 'oauth:chatgpt' });
    const res = await c.callTool({ name: 'get_student_state', arguments: {} });
    const text = (res.content as { text: string }[])[0]?.text ?? '';
    expect(text.length).toBeLessThan(30_000);
    const env = JSON.parse(text) as McpEnvelope<{
      suggestion: { top: Action };
      assignments: { title: string }[];
    }>;
    expect(env.data.suggestion.top.title).toBe('Lesson 3: SQL演習');
    expect(env.data.assignments.map((a) => a.title)).toContain('小レポート2');
  });

  it('get_attention_required describes the stages, pending and quietUntil', async () => {
    const c = await connect('remote', { id: 'oauth:desc' });
    const t = (await c.listTools()).tools.find((x) => x.name === 'get_attention_required');
    const d = t?.description ?? '';
    for (const word of [
      'notifyStage',
      'overdue',
      'final',
      'pending',
      'quietUntil',
      'nextEscalationAt',
    ])
      expect(d, word).toContain(word);
    expect(d).not.toContain('Repeats only when severity rises');
  });

  it('get_attention_required dedupes per OAuth client', async () => {
    clock.set('2026-10-05T10:00:00.000Z');
    const a = await connect('remote', { id: 'oauth:chatgpt' });
    type Att = { nothingImportant: boolean; text: string; items: unknown[] };
    const first = await call<Att>(a, 'get_attention_required');
    expect(first.data.nothingImportant).toBe(false);
    expect(first.data.text).toContain('Lesson 3: SQL演習');
    const again = await call<Att>(a, 'get_attention_required');
    expect(again.data.nothingImportant).toBe(true);
    expect(again.answerHint).toContain('何も通知しない');
    const other = await connect('remote', { id: 'oauth:claude' });
    expect((await call<Att>(other, 'get_attention_required')).data.nothingImportant).toBe(false);
  });

  it('get_briefing returns a ready-to-send morning text', async () => {
    const c = await connect('remote', { id: 'oauth:chatgpt' });
    const env = await call<{ kind: string; text: string; nothingImportant: boolean }>(
      c,
      'get_briefing',
    );
    expect(env.data.kind).toBe('morning');
    expect(env.data.nothingImportant).toBe(false);
    expect(env.data.text.length).toBeLessThanOrEqual(300);
    expect(env.data.text).toContain('まずこれ: ');
  });
});
