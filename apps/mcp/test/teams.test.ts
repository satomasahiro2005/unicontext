import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { stableId, type EntityKind } from '@unicontext/canonical-model';
import type { UniContext } from '@unicontext/context-engine';
import { EntityStore } from '@unicontext/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer, ProposalStore, type McpEnvelope } from '../src/index.js';
import { createSeeded } from './seeded.js';

let uc: UniContext;
let tmp: string;
let proposals: ProposalStore;

const dbCourse = stableId('courseOffering', 'lcu', 'J2401-2026-2');
const SRC = 'teams-web';
const TEAMS = { platform: 'teams' };

async function connect(surface: 'local' | 'remote'): Promise<Client> {
  const server = createMcpServer({ uc, proposals, surface });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'teams-test', version: '0.0.0' });
  await client.connect(b);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  return {
    isError: res.isError === true,
    envelope: res.structuredContent as unknown as McpEnvelope,
  };
}

beforeAll(async () => {
  ({ uc } = await createSeeded());
  tmp = mkdtempSync(path.join(tmpdir(), 'uc-mcp-teams-'));
  proposals = new ProposalStore(path.join(tmp, 'proposals'), { clock: uc.clock });
  const store = new EntityStore(uc.db, { clock: uc.clock });
  const id = <K extends EntityKind>(kind: K, n: string) => stableId(kind, SRC, n);
  const put = (input: Parameters<EntityStore['upsert']>[0]) =>
    store.upsert(input, { sourceId: SRC });
  put({
    id: id('thread', 'general'),
    kind: 'thread',
    title: '一般',
    platform: 'teams',
    courseOfferingId: dbCourse,
    extra: { ...TEAMS, channelName: '一般' },
  });
  put({
    id: id('message', 'p1'),
    kind: 'message',
    threadId: id('thread', 'general'),
    courseOfferingId: dbCourse,
    authorName: '先生A',
    authorRole: 'instructor',
    body: 'テスト用の投稿です',
    sentAt: '2026-09-30T05:00:00Z',
    extra: { ...TEAMS, isReply: false, subject: '資料を追加しました' },
  });
  put({
    id: id('document', 'f1'),
    kind: 'document',
    title: 'week1.pdf',
    path: '/00_講義資料/week1.pdf',
    url: 'https://sp.example.com/week1.pdf',
    sizeBytes: 1024,
    modifiedAt: '2026-09-30T06:00:00Z',
    courseOfferingId: dbCourse,
    extra: { ...TEAMS, folder: '00_講義資料' },
  });
  put({
    id: id('document', 'f2'),
    kind: 'document',
    title: 'readme.txt',
    path: '/readme.txt',
    modifiedAt: '2026-09-01T06:00:00Z',
    courseOfferingId: dbCourse,
    extra: { ...TEAMS, folder: '' },
  });
  put({
    id: id('assignment', 'a1'),
    kind: 'assignment',
    title: 'Teamsレポート',
    dueAt: '2026-10-20T14:59:00Z',
    availableFrom: '2026-09-30T00:00:00Z',
    courseOfferingId: dbCourse,
    extra: { platform: 'teams-assignments', source: 'assignments-api', status: 'assigned' },
  });
});

afterAll(async () => {
  await uc.close();
  rmSync(tmp, { recursive: true, force: true });
});

for (const surface of ['local', 'remote'] as const)
  describe(`Teams tools (${surface} surface)`, () => {
    let client: Client;
    beforeAll(async () => {
      client = await connect(surface);
    });
    afterAll(async () => client.close());

    it('lists get_teams_activity and list_course_files as read-only tools', async () => {
      const tools = (await client.listTools()).tools;
      for (const name of ['get_teams_activity', 'list_course_files']) {
        const t = tools.find((x) => x.name === name);
        expect(t, name).toBeDefined();
        expect(t?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
        expect(t?.description).toContain(' / ');
      }
    });

    it('get_teams_activity returns posts, files and assignments', async () => {
      const { isError, envelope } = await call(client, 'get_teams_activity', {
        since: '2026-09-29',
      });
      expect(isError).toBe(false);
      const data = envelope.data as unknown as {
        view: string;
        posts: { title: string }[];
        files: { title: string }[];
        assignments: { title: string }[];
      };
      expect(data.view).toBe('teams-activity');
      expect(data.posts.map((p) => p.title)).toEqual(['資料を追加しました']);
      expect(data.files.map((f) => f.title)).toEqual(['week1.pdf']);
      expect(data.assignments.map((a) => a.title)).toEqual(['Teamsレポート']);
    });

    it('get_teams_activity resolves a course by name and rejects bad input', async () => {
      const scoped = await call(client, 'get_teams_activity', {
        since: '2026-09-29',
        course: 'データベース',
      });
      expect(scoped.isError).toBe(false);
      expect((scoped.envelope.data as unknown as { posts: unknown[] }).posts).toHaveLength(1);
      expect(
        (await call(client, 'get_teams_activity', { course: '存在しない科目xyz' })).isError,
      ).toBe(true);
      expect((await call(client, 'get_teams_activity', { since: 'not a date' })).isError).toBe(
        true,
      );
    });

    it('list_course_files returns the folder tree level by level', async () => {
      const root = await call(client, 'list_course_files', { course: 'データベース' });
      expect(root.isError).toBe(false);
      const rootData = root.envelope.data as unknown as {
        path: string;
        folders: { name: string; fileCount: number }[];
        files: { title: string }[];
      };
      expect(rootData.path).toBe('');
      expect(rootData.folders).toEqual([
        expect.objectContaining({ name: '00_講義資料', fileCount: 1 }),
      ]);
      expect(rootData.files.map((f) => f.title)).toContain('readme.txt');
      const sub = await call(client, 'list_course_files', {
        course: dbCourse,
        path: '/00_講義資料',
      });
      expect((sub.envelope.data as unknown as { files: { title: string }[] }).files).toEqual([
        expect.objectContaining({ title: 'week1.pdf', url: 'https://sp.example.com/week1.pdf' }),
      ]);
      expect((await call(client, 'list_course_files', {})).isError).toBe(true);
    });

    it('get_course carries discussion, files and assignments', async () => {
      const { envelope } = await call(client, 'get_course', { courseOfferingId: dbCourse });
      const data = envelope.data as unknown as {
        discussion: { channel: string }[];
        files: unknown[];
        filesTotal: number;
        assignments: { title: string }[];
      };
      expect(data.discussion).toEqual(
        expect.arrayContaining([expect.objectContaining({ channel: '一般' })]),
      );
      expect(data.filesTotal).toBeGreaterThanOrEqual(2);
      expect(data.files.length).toBe(data.filesTotal);
      expect(data.assignments.map((a) => a.title)).toContain('Teamsレポート');
    });
  });
