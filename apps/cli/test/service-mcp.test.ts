import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServiceDeps, ServicePlatform } from '@unicontext/daemon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';
import { exec, json, removeDir, tempDir } from './helpers.js';

describe('service install / uninstall / status (injected deps, nothing touches the machine)', () => {
  let dir: string;
  let script: string;
  const calls: { file: string; args: string[] }[] = [];
  let deps: ServiceDeps;
  const over = (platform: ServicePlatform, extra: object = {}) => ({
    daemonScript: () => script,
    service: { deps, platform },
    ...extra,
  });

  beforeAll(() => {
    dir = tempDir('unicontext-cli-service-');
    script = path.join(dir, 'daemon-bin.js');
    writeFileSync(script, '// stand-in');
    deps = {
      exec: async (file, args) => {
        calls.push({ file, args });
        return { code: 0, stdout: 'active\n', stderr: '' };
      },
      homedir: path.join(dir, 'home'),
      env: { APPDATA: path.join(dir, 'appdata') },
      uid: 501,
    };
  });
  afterAll(() => removeDir(dir));

  const launcher = (): string =>
    path.join(
      dir,
      'appdata',
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
      'UniContext.vbs',
    );

  it('status before installing: not registered, with the command to register', async () => {
    const r = await exec(['service', 'status'], over('win32'));
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('登録: 未登録');
    expect(r.stdout).toContain('unicontext service install');
    const body = json<{ platform: string; installed: boolean; file: string }>(
      await exec(['--json', 'service', 'status'], over('win32')),
    );
    expect(body).toMatchObject({ platform: 'win32', installed: false, file: launcher() });
  });

  it('Windows installs the Startup-folder wscript launcher, not a scheduled task', async () => {
    calls.length = 0;
    const data = path.join(dir, 'my-data');
    const r = await exec(['--data-dir', data, 'service', 'install'], over('win32'));
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('自動起動を登録しました');
    expect(r.stdout).toContain(launcher());
    const vbs = readFileSync(launcher(), 'utf8');
    expect(vbs).toContain('node-for-tests');
    expect(vbs).toContain(script);
    expect(vbs).toContain(`env("UNICONTEXT_DATA_DIR") = "${data}"`);
    expect(vbs).toContain(`env("UNICONTEXT_CONFIG_DIR") = "${data}"`);
    expect(calls.map((c) => c.file)).toEqual(['wscript.exe']);
    expect(calls.some((c) => /schtasks/i.test(c.file))).toBe(false);

    const status = json<{ installed: boolean; detail: string }>(
      await exec(['--json', 'service', 'status'], over('win32')),
    );
    expect(status.installed).toBe(true);
    expect((await exec(['service', 'status'], over('win32'))).stdout).toContain('登録: 済み');
  });

  it('uninstall removes the launcher', async () => {
    const r = await exec(['service', 'uninstall'], over('win32'));
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('自動起動の登録を解除しました');
    expect(existsSync(launcher())).toBe(false);
    expect(r.stdout).toContain('unicontext daemon stop');
  });

  it('Linux writes a systemd user unit and enables it; status asks systemctl', async () => {
    calls.length = 0;
    const r = await exec(
      ['service', 'install'],
      over('linux', { env: { UNICONTEXT_DATA_DIR: '/data/uc' } }),
    );
    expect(r.code, r.stderr).toBe(0);
    const unit = path.join(dir, 'home', '.config', 'systemd', 'user', 'unicontextd.service');
    const text = readFileSync(unit, 'utf8');
    expect(text).toContain('ExecStart=');
    expect(text).toContain('UNICONTEXT_DATA_DIR=/data/uc');
    expect(calls.map((c) => [c.file, ...c.args].join(' '))).toContain(
      'systemctl --user enable --now unicontextd.service',
    );
    const status = await exec(['service', 'status'], over('linux'));
    expect(status.stdout).toContain('登録: 済み');
    expect(status.stdout).toContain('起動中');
    expect(calls.map((c) => [c.file, ...c.args].join(' '))).toContain(
      'systemctl --user is-active unicontextd.service',
    );
    await exec(['service', 'uninstall'], over('linux'));
    expect(existsSync(unit)).toBe(false);
  });

  it('macOS writes a LaunchAgent plist', async () => {
    const r = await exec(
      ['--config', path.join(dir, 'cfg', 'config.yaml'), 'service', 'install'],
      over('darwin'),
    );
    expect(r.code, r.stderr).toBe(0);
    const plist = readFileSync(
      path.join(dir, 'home', 'Library', 'LaunchAgents', 'ai.nemut.unicontext.plist'),
      'utf8',
    );
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('UNICONTEXT_CONFIG_DIR');
    expect(plist).toContain(path.join(dir, 'cfg').replace(/\\/g, '\\'));
  });

  it('refuses without a built daemon (exit 1) and with --dev (exit 2)', async () => {
    const missing = await exec(['service', 'install'], {
      ...over('win32'),
      daemonScript: () => path.join(dir, 'missing.js'),
    });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('pnpm build');
    const devInstall = await exec(['--dev', 'service', 'install'], over('win32'));
    expect(devInstall.code).toBe(2);
  });
});

describe('mcp', () => {
  it('hands the runtime to the stdio server and prints nothing on stdout', async () => {
    const seen: { version?: string; hasUc: boolean; hasProposals: boolean }[] = [];
    const r = await exec(['--dev', 'mcp'], {
      runStdioServer: async (d) => {
        seen.push({
          ...(d.version ? { version: d.version } : {}),
          hasUc: !!d.uc,
          hasProposals: !!d.proposals,
        });
        expect(d.uc.context.today().classes.length).toBeGreaterThan(0);
      },
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe('');
    expect(seen).toEqual([{ version: VERSION, hasUc: true, hasProposals: true }]);
  });

  it('routes every runtime log to stderr, never stdout', async () => {
    const r = await exec(['--dev', 'mcp'], {
      runStdioServer: async (d) => {
        d.logger?.info('hello from the mcp server', { token: 'sekret-token-value' });
        d.logger?.error('something failed');
      },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('hello from the mcp server');
    expect(r.stderr).toContain('something failed');
    expect(r.stderr).not.toContain('sekret-token-value');
    for (const line of r.stderr.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
  });

  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin.js');
  it.skipIf(!existsSync(bin))(
    'the built binary speaks only JSON-RPC on stdout and exits when stdin closes',
    async () => {
      const child = spawn(process.execPath, [bin, '--dev', 'mcp'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
      const send = (m: unknown): void => void child.stdin.write(`${JSON.stringify(m)}\n`);
      const waitFor = async (pred: () => boolean, ms = 30_000): Promise<void> => {
        const end = Date.now() + ms;
        while (!pred()) {
          if (Date.now() > end) throw new Error(`timeout; stdout=${stdout}; stderr=${stderr}`);
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      });
      await waitFor(() => stdout.includes('"id":1'));
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      await waitFor(() => stdout.includes('"id":2'));
      child.stdin.end();
      const code = await Promise.race([
        exited,
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 20_000)),
      ]);
      if (code === 'timeout') child.kill();
      expect(code).toBe(0);
      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        const msg = JSON.parse(line) as { jsonrpc: string };
        expect(msg.jsonrpc).toBe('2.0');
      }
      expect(stdout).toContain('get_today');
    },
    60_000,
  );
});
