import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DaemonClient, lockFile, startDaemon, type RunningDaemon } from '@unicontext/daemon';
import type { ConflictsResponse } from '@unicontext/daemon/api-types';
import type { Fact } from '@unicontext/canonical-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultDeps } from '../src/deps.js';
import { exec, json, removeDir, tempDir } from './helpers.js';

interface SyncJson {
  via: string;
  reports: { sourceId: string; ok: boolean; mode: string; health: string }[];
}

describe('with a real daemon (dev seed, 127.0.0.1, ephemeral port)', () => {
  let dir: string;
  let daemon: RunningDaemon;
  const base = (): string[] => ['--data-dir', dir];
  // real discovery through the lock file and daemon.token, like the shipped CLI does
  const real = { daemonClient: defaultDeps().daemonClient };

  beforeAll(async () => {
    dir = tempDir('unicontext-cli-daemon-');
    daemon = await startDaemon({
      dev: true,
      dataDir: dir,
      port: 0,
      noKeychain: true,
      handleSignals: false,
      noScheduler: true,
      noNotifications: true,
      logSink: () => undefined,
    });
  }, 60_000);

  afterAll(async () => {
    await daemon.stop();
    removeDir(dir);
  });

  it('daemon status finds it through the lock file and /api/v1/health', async () => {
    const r = await exec([...base(), 'daemon', 'status'], real);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('デーモン: 稼働中');
    expect(r.stdout).toContain(daemon.url);
    expect(r.stdout).toContain(`pid: ${process.pid}`);
    expect(r.stdout).toContain('見本データで動作中');
    const body = json<{
      running: boolean;
      pid: number;
      url: string;
      version: string;
      dev: boolean;
    }>(await exec([...base(), '--json', 'daemon', 'status'], real));
    expect(body).toMatchObject({ running: true, pid: process.pid, url: daemon.url, dev: true });
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('status reports the running daemon', async () => {
    const r = await exec([...base(), 'status'], real);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('デーモン: 稼働中');
    expect(r.stdout).toContain(daemon.url);
    expect(r.stdout).toContain('競合: 1件');
  });

  it('sync goes through POST /api/v1/sources/:id/sync for all enabled sources, one by one', async () => {
    const r = await exec([...base(), '--json', 'sync'], real);
    expect(r.code, r.stderr).toBe(0);
    const body = json<SyncJson>(r);
    expect(body.via).toBe('daemon');
    expect(body.reports.map((x) => x.sourceId).sort()).toEqual(['lcu', 'lms', 'record', 'teams']);
    expect(body.reports.every((x) => x.ok && x.health === 'healthy')).toBe(true);
    const human = await exec([...base(), 'sync', 'lcu'], real);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain('デーモン経由で同期しました');
    expect(human.stdout).toContain('lcu');
    expect(human.stdout).toContain('正常');
  });

  it('sync of an unknown source is the daemon error, shown as a Japanese one-liner', async () => {
    const r = await exec([...base(), 'sync', 'ghost'], real);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^エラー: デーモンがエラーを返しました/);
    expect(r.stderr).toContain('ghost');
    expect(r.stderr).toContain('ヒント:');
  });

  it('login of a dev source triggers a sync on the running daemon', async () => {
    const client = new DaemonClient({ baseUrl: daemon.url, token: daemon.token });
    const r = await exec(['--dev', '--json', 'login', 'lcu'], { daemonClient: async () => client });
    expect(r.code, r.stderr).toBe(0);
    const body = json<{ auth: { status: string }; sync: { ok: boolean }[] }>(r);
    expect(body.auth.status).toBe('authenticated');
    expect(body.sync).toHaveLength(1);
    expect(body.sync[0]?.ok).toBe(true);
  });

  it('correct <id> prefers POST /api/v1/facts/:id/correct', async () => {
    const list = json<ConflictsResponse>(await exec([...base(), '--json', 'conflicts']));
    const id = list.conflicts[0]?.id;
    expect(id).toBeDefined();
    const r = await exec(
      [...base(), '--json', 'correct', id ?? '', '情報学部2号館11教室', '--note', 'via daemon'],
      real,
    );
    expect(r.code, r.stderr).toBe(0);
    const body = json<{ fact: Fact; via: string }>(r);
    expect(body.via).toBe('daemon');
    expect(body.fact.origin).toBe('user');
    expect(body.fact.value).toBe('情報学部2号館11教室');
    const after = json<ConflictsResponse>(await exec([...base(), '--json', 'conflicts']));
    expect(after.conflicts).toHaveLength(0);
  });

  it('start reports an already running daemon and does not spawn another', async () => {
    const r = await exec([...base(), 'daemon', 'start'], real);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('既に起動しています');
    expect(r.t.spawned).toHaveLength(0);
  });

  it('stop posts /api/v1/daemon/stop with the bearer token and waits for it to go away', async () => {
    const r = await exec([...base(), 'daemon', 'stop'], {
      ...real,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 50))),
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('デーモンを停止しました');
    await daemon.stopped;
    const after = await exec([...base(), 'daemon', 'status'], real);
    expect(after.stdout).toContain('デーモン: 停止中');
    const again = await exec([...base(), 'daemon', 'stop'], real);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('起動していません');
  });
});

