import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySecretStore } from '@unicontext/auth';
import { defineMetadata } from '@unicontext/connector-sdk';
import { testConnectorCompliance } from '@unicontext/connector-sdk/testing';
import { AuthRequiredError, secretKey } from '@unicontext/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BrowserSession,
  CookieJar,
  COOKIE_SECRET_NAME,
  createBrowserSourceAdapter,
  defaultProfileDir,
  FakeBrowserDriver,
  hasCredentialField,
  parseSetCookie,
  playwrightDriver,
  runInterstitials,
  shibbolethConsentHandler,
  type BrowserCookie,
  type FakeScreen,
} from '../src/index.js';

const LCU = 'https://gakujo.example.ac.jp/lcu-web/';
const HOME = 'https://gakujo.example.ac.jp/lcu-web/SC_01002B00_00';
const IDP = 'https://idp.example.ac.jp/idp/profile/SAML2/Redirect/SSO?execution=e1s3';
const MS_LOGIN = 'https://login.microsoftonline.com/common/oauth2/authorize';

const CONSENT_HTML = `<html><head><title>送信属性の選択</title></head><body>
<h1>Information Release</h1>
<form method="post" action="/idp/profile/SAML2/Redirect/SSO?execution=e1s3">
<input type="checkbox" name="_shib_idp_consentIds" value="mail" checked>
<input type="radio" name="_shib_idp_consentOptions" value="_shib_idp_doNotRememberConsent">
<input type="radio" name="_shib_idp_consentOptions" value="_shib_idp_rememberConsent" checked>
<input type="radio" name="_shib_idp_consentOptions" value="_shib_idp_globalConsent">
<input type="submit" name="_eventId_AttributeReleaseRejected" value="拒否">
<input type="submit" name="_eventId_proceed" value="同意">
</form></body></html>`;

const REMEMBER = 'input[name="_shib_idp_consentOptions"][value="_shib_idp_rememberConsent"]';

const sessionCookie: BrowserCookie = {
  name: 'JSESSIONID',
  value: 'abc123',
  domain: 'gakujo.example.ac.jp',
  path: '/lcu-web',
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
};

function screens(consent: Partial<FakeScreen> = {}): Record<string, FakeScreen> {
  return {
    [LCU]: {
      title: 'ログイン',
      html: '<button id="btnSsoStart">ログイン</button>',
      clicks: { '#btnSsoStart': IDP },
    },
    'https://idp.example.ac.jp/idp/profile/SAML2/Redirect/SSO': {
      title: '送信属性の選択',
      html: CONSENT_HTML,
      selectors: [REMEMBER],
      clicks: { '[name="_eventId_proceed"]': HOME },
      ...consent,
    },
    [HOME]: { title: 'ホーム', html: '<div>ホーム</div>' },
    'https://login.microsoftonline.com/common/oauth2/authorize': {
      title: 'Sign in',
      html: '<input type="email" name="loginfmt"><input type="password" name="passwd">',
      selectors: ['input[type="password"]:visible'],
    },
  };
}

let dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'uc-browser-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function makeSession(driver: FakeBrowserDriver, secrets = new MemorySecretStore()) {
  return {
    secrets,
    session: new BrowserSession({
      sourceId: 'livecampusu',
      profileDir: join(tempDir(), 'profile'),
      secrets,
      driver,
      startUrl: LCU,
      begin: async (page) => {
        await page.locator('#btnSsoStart').click();
      },
      isAuthenticated: (page) => page.url().startsWith(HOME),
      handlers: [shibbolethConsentHandler({ hosts: ['idp.example.ac.jp'] })],
      cookieUrls: [LCU],
      pollIntervalMs: 2,
      refreshTimeoutMs: 200,
      timeoutMs: 500,
    }),
  };
}

