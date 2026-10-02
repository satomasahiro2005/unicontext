import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type CanonicalEntityInput, stableId } from '@unicontext/canonical-model';
import type { UniContext } from '@unicontext/context-engine';
import { EntityStore } from '@unicontext/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer, ProposalStore, type McpEnvelope } from '../src/index.js';
import { createSeeded } from './seeded.js';

let uc: UniContext;
let tmp: string;
let client: Client;

const OLD = '2024年度の古い課題';
const CURRENT = '今期の期限切れ課題';

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError).not.toBe(true);
  return (res.structuredContent as unknown as McpEnvelope).data as {
    assignments?: { title: string; status: string; overdue: boolean }[];
    tasks?: { title: string; status: string; overdue: boolean }[];
  };
}

beforeAll(async () => {
  ({ uc } = await createSeeded());
  tmp = mkdtempSync(path.join(tmpdir(), 'uc-mcp-past-'));
  const store = new EntityStore(uc.db, { clock: uc.clock });
  const put = (input: CanonicalEntityInput): void => {
    store.upsert(input, { sourceId: 'teams-web' });
  };
  const oldTeam = stableId('courseOffering', 'teams-web', 'team-2024');
  const thisTeam = stableId('courseOffering', 'teams-web', 'team-2026');
  put({
    id: oldTeam,
    kind: 'courseOffering',
    title: '過去のチーム',
    academicYear: 2024,
    instructorIds: [],
    instructorNames: [],
    schedule: [],
  } as CanonicalEntityInput);
  put({
    id: thisTeam,
    kind: 'courseOffering',
    title: '今年のチーム',
    academicYear: 2026,
    term: '後期',
    instructorIds: [],
    instructorNames: [],
    schedule: [],
  } as CanonicalEntityInput);
  for (const [title, course, dueAt] of [
    [OLD, oldTeam, '2025-01-10T14:59:00Z'],
    [CURRENT, thisTeam, '2026-09-30T23:00:00Z'],
  ] as const)
    put({
      id: stableId('assignment', 'teams-web', title),
      kind: 'assignment',
      title,
      courseOfferingId: course,
      dueAt,
    } as CanonicalEntityInput);
  uc.tasks.derive();
  const proposals = new ProposalStore(path.join(tmp, 'proposals'), { clock: uc.clock });
  const server = createMcpServer({ uc, proposals, surface: 'local' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'past-term-test', version: '0.0.0' });
  await client.connect(b);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('ended-term assignments over MCP', () => {
  it('get_assignments hides them by default and keeps current-term overdue work', async () => {
    const { assignments } = await call('get_assignments');
    const titles = assignments?.map((a) => a.title) ?? [];
    expect(titles).not.toContain(OLD);
    expect(titles).toContain(CURRENT);
    expect(assignments?.find((a) => a.title === CURRENT)?.overdue).toBe(true);
  });

  it('get_assignments({includePast:true}) lists them as expired_past_term, not overdue', async () => {
    const { assignments } = await call('get_assignments', { includePast: true });
    expect(assignments?.find((a) => a.title === OLD)).toMatchObject({
      status: 'expired_past_term',
      overdue: false,
    });
    expect(assignments?.map((a) => a.title)).toContain(CURRENT);
  });

  it('get_tasks follows the same rule', async () => {
    const plain = await call('get_tasks');
    expect(plain.tasks?.map((t) => t.title)).not.toContain(OLD);
    const withPast = await call('get_tasks', { includePast: true });
    expect(withPast.tasks?.map((t) => t.title)).toContain(OLD);
  });
});
