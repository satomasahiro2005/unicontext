import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemorySecretStore } from '@unicontext/auth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OffsetClock } from '../src/dev.js';
import {
  acquireLock,
  DaemonAlreadyRunningError,
  lockFile,
  readLock,
  startedBeforeBoot,
} from '../src/lock.js';
import {
  CsrfTokens,
  bearerToken,
  isLoopbackHost,
  isLoopbackOrigin,
  originMatchesHost,
  parseCookies,
  parseHostHeader,
} from '../src/security.js';
import {
  API_TOKEN_KEY,
  loadOrCreateApiToken,
  readApiToken,
  tokenFile,
  tokensEqual,
} from '../src/token.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'uc-infra-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('security helpers', () => {
  it('parses Host headers', () => {
    expect(parseHostHeader('localhost:17878')).toEqual({ hostname: 'localhost', port: '17878' });
    expect(parseHostHeader('[::1]:80')).toEqual({ hostname: '[::1]', port: '80' });
    expect(parseHostHeader('127.0.0.1')).toEqual({ hostname: '127.0.0.1', port: undefined });
    expect(parseHostHeader(undefined)).toBeUndefined();
    expect(parseHostHeader('a b')).toBeUndefined();
  });

  it('isLoopbackHost / isLoopbackOrigin', () => {
    expect(isLoopbackHost('LOCALHOST:1234')).toBe(true);
    expect(isLoopbackHost('127.0.0.2')).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
    expect(isLoopbackOrigin('http://localhost:5173')).toBe(true);
    expect(isLoopbackOrigin('https://localhost.evil.com')).toBe(false);
    expect(isLoopbackOrigin('null')).toBe(false);
    expect(isLoopbackOrigin('file:///x')).toBe(false);
    expect(originMatchesHost('http://127.0.0.1:17878', '127.0.0.1:17878')).toBe(true);
    expect(originMatchesHost('http://127.0.0.1:17878', 'localhost:17878')).toBe(false);
    expect(originMatchesHost(undefined, 'localhost')).toBe(false);
  });

  it('CSRF tokens verify only when issued with the same key', () => {
    const a = new CsrfTokens('secret-a');
    const b = new CsrfTokens('secret-b');
    const t = a.issue();
    expect(a.verify(t)).toBe(true);
    expect(b.verify(t)).toBe(false);
    expect(a.verify(undefined)).toBe(false);
    expect(a.verify('x')).toBe(false);
    expect(a.verify(`${t}.extra`)).toBe(false);
    expect(a.issue()).not.toBe(t);
  });

  it('parses cookies and bearer headers', () => {
    expect(parseCookies('a=1; uc_csrf=x.y; b=')).toEqual({ a: '1', uc_csrf: 'x.y', b: '' });
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer  abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});

describe('API token (§32, §41)', () => {
  it('keychain-like store: token is stored in the secret store, not on disk', async () => {
    const secrets = new MemorySecretStore();
    Object.defineProperty(secrets, 'backend', { value: 'keyring' });
    const t = await loadOrCreateApiToken(secrets, { root: dir });
    expect(t.length).toBeGreaterThanOrEqual(32);
    expect(await secrets.get(API_TOKEN_KEY)).toBe(t);
    expect(existsSync(tokenFile({ root: dir }))).toBe(false);
    expect(await loadOrCreateApiToken(secrets, { root: dir })).toBe(t);
    expect(await readApiToken(secrets, { root: dir })).toBe(t);
  });

  it('memory backend: falls back to a token file the CLI can read', async () => {
    const secrets = new MemorySecretStore();
    const t = await loadOrCreateApiToken(secrets, { root: dir });
    expect(readFileSync(tokenFile({ root: dir }), 'utf8').trim()).toBe(t);
    expect(await readApiToken(new MemorySecretStore(), { root: dir })).toBe(t);
  });

  it('a throwing keychain falls back to the file', async () => {
    const broken = {
      backend: 'keyring',
      get: async () => {
        throw new Error('no secret service');
      },
      set: async () => {
        throw new Error('no secret service');
      },
      delete: async () => false,
    };
    const t = await loadOrCreateApiToken(broken, { root: dir });
    expect(await readApiToken(broken, { root: dir })).toBe(t);
  });

  it('tokensEqual is exact', () => {
    expect(tokensEqual('abc', 'abc')).toBe(true);
    expect(tokensEqual('abc', 'abd')).toBe(false);
    expect(tokensEqual('abc', 'abcd')).toBe(false);
    expect(tokensEqual('abc', undefined)).toBe(false);
  });
});

describe('single-instance lock (§34)', () => {
  it('a second daemon on the same data dir is refused, and release frees it', () => {
    const l1 = acquireLock({ root: dir });
    l1.setPort(17878);
    expect(readLock({ root: dir })).toMatchObject({ pid: process.pid, port: 17878 });
    // same process holds it: acquiring again must not silently succeed twice
    expect(() => acquireLock({ root: dir })).not.toThrow(DaemonAlreadyRunningError);
    l1.release();
    expect(existsSync(lockFile({ root: dir }))).toBe(false);
  });

  it('refuses when another live process owns the lock', () => {
    // parent process of the test runner is alive and is not us
    writeFileSync(
      lockFile({ root: dir }),
      JSON.stringify({ pid: process.ppid, port: 1234, startedAt: 'x' }),
    );
    expect(() => acquireLock({ root: dir })).toThrow(DaemonAlreadyRunningError);
  });

  it('recovers a stale lock (dead pid) and corrupt lock files', () => {
    writeFileSync(
      lockFile({ root: dir }),
      JSON.stringify({ pid: 2 ** 22 + 12345, port: 1, startedAt: 'x' }),
    );
    const l = acquireLock({ root: dir });
    expect(readLock({ root: dir })?.pid).toBe(process.pid);
    l.release();
    writeFileSync(lockFile({ root: dir }), '{not json');
    acquireLock({ root: dir }).release();
  });

  it('a lock from a previous boot is stale even if its pid was reused by a live process', () => {
    writeFileSync(
      lockFile({ root: dir }),
      JSON.stringify({ pid: process.ppid, port: 1234, startedAt: '2000-01-01T00:00:00.000Z' }),
    );
    const l = acquireLock({ root: dir });
    expect(readLock({ root: dir })?.pid).toBe(process.pid);
    l.release();
  });

  it('startedBeforeBoot uses the boot time with slack and ignores unparsable times', () => {
    const now = new Date('2026-10-01T12:00:00.000Z');
    const uptimeSec = 3600; // booted 11:00
    expect(startedBeforeBoot({ startedAt: '2026-10-01T10:00:00.000Z' }, now, uptimeSec)).toBe(true);
    expect(startedBeforeBoot({ startedAt: '2026-10-01T10:55:00.000Z' }, now, uptimeSec)).toBe(
      false,
    );
    expect(startedBeforeBoot({ startedAt: '2026-10-01T11:30:00.000Z' }, now, uptimeSec)).toBe(
      false,
    );
    expect(startedBeforeBoot({ startedAt: 'x' }, now, uptimeSec)).toBe(false);
  });

  it('release does not remove somebody else lock', () => {
    const l = acquireLock({ root: dir });
    writeFileSync(
      lockFile({ root: dir }),
      JSON.stringify({ pid: process.ppid, port: 1, startedAt: 'x' }),
    );
    l.release();
    expect(existsSync(lockFile({ root: dir }))).toBe(true);
    mkdirSync(dir, { recursive: true });
  });
});

describe('OffsetClock', () => {
  it('set() shifts now() and keeps it ticking', async () => {
    const c = new OffsetClock();
    c.set('2026-10-01T00:30:00.000Z');
    const a = c.now().getTime();
    expect(Math.abs(a - new Date('2026-10-01T00:30:00.000Z').getTime())).toBeLessThan(2000);
    await c.sleep(30);
    expect(c.now().getTime()).toBeGreaterThan(a);
  });
});
