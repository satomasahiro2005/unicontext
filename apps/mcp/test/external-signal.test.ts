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
import { createMcpServer, ProposalStore, type McpDeps, type ToolCallEvent } from '../src/index.js';

/*
 * ingest_external_signal over the in-memory MCP transport: what ChatGPT writes after reading the
 * student's Gmail / Google Calendar. Monday 2026-10-05 12:56 JST; the university systems were read
 * at 12:00.
 */

const TOOL = 'ingest_external_signal';
const SE = stableId('courseOffering', 'livecampusu', 'C-SE');
const REPORT = stableId('assignment', 'livecampusu', 'A-1');
const SYSTEM_DUE = '2026-10-16T23:59:00+09:00';

let uc: UniContext;
let tmp: string;
let proposals: ProposalStore;
const events: ToolCallEvent[] = [];

async function connect(extra: Partial<McpDeps> = {}): Promise<Client> {
  const server = createMcpServer({
    uc,
    proposals,
    onToolCall: (e) => void events.push(e),
    ...extra,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'chatgpt-test', version: '0.0.0' });
  await client.connect(b);
  return client;
}

const chatgpt = {
  surface: 'remote' as const,
  allowWrite: true,
  client: { id: 'oauth-chatgpt', name: 'ChatGPT' },
};

type Out = Record<string, unknown> & {
  status: string;
  addition: Record<string, unknown> & {
    id: string;
    stored: Record<string, unknown>;
    conflicts: { values: { source: string }[] }[];
  };
  answerHint: string;
};

const mail = (over: Record<string, unknown> = {}) => ({
  source: 'gmail',
  nativeId: 'msg-0001',
  observedAt: '2026-10-05T11:00:00+09:00',
  from: '教務係 <kyomu@example.ac.jp>',
  subject: '【履修登録】結果のお知らせ',
  summary: 'ソフトウェア工学は抽選に外れ、履修できません。',
  kind: 'registration_result',
  course: 'ソフトウェア',
  enrollment: 'not_taking',
  quote: 'ソフトウェア工学は抽選の結果、履修を許可できませんでした。',
  url: 'https://mail.google.com/mail/u/0/#inbox/msg-0001',
  ...over,
});

async function call(client: Client, args: Record<string, unknown>) {
  return client.callTool({ name: TOOL, arguments: args });
}

beforeAll(async () => {
  const clock = new ManualClock('2026-10-05T03:00:00.000Z');
  uc = createUniContext({ profile: 'shizuoka-university', clock });
  const lcu = createFakeConnector({
    product: 'livecampusu',
    sourceLabel: '学務情報システム',
    authority: 'academic-system',
    authorities: { 'fake.assignment': 'submission-system' },
    capabilities: ['courses', 'enrollments', 'timetable', 'assignments'],
    dataset: {
      courses: [
        {
          id: 'C-SE',
          code: 'J3101',
          title: 'ソフトウェア工学',
          year: 2026,
          term: '後期',
          enrolled: true,
          schedule: [{ day: 1, period: 2 }],
        },
      ],
      assignments: [{ id: 'A-1', courseId: 'C-SE', title: 'レポート課題2', due: SYSTEM_DUE }],
    },
  });
  uc.sync.register({
    sourceId: 'livecampusu',
    adapter: lcu.adapter,
    normalizer: lcu.normalizer,
    metadata: lcu.metadata,
  });
  expect((await uc.sync.sync('livecampusu')).ok).toBe(true);
  clock.set('2026-10-05T03:56:00.000Z');
  tmp = mkdtempSync(path.join(tmpdir(), 'uc-mcp-signal-'));
  proposals = new ProposalStore(path.join(tmp, 'proposals'), { clock });
});

