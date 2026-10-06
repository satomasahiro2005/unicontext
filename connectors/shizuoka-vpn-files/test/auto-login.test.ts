import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeBrowserDriver, type FakePage, type FakeScreen } from '@unicontext/adapter-browser';
import { instantiateConnector, supportsSavedCredentials } from '@unicontext/connector-sdk';
import type { Clock, Logger, SecretStore, UniversityProfile } from '@unicontext/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  autoLoginGate,
  createShizuokaVpnFilesConnector,
  emptyAutoLoginState,
  isRealmSignInPage,
  recordAutoLoginOutcome,
  redact,
  type SessionCheck,
  ShizuokaVpnFilesAdapter,
  ShizuokaVpnFilesConfigSchema,
} from '../src/index.js';
import { DEPLOYMENT } from './helpers.js';

/*
 * Automatic sign-in with the credentials the student saved (fake Ivanti portal, no network).
 * The values below are test values; the point of several tests is that they never show up
 * anywhere but the form fields.
 */

const O = 'https://vpn.inf.shizuoka.ac.jp';
const WELCOME = `${O}/dana-na/auth/url_3/welcome.cgi`;
const LOGIN_CGI = `${O}/dana-na/auth/url_3/login.cgi`;
const LANDING = '/api/v1/enduser/landing-page';
const USER = 'cs-test-user-7';
const PASS = 'Corr3ct-Horse-Battery!';

const SUBMIT = 'form[name="frmLogin"] input[name="btnSubmit"]';
const FORM_SCREEN: FakeScreen = {
  title: 'Ivanti Connect Secure',
  html: '<form name="frmLogin" action="login.cgi"><input name="username"><input type="password" name="password"><input type="submit" name="btnSubmit"></form>',
  selectors: [
    'form[name="frmLogin"] input[name="username"]:visible',
    'form[name="frmLogin"] input[name="password"]:visible',
    SUBMIT,
    'input[type="password"]:visible',
  ],
};
const JSON_OK: SessionCheck = { live: true, status: 200, ctype: 'application/json', redirected: false, finalPath: LANDING };
const BOUNCED: SessionCheck = { live: false, status: 200, ctype: 'text/html', redirected: true, finalPath: '/dana-na/auth/welcome.cgi' };

class MemoryKeychain implements SecretStore {
  readonly backend = 'fake-keyring';
  readonly map = new Map<string, string>();
  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.map.get(key));
  }
  set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.map.delete(key));
  }
}

