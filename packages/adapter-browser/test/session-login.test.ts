import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySecretStore } from '@unicontext/auth';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BrowserSession,
  type BrowserContextLike,
  FakeBrowserContext,
  FakeBrowserDriver,
  type LaunchOptions,
  type LoginProgress,
  type PageLike,
} from '../src/index.js';

const START = 'https://portal.example.ac.jp/home';
const DONE = 'https://portal.example.ac.jp/after';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A driver whose context comes back with leftover tabs, like `--restore-last-session` does. */
class RestoringDriver extends FakeBrowserDriver {
  /** Tab URLs at the moment each page navigates (to see what was open before the first goto). */
  tabsAtGoto: number[] = [];
  constructor(
    private readonly restored: number,
    init: ConstructorParameters<typeof FakeBrowserDriver>[0] = {},
  ) {
    super(init);
  }
  override async launchPersistentContext(
    userDataDir: string,
    options: LaunchOptions,
  ): Promise<BrowserContextLike> {
    const ctx = (await super.launchPersistentContext(userDataDir, options)) as FakeBrowserContext;
    for (let i = 1; i < this.restored; i++) await ctx.newPage();
    for (const page of ctx.list) {
      const goto = page.goto.bind(page);
      page.goto = (url: string) => {
        this.tabsAtGoto.push(ctx.pages().length);
        return goto(url);
      };
    }
    return ctx;
  }
}

function session(
  driver: FakeBrowserDriver,
  extra: Partial<ConstructorParameters<typeof BrowserSession>[0]> = {},
): BrowserSession {
  const dir = mkdtempSync(join(tmpdir(), 'uc-session-'));
  dirs.push(dir);
  return new BrowserSession({
    sourceId: 'portal',
    profileDir: join(dir, 'profile'),
    secrets: new MemorySecretStore(),
    driver,
    startUrl: START,
    cookieUrls: [],
    pollIntervalMs: 10,
    isAuthenticated: (page: PageLike) => page.url() === DONE,
    ...extra,
  });
}

describe('interactive login and restored tabs', () => {
  it('closes every restored tab but one before the first navigation', async () => {
    const driver = new RestoringDriver(3, { screens: { [START]: { title: 'x', html: '' } } });
    const s = session(driver, { keepSessionCookies: true, isAuthenticated: () => true });
    expect((await s.login()).status).toBe('authenticated');
    expect(driver.contexts[0]?.list).toHaveLength(3);
    expect(driver.tabsAtGoto[0]).toBe(1); // one page left when the sign-in page was opened
    expect(driver.contexts[0]?.list.filter((p) => !p.closed)).toHaveLength(0); // closed again at the end
    expect(driver.launches[0]?.options.args).toEqual(['--restore-last-session']);
  });

  it('a headless refresh leaves restored tabs alone (it only reads)', async () => {
    const driver = new RestoringDriver(3);
    const s = session(driver, { isAuthenticated: () => true });
    await s.refresh();
    expect(driver.tabsAtGoto[0]).toBe(3);
  });
});

describe('interactive login says what it is waiting on', () => {
  function stuck(describe?: (page: PageLike) => LoginProgress | undefined) {
    const driver = new FakeBrowserDriver({
      screens: { [START]: { title: 'x', html: '' }, [DONE]: { title: 'y', html: '' } },
    });
    const said: string[] = [];
    const s = session(driver, {
      describeIntervalMs: 30,
      timeoutMs: 400,
      ...(describe ? { describe } : {}),
    });
    return { driver, said, s };
  }

  it('notifies the tab paths (never queries) and the connector detail every interval', async () => {
    const { driver, said, s } = stuck(() => ({ detail: '確認: 302→/dana-na/…' }));
    driver.redirects[START] = 'https://portal.example.ac.jp/dana-na/auth/url_3/login.cgi?token=SECRET';
    const r = await s.login({ notify: (m) => said.push(m) });
    expect(r.status).toBe('failed'); // timed out
    const line = said.find((m) => m.startsWith('サインイン後の確認待ち:'));
    expect(line).toBe(
      'サインイン後の確認待ち: /dana-na/auth/url_3/login.cgi（確認: 302→/dana-na/…）',
    );
    expect(said.join('\n')).not.toContain('SECRET');
    expect(said.filter((m) => m === line).length).toBeGreaterThan(1);
  });

  it('says a notice once, as soon as it shows, and again only after it went away', async () => {
    let n = 0;
    const { said, s } = stuck(() => (++n < 15 ? { notice: '画面の「続行」を押してください' } : {}));
    await s.login({ notify: (m) => said.push(m) });
    expect(said.filter((m) => m === '画面の「続行」を押してください')).toHaveLength(1);
  });

  it('stays quiet when there is no notify callback, and when the connector throws', async () => {
    const { s } = stuck(() => {
      throw new Error('boom');
    });
    expect((await s.login()).status).toBe('failed');
    const { said, s: s2 } = stuck(() => {
      throw new Error('boom');
    });
    await s2.login({ notify: (m) => said.push(m) });
    expect(said.every((m) => m.startsWith('サインイン後の確認待ち:'))).toBe(true);
  });

  it('is never said by a headless refresh', async () => {
    const driver = new FakeBrowserDriver({ screens: { [START]: { title: 'x', html: '' } } });
    let described = 0;
    const s = session(driver, {
      describeIntervalMs: 5,
      refreshTimeoutMs: 150,
      describe: () => {
        described++;
        return { detail: 'x' };
      },
    });
    expect((await s.refresh()).status).toBe('auth_required');
    expect(described).toBe(0);
  });

  it('is quiet on a page that asks for credentials (the person is typing)', async () => {
    const driver = new FakeBrowserDriver({
      screens: {
        [START]: { title: 'x', html: '', selectors: ['input[type="password"]:visible'] },
      },
    });
    const said: string[] = [];
    const s = session(driver, { describeIntervalMs: 20, timeoutMs: 300 });
    await s.login({ notify: (m) => said.push(m) });
    expect(said).toEqual([]);
  });
});

// Compile-time: the LCU / teams-web style call (prepareContext with one parameter) still fits.
const oneParam: NonNullable<ConstructorParameters<typeof BrowserSession>[0]['prepareContext']> = (
  _context,
) => Promise.resolve();
void oneParam;
