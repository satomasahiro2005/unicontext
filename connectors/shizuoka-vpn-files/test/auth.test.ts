import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeBrowserDriver, type FakePage } from '@unicontext/adapter-browser';
import { instantiateConnector, type AuthResult } from '@unicontext/connector-sdk';
import { AuthRequiredError, type SecretStore, type UniversityProfile } from '@unicontext/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createShizuokaVpnFilesConnector,
  onPortal,
  type SessionMarker,
  ShizuokaVpnFilesAdapter,
  signInUrl,
} from '../src/index.js';
import { DEPLOYMENT, harness, NOW, testClock } from './helpers.js';

const O = 'https://vpn.inf.shizuoka.ac.jp';

/** The connector never stores secrets (cookieUrls: []); an empty store is enough. */
const noSecrets: SecretStore = {
  backend: 'memory',
  get: () => Promise.resolve(undefined),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve(false),
};

function memMarker(at?: string): SessionMarker & { value: string | undefined } {
  const m = {
    value: at,
    read: () => m.value,
    write: (v: string | undefined) => {
      m.value = v;
    },
  };
  return m;
}

const minutesAgo = (n: number): string => new Date(NOW.getTime() - n * 60_000).toISOString();

describe('onPortal (URL shape only)', () => {
  it('is false where a signed-out browser ends up', () => {
    // /dana/home/index.cgi → /dana-na/auth/welcome.cgi → / (a 404 page), observed 2026-10-06.
    expect(onPortal(DEPLOYMENT, `${O}/`)).toBe(false);
    expect(onPortal(DEPLOYMENT, `${O}/dana-na/auth/welcome.cgi`)).toBe(false);
    expect(onPortal(DEPLOYMENT, `${O}/dana-na/auth/url_3/welcome.cgi?p=user-confirm`)).toBe(false);
    expect(onPortal(DEPLOYMENT, `${O}/dana-cached/imgs/logo.png`)).toBe(false);
    expect(onPortal(DEPLOYMENT, 'https://example.com/dana/home/index.cgi')).toBe(false);
  });

  it('is true on signed-in portal pages', () => {
    expect(onPortal(DEPLOYMENT, `${O}/dana/home/index.cgi`)).toBe(true);
    expect(onPortal(DEPLOYMENT, `${O}/files/list/windows/resource_1?dirPath=`)).toBe(true);
  });

  it('signs in at the realm form', () => {
    expect(signInUrl(DEPLOYMENT)).toBe(`${O}/dana-na/auth/url_3/welcome.cgi`);
  });
});

describe('authenticate() needs a verified portal session', () => {
  it('a browser profile alone is not a session (a sign-in window that closed early)', async () => {
    let verified = 0;
    const { adapter } = harness({
      sessionMarker: memMarker(),
      verifySession: () => {
        verified++;
        return Promise.resolve({ status: 'authenticated' });
      },
    });
    const r = await adapter.authenticate();
    expect(r.status).toBe('auth_required');
    expect(r.message).toMatch(/unicontext login shizuoka-vpn-files/);
    expect(verified).toBe(0); // no browser opened for a session that was never established
  });

  it('no profile → auth_required', async () => {
    const { adapter } = harness({ profileExists: false, sessionMarker: memMarker(minutesAgo(1)) });
    expect((await adapter.authenticate()).status).toBe('auth_required');
  });

  it('just verified → authenticated without opening the browser again', async () => {
    let verified = 0;
    const { adapter } = harness({
      sessionMarker: memMarker(minutesAgo(1)),
      verifySession: () => {
        verified++;
        return Promise.resolve({ status: 'auth_required' });
      },
    });
    expect((await adapter.authenticate()).status).toBe('authenticated');
    expect(verified).toBe(0);
  });

  it('verified a while ago → asks the portal; a dead session forgets the marker', async () => {
    const marker = memMarker(minutesAgo(30));
    const { adapter } = harness({
      sessionMarker: marker,
      verifySession: () => Promise.resolve({ status: 'auth_required', message: 'password field' }),
    });
    const r = await adapter.authenticate();
    expect(r.status).toBe('auth_required');
    expect(marker.value).toBeUndefined();
  });

  it('verified a while ago and still live → authenticated, marker renewed', async () => {
    const marker = memMarker(minutesAgo(30));
    const { adapter } = harness({
      sessionMarker: marker,
      verifySession: () => Promise.resolve({ status: 'authenticated' }),
    });
    expect((await adapter.authenticate()).status).toBe('authenticated');
    expect(marker.value).toBe(NOW.toISOString());
  });

  it('older than the portal keeps a session → auth_required without a check', async () => {
    let verified = 0;
    const { adapter } = harness({
      sessionMarker: memMarker(minutesAgo(90)),
      verifySession: () => {
        verified++;
        return Promise.resolve({ status: 'authenticated' });
      },
    });
    expect((await adapter.authenticate()).status).toBe('auth_required');
    expect(verified).toBe(0);
  });

  it('the other UniContext process is using the session → no second browser', async () => {
    let verified = 0;
    const { adapter } = harness({
      sessionMarker: memMarker(minutesAgo(10)),
      profileInUse: () => true,
      verifySession: () => {
        verified++;
        return Promise.resolve({ status: 'auth_required' });
      },
    });
    expect((await adapter.authenticate()).status).toBe('authenticated');
    expect(verified).toBe(0);
  });

  it('login and sync record the verified session; a lost session clears it', async () => {
    const marker = memMarker();
    const ok = harness({
      sessionMarker: marker,
      login: () => Promise.resolve({ status: 'authenticated' } as AuthResult),
    });
    expect((await ok.adapter.login()).status).toBe('authenticated');
    expect(marker.value).toBe(NOW.toISOString());
    marker.value = minutesAgo(30);
    await ok.adapter.sync({ mode: 'initial' });
    expect(marker.value).toBe(NOW.toISOString());

    const lost = harness({ sessionMarker: marker, authFail: true });
    await expect(lost.adapter.sync({ mode: 'incremental' })).rejects.toBeInstanceOf(
      AuthRequiredError,
    );
    expect(marker.value).toBeUndefined();
  });
});

