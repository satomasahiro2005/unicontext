import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ConfigSchema } from '@unicontext/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon, type RunningDaemon } from '../src/daemon.js';
import { createRemoteServer, remoteRequestInfo, type RemoteServer } from '../src/remote/server.js';
import { hashPassphrase } from '../src/remote/passphrase.js';
import { RemoteStateStore } from '../src/remote/state.js';
import { tunnelConfigYaml } from '../src/remote/tunnel.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

const PUBLIC = 'https://uc.example.test';
const RESOURCE = `${PUBLIC}/mcp`;
const CHATGPT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const PASS = 'correct horse battery staple';
const FAST = { N: 1024, r: 8, p: 1 };

const s256 = (v: string): string => createHash('sha256').update(v).digest('base64url');
const VERIFIER = 'v'.repeat(20) + 'erifier-0123456789-abcdefghijklmnop';

let dir: string;
let runtime: Runtime;
let now = new Date('2026-10-01T00:00:00.000Z');
const audit: Record<string, unknown>[] = [];

function remoteConfig(extra: Record<string, unknown> = {}) {
  return ConfigSchema.parse({
    remote: { enabled: true, publicUrl: PUBLIC, ...extra },
  });
}

async function makeServer(
  file: string,
  fetchImpl?: typeof fetch,
  configExtra: Record<string, unknown> = {},
): Promise<RemoteServer> {
  const store = new RemoteStateStore(path.join(dir, file), () => now);
  store.setPassphrase(await hashPassphrase(PASS, FAST));
  const rt: Runtime = { ...runtime, config: remoteConfig(configExtra) };
  const server = await createRemoteServer({
    runtime: rt,
    version: '1.0.0-test',
    store,
    now: () => now,
    audit: (e) => void audit.push(e),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  await server.app.ready();
  return server;
}

interface InjectOptions {
  headers?: Record<string, string>;
  form?: Record<string, string>;
  json?: unknown;
  ip?: string;
  remoteAddress?: string;
}

function inject(
  s: RemoteServer,
  method: 'GET' | 'POST' | 'OPTIONS',
  url: string,
  o: InjectOptions = {},
) {
  const headers: Record<string, string> = {
    host: 'uc.example.test',
    'x-forwarded-proto': 'https',
    'cf-connecting-ip': o.ip ?? '198.51.100.7',
    ...(o.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    ...(o.json !== undefined ? { 'content-type': 'application/json' } : {}),
    ...o.headers,
  };
  return s.app.inject({
    method,
    url,
    headers,
    ...(o.remoteAddress ? { remoteAddress: o.remoteAddress } : {}),
    ...(o.form ? { payload: new URLSearchParams(o.form).toString() } : {}),
    ...(o.json !== undefined ? { payload: JSON.stringify(o.json) } : {}),
  });
}

const body = <T = Record<string, unknown>>(res: { body: string }): T => JSON.parse(res.body) as T;

async function register(s: RemoteServer, extra: Record<string, unknown> = {}, ip?: string) {
  const res = await inject(s, 'POST', '/register', {
    json: {
      redirect_uris: [CHATGPT],
      client_name: 'ChatGPT',
      token_endpoint_auth_method: 'none',
      ...extra,
    },
    ...(ip ? { ip } : {}),
  });
  return { res, client: body<{ client_id: string; client_secret?: string }>(res) };
}

function authorizeQuery(clientId: string, extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CHATGPT,
    code_challenge: s256(VERIFIER),
    code_challenge_method: 'S256',
    state: 'st-1',
    resource: RESOURCE,
    scope: 'unicontext.read offline_access',
    ...extra,
  }).toString();
}

async function consent(s: RemoteServer, clientId: string, extra: Record<string, string> = {}) {
  const page = await inject(s, 'GET', `/authorize?${authorizeQuery(clientId, extra)}`);
  expect(page.statusCode, page.body).toBe(200);
  const sealed = /name="request" value="([^"]+)"/.exec(page.body)?.[1];
  expect(sealed).toBeTruthy();
  return { page, sealed: sealed as string };
}

async function getCode(s: RemoteServer, clientId: string, ip = '198.51.100.7'): Promise<string> {
  const { sealed } = await consent(s, clientId);
  const res = await inject(s, 'POST', '/authorize', {
    form: { request: sealed, passphrase: PASS, action: 'approve' },
    ip,
  });
  expect(res.statusCode, res.body).toBe(303);
  const loc = new URL(res.headers.location as string);
  expect(loc.origin + loc.pathname).toBe(CHATGPT);
  expect(loc.searchParams.get('iss')).toBe(PUBLIC);
  expect(loc.searchParams.get('state')).toBe('st-1');
  return loc.searchParams.get('code') as string;
}

async function exchange(
  s: RemoteServer,
  clientId: string,
  code: string,
  extra: Record<string, string> = {},
) {
  return inject(s, 'POST', '/token', {
    form: {
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: CHATGPT,
      code_verifier: VERIFIER,
      resource: RESOURCE,
      ...extra,
    },
  });
}

