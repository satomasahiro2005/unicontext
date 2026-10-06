import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { MemorySecretStore } from '@unicontext/auth';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DaemonApiError, DaemonClient } from '../src/client.js';
import { drainSyncs, startDaemon, type RunningDaemon } from '../src/daemon.js';
import { DaemonAlreadyRunningError, lockFile } from '../src/lock.js';

/** fetch() forbids overriding Host, so use node:http for the rebinding cases. */
function rawRequest(
  port: number,
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let dir: string;
let webDir: string;
let daemon: RunningDaemon;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'uc-daemon-run-'));
  webDir = path.join(dir, 'web');
  mkdirSync(webDir, { recursive: true });
  writeFileSync(
    path.join(webDir, 'index.html'),
    '<!doctype html><title>UniContext</title><div id="root"></div>',
  );
  writeFileSync(path.join(webDir, 'app.js'), 'console.log(1)');
  daemon = await startDaemon({
    dev: true,
    dataDir: path.join(dir, 'data'),
    port: 0,
    webDir,
    noKeychain: true,
    noScheduler: true,
    noNotifications: true,
  });
}, 60_000);

afterAll(async () => {
  await daemon.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('unicontextd', () => {
  it('listens on 127.0.0.1 only', () => {
    const addr = daemon.app.server.address();
    expect(typeof addr === 'object' && addr?.address).toBe('127.0.0.1');
    expect(daemon.url).toBe(`http://127.0.0.1:${daemon.port}`);
  });

  it('answers /api/v1/today with JSON over a real socket', async () => {
    const res = await fetch(`${daemon.url}/api/v1/today`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { view: string; classes: unknown[] };
    expect(body.view).toBe('today');
    expect(body.classes.length).toBeGreaterThan(0);
  });

  it('serves the Web UI index, assets and SPA routes; unknown assets and /api stay 404', async () => {
    const index = await fetch(`${daemon.url}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('<div id="root">');
    expect((await fetch(`${daemon.url}/app.js`)).status).toBe(200);
    const spa = await fetch(`${daemon.url}/courses/courseOffering:abc`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('<div id="root">');
    expect((await fetch(`${daemon.url}/missing.js`)).status).toBe(404);
    expect((await fetch(`${daemon.url}/api/v1/missing`)).status).toBe(404);
  });

  it('refuses a rebinding Host over a real socket', async () => {
    expect(
      await rawRequest(daemon.port, 'GET', '/api/v1/today', { host: 'evil.example.com' }),
    ).toBe(403);
  });

  it('the Host check also covers the Web UI, SPA fallback, 404 and parse-error paths', async () => {
    const evil = { host: 'evil.example.com' };
    for (const url of ['/', '/app.js', '/today', '/nope.png', '/api/v1/nope'])
      expect(await rawRequest(daemon.port, 'GET', url, evil), url).toBe(403);
    expect(
      await rawRequest(
        daemon.port,
        'POST',
        '/api/v1/identity/confirm',
        { ...evil, 'content-type': 'application/json' },
        '{not json',
      ),
    ).toBe(403);
  });

  it('single-instance lock: a second daemon on the same data dir fails', async () => {
    const file = lockFile(daemon.runtime.paths);
    expect(existsSync(file)).toBe(true);
    // a lock owned by this very process counts as stale (pid reuse after a restart), so simulate
    // another live process (the test runner's parent) owning it
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, JSON.stringify({ pid: process.ppid, port: daemon.port, startedAt: 'x' }));
    await expect(
      startDaemon({
        dev: true,
        dataDir: daemon.runtime.paths.root,
        port: 0,
        noKeychain: true,
        noScheduler: true,
        noNotifications: true,
      }),
    ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
    writeFileSync(file, original);
  });

  it('DaemonClient.discover finds it through the lock file and the token file; writes work', async () => {
    const client = await DaemonClient.discover(daemon.runtime.paths, new MemorySecretStore());
    expect(client).toBeDefined();
    const health = await client!.health();
    expect(health.dev).toBe(true);
    const sync = await client!.post<{ report: { ok: boolean } }>('/api/v1/sources/lcu/sync');
    expect(sync.report.ok).toBe(true);
    const noToken = new DaemonClient({ baseUrl: daemon.url });
    await expect(noToken.post('/api/v1/sources/lcu/sync')).rejects.toBeInstanceOf(DaemonApiError);
    const badToken = new DaemonClient({ baseUrl: daemon.url, token: 'x'.repeat(40) });
    await expect(badToken.post('/api/v1/sources/lcu/sync')).rejects.toMatchObject({ status: 401 });
    await expect(client!.get('/api/v1/courses/courseOffering:none')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('discover returns undefined when nothing listens', async () => {
    const other = mkdtempSync(path.join(tmpdir(), 'uc-nodaemon-'));
    expect(await DaemonClient.discover({ root: other }, new MemorySecretStore())).toBeUndefined();
    writeFileSync(lockFile({ root: other }), JSON.stringify({ pid: 1, port: 1, startedAt: 'x' }));
    expect(await DaemonClient.discover({ root: other }, new MemorySecretStore())).toBeUndefined();
    rmSync(other, { recursive: true, force: true });
  });

  it('discover waits for a live daemon that has not opened its port yet (start-up)', async () => {
    const other = mkdtempSync(path.join(tmpdir(), 'uc-starting-'));
    try {
      const startedAt = new Date().toISOString();
      // The lock is written before the runtime opens and the port is known.
      writeFileSync(lockFile({ root: other }), JSON.stringify({ pid: process.pid, startedAt }));
      writeFileSync(path.join(other, 'daemon.token'), `${'t'.repeat(43)}\n`);
      const waited: number[] = [];
      const found = DaemonClient.discover({ root: other }, new MemorySecretStore(), {
        waitMs: 5_000,
        retryDelayMs: 20,
        onWait: (lock) => waited.push(lock.pid),
      });
      await new Promise((r) => setTimeout(r, 100));
      writeFileSync(
        lockFile({ root: other }),
        JSON.stringify({ pid: process.pid, port: daemon.port, startedAt }),
      );
      const client = await found;
      expect(client?.baseUrl).toBe(daemon.url);
      expect(waited).toEqual([process.pid]);
      // Without waitMs, the same state is "no daemon" (the old behaviour).
      writeFileSync(lockFile({ root: other }), JSON.stringify({ pid: process.pid, startedAt }));
      expect(await DaemonClient.discover({ root: other }, new MemorySecretStore())).toBeUndefined();
      // A dead pid is never waited for.
      writeFileSync(lockFile({ root: other }), JSON.stringify({ pid: 2 ** 30, port: 1, startedAt }));
      const t0 = Date.now();
      expect(
        await DaemonClient.discover({ root: other }, new MemorySecretStore(), { waitMs: 5_000 }),
      ).toBeUndefined();
      expect(Date.now() - t0).toBeLessThan(4_000);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('discover does not hand the token to a listener whose pid does not own the lock', async () => {
    const other = mkdtempSync(path.join(tmpdir(), 'uc-squat-'));
    try {
      // a stale lock whose port is now served by a different process
      writeFileSync(
        lockFile({ root: other }),
        JSON.stringify({ pid: process.pid + 1, port: daemon.port, startedAt: 'x' }),
      );
      writeFileSync(path.join(other, 'daemon.token'), `${'t'.repeat(43)}\n`);
      expect(await DaemonClient.discover({ root: other }, new MemorySecretStore())).toBeUndefined();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('serves MCP over streamable HTTP at /mcp (§39)', async () => {
    const client = new Client({ name: 'daemon-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${daemon.url}/mcp`));
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['get_today', 'get_week', 'get_conflicts', 'search', 'correct_fact']),
    );
    const result = await client.callTool({ name: 'get_today', arguments: {} });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { citations: unknown[]; conflicts: string[] };
    expect(structured.citations.length).toBeGreaterThan(0);
    expect(structured.conflicts.length).toBeGreaterThan(0);
    await client.close();
  });

  it('/mcp also enforces the Host check', async () => {
    const status = await rawRequest(
      daemon.port,
      'POST',
      '/mcp',
      {
        host: 'evil.example.com',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      '{}',
    );
    expect(status).toBe(403);
  });

  it('POST /api/v1/daemon/stop shuts down gracefully and releases the lock', async () => {
    const d2 = await startDaemon({
      dev: true,
      port: 0,
      noKeychain: true,
      noScheduler: true,
      noNotifications: true,
    });
    const lock = lockFile(d2.runtime.paths);
    expect(existsSync(lock)).toBe(true);
    const res = await fetch(`${d2.url}/api/v1/daemon/stop`, {
      method: 'POST',
      headers: { authorization: `Bearer ${d2.token}` },
    });
    expect(res.status).toBe(200);
    await d2.stopped;
    expect(existsSync(lock)).toBe(false);
    await expect(fetch(`${d2.url}/api/v1/health`)).rejects.toThrow();
  });
});

describe('shutdown', () => {
  const fakeUc = (running: string[], pending: Promise<unknown>, started: string[]) =>
    ({
      sync: {
        sources: () => [{ sourceId: 'a' }, { sourceId: 'b' }],
        isRunning: (id: string) => running.includes(id),
        sync: (id: string) => {
          started.push(id);
          return pending;
        },
      },
    }) as unknown as Parameters<typeof drainSyncs>[0];

  it('drainSyncs waits for in-flight syncs before the database closes and starts none', async () => {
    let release!: () => void;
    const pending = new Promise<void>((r) => {
      release = r;
    });
    const started: string[] = [];
    let done = false;
    const drained = drainSyncs(fakeUc(['a'], pending, started)).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    release();
    await drained;
    expect(done).toBe(true);
    expect(started).toEqual(['a']);
  });

  it('drainSyncs is bounded and tolerates a rejecting sync', async () => {
    const started: string[] = [];
    await drainSyncs(fakeUc(['a'], new Promise(() => undefined), started), 30);
    await drainSyncs(fakeUc(['b'], Promise.reject(new Error('db closed')), started), 30);
    expect(started).toEqual(['a', 'b']);
  });
});
