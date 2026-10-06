import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { UniContext } from '@unicontext/context-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMcpServer,
  ProposalStore,
  REMOTE_SERVER_INSTRUCTIONS,
  type McpEnvelope,
  type ToolCallEvent,
} from '../src/index.js';
import { createSeeded } from './seeded.js';

let uc: UniContext;
let tmp: string;
let proposals: ProposalStore;
const events: ToolCallEvent[] = [];

async function connect(surface: 'local' | 'remote'): Promise<Client> {
  const server = createMcpServer({
    uc,
    proposals,
    surface,
    onToolCall: (e) => void events.push(e),
    sourcesInfo: () => ({ secretish: 'connector health detail' }),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'surface-test', version: '0.0.0' });
  await client.connect(b);
  return client;
}

beforeAll(async () => {
  ({ uc } = await createSeeded());
  tmp = mkdtempSync(path.join(tmpdir(), 'uc-mcp-remote-'));
  proposals = new ProposalStore(path.join(tmp, 'proposals'), { clock: uc.clock });
});

afterAll(async () => {
  await uc.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('remote (read-only) MCP surface', () => {
  it('registers no write tools and marks every tool read-only with an output schema', async () => {
    const local = await connect('local');
    const remote = await connect('remote');
    try {
      const localNames = (await local.listTools()).tools.map((t) => t.name);
      expect(localNames).toEqual(expect.arrayContaining(['correct_fact', 'propose_pace_slot']));
      const tools = (await remote.listTools()).tools;
      const names = tools.map((t) => t.name);
      expect(names).not.toContain('correct_fact');
      expect(names).not.toContain('propose_pace_slot');
      expect(names).toEqual(
        expect.arrayContaining(['search_syllabus', 'get_syllabus', 'get_credit_summary']),
      );
      // Record tools need the unicontext.write scope (apps/mcp/test/additions.test.ts).
      const record =
        /^(ingest_lecture|record_lecture|add_deadline|add_note|add_task|set_course_condition|add_session_rule|ingest_external_signal|list_my_additions|retract_addition|open_announcement)$/;
      for (const n of localNames.filter(
        (x) => !['correct_fact', 'propose_pace_slot'].includes(x) && !record.test(x),
      ))
        expect(names).toContain(n);
      for (const n of localNames.filter((x) => record.test(x))) expect(names).not.toContain(n);
      for (const t of tools) {
        expect(t.annotations, t.name).toMatchObject({ readOnlyHint: true, destructiveHint: false });
        expect(t.outputSchema, t.name).toBeTruthy();
        // ChatGPT's connector safety scan flags such wording (docs/research/chatgpt-connector.md §4)
        expect(`${t.title ?? ''} ${t.description ?? ''}`, t.name).not.toMatch(
          /personal information|no authentication|password|個人情報|propose/i,
        );
      }
      expect(remote.getInstructions()).toBe(REMOTE_SERVER_INSTRUCTIONS);
      const call = await remote.callTool({
        name: 'correct_fact',
        arguments: { subject: 'x', predicate: 'room', value: 'y' },
      });
      expect(call.isError).toBe(true);
      expect(proposals.list({ status: 'pending' })).toHaveLength(0);
    } finally {
      await local.close();
      await remote.close();
    }
  });

  it('returns compact text plus structuredContent and reports every call to the audit hook', async () => {
    const remote = await connect('remote');
    try {
      events.length = 0;
      const res = await remote.callTool({ name: 'get_today', arguments: {} });
      const text = (res.content as { text: string }[])[0]?.text ?? '';
      expect(text.includes('\n')).toBe(false);
      const env = res.structuredContent as unknown as McpEnvelope;
      expect(env.citations.length).toBeGreaterThan(0);
      const bad = await remote.callTool({
        name: 'get_course',
        arguments: { courseOfferingId: '存在しない科目xyz' },
      });
      expect(bad.isError).toBe(true);
      expect(events.map((e) => [e.tool, e.ok])).toEqual([
        ['get_today', true],
        ['get_course', false],
      ]);
      expect(Object.keys(events[0] ?? {}).sort()).toEqual(['ms', 'ok', 'tool']);
    } finally {
      await remote.close();
    }
  });

  it('get_source leaves out raw payloads and connector details on the remote surface', async () => {
    const remote = await connect('remote');
    const local = await connect('local');
    try {
      const today = (await remote.callTool({ name: 'get_today', arguments: {} }))
        .structuredContent as unknown as McpEnvelope;
      const ref = today.citations[0]?.sourceReferenceId as string;
      const r = (
        await remote.callTool({ name: 'get_source', arguments: { sourceReferenceId: ref } })
      ).structuredContent as unknown as McpEnvelope<Record<string, Record<string, unknown>>>;
      expect(r.data.rawItem).toBeDefined();
      expect(r.data.rawItem?.payload).toBeUndefined();
      expect(r.data.rawItem?.payloadPreview).toBeUndefined();
      expect(r.data.sourcesInfo).toBeUndefined();
      const l = (
        await local.callTool({ name: 'get_source', arguments: { sourceReferenceId: ref } })
      ).structuredContent as unknown as McpEnvelope<Record<string, Record<string, unknown>>>;
      expect(l.data.rawItem?.payload ?? l.data.rawItem?.payloadPreview).toBeDefined();
      expect(l.data.sourcesInfo).toBeDefined();
    } finally {
      await remote.close();
      await local.close();
    }
  });
});