describe('shibboleth consent handler', () => {
  it('selects remember-consent and presses 同意 (never 拒否)', async () => {
    const driver = new FakeBrowserDriver({ screens: screens(), cookies: [sessionCookie] });
    const { session, secrets } = makeSession(driver);
    const res = await session.refresh();
    expect(res.status).toBe('authenticated');
    expect(driver.checked).toEqual([REMEMBER]);
    expect(driver.clicked).toContain('[name="_eventId_proceed"]');
    expect(driver.clicked).not.toContain('[name="_eventId_AttributeReleaseRejected"]');
    const stored = await secrets.get(secretKey('livecampusu', COOKIE_SECRET_NAME));
    expect(stored).toContain('JSESSIONID');
    expect(await session.cookieHeader(`${LCU}SC_01002B00_01`)).toBe('JSESSIONID=abc123');
    expect(driver.launches[0]?.options.headless).toBe(true);
  });

  it('does not act on other hosts, paths or pages without _eventId_proceed', () => {
    const handler = shibbolethConsentHandler({ hosts: ['idp.example.ac.jp'] });
    const base = {
      page: undefined as never,
      title: '送信属性の選択',
      html: CONSENT_HTML,
      logger: undefined as never,
    };
    expect(handler.matches({ ...base, url: new URL(IDP) })).toBe(true);
    expect(
      handler.matches({
        ...base,
        url: new URL('https://evil.example.com/idp/profile/SAML2/Redirect/SSO'),
      }),
    ).toBe(false);
    expect(
      handler.matches({ ...base, url: new URL('https://idp.example.ac.jp/idp/profile/admin') }),
    ).toBe(false);
    expect(
      handler.matches({
        ...base,
        url: new URL(IDP),
        html: '<form><input name="other"></form>',
        title: 'x',
      }),
    ).toBe(false);
    expect(
      shibbolethConsentHandler().matches({
        ...base,
        url: new URL('https://idp.shizuoka.ac.jp/idp/profile/SAML2/Redirect/SSO?execution=e1s2'),
      }),
    ).toBe(true);
  });

  it('never runs on a page with a credential field', async () => {
    const driver = new FakeBrowserDriver({
      screens: screens({ html: `${CONSENT_HTML}<input type="password" name="j_password">` }),
    });
    const ctx = await driver.launchPersistentContext('x', { headless: true });
    const page = ctx.pages()[0]!;
    await page.goto(IDP);
    const run = await runInterstitials(page, [
      shibbolethConsentHandler({ hosts: ['idp.example.ac.jp'] }),
    ]);
    expect(run.handled).toEqual([]);
    expect(run.needsHuman).toMatch(/credentials/);
    expect(driver.clicked).toEqual([]);
  });

  it('detects credential and OTP fields', () => {
    expect(hasCredentialField('<input type="password">')).toBe(true);
    expect(hasCredentialField('<input autocomplete="one-time-code" name="x">')).toBe(true);
    expect(hasCredentialField('<input name="otc" type="tel">')).toBe(true);
    expect(hasCredentialField(CONSENT_HTML)).toBe(false);
  });
});