/** A clock whose sleep moves time forward (the submit wait is bounded by it). */
function advancingClock(start = '2026-10-06T03:00:00Z'): Clock & { set(d: string | Date): void } {
  let now = new Date(start).getTime();
  return {
    now: () => new Date(now),
    set(d) {
      now = new Date(d).getTime();
    },
    setTimeout: () => ({ id: 0 }) as never,
    clearTimeout: () => undefined,
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

function captureLogger(lines: string[]): Logger {
  const rec =
    (level: string) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      lines.push(`${level} ${msg} ${JSON.stringify(fields ?? {})}`);
    };
  const l: Logger = {
    debug: rec('debug'),
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
    child: () => l,
  };
  return l;
}

type Behaviour = 'ok' | 'wrong' | 'mfa' | 'continue' | 'captcha' | 'stuck';

describe('automatic sign-in with saved credentials (fake portal)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup(opts: { behaviour?: Behaviour; saved?: boolean; config?: Record<string, unknown>; first?: FakeScreen } = {}) {
    const cacheDir = mkdtempSync(join(tmpdir(), 'uc-vpn-auto-'));
    dirs.push(cacheDir);
    const keychain = new MemoryKeychain();
    if (opts.saved !== false) {
      keychain.map.set('shizuoka-vpn-files/username', USER);
      keychain.map.set('shizuoka-vpn-files/password', PASS);
    }
    const state = { signedIn: false, submits: 0, behaviour: opts.behaviour ?? 'ok' };
    const driver = new FakeBrowserDriver({
      screens: {
        [`${O}/`]: { title: 'Ivanti Connect Secure', html: '<h1>404</h1>' },
        [WELCOME]: opts.first ?? FORM_SCREEN,
        [LOGIN_CGI]: { title: 'Ivanti Connect Secure', html: '' },
        [`${O}/dana-na/auth/url_3/mfa.cgi`]: {
          title: 'Ivanti Connect Secure',
          html: '<form name="frmDefender"><input type="password" name="password"></form>',
          selectors: ['input[type="password"]:visible'],
        },
        [`${O}/dana-na/auth/url_3/confirm.cgi`]: {
          title: 'Ivanti Connect Secure',
          html: '<form><input type="submit" name="btnContinue"><input type="hidden" name="FormDataStr"></form>',
          selectors: ['input[name="btnContinue"]', 'input[name="FormDataStr"]'],
        },
        [`${O}/dana-na/auth/url_3/captcha.cgi`]: {
          title: 'Ivanti Connect Secure',
          html: '<div class="g-recaptcha"></div>',
        },
        [`${O}/dana-na/auth/url_3/wait.cgi`]: { title: 'Ivanti Connect Secure', html: '<p>please wait</p>' },
      },
      redirects: {
        [`${O}/dana/home/index.cgi`]: `${O}/dana-na/auth/welcome.cgi`,
        [`${O}/dana-na/auth/welcome.cgi`]: `${O}/`,
      },
      evaluate: (_page: FakePage, expression: string) => {
        const m = /\)\((\{.*\})\)$/s.exec(expression);
        const url = (JSON.parse(m?.[1] ?? '{}') as { url?: string }).url ?? '';
        if (url === LANDING) return state.signedIn ? JSON_OK : BOUNCED;
        return { live: false, status: 404 };
      },
      onClick: (_page, selector) => {
        if (selector !== SUBMIT) return undefined;
        state.submits++;
        const typed = driver.filled.find((f) => f.selector.includes('password'))?.value;
        switch (state.behaviour) {
          case 'ok':
            if (typed !== PASS) return `${WELCOME}?p=failed`;
            state.signedIn = true;
            return LOGIN_CGI;
          case 'wrong':
            return `${WELCOME}?p=failed`;
          case 'mfa':
            return `${O}/dana-na/auth/url_3/mfa.cgi`;
          case 'continue':
            return `${O}/dana-na/auth/url_3/confirm.cgi`;
          case 'captcha':
            return `${O}/dana-na/auth/url_3/captcha.cgi`;
          case 'stuck':
            return `${O}/dana-na/auth/url_3/wait.cgi`;
        }
      },
    });
    const clock = advancingClock();
    const lines: string[] = [];
    const profile = {
      products: { 'shizuoka-vpn-files': { deployment: 'shizuoka' } },
      academicCalendar: { timezone: 'Asia/Tokyo' },
    } as unknown as UniversityProfile;
    const { adapter } = instantiateConnector(createShizuokaVpnFilesConnector({ driver }), {
      sourceId: 'shizuoka-vpn-files',
      config: { browser: { bootTimeoutMs: 5_000 }, autoLogin: { submitTimeoutMs: 5_000 }, ...(opts.config ?? {}) },
      secrets: keychain,
      profile,
      cacheDir,
      clock,
      logger: captureLogger(lines),
    });
    return { adapter: adapter as ShizuokaVpnFilesAdapter, driver, state, clock, lines, cacheDir, keychain };
  }

  /** Every file the connector wrote under its cache dir (not the browser profile). */
  function writtenFiles(cacheDir: string): string {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (n === 'browser-profile') continue;
        if (statSync(p).isDirectory()) walk(p);
        else out.push(readFileSync(p, 'utf8'));
      }
    };
    walk(cacheDir);
    return out.join('\n');
  }

  function expectNoSecrets(text: string): void {
    expect(text).not.toContain(PASS);
    expect(text).not.toContain(USER);
  }

  it('declares the credentials it can store (opt-in) for the CLI', () => {
    const { adapter } = setup();
    expect(supportsSavedCredentials(adapter)).toBe(true);
    expect(adapter.credentialSecrets().map((c) => [c.secret, c.echo])).toEqual([
      ['username', true],
      ['password', false],
    ]);
  });

  it('signs in with the saved credentials when the session is gone, and records the sign-in time', async () => {
    const { adapter, driver, state, lines, cacheDir, clock } = setup();
    const r = await adapter.authenticate();
    expect(r.status).toBe('authenticated');
    expect(state.submits).toBe(1);
    // Typed only into the realm form's two fields, once each.
    expect(driver.filled.map((f) => f.selector)).toEqual([
      'form[name="frmLogin"] input[name="username"]:visible',
      'form[name="frmLogin"] input[name="password"]:visible',
    ]);
    const marker = JSON.parse(readFileSync(join(cacheDir, 'portal-session.json'), 'utf8')) as Record<string, string>;
    expect(marker.signedInAt).toBe(clock.now().toISOString());
    expect(marker.verifiedAt).toBe(marker.signedInAt);
    // Nothing secret anywhere it writes or logs.
    expectNoSecrets(lines.join('\n'));
    expectNoSecrets(writtenFiles(cacheDir));
    expectNoSecrets(JSON.stringify(r));
    expect(lines.some((l) => l.includes('vpn automatic sign-in') && l.includes('signed_in'))).toBe(true);
  });

  it('without saved credentials it never opens a browser (auth_required as before)', async () => {
    const { adapter, driver } = setup({ saved: false });
    const r = await adapter.authenticate();
    expect(r.status).toBe('auth_required');
    expect(driver.launches).toHaveLength(0);
  });

  it('autoLogin.enabled: false turns it off even with saved credentials', async () => {
    const { adapter, driver } = setup({ config: { autoLogin: { enabled: false } } });
    expect((await adapter.authenticate()).status).toBe('auth_required');
    expect(driver.launches).toHaveLength(0);
  });

  it('a wrong password stops at once: no second attempt until the credentials are saved again', async () => {
    const { adapter, state, clock, lines, cacheDir } = setup({ behaviour: 'wrong' });
    const r = await adapter.authenticate();
    expect(r.status).toBe('auth_required');
    expect(r.message).toMatch(/wrong_credentials/);
    expect(state.submits).toBe(1);
    // Hours later: still stopped (a changed password must not lock the account).
    clock.set('2026-10-06T09:00:00Z');
    const again = await adapter.authenticate();
    expect(again.status).toBe('auth_required');
    expect(again.message).toMatch(/止めています|stopped/);
    expect(state.submits).toBe(1);
    // The student saves the password again → one new attempt is allowed.
    adapter.credentialsChanged();
    state.behaviour = 'ok';
    expect((await adapter.authenticate()).status).toBe('authenticated');
    expect(state.submits).toBe(2);
    expectNoSecrets(lines.join('\n') + writtenFiles(cacheDir) + JSON.stringify([r, again]));
  });

  it('an MFA page stops and says so; nothing is typed there', async () => {
    const { adapter, driver, state } = setup({ behaviour: 'mfa' });
    const r = await adapter.authenticate();
    expect(r.status).toBe('auth_required');
    expect(r.message).toMatch(/二段階認証/);
    expect(r.message).toMatch(/mfa @ \/dana-na\/auth\/url_3\/mfa\.cgi/);
    expect(driver.filled).toHaveLength(2); // username + password on the realm form only
    expect(state.submits).toBe(1);
    expect((await adapter.authenticate()).status).toBe('auth_required');
    expect(state.submits).toBe(1); // stopped
  });

  it('an MFA field already on the sign-in page: nothing is typed at all', async () => {
    const { adapter, driver, state } = setup({
      first: { ...FORM_SCREEN, selectors: [...(FORM_SCREEN.selectors ?? []), 'input[name="password#2"]:visible'] },
    });
    const r = await adapter.authenticate();
    expect(r.status).toBe('auth_required');
    expect(r.message).toMatch(/mfa/);
    expect(driver.filled).toHaveLength(0);
    expect(state.submits).toBe(0);
  });

  it('the "other sessions in progress" page is never pressed: soft failure, retried after the interval', async () => {
    const { adapter, driver, state, clock } = setup({ behaviour: 'continue' });
    const r = await adapter.authenticate();
    expect(r.status).toBe('auth_required');
    expect(r.message).toMatch(/続行」は押していません|session_in_progress/);
    expect(driver.clicked.filter((c) => /btnContinue/.test(c))).toHaveLength(0);
    // Rate limit: not again within 10 minutes.
    clock.set(new Date(clock.now().getTime() + 5 * 60_000));
    const soon = await adapter.authenticate();
    expect(soon.message).toMatch(/10分に1回/);
    expect(state.submits).toBe(1);
    // After the interval: one more try.
    clock.set(new Date(clock.now().getTime() + 6 * 60_000));
    await adapter.authenticate();
    expect(state.submits).toBe(2);
  });

  it('stops after maxConsecutiveFailures soft failures in a row', async () => {
    const { adapter, state, clock } = setup({ behaviour: 'stuck', config: { autoLogin: { maxConsecutiveFailures: 2, submitTimeoutMs: 3_000 } } });
    await adapter.authenticate();
    clock.set(new Date(clock.now().getTime() + 11 * 60_000));
    const second = await adapter.authenticate();
    expect(second.message).toMatch(/timeout/);
    clock.set(new Date(clock.now().getTime() + 60 * 60_000));
    const third = await adapter.authenticate();
    expect(third.message).toMatch(/止めています|stopped/);
    expect(state.submits).toBe(2);
  });

  it('a CAPTCHA stops for good', async () => {
    const { adapter, state, clock } = setup({ behaviour: 'captcha' });
    expect((await adapter.authenticate()).message).toMatch(/captcha/i);
    clock.set(new Date(clock.now().getTime() + 3 * 3_600_000));
    expect((await adapter.authenticate()).message).toMatch(/止めています|stopped/);
    expect(state.submits).toBe(1);
  });

  it('a page that is not the realm form gets nothing typed (form_not_found)', async () => {
    const { adapter, driver } = setup({
      first: { title: 'something else', html: '<form><input type="password" name="pw"></form>', selectors: ['input[type="password"]:visible'] },
    });
    const r = await adapter.authenticate();
    expect(r.message).toMatch(/form_not_found/);
    expect(driver.filled).toHaveLength(0);
  });
});

