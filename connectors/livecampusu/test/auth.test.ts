import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrowserSession,
  COOKIE_SECRET_NAME,
  FakeBrowserDriver,
  type FakeScreen,
} from '@unicontext/adapter-browser';
import { MemorySecretStore } from '@unicontext/auth';
import { ConfigError, parseProfile, secretKey } from '@unicontext/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BrowserSsoStrategy,
  createAuthStrategy,
  DEPLOYMENTS,
  inMaintenanceWindow,
  isLoggedInPage,
  LcuDeploymentProfileSchema,
  LiveCampusUAdapter,
  LocalAccountStrategy,
  resolveDeployment,
  selectAuthStrategy,
  SHIZUOKA_DEPLOYMENT,
} from '../src/index.js';
import { BASE, FakeLcuServer, newClock, TEST_DEPLOYMENT, testContext } from './helpers.js';

const IDP = 'https://idp.example.ac.jp/idp/profile/SAML2/Redirect/SSO?execution=e1s3';
const HOME = `${BASE}SC_01002B00_00`;
const CONSENT_HTML = `<html><head><title>送信属性の選択</title></head><body><h1>Information Release</h1>
<form method="post" action="/idp/profile/SAML2/Redirect/SSO?execution=e1s3">
<input type="radio" name="_shib_idp_consentOptions" value="_shib_idp_rememberConsent">
<input type="submit" name="_eventId_AttributeReleaseRejected" value="拒否">
<input type="submit" name="_eventId_proceed" value="同意"></form></body></html>`;
const REMEMBER = 'input[name="_shib_idp_consentOptions"][value="_shib_idp_rememberConsent"]';

const deployment = LcuDeploymentProfileSchema.parse({
  ...SHIZUOKA_DEPLOYMENT,
  baseUrl: BASE,
  auth: { ...SHIZUOKA_DEPLOYMENT.auth, idpHosts: ['idp.example.ac.jp'] },
});

function screens(): Record<string, FakeScreen> {
  return {
    [BASE]: {
      title: 'ログイン',
      html: '<form id="SC_01001B00_01_Login_Form"><button id="btnSsoStart">ログイン</button></form>',
      clicks: { '#btnSsoStart': IDP },
    },
    'https://idp.example.ac.jp/idp/profile/SAML2/Redirect/SSO': {
      title: '送信属性の選択',
      html: CONSENT_HTML,
      selectors: [REMEMBER],
      clicks: { '[name="_eventId_proceed"]': HOME },
    },
    [HOME]: { title: 'ホーム', html: '<div>ホーム</div>' },
  };
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function browserStrategy(driver: FakeBrowserDriver) {
  const dir = mkdtempSync(join(tmpdir(), 'uc-lcu-'));
  dirs.push(dir);
  const secrets = new MemorySecretStore();
  const strategy = new BrowserSsoStrategy({
    sourceId: 'livecampusu',
    deployment,
    secrets,
    cacheDir: dir,
    driver,
    createSession: (o) =>
      new BrowserSession({ ...o, pollIntervalMs: 5, timeoutMs: 2000, refreshTimeoutMs: 2000 }),
  });
  return { strategy, secrets, dir };
}

describe('auth strategy selection', () => {
  it('maps profile/config auth values', () => {
    expect(selectAuthStrategy(undefined, { auth: 'entra' })).toBe('browser-sso');
    expect(selectAuthStrategy(undefined, { auth: 'saml' })).toBe('browser-sso');
    expect(selectAuthStrategy('browser-sso', { auth: 'local' })).toBe('browser-sso');
    expect(selectAuthStrategy(undefined, { auth: 'local' })).toBe('local-account');
    expect(selectAuthStrategy(undefined, undefined)).toBe('browser-sso');
  });
});

describe('local-account strategy (stub)', () => {
  it('is disabled unless explicitly allowed, and never implements the hidden password form', async () => {
    const off = createAuthStrategy({
      sourceId: 'x',
      deployment,
      secrets: new MemorySecretStore(),
      productSettings: { auth: 'local' },
    });
    expect(off).toBeInstanceOf(LocalAccountStrategy);
    const r = await off.authenticate();
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/disabled.*bypass the university SSO\/MFA/);
    expect((await off.login()).status).toBe('failed');
    expect(await off.cookies()).toBeUndefined();
    expect(await off.reauthenticate()).toBe(false);

    const on = new LocalAccountStrategy({ sourceId: 'x', allowed: true });
    expect((await on.authenticate()).message).toMatch(/not implemented/);
    await expect(on.login()).rejects.toThrow(/not implemented/);
  });

  it('the adapter wires auth: local + allowLocalAccount from the profile', async () => {
    const clock = newClock();
    const server = new FakeLcuServer({ clock });
    const profile = parseProfile(`
id: other-university
academicCalendar: { timezone: Asia/Tokyo }
products:
  livecampusu: { deployment: shizuoka, auth: local, allowLocalAccount: true }
`);
    const adapter = new LiveCampusUAdapter(testContext(clock, server.fetch, {}, profile));
    expect(adapter.strategyKind).toBe('local-account');
    expect((await adapter.authenticate()).message).toMatch(/not implemented/);
    const plain = new LiveCampusUAdapter(testContext(clock, server.fetch, { auth: 'local' }));
    expect((await plain.authenticate()).message).toMatch(/disabled/);
    expect(server.log).toHaveLength(0);
  });
});

