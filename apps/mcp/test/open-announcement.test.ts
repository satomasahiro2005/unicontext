import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { OpenAnnouncementsReport, UniContext } from '@unicontext/context-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer, ProposalStore, type McpDeps } from '../src/index.js';
import { createSeeded } from './seeded.js';

/* open_announcement: fetches unread LiveCampusU notices on request (marks them read there). */

let uc: UniContext;
let tmp: string;
let proposals: ProposalStore;

async function connect(extra: Partial<McpDeps> = {}): Promise<Client> {
  const server = createMcpServer({ uc, proposals, ...extra });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'open-test', version: '0.0.0' });
  await client.connect(b);
  return client;
}

beforeAll(async () => {
  ({ uc } = await createSeeded());
  tmp = mkdtempSync(path.join(tmpdir(), 'uc-mcp-open-'));
  proposals = new ProposalStore(path.join(tmp, 'proposals'), { clock: uc.clock });
});

afterAll(async () => {
  await uc.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('open_announcement', () => {
  it('is an open-world write tool used without asking; remote only with unicontext.write', async () => {
    const tools = (await (await connect()).listTools()).tools;
    const local = tools.find((t) => t.name === 'open_announcement');
    // The student chose content over the unread flag: no confirmation-forcing destructive hint.
    expect(local?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(local?.description).toContain('既読');
    expect(local?.description).toContain('本人に確かめずに');
    for (const t of tools.filter((x) => /announcement/.test(x.name)))
      expect(t.description ?? '').not.toMatch(/了承|ask the user first/);
    const get = tools.find((t) => t.name === 'get_announcement');
    expect(get?.description).toContain('open_announcement');
    expect(local?.outputSchema).toBeDefined();
    const ro = await connect({ surface: 'remote', client: { id: 'ro' } });
    expect((await ro.listTools()).tools.map((t) => t.name)).not.toContain('open_announcement');
    const rw = await connect({ surface: 'remote', allowWrite: true, client: { id: 'rw' } });
    expect((await rw.listTools()).tools.map((t) => t.name)).toContain('open_announcement');
  });

  it('goes through the openAnnouncements hook (the daemon) and reports what was opened', async () => {
    const id = uc.context.listAnnouncements()[0]?.id ?? '';
    const calls: string[][] = [];
    const client = await connect({
      openAnnouncements: async (ids): Promise<OpenAnnouncementsReport> => {
        calls.push(ids);
        return {
          results: ids.map((x) => ({
            id: x,
            title: 't',
            status: 'opened',
            markedReadAtSource: true,
          })),
          opened: ids.length,
          markedReadAtSource: ids.length,
          warnings: [],
        };
      },
    });
    const res = await client.callTool({ name: 'open_announcement', arguments: { ids: [id] } });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect(calls).toEqual([[id]]);
    const out = res.structuredContent as { opened: number; answerHint: string };
    expect(out.opened).toBe(1);
    expect(out.answerHint).toContain('LiveCampusUで既読');
    const bad = await client.callTool({
      name: 'open_announcement',
      arguments: { ids: ['courseOffering:x'] },
    });
    expect(bad.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('in-process: a source without on-demand support is reported, nothing changes', async () => {
    const id = uc.context.listAnnouncements()[0]?.id ?? '';
    const client = await connect();
    const res = await client.callTool({ name: 'open_announcement', arguments: { ids: [id] } });
    const out = res.structuredContent as OpenAnnouncementsReport;
    expect(out.results[0]?.status).toBe('unsupported');
    expect(out.opened).toBe(0);
  });
});
