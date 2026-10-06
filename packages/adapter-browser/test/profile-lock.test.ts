import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySecretStore } from '@unicontext/auth';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BrowserProfileInUseError,
  BrowserSession,
  FakeBrowserDriver,
  isProfileHandOffError,
  isProfileInUse,
  playwrightDriver,
} from '../src/index.js';

const HOME = 'https://portal.example.ac.jp/home';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'uc-lock-'));
  dirs.push(d);
  return d;
};

function lockedSession(
  driver: FakeBrowserDriver,
  inUse: { value: boolean },
  extra: Partial<ConstructorParameters<typeof BrowserSession>[0]> = {},
): BrowserSession {
  return new BrowserSession({
    sourceId: 'vpn',
    profileDir: join(tmp(), 'profile'),
    secrets: new MemorySecretStore(),
    driver,
    startUrl: HOME,
    isAuthenticated: (page) => page.url().startsWith(HOME),
    cookieUrls: [],
    pollIntervalMs: 2,
    refreshTimeoutMs: 200,
    timeoutMs: 500,
    isProfileInUse: () => inUse.value,
    ...extra,
  });
}

const homeScreen = { [HOME]: { title: 'ホーム', html: '' } };

describe('a browser profile another process holds', () => {
  it('a headless run fails at once with an accurate error and never launches', async () => {
    const driver = new FakeBrowserDriver({ screens: homeScreen });
    const session = lockedSession(driver, { value: true });
    const r = await session.refresh();
    expect(r.status).toBe('auth_required');
    expect(r.message).toMatch(/in use by another browser process/);
    await expect(session.withPage(() => Promise.resolve(1))).rejects.toBeInstanceOf(
      BrowserProfileInUseError,
    );
    expect(driver.launches).toHaveLength(0);
  });

  it('an interactive login waits for the profile, says so, then opens the window', async () => {
    const driver = new FakeBrowserDriver({ screens: homeScreen });
    const inUse = { value: true };
    const session = lockedSession(driver, inUse);
    const notes: string[] = [];
    const p = session.login({ notify: (m) => notes.push(m) });
    await new Promise((r) => setTimeout(r, 30));
    expect(driver.launches).toHaveLength(0);
    inUse.value = false; // the daemon's sync finished
    expect((await p).status).toBe('authenticated');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/待ちます/);
    expect(driver.launches.map((l) => l.options.headless)).toEqual([false]);
  });

  it('an interactive login gives up after profileWaitMs with the in-use error', async () => {
    const driver = new FakeBrowserDriver();
    const session = lockedSession(driver, { value: true }, { profileWaitMs: 20 });
    const r = await session.login();
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/in use by another browser process/);
    expect(driver.launches).toHaveLength(0);
  });

  it('keepSessionCookies restores the last session and leaves one blank tab behind', async () => {
    const driver = new FakeBrowserDriver({ screens: homeScreen });
    const session = lockedSession(driver, { value: false }, { keepSessionCookies: true });
    await session.withPage(async (_page, context) => {
      await context.newPage();
      return undefined;
    });
    expect(driver.launches[0]?.options.args).toEqual(['--restore-last-session']);
    const ctx = driver.contexts[0]!;
    expect(ctx.list[1]?.closed).toBe(true);
    expect(driver.visited.at(-1)).toBe('about:blank');
  });

  it('isProfileInUse ignores a stale lock left by a browser that exited', () => {
    const dir = tmp();
    if (process.platform === 'win32') writeFileSync(join(dir, 'lockfile'), '');
    else symlinkSync('host-999999999', join(dir, 'SingletonLock'));
    expect(isProfileInUse(dir)).toBe(false);
    expect(isProfileInUse(join(dir, 'missing'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('isProfileInUse sees a live SingletonLock owner', () => {
    const dir = tmp();
    symlinkSync(`host-${process.pid}`, join(dir, 'SingletonLock'));
    expect(isProfileInUse(dir)).toBe(true);
  });
});

describe('playwrightDriver launch errors', () => {
  it('reports a profile hand-off (Chrome exit code 21) as in use, not as "no browser"', async () => {
    const tried: string[] = [];
    const driver = playwrightDriver(() =>
      Promise.resolve({
        chromium: {
          launchPersistentContext: (_dir: string, opts: Record<string, unknown>) => {
            tried.push(String(opts.channel));
            return Promise.reject(
              new Error(
                'browserType.launchPersistentContext: Target page, context or browser has been closed\nBrowser logs:\n - [pid=1] <process did exit: exitCode=21, signal=null>',
              ),
            );
          },
        },
      }),
    );
    await expect(
      driver.launchPersistentContext('prof', { headless: true }),
    ).rejects.toBeInstanceOf(BrowserProfileInUseError);
    expect(tried).toEqual(['chrome']);
    expect(isProfileHandOffError(new Error('not installed'))).toBe(false);
  });

  it('the "no browser" error carries the last launch error', async () => {
    const driver = playwrightDriver(() =>
      Promise.resolve({
        chromium: {
          launchPersistentContext: () =>
            Promise.reject(new Error('Chromium distribution "msedge" is not found\nmore')),
        },
      }),
    );
    await expect(driver.launchPersistentContext('d', { headless: true })).rejects.toThrow(
      /tried channels: chrome, msedge\): Chromium distribution "msedge" is not found\./,
    );
  });

  it('passes extra switches through', async () => {
    let seen: Record<string, unknown> | undefined;
    const driver = playwrightDriver(() =>
      Promise.resolve({
        chromium: {
          launchPersistentContext: (_dir: string, opts: Record<string, unknown>) => {
            seen = opts;
            return Promise.resolve({});
          },
        },
      }),
    );
    await driver.launchPersistentContext('d', { headless: true, args: ['--restore-last-session'] });
    expect(seen?.args).toEqual(['--restore-last-session']);
  });
});
