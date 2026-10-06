import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { stableId } from '@unicontext/canonical-model';
import type { OpenLinkReport, UniContext } from '@unicontext/context-engine';
import { EntityStore } from '@unicontext/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMcpServer,
  type McpDeps,
  type McpEnvelope,
  ProposalStore,
  REMOTE_SERVER_INSTRUCTIONS,
  REMOTE_WRITE_SERVER_INSTRUCTIONS,
  SERVER_INSTRUCTIONS,
} from '../src/index.js';
import { createSeeded } from './seeded.js';

let uc: UniContext;
let tmp: string;
const SRC = 'teams-web';
const course = stableId('courseOffering', 'lcu', 'J2401-2026-2');
const doc = stableId('document', SRC, 'linked-slides');
const LINK = 'https://example.sharepoint.com/:p:/s/db2026/EslidesTOKEN?e=1';
const FOLDER = 'https://example-my.sharepoint.com/:f:/g/personal/t_example_ac_jp/IgFolder';
const calls: { url: string; extract: boolean }[] = [];
const linked: string[] = [];

const reports: Record<string, OpenLinkReport> = {
  [LINK]: {
    url: LINK,
    status: 'file',
    sourceId: SRC,
    warnings: [],
    file: {
      id: doc,
      ref: LINK,
      title: '第3回.pptx',
      status: 'downloaded',
      path: 'C:\\Users\\student\\files\\第3回.pptx',
      bytes: 2048,
      course: { id: course, title: 'データベース論' },
      text: { chunks: 2, chars: 30 },
    },
  },
  [FOLDER]: {
    url: FOLDER,
    status: 'folder',
    sourceId: SRC,
    warnings: [],
    folder: { name: '応用数学', childCount: 2 },
    files: [{ id: doc, name: '第3回.pptx', sizeBytes: 2048 }],
    folders: [{ name: '解答', url: 'https://example-my.sharepoint.com/personal/t/解答' }],
    truncated: false,
  },
};

async function connect(surface: 'local' | 'remote', extra: Partial<McpDeps> = {}) {
  const proposals = new ProposalStore(path.join(tmp, 'proposals'), { clock: uc.clock });
  const server = createMcpServer({
    uc,
    proposals,
    surface,
    openLink: (url, o) => {
      calls.push({ url, extract: o.extract });
      return Promise.resolve(
        reports[url] ?? {
          url,
          status: 'forbidden',
          reason: 'このアカウントには開く権限がありません',
          warnings: [],
        },
      );
    },
    fileLink: (id) => {
      linked.push(id);
      return { url: 'https://uc.example.test/files/TOKEN', expiresAt: '2026-10-01T00:10:00Z' };
    },
    ...extra,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'open-link-test', version: '0.0.0' });
  await client.connect(b);
  return client;
}

async function call(client: Client, args: Record<string, unknown>) {
  const res = await client.callTool({ name: 'open_link', arguments: args });
  return {
    isError: res.isError === true,
    envelope: res.structuredContent as unknown as McpEnvelope<Record<string, unknown>>,
    text: JSON.stringify(res.content),
  };
}

beforeAll(async () => {
  ({ uc } = await createSeeded());
  tmp = mkdtempSync(path.join(tmpdir(), 'uc-mcp-open-link-'));
  const store = new EntityStore(uc.db, { clock: uc.clock });
  const put = (input: Parameters<EntityStore['upsert']>[0]) =>
    store.upsert(input, { sourceId: SRC });
  put({
    id: doc,
    kind: 'document',
    title: '第3回.pptx',
    courseOfferingId: course,
    extra: { platform: 'teams' },
  });
  ['正規化の続き', 'BCNF'].forEach((text, i) =>
    put({
      id: stableId('documentChunk', SRC, 'linked-slides', String(i)),
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

describe('open_link', () => {
  it('a file: document id, local path, course and the text with slide markers', async () => {
    const client = await connect('local');
    const r = await call(client, { url: LINK });
    expect(r.isError).toBe(false);
    const data = r.envelope.data;
    expect(data.status).toBe('file');
    expect(data.file).toMatchObject({
      id: doc,
      status: 'downloaded',
      path: 'C:\\Users\\student\\files\\第3回.pptx',
      course: { title: 'データベース論' },
    });
    expect(data.text).toMatchObject({
      excerpt: '[スライド 1]\n正規化の続き\n\n[スライド 2]\nBCNF',
      truncated: false,
    });
    expect(calls.at(-1)).toEqual({ url: LINK, extract: true });
    const tool = (await client.listTools()).tools.find((t) => t.name === 'open_link');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.description).toContain('SharePoint');
  });

  it('remote: no local path; a short-lived link only when asked', async () => {
    const client = await connect('remote');
    const plain = await call(client, { url: LINK });
    expect(plain.envelope.data.file).not.toHaveProperty('path');
    expect(plain.text).not.toContain('C:\\\\Users');
    expect(linked).toEqual([]);
    const withLink = await call(client, { url: LINK, link: true });
    expect(withLink.envelope.data.link).toEqual({
      url: 'https://uc.example.test/files/TOKEN',
      expiresAt: '2026-10-01T00:10:00Z',
    });
    expect(linked).toEqual([doc]);
  });

  it('a folder: its files with ids and its subfolders', async () => {
    const client = await connect('remote');
    const r = await call(client, { url: FOLDER });
    expect(r.envelope.data).toMatchObject({
      status: 'folder',
      folder: { name: '応用数学' },
      files: [{ id: doc, name: '第3回.pptx' }],
      folders: [{ name: '解答' }],
      truncated: false,
    });
  });

  it('a link it cannot open: status and reason, and a hint not to guess', async () => {
    const client = await connect('remote');
    const r = await call(client, { url: 'https://example.sharepoint.com/:b:/s/x/Eprivate' });
    expect(r.isError).toBe(false);
    expect(r.envelope.data).toMatchObject({
      status: 'forbidden',
      reason: 'このアカウントには開く権限がありません',
    });
    expect(r.envelope.answerHint).toContain('推測');
  });

  it('every surface tells the AI to open such links instead of asking the student', () => {
    for (const s of [
      SERVER_INSTRUCTIONS,
      REMOTE_SERVER_INSTRUCTIONS,
      REMOTE_WRITE_SERVER_INSTRUCTIONS,
    ])
      expect(s).toContain('open_link');
  });
});
