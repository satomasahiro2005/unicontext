import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FakeSourceAdapter } from '@unicontext/connector-sdk';
import { DaemonClient } from '@unicontext/daemon';
import { openDatabase } from '@unicontext/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DoctorCheck } from '../src/commands/doctor.js';
import type { DoctorProbes } from '../src/deps.js';
import {
  exec,
  json,
  OK_PROBES,
  removeDir,
  sharedDevRuntime,
  tempDir,
  writeConfig,
  type ExecResult,
  type SharedRuntime,
} from './helpers.js';

const probes = (over: Partial<DoctorProbes> = {}): DoctorProbes => ({ ...OK_PROBES, ...over });

function byId(checks: DoctorCheck[], id: string): DoctorCheck {
  const c = checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}; have ${checks.map((x) => x.id).join(', ')}`);
  return c;
}

const checksOf = (r: ExecResult): DoctorCheck[] => json<DoctorCheck[]>(r);

describe('doctor on the dev seed', () => {
  let shared: SharedRuntime;
  beforeAll(async () => {
    shared = await sharedDevRuntime();
  }, 60_000);
  afterAll(async () => {
    await shared.dispose();
  });
  const dev = (args: string[], over: object = {}) =>
    exec(['--dev', ...args], { ...shared.overrides, probes: probes(), ...over });

  it('is clean apart from the daemon warning, with exit code 0', async () => {
    const r = await dev(['--json', 'doctor']);
    expect(r.code, r.stdout).toBe(0);
    const checks = checksOf(r);
    expect(checks.filter((c) => c.status === 'ng')).toEqual([]);
    expect(byId(checks, 'node').status).toBe('ok');
    expect(byId(checks, 'database').message).toMatch(/スキーマv7/);
    for (const id of ['lcu', 'teams', 'lms', 'record'])
      expect(byId(checks, `source:${id}`).status).toBe('ok');
    expect(byId(checks, 'daemon')).toMatchObject({ status: 'warn', label: '警告' });
    expect(byId(checks, 'daemon').fix).toContain('unicontext daemon start');
    expect(byId(checks, 'telemetry').status).toBe('ok');
    expect(byId(checks, 'telemetry').message).toContain('無効');
    for (const c of checks) expect(['OK', '警告', 'NG']).toContain(c.label);
  });

  it('prints OK / 警告 / NG with a fix line under every problem and a summary', async () => {
    const r = await dev(['doctor']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^OK\s+Node\.js/m);
    expect(r.stdout).toMatch(/^警告\s+デーモン/m);
    expect(r.stdout).toContain('      fix: 「unicontext daemon start」');
    expect(r.stdout).toMatch(/NG 0件 \/ 警告\d件 \/ OK \d+件/);
  });

  it('warns with the login command when a source needs a login', async () => {
    const adapter = shared.runtime.uc.sync.getSource('lcu').adapter as FakeSourceAdapter;
    adapter.authenticated = false;
    try {
      const r = await dev(['--json', 'doctor']);
      expect(r.code).toBe(0);
      const c = byId(checksOf(r), 'source:lcu');
      expect(c.status).toBe('warn');
      expect(c.message).toContain('要ログイン');
      expect(c.fix).toContain('unicontext login lcu');
    } finally {
      adapter.authenticated = true;
      await shared.runtime.uc.sync.checkHealth('lcu');
    }
  });

  it('gives up on a source that does not answer in time (warning, not a hang)', async () => {
    const adapter = shared.runtime.uc.sync.getSource('teams').adapter as FakeSourceAdapter;
    const original = adapter.health.bind(adapter);
    adapter.health = () => new Promise(() => undefined);
    try {
      const r = await dev(['--json', 'doctor'], { healthTimeoutMs: 60 });
      const c = byId(checksOf(r), 'source:teams');
      expect(c.status).toBe('warn');
      expect(c.message).toContain('終わりませんでした');
    } finally {
      adapter.health = original;
    }
  });

  it('reports a failing source as NG with exit code 1', async () => {
    const adapter = shared.runtime.uc.sync.getSource('lms').adapter as FakeSourceAdapter;
    const original = adapter.health.bind(adapter);
    adapter.health = async () => ({
      state: 'failed',
      checkedAt: '2026-10-01T00:30:00Z',
      message: 'HTTP 500',
    });
    try {
      const r = await dev(['--json', 'doctor']);
      expect(r.code).toBe(1);
      const c = byId(checksOf(r), 'source:lms');
      expect(c.status).toBe('ng');
      expect(c.message).toContain('HTTP 500');
      expect(c.fix).toContain('unicontext sync lms');
    } finally {
      adapter.health = original;
    }
  });
});

describe('doctor on a real data dir with injected probes', () => {
  let dir: string;
  beforeAll(() => {
    dir = tempDir('unicontext-cli-doctor-');
  });
  afterAll(() => removeDir(dir));
  const sub = (name: string): string => path.join(dir, name);
  const run = (data: string, args: string[], over: Parameters<typeof exec>[1] = {}) =>
    exec(['--data-dir', data, ...args], over);

  it('mixes OK, warning and NG: exit code 1 and a fix for each', async () => {
    const d = sub('mixed');
    writeConfig(
      d,
      [
        'sources:',
        '  ghost:',
        '    connector: "@unicontext/definitely-not-installed"',
        '  parked:',
        '    enabled: false',
        '    connector: "@unicontext/definitely-not-installed"',
        '  portal:',
        '    adapter: browser',
        '    enabled: false',
        '',
      ].join('\n'),
    );
    expect((await run(d, ['status'])).code).toBe(0); // creates the database
    const r = await run(d, ['--json', 'doctor'], {
      probes: probes({
        nodeVersion: () => '20.11.1',
        keychain: async () => ({ ok: false, detail: 'Secret Service is not running' }),
        playwright: async () => ({ ok: false, detail: 'not found' }),
        desktopNotifications: async () => ({ ok: false }),
      }),
    });
    expect(r.code).toBe(1);
    const checks = checksOf(r);
    expect(byId(checks, 'node')).toMatchObject({ status: 'ng' });
    expect(byId(checks, 'node').fix).toContain('22.12');
    expect(byId(checks, 'config').status).toBe('ok');
    const ghost = byId(checks, 'source:ghost');
    expect(ghost.status).toBe('ng');
    expect(ghost.message).toContain('definitely-not-installed');
    expect(ghost.fix).toContain('pnpm add @unicontext/definitely-not-installed');
    expect(byId(checks, 'source:parked')).toMatchObject({ status: 'ok' });
    expect(byId(checks, 'source:parked').message).toContain('スキップ');
    const keychain = byId(checks, 'keychain');
    expect(keychain.status).toBe('warn');
    expect(keychain.message).toContain('メモリ上にだけ');
    expect(keychain.message).toContain('Secret Service is not running');
    expect(keychain.fix).toBeTruthy();
    const pw = byId(checks, 'playwright');
    expect(pw.status).toBe('warn');
    expect(pw.message).toContain('adapter: browser');
    expect(byId(checks, 'desktop-notifications').status).toBe('warn');
    expect(byId(checks, 'database').status).toBe('ok');
    // every non-OK check says what to do
    for (const c of checks.filter((x) => x.status !== 'ok')) expect(c.fix, c.id).toBeTruthy();
  });

  it('only warnings give exit code 0', async () => {
    const d = sub('warn-only');
    writeConfig(d, 'sync:\n  background: false\n');
    expect((await run(d, ['status'])).code).toBe(0);
    const r = await run(d, ['--json', 'doctor'], {
      probes: probes({
        keychain: async () => ({ ok: false, detail: 'no keyring' }),
        playwright: async () => ({ ok: false }),
      }),
    });
    expect(r.code).toBe(0);
    const checks = checksOf(r);
    expect(checks.some((c) => c.status === 'warn')).toBe(true);
    expect(checks.some((c) => c.status === 'ng')).toBe(false);
    expect(byId(checks, 'sources').status).toBe('warn');
  });

  it('shows a configuration error verbatim as NG and keeps checking the rest', async () => {
    const d = sub('bad-config');
    writeConfig(d, 'sources:\n  edstem:\n    password: hunter2\n');
    const r = await run(d, ['--json', 'doctor'], { probes: probes() });
    expect(r.code).toBe(1);
    const checks = checksOf(r);
    const c = byId(checks, 'config');
    expect(c.status).toBe('ng');
    expect(c.message).toBe(
      'Secrets must not be stored in config.yaml (use the OS keychain): sources.edstem.password',
    );
    expect(c.fix).toContain('config.yaml');
    expect(r.stdout).not.toContain('hunter2');
    expect(byId(checks, 'node').status).toBe('ok');
    expect(byId(checks, 'telemetry').status).toBe('ok');
  });

  it('reports a profile that cannot be loaded', async () => {
    const d = sub('bad-profile');
    writeConfig(d, 'profile: no-such-university\n');
    const checks = checksOf(await run(d, ['--json', 'doctor'], { probes: probes() }));
    const c = byId(checks, 'profile');
    expect(c.status).toBe('ng');
    expect(c.message).toContain('no-such-university');
    const ok = sub('good-profile');
    writeConfig(ok, 'profile: shizuoka-university\n');
    const good = checksOf(await run(ok, ['--json', 'doctor'], { probes: probes() }));
    expect(byId(good, 'profile')).toMatchObject({ status: 'ok' });
  });

  it('a missing data dir is a warning, nothing is created', async () => {
    const d = sub('does-not-exist-yet');
    const r = await run(d, ['--json', 'doctor'], { probes: probes() });
    expect(r.code).toBe(0);
    const checks = checksOf(r);
    expect(byId(checks, 'data-dir').status).toBe('warn');
    expect(byId(checks, 'database').status).toBe('warn');
    expect(r.t.runtimeOptions).toHaveLength(0);
  });

  it('a modified or too-new migration is NG with the MigrationError message', async () => {
    const d = sub('tampered');
    writeConfig(d, '');
    const db = openDatabase({ path: path.join(d, 'unicontext.db') });
    db.sqlite.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1").run();
    db.close();
    const r = await run(d, ['--json', 'doctor'], { probes: probes() });
    expect(r.code).toBe(1);
    const c = byId(checksOf(r), 'database');
    expect(c.status).toBe('ng');
    expect(c.message).toContain('001_initial was modified (checksum mismatch)');
    expect(c.fix).toContain('unicontext backup');

    const n = sub('too-new');
    writeConfig(n, '');
    const newer = openDatabase({ path: path.join(n, 'unicontext.db') });
    newer.sqlite
      .prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (99, '099_future', 'x', 'now')",
      )
      .run();
    newer.close();
    const t = await run(n, ['--json', 'doctor'], { probes: probes() });
    expect(t.code).toBe(1);
    expect(byId(checksOf(t), 'database').message).toContain('newer than this UniContext build');
  });

  it('checks data dir permissions: informational on Windows, chmod 700 hint on POSIX', async () => {
    const d = sub('perms');
    writeConfig(d, '');
    const win = checksOf(
      await run(d, ['--json', 'doctor'], { probes: probes({ platform: () => 'win32' }) }),
    );
    expect(byId(win, 'data-dir-permissions')).toMatchObject({ status: 'ok' });
    expect(byId(win, 'data-dir-permissions').message).toContain('Windows');
    expect(byId(win, 'data-dir').status).toBe('ok');

    if (process.platform !== 'win32') chmodSync(d, 0o755);
    const posix = checksOf(
      await run(d, ['--json', 'doctor'], { probes: probes({ platform: () => 'linux' }) }),
    );
    const perm = byId(posix, 'data-dir-permissions');
    expect(perm.status).toBe('warn');
    expect(perm.fix).toBe(`chmod 700 "${d}"`);
    if (process.platform !== 'win32') {
      chmodSync(d, 0o700);
      const fixed = checksOf(
        await run(d, ['--json', 'doctor'], { probes: probes({ platform: () => 'linux' }) }),
      );
      expect(byId(fixed, 'data-dir-permissions').status).toBe('ok');
    }
  });

  it('checks the daemon and the write token without ever printing the token', async () => {
    const d = sub('token');
    writeConfig(d, '');
    const none = checksOf(await run(d, ['--json', 'doctor'], { probes: probes() }));
    expect(byId(none, 'daemon').status).toBe('warn');
    expect(byId(none, 'api-token')).toMatchObject({ status: 'warn' });

    const secret = 'T0kenT0kenT0kenT0kenT0kenT0kenT0kenT0ken12345';
    writeFileSync(path.join(d, 'daemon.token'), `${secret}\n`);
    const withToken = await run(d, ['--json', 'doctor'], { probes: probes() });
    expect(byId(checksOf(withToken), 'api-token').status).toBe('ok');
    expect(withToken.stdout).not.toContain(secret);

    // a running daemon without a readable token is a real problem
    const d2 = sub('token-missing');
    writeConfig(d2, '');
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:17999' });
    client.health = async () => ({
      ok: true as const,
      version: '1.0.0',
      startedAt: '2026-10-01T00:00:00Z',
      pid: 1234,
      dev: false,
    });
    const broken = await run(d2, ['--json', 'doctor'], {
      probes: probes(),
      daemonClient: async () => client,
    });
    expect(broken.code).toBe(1);
    const checks = checksOf(broken);
    expect(byId(checks, 'daemon')).toMatchObject({ status: 'ok' });
    expect(byId(checks, 'daemon').message).toContain('http://127.0.0.1:17999');
    expect(byId(checks, 'api-token')).toMatchObject({ status: 'ng' });
  });

  it('--no-keychain skips the keychain probe, telemetry on is flagged', async () => {
    const d = sub('flags');
    writeConfig(d, 'telemetry:\n  enabled: true\n');
    let probed = false;
    const r = await run(d, ['--no-keychain', '--json', 'doctor'], {
      probes: probes({
        keychain: async () => {
          probed = true;
          return { ok: true };
        },
      }),
    });
    expect(probed).toBe(false);
    const checks = checksOf(r);
    expect(byId(checks, 'keychain').status).toBe('warn');
    expect(byId(checks, 'telemetry')).toMatchObject({ status: 'warn' });
    expect(byId(checks, 'telemetry').fix).toContain('telemetry.enabled: false');
  });

  it('the default probes work against the real machine without throwing', async () => {
    const { defaultProbes } = await import('../src/deps.js');
    const real = defaultProbes();
    expect(real.nodeVersion()).toBe(process.versions.node);
    expect(real.platform()).toBe(process.platform);
    expect(typeof (await real.playwright()).ok).toBe('boolean');
    expect(typeof (await real.desktopNotifications()).ok).toBe('boolean');
    // the keychain probe is only exercised when explicitly allowed (it writes a probe entry)
    if (process.env.UNICONTEXT_TEST_KEYRING === '1')
      expect(typeof (await real.keychain()).ok).toBe('boolean');
  });
});
