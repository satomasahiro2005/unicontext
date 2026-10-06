import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createUniContext, type UniContext } from '@unicontext/context-engine';
import { ManualClock } from '@unicontext/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeConnector } from '../../../packages/connector-sdk/src/index.js';
import { createMcpServer, ProposalStore, type McpDeps } from '../src/index.js';

/* set_travel_time over the in-memory MCP transport: a trip the student states shows on the views. */

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

type Structured = Record<string, unknown> & {
  status: string;
  addition: Record<string, unknown> & { id: string; stored: Record<string, unknown> };
  answerHint: string;
};

const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args });

interface TodayClass {
  course: { title: string };
  room: { value: string };
  travelFromPrevious?: { minutes: number; from: string; mode?: string };
  place?: { building?: string; room: string };
}

const classes = async (client: Client): Promise<TodayClass[]> => {
  const res = await call(client, 'get_today', {});
  return ((res.structuredContent as { data: { classes: TodayClass[] } }).data.classes ??
    []) as TodayClass[];
};

beforeAll(async () => {
  // Monday 2026-11-16 12:00 JST
  const clock = new ManualClock('2026-11-16T03:00:00.000Z');
  uc = createUniContext({ profile: 'shizuoka-university', clock });
  const lcu = createFakeConnector({
    product: 'livecampusu',
    sourceLabel: '学務情報システム',
    authority: 'academic-system',
    capabilities: ['courses', 'enrollments', 'timetable'],
    dataset: {
      courses: [
        {
          id: 'C-MON',
          code: 'J3101',
          title: 'ソフトウェア工学',
          year: 2026,
          term: '後期',
          enrolled: true,
          schedule: [{ day: 1, period: 2, room: '工３－３１' }],
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
  expect((await uc.sync.sync('livecampusu')).ok).toBe(true);
  tmp = mkdtempSync(path.join(tmpdir(), 'uc-mcp-places-'));
  proposals = new ProposalStore(path.join(tmp, 'proposals'), { clock });
});

afterAll(async () => {
  await uc.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('set_travel_time', () => {
  it('registers a trip; the first class of the day shows it; retract removes it', async () => {
    const client = await connect();
    expect((await classes(client))[0]?.travelFromPrevious).toBeUndefined();

    const res = await call(client, 'set_travel_time', {
      from: 'home',
      to: '工学部',
      minutes: 10,
      mode: 'bike',
      statement: '家から工学部まで自転車で10分',
    });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as Structured;
    expect(out.status).toBe('created');
    expect(out.addition).toMatchObject({
      tool: 'set_travel_time',
      kind: 'place',
      status: 'unconfirmed',
      title: '移動時間: 自宅→工学部 10分',
      stored: { predicate: 'travel:minutes', from: 'home', to: '工', minutes: 10 },
    });
    expect(out.answerHint).toContain('travelFromPrevious');
    expect(out.answerHint).toContain('地図サービスは使っていません');

    const first = (await classes(client))[0];
    expect(first?.course.title).toBe('ソフトウェア工学');
    expect(first?.place).toMatchObject({ building: '工', room: '工3-31' });
    expect(first?.travelFromPrevious).toMatchObject({ minutes: 10, from: '自宅', mode: 'bike' });

    // the same call again is not stored twice
    const again = await call(client, 'set_travel_time', {
      from: 'home',
      to: '工学部',
      minutes: 10,
      mode: 'bike',
      statement: '家から工学部まで自転車で10分',
    });
    expect((again.structuredContent as Structured).status).toBe('replayed');

    const listed = await call(client, 'list_my_additions', {});
    const additions = (listed.structuredContent as { additions: { id: string }[] }).additions;
    expect(additions.map((a) => a.id)).toContain(out.addition.id);

    const retracted = await call(client, 'retract_addition', { additionId: out.addition.id });
    expect((retracted.structuredContent as Structured).status).toBe('retracted');
    expect((await classes(client))[0]?.travelFromPrevious).toBeUndefined();
  });

  it('refuses nonsense: the same place twice, 0 minutes, an unknown mode', async () => {
    const client = await connect();
    const same = await call(client, 'set_travel_time', {
      from: '工学部',
      to: '工5-22',
      minutes: 5,
      statement: 'x',
    });
    expect(same.isError).toBe(true);
    const zero = await call(client, 'set_travel_time', {
      from: 'home',
      to: '工学部',
      minutes: 0,
      statement: 'x',
    });
    expect(zero.isError).toBe(true);
    const mode = await call(client, 'set_travel_time', {
      from: 'home',
      to: '工学部',
      minutes: 5,
      mode: 'rocket',
      statement: 'x',
    });
    expect(mode.isError).toBe(true);
  });

  it('is not on the read-only remote surface', async () => {
    const ro = await connect({ surface: 'remote', client: { id: 'ro-client' } });
    expect((await ro.listTools()).tools.map((t) => t.name)).not.toContain('set_travel_time');
    const rw = await connect({
      surface: 'remote',
      allowWrite: true,
      client: { id: 'rw-client', name: 'chatgpt' },
    });
    expect((await rw.listTools()).tools.map((t) => t.name)).toContain('set_travel_time');
  });
});