afterAll(async () => {
  await uc.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('ingest_external_signal: registration', () => {
  it('local and remote with the write scope list it as an honest write tool; remote read-only does not', async () => {
    for (const extra of [{}, chatgpt]) {
      const client = await connect(extra);
      const t = (await client.listTools()).tools.find((x) => x.name === TOOL);
      expect(t).toBeDefined();
      expect(t?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(t?.outputSchema).toBeDefined();
      expect(`${t?.title} ${t?.description}`).not.toMatch(
        /personal information|no authentication|password|個人情報|propose/i,
      );
      // Tells the AI to call it without asking, once per mail, and what never to do.
      expect(t?.description).toContain('ユーザーに聞かずに');
      expect(t?.description).toContain('nativeId');
      expect(t?.description).toContain('Gmail（本人のメール）');
      expect(t?.description).toContain('上書きしない');
      await client.close();
    }
    const ro = await connect({ surface: 'remote', client: { id: 'ro-client' } });
    expect((await ro.listTools()).tools.map((x) => x.name)).not.toContain(TOOL);
    const res = await call(ro, mail());
    expect(res.isError).toBe(true);
    await ro.close();
  });

  it('stores a rejection once, hides the course, and replays as duplicate', async () => {
    const client = await connect(chatgpt);
    events.length = 0;
    const res = await call(client, mail());
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    const out = res.structuredContent as Out;
    expect(out.status).toBe('created');
    expect(out.addition).toMatchObject({
      tool: TOOL,
      kind: 'external_signal',
      status: 'unconfirmed',
      label: 'Gmail（本人のメール）',
      source: 'Gmail（本人のメール）',
      course: { id: SE, title: 'ソフトウェア工学' },
      stored: { predicate: 'condition:enrollment', value: 'not_taking' },
    });
    expect(out.answerHint).toContain('外れます');
    expect(out.answerHint).toContain('enrollmentNotes');
    expect(out.answerHint).toContain('何も送っていません');

    const e = events.find((x) => x.tool === TOOL);
    expect(e).toMatchObject({
      ok: true,
      write: { status: 'created', additionId: out.addition.id },
    });
    expect(JSON.stringify(e)).not.toContain('抽選');

    // Declared by mail: the course view shows both statuses, with the source.
    const reader = await connect();
    const course = (
      await reader.callTool({ name: 'get_course', arguments: { courseOfferingId: SE } })
    ).structuredContent as { data: { enrolled: boolean; enrollment: Record<string, unknown> } };
    expect(course.data.enrolled).toBe(false);
    expect(course.data.enrollment).toMatchObject({
      academic: 'active',
      declaration: {
        value: 'not_taking',
        confirmed: false,
        provenance: 'external',
        source: 'Gmail（本人のメール）',
      },
    });
    await reader.close();

    const again = (await call(client, mail())).structuredContent as Out;
    expect(again.status).toBe('duplicate');
    expect(again.addition.id).toBe(out.addition.id);
    expect(again.answerHint).toContain('既に保存済み');
    expect(events.filter((x) => x.tool === TOOL && x.write?.status === 'created')).toHaveLength(1);

    // The AI can take its own back; the course returns.
    const gone = await client.callTool({
      name: 'retract_addition',
      arguments: { additionId: out.addition.id },
    });
    expect(gone.isError).toBeFalsy();
    expect(uc.context.enrollmentOf(SE).enrolled).toBe(true);
  });
});

describe('ingest_external_signal: deadline and others', () => {
  it('a deadline links to the assignment of the same number and shows the disagreement', async () => {
    const client = await connect(chatgpt);
    const res = await call(
      client,
      mail({
        nativeId: 'msg-0002',
        kind: 'deadline',
        enrollment: undefined,
        subject: 'レポート2の期限',
        summary: 'レポート課題2の提出期限が10月23日に延びた。',
        task: 'レポート2',
        dueAt: '2026-10-23T23:59:00+09:00',
        quote: 'レポート課題2の提出期限を10月23日(金)23:59までに延長します。',
      }),
    );
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    const out = res.structuredContent as Out;
    expect(out.status).toBe('created');
    expect(out.addition).toMatchObject({
      attachedTo: { id: REPORT, title: 'レポート課題2' },
      dueText: '10/23 23:59',
    });
    expect(out.answerHint).toContain('10/23 23:59');
    expect(out.answerHint).toContain('断定せず');
    expect(out.addition.conflicts[0]?.values.map((v) => v.source)).toEqual(
      expect.arrayContaining(['Gmail（本人のメール）']),
    );
    // Both values are in get_conflicts; the university's value is still the deadline shown.
    const reader = await connect();
    const conflicts = (await reader.callTool({ name: 'get_conflicts', arguments: {} }))
      .structuredContent as { conflicts: string[]; data: { conflicts: { predicate: string }[] } };
    expect(conflicts.data.conflicts.map((c) => c.predicate)).toContain('assignment_due');
    expect(conflicts.conflicts.join('\n')).toContain('Gmail（本人のメール）');
    const deadlines = (
      await reader.callTool({
        name: 'get_deadlines',
        arguments: { days: 30, courseOfferingId: SE },
      })
    ).structuredContent as { data: { upcoming: { title: string; dueAt: string }[] } };
    expect(deadlines.data.upcoming.find((d) => d.title === 'レポート課題2')?.dueAt).toBe(
      SYSTEM_DUE,
    );
    await reader.close();
  });

  it('a calendar event about a room change becomes a note on the course', async () => {
    const client = await connect(chatgpt);
    const res = await call(client, {
      source: 'calendar',
      nativeId: 'evt-77',
      observedAt: '2026-10-05T11:30:00+09:00',
      subject: 'ソフトウェア工学 10/12',
      eventStart: '2026-10-12T10:20:00+09:00',
      eventEnd: '2026-10-12T11:50:00+09:00',
      location: '共通講義棟21',
      summary: '10/12のソフトウェア工学の教室が共通講義棟21に変更。',
      kind: 'room_change',
      course: 'ソフトウェア工学',
      quote: '場所: 共通講義棟21',
    });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    const out = res.structuredContent as Out;
    expect(out.status).toBe('created');
    expect(out.addition.label).toBe('Googleカレンダー');
    const reader = await connect();
    const notes = (
      await reader.callTool({ name: 'get_notes', arguments: { course: 'ソフトウェア' } })
    ).structuredContent as { data: { notes: { kind: string; text: string }[] } };
    expect(notes.data.notes.find((n) => n.kind === 'external_signal')?.text).toContain(
      '共通講義棟21',
    );
    await reader.close();
  });

  it('rejects what cannot be stored with a clear error', async () => {
    const client = await connect(chatgpt);
    for (const bad of [
      mail({ nativeId: 'e1', kind: 'deadline', enrollment: undefined, dueAt: undefined }),
      mail({ nativeId: 'e2', course: undefined }),
      mail({ nativeId: 'e3', source: 'slack' }),
      mail({ nativeId: 'e4', observedAt: 'yesterday' }),
      mail({ nativeId: 'e5', url: 'ftp://example.com/x' }),
    ]) {
      const res = await call(client, bad);
      expect(res.isError, JSON.stringify(bad)).toBe(true);
    }
  });
});