async function tokens(s: RemoteServer) {
  const { client } = await register(s);
  const code = await getCode(s, client.client_id);
  const res = await exchange(s, client.client_id, code);
  expect(res.statusCode, res.body).toBe(200);
  return {
    clientId: client.client_id,
    ...body<{ access_token: string; refresh_token: string; expires_in: number; scope: string }>(
      res,
    ),
  };
}

function mcp(
  s: RemoteServer,
  token: string | undefined,
  payload: unknown,
  extra: InjectOptions = {},
) {
  return inject(s, 'POST', '/mcp', {
    json: payload,
    headers: {
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra.headers,
    },
    ...(extra.remoteAddress ? { remoteAddress: extra.remoteAddress } : {}),
  });
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'uc-remote-test-'));
  runtime = await createRuntime({
    dev: true,
    dataDir: dir,
    noKeychain: true,
    logSink: () => undefined,
  });
}, 60_000);

afterAll(async () => {
  await runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('discovery metadata', () => {
  let s: RemoteServer;
  beforeAll(async () => {
    s = await makeServer('meta.json');
  });
  afterAll(() => s.app.close());

  it('serves RFC 9728 protected resource metadata (plain and path-suffixed)', async () => {
    for (const url of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const res = await inject(s, 'GET', url);
      expect(res.statusCode).toBe(200);
      expect(body(res)).toMatchObject({
        resource: RESOURCE,
        authorization_servers: [PUBLIC],
        scopes_supported: ['unicontext.read', 'unicontext.write', 'offline_access'],
      });
    }
  });

  it('serves RFC 8414 AS metadata with S256, iss, CIMD and DCR', async () => {
    for (const url of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
    ]) {
      const m = body(await inject(s, 'GET', url));
      expect(m).toMatchObject({
        issuer: PUBLIC,
        authorization_endpoint: `${PUBLIC}/authorize`,
        token_endpoint: `${PUBLIC}/token`,
        registration_endpoint: `${PUBLIC}/register`,
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true,
      });
      expect(m.token_endpoint_auth_methods_supported).toContain('none');
    }
  });

  it('answers /mcp without a token with 401 + WWW-Authenticate resource_metadata', async () => {
    const res = await mcp(s, undefined, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe(
      `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp", scope="unicontext.read unicontext.write"`,
    );
    const bad = await mcp(s, 'uca_nope', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(bad.statusCode).toBe(401);
    expect(bad.headers['www-authenticate']).toContain('error="invalid_token"');
  });

  it('CORS preflight for the MCP endpoint', async () => {
    const res = await inject(s, 'OPTIONS', '/mcp', { headers: { origin: 'https://example.org' } });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-headers']).toContain('authorization');
    expect(res.headers['access-control-expose-headers']).toContain('www-authenticate');
  });

  it('has none of the local admin API or Web UI routes', async () => {
    for (const url of ['/api/v1/health', '/api/v1/today', '/api/v1/settings', '/index.html']) {
      const res = await inject(s, 'GET', url);
      expect(res.statusCode, url).toBe(404);
    }
  });
});

describe('forwarded header trust', () => {
  let s: RemoteServer;
  beforeAll(async () => {
    s = await makeServer('trust.json');
  });
  afterAll(() => s.app.close());

  it('honours X-Forwarded-* and CF-Connecting-IP only from a trusted peer', () => {
    const headers = {
      host: '127.0.0.1:17879',
      'x-forwarded-host': 'uc.example.test',
      'x-forwarded-proto': 'https',
      'cf-connecting-ip': '203.0.113.9',
      'x-forwarded-for': '203.0.113.10, 10.0.0.1',
    };
    const trusted = remoteRequestInfo(
      { headers, socket: { remoteAddress: '127.0.0.1' } } as never,
      ['127.0.0.1'],
    );
    expect(trusted).toMatchObject({
      trustedPeer: true,
      proto: 'https',
      host: 'uc.example.test',
      ip: '203.0.113.9',
    });
    const untrusted = remoteRequestInfo(
      { headers, socket: { remoteAddress: '192.0.2.4' } } as never,
      ['127.0.0.1'],
    );
    expect(untrusted).toMatchObject({
      trustedPeer: false,
      proto: 'http',
      host: '127.0.0.1:17879',
      ip: '192.0.2.4',
    });
  });

  it('rejects an unexpected Host (DNS rebinding) with 421', async () => {
    const res = await inject(s, 'GET', '/.well-known/oauth-protected-resource', {
      headers: { host: 'evil.example' },
    });
    expect(res.statusCode).toBe(421);
  });

  it('rejects plain http (no X-Forwarded-Proto: https) when publicUrl is https', async () => {
    const res = await inject(s, 'GET', '/.well-known/oauth-protected-resource', {
      headers: { 'x-forwarded-proto': 'http' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('ignores forwarded headers from an untrusted peer', async () => {
    const res = await inject(s, 'GET', '/.well-known/oauth-protected-resource', {
      remoteAddress: '192.0.2.4',
    });
    // proto falls back to http for an untrusted peer
    expect(res.statusCode).toBe(403);
    const forgedHost = await inject(s, 'GET', '/.well-known/oauth-protected-resource', {
      remoteAddress: '192.0.2.4',
      headers: { host: '127.0.0.1:17879', 'x-forwarded-host': 'uc.example.test' },
    });
    expect(forgedHost.statusCode).toBe(421);
  });
});

describe('dynamic client registration', () => {
  let s: RemoteServer;
  beforeAll(async () => {
    s = await makeServer('dcr.json');
  });
  afterAll(() => s.app.close());

  it('registers a public client for ChatGPT and claude.ai callbacks', async () => {
    const { res, client } = await register(s, {
      redirect_uris: [CHATGPT, 'https://chatgpt.com/connector/oauth/abc123', CLAUDE],
    });
    expect(res.statusCode).toBe(201);
    expect(client.client_id).toMatch(/^ucc_/);
    expect(client.client_secret).toBeUndefined();
    expect(s.store.read().clients[client.client_id]?.redirectUris).toHaveLength(3);
  });

  it('issues a hashed client secret for confidential clients', async () => {
    const { res, client } = await register(s, { token_endpoint_auth_method: 'client_secret_post' });
    expect(res.statusCode).toBe(201);
    expect(client.client_secret).toMatch(/^ucs_/);
    const stored = s.store.read().clients[client.client_id];
    expect(stored?.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(s.store.read())).not.toContain(client.client_secret as string);
  });

  it('refuses redirect URIs outside the allowlist', async () => {
    for (const uri of [
      'https://evil.example/cb',
      'https://chatgpt.com.evil.example/connector_platform_oauth_redirect',
      'http://chatgpt.com/connector_platform_oauth_redirect',
      'https://chatgpt.com/connector/oauth/../../x',
    ]) {
      const { res } = await register(s, { redirect_uris: [uri] });
      expect(res.statusCode, uri).toBe(400);
      expect(body(res).error).toBe('invalid_redirect_uri');
    }
  });

  it('refuses unsupported grant types and auth methods', async () => {
    expect((await register(s, { grant_types: ['client_credentials'] })).res.statusCode).toBe(400);
    expect(
      (await register(s, { token_endpoint_auth_method: 'private_key_jwt' })).res.statusCode,
    ).toBe(400);
    expect((await register(s, { redirect_uris: [] })).res.statusCode).toBe(400);
  });
});

describe('authorization code + PKCE + resource binding', () => {
  let s: RemoteServer;
  beforeAll(async () => {
    s = await makeServer('flow.json');
  });
  afterAll(() => s.app.close());

  it('issues tokens through the full flow and serves read tools only', async () => {
    const t = await tokens(s);
    expect(t.access_token).toMatch(/^uca_/);
    expect(t.refresh_token).toMatch(/^ucr_/);
    expect(t.expires_in).toBe(3600);
    expect(t.scope).toBe('unicontext.read offline_access');
    const state = JSON.stringify(s.store.read());
    expect(state).not.toContain(t.access_token);
    expect(state).not.toContain(t.refresh_token);

    const list = await mcp(s, t.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(list.statusCode, list.body).toBe(200);
    const tools = body<{
      result: {
        tools: {
          name: string;
          annotations?: Record<string, unknown>;
          outputSchema?: unknown;
          description?: string;
        }[];
      };
    }>(list).result.tools;
    const names = tools.map((x) => x.name);
    expect(names).toContain('get_today');
    expect(names).not.toContain('correct_fact');
    expect(names).not.toContain('propose_pace_slot');
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      expect(tool.outputSchema, tool.name).toBeTruthy();
      expect(tool.description ?? '', tool.name).not.toMatch(
        /personal information|no auth|password|個人情報/i,
      );
    }

    audit.length = 0;
    const call = await mcp(s, t.access_token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_today', arguments: {} },
    });
    expect(call.statusCode).toBe(200);
    const result = body<{
      result: { structuredContent: { citations: unknown[] }; isError?: boolean };
    }>(call).result;
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.citations.length).toBeGreaterThan(0);
    const toolEvents = audit.filter((e) => e.event === 'tool');
    expect(toolEvents).toEqual([
      expect.objectContaining({
        tool: 'get_today',
        ok: true,
        clientId: t.clientId,
        ip: '198.51.100.7',
      }),
    ]);
    expect(JSON.stringify(toolEvents)).not.toContain('arguments');
  });

  it('refuses calling a write tool on the remote surface', async () => {
    const t = await tokens(s);
    const res = await mcp(s, t.access_token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'correct_fact', arguments: { subject: 'x', predicate: 'room', value: 'y' } },
    });
    const out = body<{ result?: { isError?: boolean }; error?: unknown }>(res);
    expect(out.error ?? out.result?.isError).toBeTruthy();
    expect(runtime.proposals.list({ status: 'pending' })).toHaveLength(0);
  });

  it('write scope: the owner grants it with the consent checkbox; read-only clients keep working', async () => {
    type ToolList = {
      result: { tools: { name: string; annotations?: Record<string, unknown> }[] };
    };
    const writeQuery = { scope: 'unicontext.read unicontext.write offline_access' };
    const approveWith = async (
      clientId: string,
      query: Record<string, string>,
      form: Record<string, string>,
    ) => {
      const { page, sealed } = await consent(s, clientId, query);
      const res = await inject(s, 'POST', '/authorize', {
        form: { request: sealed, passphrase: PASS, action: 'approve', ...form },
        // its own address: the per-address unlock limiter is shared with the other flow tests
        ip: '198.51.100.88',
      });
      expect(res.statusCode, res.body).toBe(303);
      const code = new URL(res.headers.location as string).searchParams.get('code') as string;
      const tok = await exchange(s, clientId, code);
      expect(tok.statusCode, tok.body).toBe(200);
      return {
        page,
        token: body<{ access_token: string; refresh_token: string; scope: string }>(tok),
      };
    };
    const toolNames = async (token: string) =>
      body<ToolList>(await mcp(s, token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).result
        .tools;

    // Asked for write, owner leaves the box ticked: write granted.
    const { client: rw } = await register(s);
    const granted = await approveWith(rw.client_id, writeQuery, { write: '1' });
    expect(granted.page.body).toMatch(/name="write" value="1" checked/);
    expect(granted.token.scope).toBe('unicontext.read unicontext.write offline_access');
    const tools = await toolNames(granted.token.access_token);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'ingest_lecture',
        'record_lecture',
        'add_deadline',
        'add_note',
        'add_task',
      ]),
    );
    expect(names).toEqual(expect.arrayContaining(['list_my_additions', 'retract_addition']));
    expect(names).not.toContain('correct_fact');
    expect(names).not.toContain('propose_pace_slot');
    const isWrite = (n: string): boolean =>
      /^(ingest_lecture|record_lecture|add_deadline|add_note|add_task|set_travel_time|set_course_condition|add_session_rule|record_task_progress|ingest_external_signal|list_my_additions|retract_addition|open_announcement)$/.test(
        n,
      );
    for (const t of tools) expect(t.annotations?.readOnlyHint, t.name).toBe(!isWrite(t.name));

    audit.length = 0;
    const call = await mcp(s, granted.token.access_token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'add_task',
        arguments: {
          course: 'データベースシステム論',
          title: 'ER図の復習',
          evidence: '秘密のメモ: 次回までにER図を見直すこと',
          recordingTimestamp: '00:10:00',
        },
      },
    });
    const result = body<{
      result: {
        structuredContent: { status: string; addition: { id: string } };
        isError?: boolean;
      };
    }>(call).result;
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent.status).toBe('created');
    const ev = audit.find((e) => e.event === 'tool' && e.tool === 'add_task');
    expect(ev).toMatchObject({
      ok: true,
      clientId: rw.client_id,
      write: 'created',
      additionId: result.structuredContent.addition.id,
    });
    expect(String(ev?.factIds)).toMatch(/^fact:/);
    expect(JSON.stringify(audit)).not.toContain('秘密のメモ');
    expect(JSON.stringify(audit)).not.toContain('ER図の復習');
    expect(runtime.uc.additions.get(result.structuredContent.addition.id)?.client.id).toBe(
      rw.client_id,
    );

    // Refreshing keeps the grant's scope.
    const refreshed = await inject(s, 'POST', '/token', {
      form: {
        grant_type: 'refresh_token',
        client_id: rw.client_id,
        refresh_token: granted.token.refresh_token,
      },
    });
    expect(body<{ scope: string }>(refreshed).scope).toBe(
      'unicontext.read unicontext.write offline_access',
    );

    // Asked for write, owner unticks the box: read-only grant, no write tools.
    const { client: ro } = await register(s);
    const denied = await approveWith(ro.client_id, writeQuery, {});
    expect(denied.token.scope).toBe('unicontext.read offline_access');
    const roNames = (await toolNames(denied.token.access_token)).map((t) => t.name);
    expect(roNames).toContain('get_today');
    expect(roNames).not.toContain('add_deadline');
    const refused = await mcp(s, denied.token.access_token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'add_task', arguments: { course: 'データベース', title: 'x' } },
    });
    const out = body<{ result?: { isError?: boolean }; error?: unknown }>(refused);
    expect(out.error ?? out.result?.isError).toBeTruthy();

    // A client that never asked: the box starts unticked.
    const { client: legacy } = await register(s);
    const { page } = await consent(s, legacy.client_id);
    expect(page.body).toMatch(/name="write" value="1">/);
  });

  it('requires PKCE S256 and rejects plain or missing challenges (redirected with iss)', async () => {
    const { client } = await register(s);
    const cases: Record<string, string>[] = [
      { code_challenge_method: 'plain' },
      { code_challenge: '' },
      { response_type: 'token' },
    ];
    for (const extra of cases) {
      const res = await inject(s, 'GET', `/authorize?${authorizeQuery(client.client_id, extra)}`);
      expect(res.statusCode).toBe(302);
      const loc = new URL(res.headers.location as string);
      expect(loc.searchParams.get('error')).toBeTruthy();
      expect(loc.searchParams.get('iss')).toBe(PUBLIC);
    }
  });

  it('never redirects to an unregistered redirect_uri', async () => {
    const { client } = await register(s);
    const res = await inject(
      s,
      'GET',
      `/authorize?${authorizeQuery(client.client_id, { redirect_uri: 'https://chatgpt.com/connector/oauth/other' })}`,
    );
    expect(res.statusCode).toBe(400);
    expect(res.headers.location).toBeUndefined();
  });

  it('binds the resource (RFC 8707): wrong resource at authorize or token is refused', async () => {
    const { client } = await register(s);
    const res = await inject(
      s,
      'GET',
      `/authorize?${authorizeQuery(client.client_id, { resource: 'https://other.example/mcp' })}`,
    );
    expect(new URL(res.headers.location as string).searchParams.get('error')).toBe(
      'invalid_target',
    );
    const code = await getCode(s, client.client_id);
    const bad = await exchange(s, client.client_id, code, {
      resource: 'https://other.example/mcp',
    });
    expect(bad.statusCode).toBe(400);
    expect(body(bad).error).toBe('invalid_target');
  });

  it('rejects a wrong code_verifier, a wrong client and a replayed code', async () => {
    const { client } = await register(s);
    const { client: other } = await register(s);
    const code = await getCode(s, client.client_id);
    const wrongVerifier = await exchange(s, client.client_id, code, {
      code_verifier: `${VERIFIER}x`,
    });
    expect(body(wrongVerifier).error).toBe('invalid_grant');
    const code2 = await getCode(s, client.client_id);
    expect(body(await exchange(s, other.client_id, code2)).error).toBe('invalid_grant');
    const code3 = await getCode(s, client.client_id);
    const ok = await exchange(s, client.client_id, code3);
    expect(ok.statusCode).toBe(200);
    const access = body<{ access_token: string }>(ok).access_token;
    const replay = await exchange(s, client.client_id, code3);
    expect(body(replay).error).toBe('invalid_grant');
    // the replay revoked what the code had produced
    expect((await mcp(s, access, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode).toBe(
      401,
    );
  });

  it('expires authorization codes after a minute and access tokens after their TTL', async () => {
    const { client } = await register(s);
    const code = await getCode(s, client.client_id);
    now = new Date(now.getTime() + 61_000);
    expect(body(await exchange(s, client.client_id, code)).error).toBe('invalid_grant');
    const t = await tokens(s);
    now = new Date(now.getTime() + 3601_000);
    expect(
      (await mcp(s, t.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode,
    ).toBe(401);
  });

  it('authenticates confidential clients by their secret', async () => {
    const { client } = await register(s, { token_endpoint_auth_method: 'client_secret_basic' });
    const code = await getCode(s, client.client_id);
    const noSecret = await exchange(s, client.client_id, code);
    expect(noSecret.statusCode).toBe(401);
    expect(body(noSecret).error).toBe('invalid_client');
    const code2 = await getCode(s, client.client_id);
    const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');
    const res = await inject(s, 'POST', '/token', {
      form: {
        grant_type: 'authorization_code',
        code: code2,
        redirect_uri: CHATGPT,
        code_verifier: VERIFIER,
      },
      headers: { authorization: `Basic ${basic}` },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('denying sends access_denied back to the client', async () => {
    const { client } = await register(s);
    const { sealed } = await consent(s, client.client_id);
    const res = await inject(s, 'POST', '/authorize', {
      form: { request: sealed, action: 'deny' },
    });
    expect(res.statusCode).toBe(303);
    expect(new URL(res.headers.location as string).searchParams.get('error')).toBe('access_denied');
  });

  it('rejects a tampered consent form', async () => {
    const { client } = await register(s);
    const { sealed } = await consent(s, client.client_id);
    const [b, mac] = sealed.split('.');
    const forged = JSON.parse(Buffer.from(b as string, 'base64url').toString('utf8')) as {
      r: { redirectUri: string };
    };
    forged.r.redirectUri = 'https://evil.example/cb';
    const tampered = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${mac}`;
    const res = await inject(s, 'POST', '/authorize', {
      form: { request: tampered, passphrase: PASS, action: 'approve' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers.location).toBeUndefined();
  });
});

describe('refresh tokens and revocation', () => {
  let s: RemoteServer;
  beforeAll(async () => {
    s = await makeServer('refresh.json');
  });
  afterAll(() => s.app.close());

  const refresh = (clientId: string, token: string, extra: Record<string, string> = {}) =>
    inject(s, 'POST', '/token', {
      form: { grant_type: 'refresh_token', client_id: clientId, refresh_token: token, ...extra },
    });

  it('rotates refresh tokens and revokes the grant on reuse', async () => {
    const t = await tokens(s);
    const r1 = await refresh(t.clientId, t.refresh_token, { resource: RESOURCE });
    expect(r1.statusCode, r1.body).toBe(200);
    const n1 = body<{ access_token: string; refresh_token: string }>(r1);
    expect(n1.refresh_token).not.toBe(t.refresh_token);
    expect(
      (await mcp(s, n1.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode,
    ).toBe(200);
    // replay of the rotated token: whole grant dies
    const reuse = await refresh(t.clientId, t.refresh_token);
    expect(body(reuse).error).toBe('invalid_grant');
    expect(body(await refresh(t.clientId, n1.refresh_token)).error).toBe('invalid_grant');
    expect(
      (await mcp(s, n1.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode,
    ).toBe(401);
  });

  it('refuses a refresh with another client or resource; never widens the scope', async () => {
    const t = await tokens(s);
    const { client: other } = await register(s);
    expect(body(await refresh(other.client_id, t.refresh_token)).error).toBe('invalid_grant');
    const wider = await refresh(t.clientId, t.refresh_token, { scope: 'unicontext.write openid' });
    expect(wider.statusCode).toBe(200);
    const w = body<{ scope: string; refresh_token: string }>(wider);
    expect(w.scope).toBe('unicontext.read offline_access');
    t.refresh_token = w.refresh_token;
    expect(
      body(await refresh(t.clientId, t.refresh_token, { resource: 'https://x.example/mcp' })).error,
    ).toBe('invalid_target');
  });

  it('`unicontext remote revoke` (store) cuts off access and refresh immediately', async () => {
    const t = await tokens(s);
    expect(
      (await mcp(s, t.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode,
    ).toBe(200);
    // a second store on the same file, like the CLI process
    const cli = new RemoteStateStore(s.store.file, () => now);
    expect(cli.revokeClient(t.clientId)).toMatchObject({ found: true, grants: 1 });
    expect(
      (await mcp(s, t.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode,
    ).toBe(401);
    expect(body(await refresh(t.clientId, t.refresh_token)).error).toBe('invalid_client');
  });

  it('RFC 7009 revocation endpoint', async () => {
    const t = await tokens(s);
    const res = await inject(s, 'POST', '/revoke', {
      form: { client_id: t.clientId, token: t.refresh_token },
    });
    expect(res.statusCode).toBe(200);
    expect(
      (await mcp(s, t.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode,
    ).toBe(401);
  });
});

describe('passphrase lockout', () => {
  let s: RemoteServer;
  beforeAll(async () => {
    s = await makeServer('lockout.json');
  });
  afterAll(() => s.app.close());

  it('locks after 5 wrong passphrases, persists, and unlocks after the lockout', async () => {
    const { client } = await register(s);
    const attempt = async (passphrase: string, ip: string) => {
      const { sealed } = await consent(s, client.client_id);
      return inject(s, 'POST', '/authorize', {
        form: { request: sealed, passphrase, action: 'approve' },
        ip,
      });
    };
    for (let i = 0; i < 4; i++) {
      const res = await attempt('wrong passphrase!!', `192.0.2.${i}`);
      expect(res.statusCode).toBe(401);
      expect(res.body).toContain(`あと${4 - i}回`);
    }
    const fifth = await attempt('wrong passphrase!!', '192.0.2.50');
    expect(fifth.statusCode).toBe(429);
    // even the right passphrase is refused while locked, from any address
    const locked = await attempt(PASS, '192.0.2.99');
    expect(locked.statusCode).toBe(429);
    expect(locked.headers.location).toBeUndefined();
    const st = new RemoteStateStore(s.store.file).read().owner;
    expect(st.lockedUntil).toBeTruthy();
    expect(st.lockouts).toBe(1);
    expect(audit.some((e) => e.event === 'lockout')).toBe(true);
    now = new Date(Date.parse(st.lockedUntil as string) + 1000);
    const ok = await attempt(PASS, '192.0.2.99');
    expect(ok.statusCode).toBe(303);
  });

  it('rate limits bursts of unlock attempts per address', async () => {
    const { client } = await register(s);
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const { sealed } = await consent(s, client.client_id);
      const res = await inject(s, 'POST', '/authorize', {
        form: { request: sealed, passphrase: PASS, action: 'approve' },
        ip: '192.0.2.200',
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });
});

describe('parallel unlock attempts', () => {
  it('are serialized so a burst cannot exceed the lockout threshold', async () => {
    const s = await makeServer('parallel.json');
    try {
      const { client } = await register(s);
      const forms = await Promise.all(
        Array.from({ length: 8 }, async () => (await consent(s, client.client_id)).sealed),
      );
      const results = await Promise.all(
        forms.map((sealed, i) =>
          inject(s, 'POST', '/authorize', {
            form: { request: sealed, passphrase: 'wrong passphrase!!', action: 'approve' },
            ip: `192.0.2.${100 + i}`,
          }),
        ),
      );
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes.filter((c) => c === 401)).toHaveLength(4);
      expect(codes.filter((c) => c === 429)).toHaveLength(4);
      expect(new RemoteStateStore(s.store.file).read().owner.lockouts).toBe(1);
    } finally {
      await s.app.close();
    }
  });
});

describe('Client ID Metadata Documents', () => {
  const CIMD_URL = 'https://chatgpt.com/oauth/unicontext-client.json';
  let s: RemoteServer;
  let fetched: string[];
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'ES256' };
  let doc: Record<string, unknown>;

  beforeAll(async () => {
    fetched = [];
    doc = {
      client_id: CIMD_URL,
      client_name: 'ChatGPT',
      redirect_uris: [CHATGPT],
      token_endpoint_auth_method: 'none',
    };
    const fakeFetch = (async (url: string | URL) => {
      fetched.push(String(url));
      if (String(url) === CIMD_URL)
        return new Response(JSON.stringify(doc), {
          headers: { 'content-type': 'application/json' },
        });
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    s = await makeServer('cimd.json', fakeFetch);
  });
  afterAll(() => s.app.close());

  it('accepts an https client_id whose document lists the redirect URI', async () => {
    const code = await getCode(s, CIMD_URL);
    const res = await exchange(s, CIMD_URL, code);
    expect(res.statusCode, res.body).toBe(200);
    expect(fetched).toContain(CIMD_URL);
    expect(s.store.read().clients[CIMD_URL]?.type).toBe('cimd');
  });

  it('never fetches documents from hosts outside remote.clientMetadataHosts (SSRF)', async () => {
    fetched.length = 0;
    const res = await inject(
      s,
      'GET',
      `/authorize?${authorizeQuery('https://169.254.169.254/latest/meta-data')}`,
    );
    expect(res.statusCode).toBe(400);
    expect(fetched).toHaveLength(0);
  });

  it('verifies private_key_jwt client assertions', async () => {
    const url = 'https://chatgpt.com/oauth/jwt-client.json';
    const jwtDoc = {
      client_id: url,
      redirect_uris: [CHATGPT],
      token_endpoint_auth_method: 'private_key_jwt',
      jwks: { keys: [jwk] },
    };
    const fakeFetch = (async () => new Response(JSON.stringify(jwtDoc))) as unknown as typeof fetch;
    const js = await makeServer('cimd-jwt.json', fakeFetch);
    try {
      const assertion = (claims: Record<string, unknown>, key = keys.privateKey) => {
        const h = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'JWT' })).toString(
          'base64url',
        );
        const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
        const sig = sign('sha256', Buffer.from(`${h}.${p}`), {
          key,
          dsaEncoding: 'ieee-p1363',
        }).toString('base64url');
        return `${h}.${p}.${sig}`;
      };
      const exp = Math.floor(now.getTime() / 1000) + 120;
      const good = { iss: url, sub: url, aud: `${PUBLIC}/token`, exp, jti: 'j1' };
      const code = await getCode(js, url);
      const form = (a: string) => ({
        grant_type: 'authorization_code',
        client_id: url,
        code,
        redirect_uri: CHATGPT,
        code_verifier: VERIFIER,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: a,
      });
      const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const forged = await inject(js, 'POST', '/token', {
        form: form(assertion(good, other.privateKey)),
      });
      expect(body(forged).error).toBe('invalid_client');
      const wrongAud = await inject(js, 'POST', '/token', {
        form: form(assertion({ ...good, aud: 'https://x' })),
      });
      expect(body(wrongAud).error).toBe('invalid_client');
      const ok = await inject(js, 'POST', '/token', { form: form(assertion(good)) });
      expect(ok.statusCode, ok.body).toBe(200);
      const replay = await inject(js, 'POST', '/token', { form: form(assertion(good)) });
      expect(body(replay).error).toBe('invalid_client');
      // no assertion at all: the registered method must be used
      const none = await inject(js, 'POST', '/token', {
        form: {
          grant_type: 'authorization_code',
          client_id: url,
          code,
          redirect_uri: CHATGPT,
          code_verifier: VERIFIER,
        },
      });
      expect(body(none).error).toBe('invalid_client');
    } finally {
      await js.app.close();
    }
  });
});

describe('cloudflared tunnel config', () => {
  it('maps only the hostname to the remote listener', () => {
    const yaml = tunnelConfigYaml({
      hostname: 'uc.nemut.ai',
      tunnel: 'unicontext',
      credentialsFile: '/home/u/.cloudflared/abc.json',
      port: 17879,
    });
    expect(yaml).toContain('hostname: uc.nemut.ai');
    expect(yaml).toContain('service: http://127.0.0.1:17879');
    expect(yaml).toContain('service: http_status:404');
    expect(yaml).not.toContain('17878');
    expect(() =>
      tunnelConfigYaml({ hostname: 'a b', tunnel: 't', credentialsFile: 'c', port: 1 }),
    ).toThrow();
  });
});

describe('daemon end to end (real sockets, MCP SDK client)', () => {
  let daemon: RunningDaemon;
  let remotePort: number;
  let base: string;
  let ddir: string;

  beforeAll(async () => {
    remotePort = await new Promise<number>((resolve) => {
      const srv = createNetServer();
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as { port: number }).port;
        srv.close(() => resolve(p));
      });
    });
    base = `http://127.0.0.1:${remotePort}`;
    ddir = mkdtempSync(path.join(tmpdir(), 'uc-remote-e2e-'));
    const config = ConfigSchema.parse({ remote: { enabled: true, publicUrl: base } });
    const store = RemoteStateStore.forPaths({ root: ddir });
    store.setPassphrase(await hashPassphrase(PASS, FAST));
    daemon = await startDaemon({
      dev: true,
      dataDir: ddir,
      config,
      noLock: true,
      noNotifications: true,
      noScheduler: true,
      port: 0,
      remotePort,
      logSink: () => undefined,
    });
  }, 60_000);

  afterAll(async () => {
    await daemon.stop();
    rmSync(ddir, { recursive: true, force: true });
  });

  it('runs the OAuth flow over HTTP and lists only read tools through the SDK client', async () => {
    expect(daemon.remote?.port).toBe(remotePort);
    // the local admin API is not reachable on the remote port
    expect((await fetch(`${base}/api/v1/health`)).status).toBe(404);
    const reg = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [CLAUDE],
        token_endpoint_auth_method: 'none',
        client_name: 'Claude',
      }),
    });
    expect(reg.status).toBe(201);
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CLAUDE,
      code_challenge: s256(VERIFIER),
      code_challenge_method: 'S256',
      state: 'xyz',
      resource: `${base}/mcp`,
    });
    const page = await fetch(`${base}/authorize?${q}`);
    expect(page.status).toBe(200);
    const sealed = /name="request" value="([^"]+)"/.exec(await page.text())?.[1] as string;
    const approve = await fetch(`${base}/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        request: sealed,
        passphrase: PASS,
        action: 'approve',
      }).toString(),
    });
    expect(approve.status).toBe(303);
    const code = new URL(approve.headers.get('location') as string).searchParams.get(
      'code',
    ) as string;
    const tok = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: CLAUDE,
        code_verifier: VERIFIER,
        resource: `${base}/mcp`,
      }).toString(),
    });
    expect(tok.status).toBe(200);
    const { access_token } = (await tok.json()) as { access_token: string };

    const client = new Client({ name: 'remote-e2e', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${access_token}` } },
      }),
    );
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.length).toBeGreaterThan(5);
      expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
      expect(tools.map((t) => t.name)).not.toContain('correct_fact');
      const res = await client.callTool({ name: 'get_week', arguments: {} });
      expect(res.isError).not.toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe('file links (/files/<token>)', () => {
  let s: RemoteServer;
  let file: string;
  beforeAll(async () => {
    s = await makeServer('files.json');
    file = path.join(dir, 'week1.pdf');
    writeFileSync(file, 'PDF-BYTES');
  });
  afterAll(() => s.app.close());

  it('serves the file to the link holder for about ten minutes, never to another client', async () => {
    const owner = await tokens(s);
    const other = await tokens(s);
    audit.length = 0;
    const { token, expiresAt } = s.fileLinks.mint({
      clientId: owner.clientId,
      documentId: 'document:test',
      path: file,
      name: '第1回 資料.pdf',
      mimeType: 'application/pdf',
      bytes: 9,
    });
    expect(new Date(expiresAt).getTime() - now.getTime()).toBe(10 * 60_000);

    const plain = await inject(s, 'GET', `/files/${token}`);
    expect(plain.statusCode).toBe(200);
    expect(plain.body).toBe('PDF-BYTES');
    expect(plain.headers['content-disposition']).toContain(
      `filename*=UTF-8''${encodeURIComponent('第1回 資料.pdf')}`,
    );
    expect(plain.headers['cache-control']).toBe('no-store');

    const own = await inject(s, 'GET', `/files/${token}`, {
      headers: { authorization: `Bearer ${owner.access_token}` },
    });
    expect(own.statusCode).toBe(200);
    const foreign = await inject(s, 'GET', `/files/${token}`, {
      headers: { authorization: `Bearer ${other.access_token}` },
    });
    expect(foreign.statusCode).toBe(403);
    const forged = await inject(s, 'GET', `/files/${token}`, {
      headers: { authorization: 'Bearer nope' },
    });
    expect(forged.statusCode).toBe(401);
    expect((await inject(s, 'GET', `/files/${'A'.repeat(43)}`)).statusCode).toBe(404);

    // audited by a tag, never the token itself
    const fetches = audit.filter((e) => e.event === 'file_fetch');
    expect(fetches.map((e) => [e.ok, e.status])).toEqual([
      [true, undefined],
      [true, undefined],
      [false, 403],
      [false, 401],
      [false, 404],
    ]);
    expect(JSON.stringify(audit)).not.toContain(token);

    const saved = now;
    now = new Date(now.getTime() + 10 * 60_000 + 1);
    try {
      expect((await inject(s, 'GET', `/files/${token}`)).statusCode).toBe(404);
    } finally {
      now = saved;
    }
  });
});
