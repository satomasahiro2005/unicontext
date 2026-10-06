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
import { createMcpServer, ProposalStore, type McpDeps } from '../src/index.js';

/*
 * get_attendance (the academic system's attendance counts, raw) and the prior-year course lineage
 * as an AI client sees them: get_course (attendance, lineage, historicalResources) and search.
 * Monday 2026-10-05 12:56 JST.
 */

const DB = stableId('courseOffering', 'livecampusu', 'C-DB');
const NET = stableId('courseOffering', 'livecampusu', 'C-NET');
const ED_2025 = stableId('courseOffering', 'edstem', 'db2025');
const LABEL_2025 = '前年度（2025）の参考資料';

let uc: UniContext;
let tmp: string;
let proposals: ProposalStore;

async function connect(extra: Partial<McpDeps> = {}): Promise<Client> {
  const server = createMcpServer({ uc, proposals, ...extra });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'attendance-test', version: '0.0.0' });
  await client.connect(b);
  return client;
}

/** The parts of a tool result these tests read. */
interface Data {
  courses: { course: { id: string; title: string } }[];
  coverage: { complete: boolean; missing: number; note: string };
  attendance?: { counts: Record<string, number>; citations: { label: string }[] };
  lineage?: { priorOfferings: unknown[] };
  [key: string]: unknown;
}

interface Envelope {
  data: Data;
  citations: { sourceReferenceId: string; label: string }[];
  conflicts: string[];
  answerHint: string;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  return res.structuredContent as unknown as Envelope;
}

beforeAll(async () => {
  const clock = new ManualClock('2026-10-05T03:00:00.000Z');
  uc = createUniContext({ profile: 'shizuoka-university', clock });
  const lcu = createFakeConnector({
    product: 'livecampusu',
    sourceLabel: '学務情報システム',
    authority: 'academic-system',
    capabilities: ['courses', 'enrollments', 'timetable'],
    dataset: {
      courses: [
        {
          id: 'C-DB',
          code: '77403030',
          title: 'データベースシステム論',
          year: 2026,
          term: '後期',
          enrolled: true,
          schedule: [{ day: 4, period: 2 }],
        },
        {
          id: 'C-NET',
          code: '77403050',
          title: 'ネットワーク論',
          year: 2026,
          term: '後期',
          enrolled: true,
          schedule: [{ day: 3, period: 3 }],
        },
      ],
    },
  });
  uc.sync.register({
    sourceId: 'livecampusu',
    adapter: lcu.adapter,
    // The connector's 出欠 rows: one fact per enrolled offering (database has a row, network none).
    normalizer: {
      ...lcu.normalizer,
      normalize: async (item, ctx) => {
        const out = await lcu.normalizer.normalize(item, ctx);
        if (item.sourceType !== 'fake.course' || item.externalId !== 'C-DB') return out;
        return {
          ...out,
          facts: [
            ...(out.facts ?? []),
            {
              subject: ctx.id('courseOffering', 'C-DB'),
              predicate: 'attendance',
              value: {
                attended: 7,
                absent: 1,
                late: 2,
                earlyLeave: 0,
                excused: 1,
                invalid: 0,
                published: '公開',
              },
              origin: 'authoritative' as const,
              ref: { url: 'https://example.ac.jp/attendance' },
            },
          ],
        };
      },
    },
    metadata: lcu.metadata,
  });
  const ed = createFakeConnector({
    product: 'edstem',
    sourceLabel: 'Ed Discussion',
    authority: 'lms',
    capabilities: ['courses', 'materials', 'messages'],
    dataset: {
      courses: [
        { id: 'db2026', code: 'db2026', title: 'データベースシステム論', year: 2026, term: '後期' },
        { id: 'db2025', code: 'db2025', title: 'データベースシステム論', year: 2025 },
      ],
      documents: [
        {
          id: 'doc-2025-1',
          courseId: 'db2025',
          title: '第1回 正規化',
          text: '正規化と関数従属性\n\n第三正規形まで。',
          path: '/Ed Lessons/第1回/第1回 正規化',
        },
        {
          id: 'doc-2026-1',
          courseId: 'db2026',
          title: '第1回 データベースとは',
          text: '正規化の前にデータベースとは何かを学ぶ',
          path: '/Ed Lessons/第1回/第1回 データベースとは',
        },
      ],
    },
  });
  uc.sync.register({
    sourceId: 'edstem',
    adapter: ed.adapter,
    normalizer: ed.normalizer,
    metadata: ed.metadata,
  });
  expect((await uc.sync.sync('livecampusu')).ok).toBe(true);
  expect((await uc.sync.sync('edstem')).ok).toBe(true);
  await uc.runPipeline();
  clock.set('2026-10-05T03:56:00.000Z');
  tmp = mkdtempSync(path.join(tmpdir(), 'uc-mcp-attendance-'));
  proposals = new ProposalStore(path.join(tmp, 'proposals'), { clock });
});