describe('daemon commands without a running daemon', () => {
  it('daemon status with nothing running says so (exit 0), also as JSON', async () => {
    const dir = tempDir();
    try {
      const r = await exec(['--data-dir', dir, 'daemon', 'status'], {
        daemonClient: defaultDeps().daemonClient,
      });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain('デーモン: 停止中');
      expect(r.stdout).toContain('unicontext daemon start');
      const body = json<{ running: boolean; lock: unknown }>(
        await exec(['--data-dir', dir, '--json', 'daemon', 'status']),
      );
      expect(body.running).toBe(false);
      expect(body.lock).toBeUndefined();
    } finally {
      removeDir(dir);
    }
  });

  it('a stale lock file is reported but not treated as running', async () => {
    const dir = tempDir();
    try {
      writeFileSync(
        lockFile({ root: dir }),
        JSON.stringify({ pid: 999999, port: 1, startedAt: 'x' }),
      );
      const r = await exec(['--data-dir', dir, 'daemon', 'status'], {
        daemonClient: defaultDeps().daemonClient,
      });
      expect(r.stdout).toContain('停止中');
      expect(r.stdout).toContain('ロックファイルは残っています');
    } finally {
      removeDir(dir);
    }
  });

  it('start spawns the daemon detached with the global flags and waits for /health', async () => {
    const dir = tempDir();
    try {
      const script = path.join(dir, 'daemon-bin.js');
      writeFileSync(script, '// stand-in');
      const target = new DaemonClient({ baseUrl: 'http://127.0.0.1:17999' });
      target.health = async () => ({
        ok: true as const,
        version: '1.0.0',
        startedAt: '2026-10-01T00:00:00Z',
        pid: 4242,
        dev: false,
      });
      let calls = 0;
      const r = await exec(
        ['--data-dir', dir, '--no-keychain', 'daemon', 'start', '--port', '18123'],
        {
          daemonScript: () => script,
          daemonClient: async () => (++calls >= 4 ? target : undefined),
        },
      );
      expect(r.code, r.stderr).toBe(0);
      expect(r.t.spawned).toHaveLength(1);
      expect(r.t.spawned[0]?.script).toBe(script);
      expect(r.t.spawned[0]?.args).toEqual(['--data-dir', dir, '--no-keychain', '--port', '18123']);
      expect(r.stdout).toContain('デーモンを起動しました: http://127.0.0.1:17999（pid 4242）');
    } finally {
      removeDir(dir);
    }
  });

  it('start fails clearly when the daemon never answers or the script is missing', async () => {
    const dir = tempDir();
    try {
      const script = path.join(dir, 'daemon-bin.js');
      writeFileSync(script, '// stand-in');
      const late = await exec(['--data-dir', dir, 'daemon', 'start'], {
        daemonScript: () => script,
        daemonStartTimeoutMs: 500,
      });
      expect(late.code).toBe(1);
      expect(late.stderr).toContain('デーモンの起動を確認できませんでした');
      expect(late.stderr).toContain('unicontextd.log');
      expect(late.stderr).toContain('--foreground');

      const missing = await exec(['--data-dir', dir, 'daemon', 'start'], {
        daemonScript: () => path.join(dir, 'nope.js'),
      });
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain('デーモン本体が見つかりません');
      expect(missing.stderr).toContain('pnpm build');
      expect(missing.t.spawned).toHaveLength(0);

      const devBg = await exec(['--dev', 'daemon', 'start']);
      expect(devBg.code).toBe(2);
    } finally {
      removeDir(dir);
    }
  });

  it('start --foreground runs the daemon in-process until it stops', async () => {
    const received: Record<string, unknown>[] = [];
    const r = await exec(['--dev', 'daemon', 'start', '--foreground', '--port', '18124'], {
      startDaemon: async (options) => {
        received.push({ ...options });
        return {
          url: 'http://127.0.0.1:18124',
          stopped: Promise.resolve(),
        } as unknown as RunningDaemon;
      },
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('unicontextd listening on http://127.0.0.1:18124');
    expect(received[0]).toMatchObject({ handleSignals: true, port: 18124, dev: true });
  });

  it('stop falls back to the pid in the lock file when the API is unreachable', async () => {
    const dir = tempDir();
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    try {
      expect(child.pid).toBeDefined();
      writeFileSync(
        lockFile({ root: dir }),
        JSON.stringify({ pid: child.pid, port: 1, startedAt: '2026-10-01T00:00:00Z' }),
      );
      const r = await exec(['--data-dir', dir, 'daemon', 'stop'], {
        killProcess: (pid) => void process.kill(pid),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain('デーモンを停止しました');
      expect(existsSync(lockFile({ root: dir }))).toBe(false);
    } finally {
      child.kill();
      removeDir(dir);
    }
  });
});
