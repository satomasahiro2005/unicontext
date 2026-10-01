import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ExecResult,
  installService,
  renderLaunchdPlist,
  renderSystemdUnit,
  renderWindowsLauncher,
  SERVICE_LABEL,
  serviceFile,
  type ServiceDeps,
  type ServiceSpec,
  serviceStatus,
  uninstallService,
} from '../src/service.js';

let home: string;
let calls: string[][];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'uc-service-'));
  calls = [];
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const spec = (): ServiceSpec => ({
  nodePath: '/usr/local/bin/node',
  daemonScript: '/opt/unicontext/apps/daemon/dist/bin.js',
  logDir: path.posix.join('/var/tmp', 'uc-logs'),
  env: { UNICONTEXT_DATA_DIR: '/data/a & b' },
});

function deps(results: Record<string, Partial<ExecResult>> = {}): ServiceDeps {
  return {
    homedir: home,
    env: { APPDATA: path.join(home, 'AppData', 'Roaming') },
    uid: 501,
    exec: async (file, args) => {
      calls.push([file, ...args]);
      const key = [file, ...args].join(' ');
      const hit = Object.entries(results).find(([k]) => key.startsWith(k));
      return { code: 0, stdout: '', stderr: '', ...(hit?.[1] ?? {}) };
    },
  };
}

describe('rendering', () => {
  it('launchd plist escapes XML and runs the daemon at load', () => {
    const xml = renderLaunchdPlist(spec());
    expect(xml).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(xml).toContain('<string>/usr/local/bin/node</string>');
    expect(xml).toContain('<string>/opt/unicontext/apps/daemon/dist/bin.js</string>');
    expect(xml).toContain('<key>RunAtLoad</key>');
    expect(xml).toContain('/data/a &amp; b');
    expect(xml).toContain('launchd.err.log');
  });

  it('systemd unit quotes the exec line and sets the environment', () => {
    const unit = renderSystemdUnit({ ...spec(), nodePath: '/opt/my node/bin/node' });
    expect(unit).toContain(
      'ExecStart="/opt/my node/bin/node" "/opt/unicontext/apps/daemon/dist/bin.js"',
    );
    expect(unit).toContain('Environment="UNICONTEXT_DATA_DIR=/data/a & b"');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('Restart=on-failure');
  });

  it('Windows launcher is a hidden wscript Run, not a scheduled task', () => {
    const vbs = renderWindowsLauncher({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      daemonScript: 'C:\\unicontext\\apps\\daemon\\dist\\bin.js',
      logDir: 'C:\\logs',
      env: { UNICONTEXT_DATA_DIR: 'D:\\uc "data"' },
    });
    expect(vbs).toContain('CreateObject("WScript.Shell")');
    expect(vbs).toContain(
      'sh.Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\unicontext\\apps\\daemon\\dist\\bin.js""", 0, False',
    );
    expect(vbs).toContain('env("UNICONTEXT_DATA_DIR") = "D:\\uc ""data"""');
    expect(vbs).not.toMatch(/schtasks/i);
  });

  it('places files in the per-OS locations', () => {
    expect(serviceFile('darwin', { homedir: '/Users/a', env: {} })).toBe(
      `/Users/a/Library/LaunchAgents/${SERVICE_LABEL}.plist`,
    );
    expect(serviceFile('linux', { homedir: '/home/a', env: {} })).toBe(
      '/home/a/.config/systemd/user/unicontextd.service',
    );
    expect(serviceFile('linux', { homedir: '/home/a', env: { XDG_CONFIG_HOME: '/x' } })).toBe(
      '/x/systemd/user/unicontextd.service',
    );
    expect(
      serviceFile('win32', {
        homedir: 'C:\\Users\\a',
        env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' },
      }),
    ).toBe(
      'C:\\Users\\a\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\UniContext.vbs',
    );
  });
});

describe('install / status / uninstall', () => {
  it('linux: writes the unit, reloads and enables it, then removes it', async () => {
    const d = deps({ 'systemctl --user is-active': { stdout: 'active\n' } });
    const r = await installService(spec(), d, 'linux');
    expect(existsSync(r.file)).toBe(true);
    expect(readFileSync(r.file, 'utf8')).toContain('ExecStart=');
    expect(calls).toContainEqual(['systemctl', '--user', 'daemon-reload']);
    expect(calls).toContainEqual(['systemctl', '--user', 'enable', '--now', 'unicontextd.service']);
    const st = await serviceStatus(d, 'linux');
    expect(st).toMatchObject({ installed: true, running: true, platform: 'linux' });
    const u = await uninstallService(d, 'linux');
    expect(existsSync(u.file)).toBe(false);
    expect(calls).toContainEqual([
      'systemctl',
      '--user',
      'disable',
      '--now',
      'unicontextd.service',
    ]);
    expect((await serviceStatus(d, 'linux')).installed).toBe(false);
  });

  it('darwin: writes the plist and bootstraps it into the gui domain', async () => {
    const d = deps({ 'launchctl print': { stdout: '\tstate = running\n' } });
    const r = await installService(spec(), d, 'darwin');
    expect(existsSync(r.file)).toBe(true);
    expect(calls).toContainEqual(['launchctl', 'bootstrap', 'gui/501', r.file]);
    expect((await serviceStatus(d, 'darwin')).running).toBe(true);
    await uninstallService(d, 'darwin');
    expect(calls).toContainEqual(['launchctl', 'bootout', `gui/501/${SERVICE_LABEL}`]);
    expect(existsSync(r.file)).toBe(false);
  });

  it('darwin: a failed bootstrap is reported, not thrown', async () => {
    const d = deps({ 'launchctl bootstrap': { code: 5, stderr: 'denied' } });
    const r = await installService(spec(), d, 'darwin');
    expect(r.messages.join('\n')).toContain('denied');
  });

  it('win32: puts the launcher in the Startup folder and starts it with wscript', async () => {
    const d = deps();
    const r = await installService(spec(), d, 'win32');
    expect(r.file.endsWith('UniContext.vbs')).toBe(true);
    expect(existsSync(r.file)).toBe(true);
    expect(calls.some((c) => c[0] === 'wscript.exe')).toBe(true);
    expect(calls.some((c) => (c[0] ?? '').toLowerCase().includes('schtasks'))).toBe(false);
    expect((await serviceStatus(d, 'win32')).installed).toBe(true);
    await uninstallService(d, 'win32');
    expect(existsSync(r.file)).toBe(false);
  });

  it('uninstall when nothing is installed says so', async () => {
    const r = await uninstallService(deps(), 'linux' as const);
    expect(r.messages.join('')).toContain('登録されていません');
  });
});