describe('sign-in through the real BrowserSession (scripted browser)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup() {
    const cacheDir = mkdtempSync(join(tmpdir(), 'uc-vpn-'));
    dirs.push(cacheDir);
    const portal = { signedIn: false };
    const signedOutRedirects = {
      [`${O}/dana/home/index.cgi`]: `${O}/dana-na/auth/welcome.cgi`,
      [`${O}/dana-na/auth/welcome.cgi`]: `${O}/`,
    };
    const driver = new FakeBrowserDriver({
      screens: {
        [`${O}/`]: { title: 'Ivanti Connect Secure', html: '<h1>404</h1>' },
        [`${O}/dana-na/auth/url_3/welcome.cgi`]: {
          title: 'Ivanti Connect Secure',
          html: '<form name="frmLogin"><input name="username"><input type="password" name="password"></form>',
          selectors: ['input[type="password"]:visible'],
        },
        [`${O}/dana/home/index.cgi`]: { title: 'Ivanti Connect Secure - Home', html: '' },
      },
      redirects: { ...signedOutRedirects },
      // The in-page session check: the landing-page JSON answers only inside a live session.
      evaluate: (page: FakePage, expression: string) =>
        expression.includes('/api/v1/enduser/landing-page')
          ? { live: portal.signedIn && onPortal(DEPLOYMENT, page.url()) }
          : undefined,
    });
    const profile = {
      products: { 'shizuoka-vpn-files': { deployment: 'shizuoka' } },
      academicCalendar: { timezone: 'Asia/Tokyo' },
    } as unknown as UniversityProfile;
    const { adapter } = instantiateConnector(createShizuokaVpnFilesConnector({ driver }), {
      sourceId: 'shizuoka-vpn-files',
      config: { browser: { loginTimeoutMs: 10_000, bootTimeoutMs: 5_000 } },
      secrets: noSecrets,
      profile,
      cacheDir,
    });
    const signIn = () => {
      portal.signedIn = true;
      for (const k of Object.keys(signedOutRedirects)) delete driver.redirects[k];
      driver.activePage?.navigate(`${O}/dana/home/index.cgi`);
    };
    const signOut = () => {
      portal.signedIn = false;
      Object.assign(driver.redirects, signedOutRedirects);
    };
    return { adapter: adapter as ShizuokaVpnFilesAdapter, driver, cacheDir, signIn, signOut };
  }

  it('keeps the window open on the sign-in form until the student has signed in', async () => {
    const { adapter, driver, cacheDir, signIn } = setup();
    expect((await adapter.authenticate()).status).toBe('auth_required');
    let settled = false;
    const login = adapter.login().finally(() => {
      settled = true;
    });
    // Signed out, the start page lands on the portal's 404 root: that is NOT a session.
    await new Promise((r) => setTimeout(r, 1_300));
    expect(settled).toBe(false);
    expect(driver.activePage?.url()).toBe(`${O}/dana-na/auth/url_3/welcome.cgi`);
    expect(driver.contexts[0]?.closed).toBe(false);
    signIn(); // the student types the password (and MFA) in the window
    const r = await login;
    expect(r.status).toBe('authenticated');
    expect(driver.launches[0]?.options).toMatchObject({
      headless: false,
      args: ['--restore-last-session'],
    });
    expect(existsSync(join(cacheDir, 'portal-session.json'))).toBe(true);
    // Just verified: no second browser for authenticate().
    expect((await adapter.authenticate()).status).toBe('authenticated');
    expect(driver.launches).toHaveLength(1);
  }, 15_000);

  it('a background sync after the session ended stops with auth_required and forgets it', async () => {
    const { adapter, driver, signIn, signOut } = setup();
    const login = adapter.login();
    await new Promise((r) => setTimeout(r, 50));
    signIn();
    expect((await login).status).toBe('authenticated');
    signOut(); // the portal ended the session (60 min)
    await expect(adapter.sync({ mode: 'incremental' })).rejects.toBeInstanceOf(AuthRequiredError);
    expect(driver.launches.at(-1)?.options.headless).toBe(true);
    const launches = driver.launches.length;
    expect((await adapter.authenticate()).status).toBe('auth_required');
    expect(driver.launches).toHaveLength(launches);
  }, 15_000);
});

describe('the in-memory marker default', () => {
  it('works without a marker store', async () => {
    const adapter = new ShizuokaVpnFilesAdapter({
      ...harness().adapter['options'],
      clock: testClock(),
      login: () => Promise.resolve({ status: 'authenticated' }),
    } as ConstructorParameters<typeof ShizuokaVpnFilesAdapter>[0]);
    expect((await adapter.authenticate()).status).toBe('auth_required');
    await adapter.login();
    expect((await adapter.authenticate()).status).toBe('authenticated');
  });
});