describe('browser-sso strategy (adapter-browser, scripted fake browser)', () => {
  it('logs in through SSO + attribute consent and exports only LCU cookies to the SecretStore', async () => {
    const driver = new FakeBrowserDriver({
      screens: screens(),
      cookies: [
        {
          name: 'JSESSIONID',
          value: 'live-1',
          domain: 'lcu.example.ac.jp',
          path: '/lcu-web',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
        {
          name: 'shib_idp_session',
          value: 'idp',
          domain: 'idp.example.ac.jp',
          path: '/idp',
          expires: -1,
          httpOnly: true,
          secure: true,
        },
      ],
    });
    const { strategy, secrets } = browserStrategy(driver);
    expect((await strategy.authenticate()).status).toBe('auth_required');
    expect(driver.launches).toHaveLength(0); // no profile yet → no browser launched

    const r = await strategy.login();
    expect(r.status).toBe('authenticated');
    expect(driver.launches[0]?.options.headless).toBe(false);
    expect(driver.clicked).toEqual(['#btnSsoStart', '[name="_eventId_proceed"]']);
    expect(driver.checked).toEqual([REMEMBER]);
    const stored = await secrets.get(secretKey('livecampusu', COOKIE_SECRET_NAME));
    expect(stored).toContain('live-1');
    expect(stored).not.toContain('shib_idp_session');

    expect((await strategy.authenticate()).status).toBe('authenticated');
    const jar = await strategy.cookies();
    expect(jar?.header(`${BASE}SC_01002B00_00`)).toBe('JSESSIONID=live-1');
    expect(jar?.header('https://lcu.example.ac.jp/other')).toBe('');
  });

  it('refreshes headlessly through the persistent profile and persists rotated cookies', async () => {
    const driver = new FakeBrowserDriver({
      screens: screens(),
      cookies: [
        {
          name: 'JSESSIONID',
          value: 'live-1',
          domain: 'lcu.example.ac.jp',
          path: '/lcu-web',
          expires: -1,
          httpOnly: true,
          secure: true,
        },
      ],
    });
    const { strategy, secrets } = browserStrategy(driver);
    await strategy.login();
    driver.cookies = [
      {
        name: 'JSESSIONID',
        value: 'live-2',
        domain: 'lcu.example.ac.jp',
        path: '/lcu-web',
        expires: -1,
        httpOnly: true,
        secure: true,
      },
    ];
    expect(await strategy.reauthenticate()).toBe(true);
    expect(driver.launches.at(-1)?.options.headless).toBe(true);
    const jar = await strategy.cookies();
    expect(jar?.get('JSESSIONID')).toBe('live-2');
    jar?.update(`${BASE}SC_01002B00_00`, ['JSESSIONID=live-3; Path=/lcu-web; Secure; HttpOnly']);
    if (jar) await strategy.persist(jar);
    expect(await secrets.get(secretKey('livecampusu', COOKIE_SECRET_NAME))).toContain('live-3');
    await strategy.logout();
    expect(await strategy.cookies()).toBeUndefined();
  });

  it('a headless refresh that reaches a credential page reports failure (never prompts)', async () => {
    const s = screens();
    const msLogin = 'https://login.microsoftonline.com/common/oauth2/authorize';
    s[BASE] = { ...s[BASE], clicks: { '#btnSsoStart': msLogin } } as FakeScreen;
    s[msLogin] = {
      title: 'Sign in',
      html: '<input type="email" name="loginfmt"><input type="password" name="passwd">',
    };
    const driver = new FakeBrowserDriver({ screens: s });
    const { strategy } = browserStrategy(driver);
    expect(await strategy.reauthenticate()).toBe(false);
  });

  it('recognizes logged-in LCU screens only', () => {
    expect(isLoggedInPage(deployment, `${BASE}SC_01002B00_00`)).toBe(true);
    expect(isLoggedInPage(deployment, `${BASE}SC_01002B00_01;jsessionid=X`)).toBe(true);
    expect(isLoggedInPage(deployment, BASE)).toBe(false);
    expect(isLoggedInPage(deployment, `${BASE}SC_17001B00_01`)).toBe(false);
    expect(isLoggedInPage(deployment, 'https://idp.example.ac.jp/lcu-web/SC_01002B00_00')).toBe(
      false,
    );
  });
});

describe('deployment profiles', () => {
  it('ships a valid Shizuoka profile', () => {
    const d = LcuDeploymentProfileSchema.parse(DEPLOYMENTS.shizuoka);
    expect(d.baseUrl).toBe('https://gakujo.shizuoka.ac.jp/lcu-web/');
    expect(d.auth.idpHosts).toEqual(['idp.shizuoka.ac.jp']);
    expect(d.contactTypes.U04?.kind).toBe('roomChange');
  });

  it('selects by `deployment`, then by profile id, and applies per-key overrides', () => {
    const byKey = resolveDeployment(DEPLOYMENTS, { productSettings: { deployment: 'shizuoka' } });
    expect(byKey.id).toBe('shizuoka');
    const byProfile = resolveDeployment(DEPLOYMENTS, {
      profileId: 'shizuoka-university',
      productSettings: { auth: 'entra' },
    });
    expect(byProfile.id).toBe('shizuoka');
    const over = resolveDeployment(DEPLOYMENTS, {
      productSettings: {
        deployment: 'shizuoka',
        screens: { timetable: 'SC_18001B00_99' },
        maintenanceWindow: '02:00-04:00',
      },
      config: { baseUrl: 'https://lcu.test.example/lcu-web', idpHosts: ['idp.test.example'] },
    });
    expect(over.screens.timetable).toBe('SC_18001B00_99');
    expect(over.screens.noticeList).toBe('SC_17001B00_01');
    expect(over.baseUrl).toBe('https://lcu.test.example/lcu-web/');
    expect(over.auth.idpHosts).toEqual(['idp.test.example']);
    expect(over.maintenanceWindow).toBe('02:00-04:00');
  });

  it('rejects unknown deployments and invalid overrides', () => {
    expect(() => resolveDeployment(DEPLOYMENTS, { config: { deployment: 'nope' } })).toThrow(
      ConfigError,
    );
    expect(() => resolveDeployment(DEPLOYMENTS, {})).toThrow(ConfigError);
    expect(() =>
      resolveDeployment(DEPLOYMENTS, { config: { deployment: 'shizuoka', baseUrl: 'ftp://x/' } }),
    ).toThrow(ConfigError);
  });

  it('evaluates maintenance windows (also across midnight)', () => {
    expect(inMaintenanceWindow('01:00-06:00', 3, 0)).toBe(true);
    expect(inMaintenanceWindow('01:00-06:00', 6, 0)).toBe(false);
    expect(inMaintenanceWindow('23:30-05:00', 23, 45)).toBe(true);
    expect(inMaintenanceWindow('23:30-05:00', 12, 0)).toBe(false);
    expect(inMaintenanceWindow(undefined, 3, 0)).toBe(false);
  });

  it('TEST_DEPLOYMENT keeps the Shizuoka screen ids on a fake host', () => {
    expect(TEST_DEPLOYMENT.screens.timetable).toBe('SC_18001B00_13');
    expect(TEST_DEPLOYMENT.baseUrl).toBe(BASE);
  });
});