describe('automatic sign-in policy (pure)', () => {
  const cfg = ShizuokaVpnFilesConfigSchema.parse({}).autoLogin;
  const t0 = new Date('2026-10-06T03:00:00Z');
  const at = (min: number): Date => new Date(t0.getTime() + min * 60_000);

  it('one attempt per minIntervalMinutes', () => {
    const s = recordAutoLoginOutcome(emptyAutoLoginState(), { status: 'timeout', path: '/x' }, t0, cfg);
    expect(autoLoginGate(s, at(9), cfg).ok).toBe(false);
    expect(autoLoginGate(s, at(10), cfg).ok).toBe(true);
  });

  it('hard stops: wrong password, lock-out, MFA, CAPTCHA, unknown form', () => {
    for (const status of ['wrong_credentials', 'locked', 'mfa', 'captcha', 'form_not_found'] as const) {
      const s = recordAutoLoginOutcome(emptyAutoLoginState(), { status, path: '/x' }, t0, cfg);
      expect(autoLoginGate(s, at(24 * 60), cfg).ok, status).toBe(false);
    }
  });

  it('success clears the failure count', () => {
    let s = recordAutoLoginOutcome(emptyAutoLoginState(), { status: 'timeout', path: '/x' }, t0, cfg);
    s = recordAutoLoginOutcome(s, { status: 'signed_in' }, at(20), cfg);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.stoppedAt).toBeUndefined();
  });

  it('types only on the realm form over HTTPS on the portal host', () => {
    expect(isRealmSignInPage(DEPLOYMENT, WELCOME)).toBe(true);
    expect(isRealmSignInPage(DEPLOYMENT, `${WELCOME}?p=failed`)).toBe(true);
    expect(isRealmSignInPage(DEPLOYMENT, WELCOME.replace('https:', 'http:'))).toBe(false);
    expect(isRealmSignInPage(DEPLOYMENT, 'https://evil.example/dana-na/auth/url_3/welcome.cgi')).toBe(false);
    expect(isRealmSignInPage(DEPLOYMENT, `${O}/dana-na/auth/url_9/welcome.cgi`)).toBe(false);
  });

  it('redact removes every occurrence of the values', () => {
    expect(redact(`fill("${PASS}") for ${USER}`, [USER, PASS])).toBe('fill("***") for ***');
  });
});
