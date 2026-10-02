import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { stableId } from '@unicontext/canonical-model';
import type { DownloadFilesReport, UniContext } from '@unicontext/context-engine';
import { EntityStore } from '@unicontext/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer, type McpDeps, ProposalStore, type McpEnvelope } from '../src/index.js';
import { createSeeded } from './seeded.js';

let uc: UniContext;
let tmp: string;
let proposals: ProposalStore;
const SRC = 'teams-web';
const course = stableId('courseOffering', 'lcu', 'J2401-2026-2');
const doc = stableId('document', SRC, 'slides');
const calls: { refs: string[]; extract: boolean }[] = [];
const linked: string[] = [];

const report = (refs: string[]): DownloadFilesReport => ({
  results: refs.map((ref) =>
    ref === doc || ref === 'データベース論/00_講義資料/第1回.pptx'
      ? {
          id: doc,
          ref,
          title: '第1回.pptx',
          status: 'downloaded' as const,
          path: 'C:\\Users\\student\\files\\第1回.pptx',
          bytes: 1234,
          course: { id: course, title: 'データベース論' },
          text: { chunks: 3, chars: 60 },
        }
      : { id: '', ref, title: undefined, status: 'notFound' as const, error: `file ${ref}` },
  ),
  downloaded: 1,
  warnings: [],
});

async function connect(surface: 'local' | 'remote', extra: Partial<McpDeps> = {}) {
  const server = createMcpServer({
    uc,
    proposals,
    surface,
    downloadFiles: (refs, o) => {
      calls.push({ refs, extract: o.extract });
      return Promise.resolve(report(refs));
    },
    fileLink: (id) => {
      linked.push(id);
      return { url: 'https://uc.example.test/files/TOKEN', expiresAt: '2026-10-01T00:10:00Z' };
    },
    ...extra,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'files-test', version: '0.0.0' });
  await client.connect(b);
  return client;
}

async function call(client: Client, args: Record<string, unknown>) {
  const res = await client.callTool({ name: 'download_course_file', arguments: args });
  return {
    isError: res.isError === true,
    envelope: res.structuredContent as unknown as McpEnvelope<Record<string, unknown>>,
    text: JSON.stringify(res.content),
  };
}

beforeAll(async () => {
  ({ uc } = await createSeeded());
  tmp = mkdtempSync(path.join(tmpdir(), 'uc-mcp-files-'));
  proposals = new ProposalStore(path.join(tmp, 'proposals'), { clock: uc.clock });
  const store = new EntityStore(uc.db, { clock: uc.clock });
  const put = (input: Parameters<EntityStore['upsert']>[0]) =>
    store.upsert(input, { sourceId: SRC });
  put({
    id: doc,
    kind: 'document',
    title: '第1回.pptx',
    path: '/00_講義資料/第1回.pptx',
    courseOfferingId: course,
    extra: { platform: 'teams', folder: '00_講義資料' },
  });
  ['表紙 データベース論', 'ER図の書き方', '正規化 第1正規形'].forEach((text, i) =>
    put({
      id: stableId('documentChunk', SRC, 'slides', String(i)),
      kind: 'documentChunk',
      documentId: doc,
      ordinal: i,
      text,
      page: i + 1,
    }),
  );
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('download_course_file', () => {
  it('local: returns the local path, metadata and the text with slide markers', async () => {
    const client = await connect('local');
    const r = await call(client, { file: doc });
    expect(r.isError).toBe(false);
    const data = r.envelope.data;
    expect(data.file).toMatchObject({
      id: doc,
      status: 'downloaded',
      path: 'C:\\Users\\student\\files\\第1回.pptx',
      course: { title: 'データベース論' },
    });
    expect(data.text).toMatchObject({
      excerpt:
        '[スライド 1]\n表紙 データベース論\n\n[スライド 2]\nER図の書き方\n\n[スライド 3]\n正規化 第1正規形',
      truncated: false,
      chunks: 3,
    });
    expect(data.link).toBeUndefined();
    expect(calls.at(-1)).toEqual({ refs: [doc], extract: true });
    const tool = (await client.listTools()).tools.find((t) => t.name === 'download_course_file');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys(tool?.inputSchema.properties ?? {})).not.toContain('link');
  });

  it('truncates the text at maxChars and can leave it out', async () => {
    const client = await connect('local');
    const short = await call(client, { file: doc, maxChars: 200 });
    expect((short.envelope.data.text as { truncated: boolean }).truncated).toBe(false);
    const cut = (
      await call(client, { file: 'データベース論/00_講義資料/第1回.pptx', maxChars: 200 })
    ).envelope.data.text as { excerpt: string };
    expect(cut.excerpt.length).toBeLessThanOrEqual(200);
    const none = await call(client, { file: doc, includeText: false });
    expect(none.envelope.data.text).toBeUndefined();
  });

  it('remote: no local path; a link only when asked, minted for this client', async () => {
    const client = await connect('remote');
    const plain = await call(client, { file: doc });
    expect(plain.isError).toBe(false);
    expect(plain.envelope.data.file).not.toHaveProperty('path');
    expect(plain.text).not.toContain('C:\\\\Users');
    expect(plain.envelope.data.link).toBeUndefined();
    expect(linked).toEqual([]);
    const withLink = await call(client, { file: doc, link: true });
    expect(withLink.envelope.data.link).toEqual({
      url: 'https://uc.example.test/files/TOKEN',
      expiresAt: '2026-10-01T00:10:00Z',
    });
    expect(linked).toEqual([doc]);
    const tool = (await client.listTools()).tools.find((t) => t.name === 'download_course_file');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toContain('link');
  });

  it('reports a file that does not exist as an error', async () => {
    const client = await connect('local');
    const r = await call(client, { file: 'document:nope' });
    expect(r.isError).toBe(true);
  });
});
