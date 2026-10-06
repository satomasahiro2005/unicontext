import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supportsFileDownloads, type FileDownloadAdapter } from '@unicontext/connector-sdk';
import type { FetchLike, SecretStore } from '@unicontext/core';
import { loadMappingFile, type MappingSpec } from '@unicontext/mapping';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAPPINGS_DIR, McpConfigSchema, McpSourceAdapter } from '../src/index.js';
import { createEdServer, inMemoryFactory } from './fixtures/servers.js';

/*
 * Ed attachments: a plain HTTPS GET of the document's url on edusercontent.com, nothing else. The
 * fake file host below is a real local HTTP server; the adapter's `fileFetch` maps the Ed hostnames
 * onto it, so every byte goes through the adapter's own request code.
 */

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
}

const MAX = 4000;

class MemorySecrets implements SecretStore {
  readonly backend = 'memory';
  get(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }
  set(): Promise<void> {
    return Promise.resolve();
  }
  delete(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
let server: Server;
let port = 0;
const seen: Seen[] = [];
const everything: Seen[] = [];
const requestedUrls: string[] = [];
const tmp = mkdtempSync(join(tmpdir(), 'uc-file-download-'));

beforeAll(async () => {
  server = createServer((req, res) => {
    const entry = { method: req.method ?? '', url: req.url ?? '', headers: req.headers };
    seen.push(entry);
    everything.push(entry);
    const url = req.url ?? '';
    if (url === '/files/ok') {
      res.writeHead(200, { 'content-type': 'application/pdf; charset=binary' });
      res.end('%PDF-1.4 hello');
    } else if (url === '/files/redirect') {
      res.writeHead(302, { location: '/files/ok' });
      res.end();
    } else if (url === '/files/declared-big') {
      res.writeHead(200, { 'content-length': String(MAX * 10) });
      res.end(Buffer.alloc(MAX * 10, 1));
    } else if (url === '/files/streamed-big') {
      // no content-length: the cap has to hold while streaming
      res.writeHead(200, { 'transfer-encoding': 'chunked' });
      for (let i = 0; i < 20; i++) res.write(Buffer.alloc(1000, 2));
      res.end();
    } else if (url === '/files/missing') {
      res.writeHead(404);
      res.end('no');
    } else {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmp, { recursive: true, force: true });
});

/** The adapter's HTTP: every URL it asks for is recorded, then served by the local fake host. */
const fileFetch: FetchLike = (input, init) => {
  requestedUrls.push(input);
  const u = new URL(input);
  return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
};

function edAdapter(spec?: MappingSpec): FileDownloadAdapter {
  const adapter = new McpSourceAdapter({
    sourceId: 'ed',
    spec: spec ?? loadMappingFile(join(MAPPINGS_DIR, 'edstem-mcp.yaml')),
    config: McpConfigSchema.parse({ command: 'fake-mcp-server' }),
    secrets: new MemorySecrets(),
    transportFactory: inMemoryFactory(() => createEdServer()),
    runOptions: { fileFetch },
  });
  if (!supportsFileDownloads(adapter))
    throw new Error('the Ed mapping should offer file downloads');
  return adapter;
}

const EDU = 'https://static.edusercontent.com';
const request = (name: string, url: string, maxBytes = 1_000_000) => ({
  externalId: url,
  payload: {},
  targetPath: join(tmp, name, 'file.bin'),
  maxBytes,
  extract: false,
});

describe('Ed file downloads (mapping `files:`)', () => {
  it('a mapping without `files` offers no downloads', () => {
    const spec = loadMappingFile(join(MAPPINGS_DIR, 'canvas-mcp.yaml'));
    const adapter = new McpSourceAdapter({
      sourceId: 'canvas',
      spec,
      config: McpConfigSchema.parse({ command: 'fake-mcp-server' }),
      secrets: new MemorySecrets(),
      transportFactory: inMemoryFactory(() => createEdServer()),
    });
    expect(supportsFileDownloads(adapter)).toBe(false);
  });

  it('describes a document by its url on the allowed hosts only', () => {
    const adapter = edAdapter();
    const doc = {
      url: `${EDU}/files/ok`,
      title: 'lab1.pdf',
      path: '/Ed Lessons/第1回/当日の講義資料/lab1.pdf',
      mimeType: 'application/pdf',
    };
    // the raw item is the lesson: the document says which of its files is meant
    const info = adapter.describeFile({
      sourceType: 'edstem.lesson_detail',
      externalId: '2001',
      payload: { id: 2001 },
      document: doc,
    } as never);
    expect(info).toMatchObject({
      externalId: `${EDU}/files/ok`,
      name: 'lab1.pdf',
      folder: 'Ed Lessons/第1回/当日の講義資料',
      mimeType: 'application/pdf',
    });
    // a raw item that is itself a file (lesson_file) carries its own url
    expect(
      adapter.describeFile({
        sourceType: 'edstem.lesson_file',
        externalId: `${EDU}/files/ok`,
        payload: { url: `${EDU}/files/ok`, filename: 'x.pdf', mediaType: 'application/pdf' },
      }),
    ).toMatchObject({ name: 'x.pdf', mimeType: 'application/pdf' });
    // Ed's own pages, other hosts, http and lookalikes are not files UniContext fetches
    for (const url of [
      'https://edstem.org/au/courses/55/lessons/2001',
      'https://evil.example.com/files/ok',
      'http://static.edusercontent.com/files/ok',
      'https://edusercontent.com.evil.example/files/ok',
      'https://user:pw@static.edusercontent.com/files/ok',
    ])
      expect(
        adapter.describeFile({
          sourceType: 'edstem.lesson_detail',
          externalId: '2001',
          payload: {},
          document: { ...doc, url },
        } as never),
      ).toBeUndefined();
    // the bare domain and any subdomain of the allowlist match
    expect(
      adapter.describeFile({
        sourceType: 'x',
        externalId: 'e',
        payload: { url: 'https://edusercontent.com/a.pdf' },
      }),
    ).toBeDefined();
  });

  it('fetches an Ed file on edusercontent.com with a plain GET: no Authorization, no cookie', async () => {
    seen.length = 0;
    requestedUrls.length = 0;
    const adapter = edAdapter();
    const req = request('ok', `${EDU}/files/ok`);
    const out = await adapter.downloadFiles([req]);
    expect(out.results).toEqual([
      {
        externalId: req.externalId,
        status: 'downloaded',
        bytes: 14,
        contentType: 'application/pdf',
        version: req.externalId,
      },
    ]);
    expect(readFileSync(req.targetPath, 'utf8')).toBe('%PDF-1.4 hello');
    expect(existsSync(`${req.targetPath}.part`)).toBe(false);
    expect(requestedUrls).toEqual([`${EDU}/files/ok`]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.headers.authorization).toBeUndefined();
    expect(seen[0]?.headers.cookie).toBeUndefined();
    expect(seen[0]?.headers['proxy-authorization']).toBeUndefined();
  });

  it('refuses a host that is not allowlisted before any request is made', async () => {
    seen.length = 0;
    requestedUrls.length = 0;
    const adapter = edAdapter();
    const bad = [
      'https://evil.example.com/files/ok',
      'https://edstem.org/api/files/ok',
      'https://edusercontent.com.evil.example/files/ok',
      'http://static.edusercontent.com/files/ok',
    ];
    const out = await adapter.downloadFiles(bad.map((u, i) => request(`bad${i}`, u)));
    expect(out.results.map((r) => r.status)).toEqual(['failed', 'failed', 'failed', 'failed']);
    expect(requestedUrls).toEqual([]);
    expect(seen).toEqual([]);
    expect(readdirSync(tmp).filter((n) => n.startsWith('bad'))).toEqual([]);
  });

  it('refuses a redirect (3xx is a failure and is not followed)', async () => {
    seen.length = 0;
    const adapter = edAdapter();
    const req = request('redirect', `${EDU}/files/redirect`);
    const out = await adapter.downloadFiles([req]);
    expect(out.results[0]).toMatchObject({ status: 'failed' });
    expect(out.results[0]?.error).toMatch(/redirect refused \(HTTP 302\)/);
    expect(seen.map((s) => s.url)).toEqual(['/files/redirect']);
    expect(existsSync(req.targetPath)).toBe(false);
  });

  it('refuses an oversize body, declared or streamed, and leaves nothing on disk', async () => {
    seen.length = 0;
    const adapter = edAdapter();
    const declared = request('declared', `${EDU}/files/declared-big`, MAX);
    const streamed = request('streamed', `${EDU}/files/streamed-big`, MAX);
    const out = await adapter.downloadFiles([declared, streamed]);
    expect(out.results.map((r) => r.status)).toEqual(['tooLarge', 'tooLarge']);
    for (const r of [declared, streamed]) {
      expect(existsSync(r.targetPath)).toBe(false);
      expect(existsSync(`${r.targetPath}.part`)).toBe(false);
    }
    // the mapping's own cap applies even when the caller allows more
    const small = loadMappingFile(join(MAPPINGS_DIR, 'edstem-mcp.yaml'));
    const capped = edAdapter({ ...small, files: { ...small.files!, maxBytes: 5 } });
    const res = await capped.downloadFiles([request('capped', `${EDU}/files/ok`, 1_000_000)]);
    expect(res.results[0]?.status).toBe('tooLarge');
  });

  it('reports a missing file as notFound, and an extract-only request only for a file that is on disk', async () => {
    const adapter = edAdapter();
    const onDisk = request('on-disk', `${EDU}/files/ok`);
    await adapter.downloadFiles([onDisk]);
    seen.length = 0;
    const out = await adapter.downloadFiles([
      request('missing', `${EDU}/files/missing`),
      { ...onDisk, extractOnly: true },
      { ...request('gone', `${EDU}/files/ok`), extractOnly: true },
    ]);
    expect(out.results.map((r) => r.status)).toEqual(['notFound', 'extracted', 'failed']);
    expect(out.results[2]?.error).toBe('the file is not on disk');
    // extract-only fetches nothing (only the missing file was asked for)
    expect(seen.map((x) => x.url)).toEqual(['/files/missing']);
  });

  it('never sends anything but GET to the file host', () => {
    expect(everything.length).toBeGreaterThan(0);
    expect(everything.filter((s) => s.method !== 'GET')).toEqual([]);
  });
});
