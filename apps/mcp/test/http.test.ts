import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { UniContext } from '@unicontext/context-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleMcpHttp, ProposalStore, type McpDeps, type McpEnvelope } from '../src/index.js';
import { createSeeded } from './seeded.js';

let uc: UniContext;
let tmp: string;
let deps: McpDeps;
let raw: Server;
let withBody: Server;
let rawUrl: URL;
let bodyUrl: URL;

function listen(server: Server): Promise<URL> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(new URL(`http://127.0.0.1:${port}/mcp`));
    });
  });
}

async function readBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

beforeAll(async () => {
  ({ uc } = await createSeeded());
  tmp = mkdtempSync(path.join(tmpdir(), 'uc-mcp-http-'));
  deps = { uc, proposals: new ProposalStore(path.join(tmp, 'proposals'), { clock: uc.clock }) };
  // raw req/res, the SDK reads the body itself
  raw = createServer((req, res) => {
    void handleMcpHttp(deps, req, res);
  });
  // simulates the daemon (Fastify) that already parsed the body
  withBody = createServer((req, res) => {
    void (async () => {
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      await handleMcpHttp(deps, req, res, body);
    })();
  });
  rawUrl = await listen(raw);
  bodyUrl = await listen(withBody);
});

afterAll(async () => {
  await Promise.all([raw, withBody].map((s) => new Promise((r) => s.close(() => r(undefined)))));
  await uc.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function connect(url: URL): Promise<Client> {
  const client = new Client({ name: 'http-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

async function callEnvelope(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError).not.toBe(true);
  return JSON.parse((res.content as { text: string }[])[0]?.text ?? '{}') as McpEnvelope<
    Record<string, unknown>
  >;
}

describe('handleMcpHttp (stateless streamable HTTP)', () => {
  it('serves tools/list and tools/call over a real loopback socket', async () => {
    expect(new URL(rawUrl).hostname).toBe('127.0.0.1');
    const client = await connect(rawUrl);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['get_today', 'correct_fact', 'get_source']));
      const env = await callEnvelope(client, 'get_today');
      expect(env.citations.length).toBeGreaterThan(0);
      expect(env.conflicts.some((c) => c.includes('21教室') && c.includes('11教室'))).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('works when the caller already parsed the body (Fastify hijack)', async () => {
    const client = await connect(bodyUrl);
    try {
      const env = await callEnvelope(client, 'get_deadlines', { days: 14 });
      expect(env.data.view).toBe('deadline');
      expect((await client.readResource({ uri: 'unicontext://today' })).contents).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it('is stateless: no session id is issued and independent clients do not interfere', async () => {
    const res = await fetch(rawUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'curl', version: '0' },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const json = (await res.json()) as {
      result: { serverInfo: { name: string }; instructions: string };
    };
    expect(json.result.serverInfo.name).toBe('unicontext');
    expect(json.result.instructions).toContain('propose-only');

    // a tools/call with no prior initialize on this connection still works (no per-session state)
    const call = await fetch(rawUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_conflicts', arguments: {} },
      }),
    });
    expect(call.status).toBe(200);

    const [a, b] = await Promise.all([connect(rawUrl), connect(bodyUrl)]);
    try {
      const [x, y] = await Promise.all([
        callEnvelope(a, 'get_week'),
        callEnvelope(b, 'get_tomorrow'),
      ]);
      expect(x.data.view).toBe('week');
      expect(y.data.view).toBe('tomorrow');
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it('answers GET and DELETE with 405 (no server-initiated streams)', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(rawUrl, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
      const body = (await res.json()) as { error: { code: number } };
      expect(body.error.code).toBe(-32000);
    }
  });

  it('garbage bodies get a JSON-RPC error and do not take the server down', async () => {
    const res = await fetch(rawUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{not json',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const client = await connect(rawUrl);
    try {
      expect((await callEnvelope(client, 'get_today')).citations.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it('correct_fact over HTTP stores a pending proposal that another store instance can see', async () => {
    const client = await connect(rawUrl);
    try {
      const env = await callEnvelope(client, 'correct_fact', {
        subject: 'プログラミング演習',
        predicate: 'room',
        value: '情報学部1号館演習室',
      });
      const id = (env.data as { proposalId: string }).proposalId;
      const other = new ProposalStore(path.join(tmp, 'proposals'), { clock: uc.clock });
      expect(other.get(id)?.status).toBe('pending');
    } finally {
      await client.close();
    }
  });
});
