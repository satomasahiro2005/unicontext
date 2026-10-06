import type { DaemonClient } from '@unicontext/daemon/lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../src/main.js';
import type { CliDeps } from '../src/deps.js';
import { exec, json, makeDeps, sharedDevRuntime, type SharedRuntime } from './helpers.js';

/** A daemon whose sync job never finishes (or finishes after `finishAfter` polls). */
function fakeDaemon(order: string[], finishAfter?: number) {
  const calls: string[] = [];
  let polls = 0;
  const job = (state: 'running' | 'done') => ({
    id: 'job-1',
    sourceId: 'lcu',
    state,
    startedAt: '2026-10-01T00:30:00.000Z',
    ...(state === 'done'
      ? {
          report: {
            sourceId: 'lcu',
            ok: true,
            mode: 'incremental',
            health: 'healthy',
            raw: { inserted: 0, updated: 0, deleted: 0 },
            normalized: { changeEvents: 0 },
          },
        }
      : {}),
  });
  const client = {
    post: (path: string): Promise<unknown> => {
      calls.push(`POST ${path}`);
      order.push('daemon');
      return Promise.resolve({ job: job('running') });
    },
    get: (path: string): Promise<unknown> => {
      calls.push(`GET ${path}`);
      polls++;
      return Promise.resolve({
        job: job(finishAfter !== undefined && polls >= finishAfter ? 'done' : 'running'),
      });
    },
  } as unknown as DaemonClient;
  return { client, calls };
}

describe('login confirms the sign-in before it contacts the daemon', () => {
  let shared: SharedRuntime;
  beforeAll(async () => {
    shared = await sharedDevRuntime();
  }, 60_000);
  afterAll(async () => {
    await shared.dispose();
  });

  it('prints 認証できました first, starts the sync without waiting and exits 0 fast', async () => {
    const order: string[] = [];
    const { client, calls } = fakeDaemon(order);
    let seenAtDiscovery = '';
    let waitMsAtDiscovery: number | undefined;
    const overrides: Partial<CliDeps> = {
      ...shared.overrides,
      daemonClient: async (target) => {
        order.push('discover');
        waitMsAtDiscovery = target.waitMs;
        seenAtDiscovery = t.stdout();
        return client;
      },
    };
    const t = makeDeps(overrides);
    const started = Date.now();
    const code = await run(['--dev', 'login', 'lcu'], t.deps);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(code, t.stderr()).toBe(0);
    const out = t.stdout();
    expect(out).toContain('lcu: 認証できました');
    expect(out).toContain('デーモンで同期を開始しました（ジョブ job-1）');
    expect(out.indexOf('認証できました')).toBeLessThan(
      out.indexOf('デーモンで同期を開始しました'),
    );
    expect(calls).toEqual(['POST /api/v1/sources/lcu/sync?wait=0']); // started, never polled
    expect(order).toEqual(['discover', 'daemon']);
    expect(seenAtDiscovery).toContain('lcu: 認証できました'); // printed before the daemon was asked
    expect(waitMsAtDiscovery).toBe(10_000);
  });

  it('--json carries the same fields plus syncJob', async () => {
    const { client } = fakeDaemon([]);
    const r = await exec(['--dev', '--json', 'login', 'lcu'], {
      ...shared.overrides,
      daemonClient: async () => client,
    });
    expect(r.code, r.stderr).toBe(0);
    const body = json<{ sourceId: string; auth: { status: string }; syncJob: { id: string } }>(r);
    expect(body).toMatchObject({ sourceId: 'lcu', auth: { status: 'authenticated' } });
    expect(body.syncJob.id).toBe('job-1');
  });

  it('a daemon that does not answer is reported and the login still exits 0', async () => {
    const r = await exec(['--dev', 'login', 'lcu'], {
      ...shared.overrides,
      daemonClient: async (target) => {
        target.onWait?.(4242);
        return undefined;
      },
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('lcu: 認証できました');
    expect(r.stderr).toContain('pid 4242');
    expect(r.stderr).toContain('応答しない');
  });

  it('--wait-sync keeps waiting for the job, with a progress line every 10 s', async () => {
    const { client, calls } = fakeDaemon([], 25);
    const r = await exec(['--dev', 'login', 'lcu', '--wait-sync'], {
      ...shared.overrides,
      daemonClient: async () => client,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(calls.filter((c) => c.startsWith('GET /api/v1/sync-jobs/job-1')).length).toBe(25);
    expect(r.stderr.match(/同期の完了を待っています/g)?.length).toBe(2);
    expect(r.stdout).toContain('デーモンで同期を実行しました（成功）');
  });

  it('--wait-sync stops waiting after 10 minutes and still exits 0', async () => {
    const { client, calls } = fakeDaemon([]);
    const r = await exec(['--dev', 'login', 'lcu', '--wait-sync'], {
      ...shared.overrides,
      daemonClient: async () => client,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(calls.filter((c) => c.startsWith('GET')).length).toBe(600);
    expect(r.stdout).toContain('10分たっても終わっていません');
  });
});