describe('BrowserSession', () => {
  it('refresh returns auth_required when the IdP asks for a password (never fills it)', async () => {
    const s = screens();
    s[LCU] = { ...s[LCU]!, clicks: { '#btnSsoStart': MS_LOGIN } };
    const driver = new FakeBrowserDriver({ screens: s });
    const { session } = makeSession(driver);
    const res = await session.refresh();
    expect(res.status).toBe('auth_required');
    expect(res.message).toMatch(/unicontext login livecampusu/);
    expect(await session.hasStoredSession()).toBe(false);
  });

  it('ignores a hidden password field on the service start page', async () => {
    const s = screens();
    s[LCU] = {
      ...s[LCU]!,
      html: '<div style="display:none"><input type="password" name="password"></div><button id="btnSsoStart">',
    };
    const driver = new FakeBrowserDriver({ screens: s, cookies: [sessionCookie] });
    const { session } = makeSession(driver);
    expect((await session.refresh()).status).toBe('authenticated');
  });

  it('refresh times out to auth_required on an unknown screen', async () => {
    const s = screens();
    s[LCU] = { ...s[LCU]!, clicks: { '#btnSsoStart': 'https://idp.example.ac.jp/unknown' } };
    const driver = new FakeBrowserDriver({ screens: s });
    const { session } = makeSession(driver);
    expect((await session.refresh()).status).toBe('auth_required');
  });

  it('interactive login waits for the human, then exports cookies', async () => {
    const s = screens();
    s[LCU] = { ...s[LCU]!, clicks: { '#btnSsoStart': MS_LOGIN } };
    const driver = new FakeBrowserDriver({ screens: s, cookies: [sessionCookie] });
    const { session } = makeSession(driver);
    const p = session.login();
    // The human types the password + MFA code; the IdP then redirects to the consent page.
    setTimeout(() => driver.activePage?.navigate(IDP), 20);
    const res = await p;
    expect(res.status).toBe('authenticated');
    expect(driver.launches[0]?.options.headless).toBe(false);
    expect(driver.checked).toEqual([REMEMBER]);
    expect(await session.hasStoredSession()).toBe(true);
  });

  it('interactive login fails when the window is closed', async () => {
    const s = screens();
    s[LCU] = { ...s[LCU]!, clicks: { '#btnSsoStart': MS_LOGIN } };
    const driver = new FakeBrowserDriver({ screens: s });
    const { session } = makeSession(driver);
    const p = session.login();
    setTimeout(() => void driver.contexts[0]?.close(), 10);
    expect((await p).status).toBe('failed');
  });

  it('concurrent refresh calls share one browser run', async () => {
    const driver = new FakeBrowserDriver({ screens: screens(), cookies: [sessionCookie] });
    const { session } = makeSession(driver);
    const [a, b] = await Promise.all([session.refresh(), session.refresh()]);
    expect(a).toBe(b);
    expect(driver.launches).toHaveLength(1);
  });

  it('clear() forgets exported cookies', async () => {
    const driver = new FakeBrowserDriver({ screens: screens(), cookies: [sessionCookie] });
    const { session } = makeSession(driver);
    await session.refresh();
    await session.clear({ profile: true });
    expect(await session.storedCookies()).toBeUndefined();
  });

  it('default profile dir is per source', () => {
    expect(defaultProfileDir('lcu', join('x', 'cache'))).toBe(
      join('x', 'cache', 'browser-profile'),
    );
    expect(defaultProfileDir('lcu')).toMatch(/lcu[\\/]browser-profile$/);
  });

  it('playwrightDriver tries installed channels and reports a helpful error', async () => {
    const tried: string[] = [];
    const driver = playwrightDriver(() =>
      Promise.resolve({
        chromium: {
          launchPersistentContext: (_dir: string, opts: Record<string, unknown>) => {
            tried.push(String(opts.channel));
            return Promise.reject(new Error('not installed'));
          },
        },
      }),
    );
    await expect(driver.launchPersistentContext('d', { headless: true })).rejects.toThrow(
      /Chrome or Microsoft Edge/,
    );
    expect(tried).toEqual(['chrome', 'msedge']);
  });
});

describe('CookieJar', () => {
  it('parses Set-Cookie and matches path/domain/secure', () => {
    const now = Date.parse('2026-10-01T00:00:00Z');
    const jar = new CookieJar(() => now);
    jar.update('https://gakujo.example.ac.jp/lcu-web/SC_01002B00_00', [
      'JSESSIONID=new; Path=/lcu-web; HttpOnly; Secure; SameSite=Lax',
      'other=1; Max-Age=0',
      'wide=2; Domain=example.ac.jp; Path=/',
    ]);
    expect(jar.header('https://gakujo.example.ac.jp/lcu-web/x')).toBe('JSESSIONID=new; wide=2');
    expect(jar.header('https://gakujo.example.ac.jp/other')).toBe('wide=2');
    expect(jar.header('http://gakujo.example.ac.jp/lcu-web/x')).toBe('wide=2');
    expect(jar.get('other')).toBeUndefined();
    const c = parseSetCookie('a=b; Expires=Wed, 01 Oct 2026 01:00:00 GMT', 'https://x.jp/a/b', now);
    expect(c.expires).toBe(Date.parse('2026-10-01T01:00:00Z') / 1000);
    expect(c.path).toBe('/a');
    const round = CookieJar.fromBrowserCookies(jar.toBrowserCookies(), () => now);
    expect(round.size).toBe(2);
  });
});

