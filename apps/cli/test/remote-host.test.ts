import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserCookie, BrowserDriver, LaunchOptions } from '@unicontext/adapter-browser';
import type { SecretStore } from '@unicontext/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { touchedProfiles } from '../src/commands/handoff.js';
import {
  commandOf,
  remoteTarget,
  runOverSsh,
  shQuote,
  sshArgs,
  type Spawner,
} from '../src/remote-host.js';
import { exec, removeDir, tempDir, writeConfig } from './helpers.js';

describe('running on a remote machine', () => {
  it('forwards only when UNICONTEXT_REMOTE is set and no local data is named', () => {
    const env = { UNICONTEXT_REMOTE: 'oppi@pi.local' };
    expect(remoteTarget(['status'], {})).toBeUndefined();
    expect(remoteTarget(['status'], env)).toEqual({ host: 'oppi@pi.local', command: 'unicontext' });
    expect(remoteTarget(['--dev', 'today'], env)).toBeUndefined();
    expect(remoteTarget(['--data-dir=x', 'today'], env)).toBeUndefined();
    expect(
      remoteTarget(['status'], { ...env, UNICONTEXT_REMOTE_COMMAND: 'node ~/uc/bin.js' })?.command,
    ).toBe('node ~/uc/bin.js');
  });

  it('finds the command after global options', () => {
    expect(commandOf(['--json', 'login', 'teams-web'])).toBe('login');
    expect(commandOf(['--config', 'login', 'status'])).toBe('status');
    expect(commandOf(['--verbose'])).toBeUndefined();
  });

  it('quotes every argument for the remote shell', () => {
    expect(shQuote('guest')).toBe('guest');
    expect(shQuote('母')).toBe("'母'");
    expect(shQuote("it's; rm -rf ~")).toBe("'it'\\''s; rm -rf ~'");
    expect(sshArgs({ host: 'h', command: 'unicontext' }, ['guest', 'add', '母'], true)).toEqual([
      '-t',
      '-o',
      'LogLevel=ERROR',
      'h',
      "unicontext guest add '母'",
    ]);
  });

  it('runs ssh and returns its exit code', async () => {
    const calls: { args: string[]; stdin?: string }[] = [];
    const spawner = ((_cmd: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { stdin: { end(s: string): void } };
      const call: { args: string[]; stdin?: string } = { args };
      calls.push(call);
      child.stdin = { end: (s) => void (call.stdin = s) };
      setImmediate(() => child.emit('close', 3));
      return child;
    }) as unknown as Spawner;
    const target = { host: 'h', command: 'unicontext' };
    expect(await runOverSsh(target, ['status'], { tty: false, spawner })).toBe(3);
    expect(await runOverSsh(target, ['import-login'], { tty: false, spawner, stdin: '{}' })).toBe(
      3,
    );
    expect(calls.map((c) => c.args[0])).toEqual(['-T', '-T']);
    expect(calls[0]?.stdin).toBeUndefined();
    expect(calls[1]?.stdin).toBe('{}');
  });
});

describe('moving a sign-in to another machine', () => {
  class Keychain implements SecretStore {
    readonly backend = 'fake-keyring';
    readonly map = new Map<string, string>();
    get = (k: string) => Promise.resolve(this.map.get(k));
    set = (k: string, v: string) => Promise.resolve(void this.map.set(k, v));
    delete = (k: string) => Promise.resolve(this.map.delete(k));
  }

  const cookie: BrowserCookie = {
    name: 'DSID',
    value: 'v',
    domain: 'vpn.example.ac.jp',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true,
  };

  /** Profiles as cookie jars; every profile starts with one stale cookie. */
  class CookieDriver implements BrowserDriver {
    readonly jars = new Map<string, BrowserCookie[]>();
    readonly launches: LaunchOptions[] = [];
    launchPersistentContext(dir: string, options: LaunchOptions) {
      this.launches.push(options);
      const jars = this.jars;
      if (!jars.has(dir)) jars.set(dir, [{ ...cookie, name: 'stale' }]);
      const page = { url: () => 'about:blank', isClosed: () => false };
      return Promise.resolve({
        pages: () => [page],
        newPage: () => Promise.reject(new Error('not used')),
        cookies: () => Promise.resolve(jars.get(dir) ?? []),
        clearCookies: () => Promise.resolve(void jars.set(dir, [])),
        addCookies: (c: BrowserCookie[]) => {
          if (c[0]?.name === 'bad') return Promise.reject(new Error('invalid cookie'));
          jars.get(dir)?.push(...c);
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      } as never);
    }
  }

  let dir: string;
  let base: string[];
  beforeAll(() => {
    dir = tempDir();
    const config = writeConfig(
      dir,
      [
        'sources:',
        '  ed:',
        '    enabled: false',
        '    adapter: mcp',
        '    command: node',
        '    envSecrets:',
        '      - { name: ED_TOKEN, secret: ed-token }',
        '',
      ].join('\n'),
    );
    base = ['--data-dir', dir, '--config', config];
  });
  afterAll(() => removeDir(dir));

  it('notices which browser profiles a sign-in wrote to', () => {
    const cache = path.join(dir, 'cache-scan');
    for (const name of ['old', 'new']) {
      const f = path.join(cache, name, 'browser-profile', 'Default', 'Network', 'Cookies');
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, '');
      if (name === 'old') utimesSync(f, new Date('2026-01-01'), new Date('2026-01-01'));
    }
    expect(touchedProfiles(cache, Date.now() - 60_000)).toEqual(['new/browser-profile']);
    expect(touchedProfiles(path.join(dir, 'missing'), 0)).toEqual([]);
  });

  it('puts the cookies and secrets where a sign-in there would have left them', async () => {
    const keychain = new Keychain();
    const driver = new CookieDriver();
    const handoff = {
      version: 1,
      sourceId: 'ed',
      secrets: { 'ed-token': 'tok' },
      profiles: { 'ed/browser-profile': [cookie, { ...cookie, name: 'bad' }] },
    };
    const res = await exec([...base, 'import-login'], {
      secretStore: async () => keychain,
      browserDriver: driver,
      readStdin: async () => JSON.stringify(handoff),
    });
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain('ed: ログインを受け取りました（cookie: ed（1件））');
    expect(keychain.map.get('ed/ed-token')).toBe('tok');
    const jar = driver.jars.get(path.join(dir, 'cache', 'ed', 'browser-profile'));
    expect(jar?.map((c) => c.name)).toEqual(['DSID']);
    expect(driver.launches[0]?.args).toContain('--restore-last-session');
  });

  it('refuses a handoff that points outside the profiles', async () => {
    const res = await exec([...base, 'import-login'], {
      secretStore: async () => new Keychain(),
      browserDriver: new CookieDriver(),
      readStdin: async () =>
        JSON.stringify({
          version: 1,
          sourceId: 'ed',
          secrets: {},
          profiles: { '../../x/browser-profile': [] },
        }),
    });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('プロファイルの場所が不正です');
    expect(existsSync(path.join(dir, 'x'))).toBe(false);
  });
});