afterAll(async () => {
  await uc.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('get_attendance', () => {
  it('is a read-only tool on both surfaces and avoids wording the ChatGPT connector scan flags', async () => {
    for (const extra of [{}, { surface: 'remote' as const }]) {
      const client = await connect(extra);
      const t = (await client.listTools()).tools.find((x) => x.name === 'get_attendance');
      expect(t).toBeDefined();
      expect(t?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t?.outputSchema).toBeTruthy();
      expect(`${t?.title} ${t?.description}`).not.toMatch(
        /personal information|no authentication|password|個人情報|propose/i,
      );
      await client.close();
    }
  });

  it('lists every course of the term with raw counts, citations and a note on the missing ones', async () => {
    const client = await connect();
    const env = await call(client, 'get_attendance');
    const courses = env.data.courses as {
      course: { id: string; title: string };
      attendance?: {
        counts: Record<string, number>;
        published: string;
        asOf: string;
        text: string;
      };
      note?: string;
    }[];
    expect(courses.map((c) => c.course.id).sort()).toEqual([DB, NET].sort());
    const db = courses.find((c) => c.course.id === DB);
    expect(db?.attendance).toMatchObject({
      counts: { attended: 7, absent: 1, late: 2, earlyLeave: 0, excused: 1, invalid: 0 },
      published: '公開',
      asOf: '2026-10-05T03:00:00.000Z',
      absencesSoFar: 1,
      text: '出席 7・欠席 1・遅刻 2・早退 0・公欠 1・無効 0',
    });
    const net = courses.find((c) => c.course.id === NET);
    expect(net?.attendance).toBeUndefined();
    expect(net?.note).toContain('出欠の行がありません');
    expect(env.data.coverage).toMatchObject({ complete: false, missing: 1 });
    expect(env.data.coverage.note).toContain('最終同期は10/5 12:00');
    // Sources and a hint that never calls it safe or dangerous.
    expect(env.citations.some((c) => c.label.includes('学務情報システム'))).toBe(true);
    expect(env.answerHint).toContain('学務情報システムの公開値そのまま');
    expect(env.answerHint).toContain('断定せず');
  });

  it('takes a course by name', async () => {
    const client = await connect();
    const env = await call(client, 'get_attendance', { course: 'データベース' });
    expect(env.data.courses).toHaveLength(1);
    expect(env.data.courses[0]?.course.id).toBe(DB);
    expect(env.data.coverage.complete).toBe(true);
    const bad = await client.callTool({
      name: 'get_attendance',
      arguments: { course: '存在しない科目xyz' },
    });
    expect(bad.isError).toBe(true);
  });

  it('get_course carries the same attendance with its citation', async () => {
    const client = await connect();
    const env = await call(client, 'get_course', { courseOfferingId: DB });
    expect(env.data.attendance).toMatchObject({ counts: { attended: 7, absent: 1 } });
    expect(env.data.attendance?.citations[0]?.label).toContain('学務情報システム');
    const net = await call(client, 'get_course', { courseOfferingId: NET });
    expect('attendance' in net.data).toBe(false);
  });
});

describe('prior-year lineage through MCP', () => {
  it("get_course labels last year's lessons and names the prior offering", async () => {
    const client = await connect();
    const env = await call(client, 'get_course', { courseOfferingId: DB });
    expect(env.data.lineage?.priorOfferings).toEqual([
      expect.objectContaining({ id: ED_2025, year: 2025, sources: ['edstem'], basis: ['title'] }),
    ]);
    const res = env.data.historicalResources as {
      title: string;
      label: string;
      course: { id: string };
    }[];
    expect(res.map((r) => r.title)).toContain('第1回 正規化');
    expect(res.every((r) => r.label === LABEL_2025 && r.course.id === ED_2025)).toBe(true);
    expect(res.map((r) => r.title)).not.toContain('第1回 データベースとは');
    // Another course has none.
    expect('lineage' in (await call(client, 'get_course', { courseOfferingId: NET })).data).toBe(
      false,
    );
  });

  it('search labels hits from the prior-year offering and only those', async () => {
    const client = await connect();
    const env = await call(client, 'search', { query: '正規化' });
    const hits = env.data.hits as {
      courseOfferingId?: string;
      label?: string;
      priorYear?: number;
    }[];
    const old = hits.filter((h) => h.courseOfferingId === ED_2025);
    const current = hits.filter((h) => h.courseOfferingId !== ED_2025);
    expect(old.length).toBeGreaterThan(0);
    expect(current.length).toBeGreaterThan(0);
    for (const h of old) expect(h).toMatchObject({ label: LABEL_2025, priorYear: 2025 });
    for (const h of current) expect(h.label).toBeUndefined();
  });

  it('nothing from last year shows up in deadlines or the next action', async () => {
    const client = await connect();
    const deadlines = await call(client, 'get_deadlines', { days: 365 });
    const next = await call(client, 'get_next_action');
    for (const env of [deadlines, next]) {
      expect(JSON.stringify(env)).not.toContain(ED_2025);
      expect(JSON.stringify(env)).not.toContain(LABEL_2025);
    }
  });
});