const metadata = defineMetadata({
  name: '@unicontext/adapter-browser',
  product: 'browser-example',
  version: '1.0.0',
  license: 'MIT',
  capabilities: ['announcements'],
  adapter: 'browser',
  apiStability: 'experimental',
  risk: 'experimental',
  defaultAuthority: 'collaboration',
  defaultSchedule: 'manual',
  rawTypes: ['browser.page'],
});

describe('BrowserSourceAdapter', () => {
  it('throws AuthRequiredError when no session can be established', async () => {
    const s = screens();
    s[LCU] = { ...s[LCU]!, clicks: { '#btnSsoStart': MS_LOGIN } };
    const { session } = makeSession(new FakeBrowserDriver({ screens: s }));
    const adapter = createBrowserSourceAdapter({
      id: 'x',
      capabilities: ['announcements'],
      session,
      scrape: () => Promise.resolve({ items: [] }),
    });
    expect((await adapter.authenticate()).status).toBe('auth_required');
    await expect(adapter.sync({ mode: 'initial' })).rejects.toBeInstanceOf(AuthRequiredError);
    expect((await adapter.health()).state).toBe('auth_required');
  });
});

testConnectorCompliance('adapter-browser (scripted)', {
  metadata,
  createAdapter: async () => {
    const secrets = new MemorySecretStore();
    const { session } = makeSession(
      new FakeBrowserDriver({ screens: screens(), cookies: [sessionCookie] }),
      secrets,
    );
    await session.refresh();
    return createBrowserSourceAdapter({
      id: 'browser-example',
      capabilities: ['announcements'],
      session,
      url: HOME,
      scrape: async ({ page }) => ({
        items: [
          {
            sourceType: 'browser.page',
            externalId: page.url(),
            payload: { title: await page.title() },
          },
        ],
      }),
    });
  },
});

describe('browser page-snapshot connector', () => {
  it('captures configured pages as documents after the consent step', async () => {
    const { instantiateConnector } = await import('@unicontext/connector-sdk');
    const { createBrowserConnector, htmlToText } = await import('../src/index.js');
    const s = screens();
    s[`${HOME}#notices`] = {
      title: 'お知らせ',
      html: '<html><script>x()</script><h1>お知らせ</h1><p>休講&amp;補講</p></html>',
    };
    const driver = new FakeBrowserDriver({ screens: s, cookies: [sessionCookie] });
    const inst = instantiateConnector(createBrowserConnector({ driver, pollIntervalMs: 2 }), {
      sourceId: 'outlook-web',
      config: {
        startUrl: LCU,
        loginButton: '#btnSsoStart',
        authenticatedUrlPattern: '/SC_01002B00_00',
        pages: [{ url: `${HOME}#notices` }],
        consent: { shibboleth: { hosts: ['idp.example.ac.jp'] } },
        profileDir: join(tempDir(), 'p'),
      },
      secrets: new MemorySecretStore(),
    });
    const res = await inst.adapter.sync({ mode: 'initial' });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.payload).toMatchObject({ title: 'お知らせ', text: 'お知らせ\n休講&補講' });
    expect(driver.checked).toEqual([REMEMBER]);
    expect(htmlToText('<p>a&#x41;&#66;</p>')).toBe('aAB');
  });
});
