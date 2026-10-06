import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FakeBrowserDriver, type FakePage, type FakeScreen } from '@unicontext/adapter-browser';
import { instantiateConnector, supportsSavedCredentials } from '@unicontext/connector-sdk';
import type { Clock, Logger, SecretStore, UniversityProfile } from '@unicontext/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  afterManualSignIn,
  type AutoLoginFs,
  type AutoLoginOutcome,
  autoLoginGate,
  createAutoLogin,
  createShizuokaVpnFilesConnector,
  emptyAutoLoginState,
  isRealmSignInPage,
  recordAutoLoginOutcome,
  redact,
  scrubBrowserError,
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

type Behaviour = 'ok' | 'wrong' | 'mfa' | 'continue' | 'captcha' | 'stuck' | 'same-form' | 'click-error';

/** What Playwright 1.63 puts in a locator.fill timeout: the call log repeats the raw value. */
const fillTimeout = (value: string): Error => {
  const e = new Error(
    `locator.fill: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('form[name="frmLogin"] input[name="password"]:visible')\n  - fill("${value}")\n`,
  );
  e.name = 'TimeoutError';
  return e;
};

describe('automatic sign-in with saved credentials (fake portal)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup(
    opts: {
      behaviour?: Behaviour;
      saved?: boolean;
      config?: Record<string, unknown>;
      first?: FakeScreen;
      creds?: { user: string; pass: string };
    } = {},
  ) {
    const cacheDir = mkdtempSync(join(tmpdir(), 'uc-vpn-auto-'));
    dirs.push(cacheDir);
    const keychain = new MemoryKeychain();
    const creds = opts.creds ?? { user: USER, pass: PASS };
    if (opts.saved !== false) {
      keychain.map.set('shizuoka-vpn-files/username', creds.user);
      keychain.map.set('shizuoka-vpn-files/password', creds.pass);
    }
    const state: {
      signedIn: boolean;
      submits: number;
      behaviour: Behaviour;
      failFill?: (selector: string, value: string) => Error | undefined;
    } = { signedIn: false, submits: 0, behaviour: opts.behaviour ?? 'ok' };
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
      onFill: (_page, selector, value) => state.failFill?.(selector, value),
      onClick: (_page, selector) => {
        if (selector !== SUBMIT) return undefined;
        state.submits++;
        const typed = driver.filled.find((f) => f.selector.includes('password'))?.value;
        switch (state.behaviour) {
          case 'ok':
            if (typed !== creds.pass) return `${WELCOME}?p=failed`;
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
          case 'same-form':
            // A refusal the connector does not recognise: the form again, same URL, no p=.
            return WELCOME;
          case 'click-error':
            throw new Error(`locator.click: Target closed\nCall log:\n  - fill("${creds.pass}")`);
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

  function expectNoSecrets(text: string, values: string[] = [USER, PASS]): void {
    for (const v of values) expect(text).not.toContain(v);
  }

  /** The student signs in in the window (the portal already answers signed in). */
  async function manualLogin(adapter: ShizuokaVpnFilesAdapter, clock: Clock) {
    // The connector re-probes a page at most every 5 s of wall time: follow the fake clock.
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock.now().getTime());
    try {
      return await adapter.login();
    } finally {
      spy.mockRestore();
    }
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

  it('the "other sessions in progress" page is never pressed and stops for good (the form was submitted)', async () => {
    const { adapter, driver, state, clock } = setup({ behaviour: 'continue' });
    const r = await adapter.authenticate();
    expect(r.status).toBe('auth_required');
    expect(r.message).toMatch(/続行」は押していません|session_in_progress/);
    expect(driver.clicked.filter((c) => /btnContinue/.test(c))).toHaveLength(0);
    clock.set(new Date(clock.now().getTime() + 3 * 3_600_000));
    expect((await adapter.authenticate()).message).toMatch(/止めています|stopped/);
    expect(state.submits).toBe(1);
  });

  it('no recognisable answer after submit (an unknown refusal page) stops for good: the password is not sent again', async () => {
    for (const behaviour of ['stuck', 'same-form'] as const) {
      const { adapter, state, clock } = setup({ behaviour, config: { autoLogin: { submitTimeoutMs: 3_000 } } });
      const first = await adapter.authenticate();
      expect(first.message, behaviour).toMatch(/timeout/);
      clock.set(new Date(clock.now().getTime() + 24 * 3_600_000));
      const later = await adapter.authenticate();
      expect(later.message, behaviour).toMatch(/止めています|stopped/);
      expect(later.message, behaviour).toMatch(/secrets set shizuoka-vpn-files password/);
      expect(state.submits, behaviour).toBe(1);
    }
  });

  it('a browser error after the submit button was pressed stops for good, scrubbed', async () => {
    const { adapter, state, clock, lines, cacheDir } = setup({ behaviour: 'click-error' });
    const r = await adapter.authenticate();
    expect(r.message).toMatch(/submit_error/);
    clock.set(new Date(clock.now().getTime() + 24 * 3_600_000));
    expect((await adapter.authenticate()).message).toMatch(/止めています|stopped/);
    expect(state.submits).toBe(1);
    expectNoSecrets(lines.join('\n') + writtenFiles(cacheDir) + JSON.stringify(r));
  });

  it('only failures before anything was submitted are retried, and they stop after maxConsecutiveFailures', async () => {
    const { adapter, driver, state, clock } = setup({ config: { autoLogin: { maxConsecutiveFailures: 2 } } });
    state.failFill = () => new Error('locator.fill: Target page, context or browser has been closed');
    const first = await adapter.authenticate();
    expect(first.message).toMatch(/何も送信していません/);
    // Rate limit: not again within 10 minutes.
    clock.set(new Date(clock.now().getTime() + 5 * 60_000));
    expect((await adapter.authenticate()).message).toMatch(/10分に1回/);
    clock.set(new Date(clock.now().getTime() + 6 * 60_000));
    await adapter.authenticate();
    clock.set(new Date(clock.now().getTime() + 60 * 60_000));
    expect((await adapter.authenticate()).message).toMatch(/止めています|stopped/);
    expect(state.submits).toBe(0);
    expect(driver.launches).toHaveLength(2);
  });

  it('a password that contains the user name never leaks from a Playwright fill error (call log)', async () => {
    const creds = { user: 's1234567', pass: 's1234567Pw!' };
    const { adapter, state, lines, cacheDir, driver } = setup({ creds });
    state.failFill = (selector, value) => (selector.includes('password') ? fillTimeout(value) : undefined);
    const r = await adapter.authenticate();
    expect(r.status).toBe('auth_required');
    expect(state.submits).toBe(0);
    expect(driver.filled.map((f) => f.selector)).toEqual(['form[name="frmLogin"] input[name="username"]:visible']);
    const logged = lines.join('\n');
    expect(logged).toMatch(/TimeoutError: locator\.fill: Timeout 10000ms exceeded\./);
    expect(logged).not.toMatch(/Call log/);
    for (const text of [logged, writtenFiles(cacheDir), JSON.stringify(r)]) {
      expectNoSecrets(text, [creds.user, creds.pass]);
      expect(text).not.toContain('Pw!');
    }
  });

  it('a wrong password is not sent again after a manual sign-in (only saving the credentials again lifts it)', async () => {
    const { adapter, state, clock } = setup({ behaviour: 'wrong' });
    expect((await adapter.authenticate()).message).toMatch(/wrong_credentials/);
    expect(state.submits).toBe(1);
    // The student signs in by hand (their new password, typed in the window).
    state.signedIn = true;
    const manual = await manualLogin(adapter, clock);
    expect(manual.status, manual.message).toBe('authenticated');
    // The portal ends that session an hour later: the saved (old) password is not tried.
    state.signedIn = false;
    clock.set(new Date(clock.now().getTime() + 2 * 3_600_000));
    const after = await adapter.authenticate();
    expect(after.status).toBe('auth_required');
    expect(after.message).toMatch(/止めています|stopped/);
    expect(state.submits).toBe(1);
    // Saving the credentials again lifts it.
    adapter.credentialsChanged();
    state.behaviour = 'ok';
    expect((await adapter.authenticate()).status).toBe('authenticated');
    expect(state.submits).toBe(2);
  });

  it('a manual sign-in lifts a stop the account explains (an MFA page), so automatic sign-in resumes', async () => {
    const { adapter, state, clock } = setup({ behaviour: 'mfa' });
    expect((await adapter.authenticate()).message).toMatch(/mfa/);
    state.signedIn = true;
    const manual = await manualLogin(adapter, clock);
    expect(manual.status, manual.message).toBe('authenticated');
    state.signedIn = false;
    state.behaviour = 'ok';
    clock.set(new Date(clock.now().getTime() + 2 * 3_600_000));
    expect((await adapter.authenticate()).status).toBe('authenticated');
    expect(state.submits).toBe(2);
  });

  it('a session already live at the sign-in URL is confirmed without typing and opens no new session window', async () => {
    const { adapter, driver, state, cacheDir } = setup();
    state.signedIn = true;
    driver.redirects[WELCOME] = `${O}/dana/home/starter.cgi`;
    driver.screens[`${O}/dana/home/starter.cgi`] = { title: 'Home', html: '<p>home</p>' };
    const r = await adapter.authenticate();
    expect(r.status).toBe('authenticated');
    expect(driver.filled).toHaveLength(0);
    expect(state.submits).toBe(0);
    const marker = JSON.parse(readFileSync(join(cacheDir, 'portal-session.json'), 'utf8')) as Record<string, string>;
    expect(marker.verifiedAt).toBeDefined();
    // Its real sign-in time is unknown: no 55-minute walk window is granted.
    expect(marker.signedInAt).toBeUndefined();
    // Nothing was typed, so it does not count as an attempt either.
    const st = JSON.parse(readFileSync(join(cacheDir, 'auto-login.json'), 'utf8')) as Record<string, unknown>;
    expect(st.lastAttemptAt).toBeUndefined();
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
    const s = recordAutoLoginOutcome(emptyAutoLoginState(), { status: 'error', message: 'x' }, t0, cfg);
    expect(autoLoginGate(s, at(9), cfg).ok).toBe(false);
    expect(autoLoginGate(s, at(10), cfg).ok).toBe(true);
  });

  it('hard stops: everything after a submit that is not a sign-in, and an unknown form', () => {
    const outcomes: AutoLoginOutcome[] = [
      ...(['wrong_credentials', 'locked', 'mfa', 'captcha', 'form_not_found', 'session_in_progress', 'timeout'] as const).map(
        (status) => ({ status, path: '/x' }),
      ),
      { status: 'submit_error', message: 'x', path: '/x' },
    ];
    for (const o of outcomes) {
      const s = recordAutoLoginOutcome(emptyAutoLoginState(), o, t0, cfg);
      expect(autoLoginGate(s, at(24 * 60), cfg).ok, o.status).toBe(false);
    }
    // Only a failure before anything was submitted is retried.
    const soft = recordAutoLoginOutcome(emptyAutoLoginState(), { status: 'error', message: 'x' }, t0, cfg);
    expect(autoLoginGate(soft, at(10), cfg).ok).toBe(true);
  });

  it('a manual sign-in keeps the stops the saved password may explain', () => {
    for (const status of ['wrong_credentials', 'locked', 'captcha', 'timeout'] as const) {
      const s = recordAutoLoginOutcome(emptyAutoLoginState(), { status, path: '/x' }, t0, cfg);
      expect(afterManualSignIn(s).stoppedAt, status).toBeDefined();
    }
    for (const status of ['mfa', 'session_in_progress', 'form_not_found'] as const) {
      const s = recordAutoLoginOutcome(emptyAutoLoginState(), { status, path: '/x' }, t0, cfg);
      expect(afterManualSignIn(s), status).toEqual(emptyAutoLoginState());
    }
  });

  it('success clears the failure count', () => {
    let s = recordAutoLoginOutcome(emptyAutoLoginState(), { status: 'error', message: 'x' }, t0, cfg);
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

  it('redact replaces the longest value first (a password that contains the user name)', () => {
    expect(redact('fill("s1234567Pw!") for s1234567', ['s1234567', 's1234567Pw!'])).toBe('fill("***") for ***');
    // As a string literal would print it.
    expect(redact('fill("a\\"b")', ['u', 'a"b'])).toBe('fill("***")');
  });

  it('a browser error keeps only its first line (no Playwright call log)', () => {
    const e = new Error('locator.fill: Timeout 10000ms exceeded.\nCall log:\n  - fill("zzz-secret")');
    expect(scrubBrowserError(e, ['zzz-user', 'zzz-secret'])).toBe('Error: locator.fill: Timeout 10000ms exceeded.');
    // Even when a value is on the first line.
    expect(scrubBrowserError(new Error('bad zzz-secret'), ['zzz-user', 'zzz-secret'])).toBe('Error: bad ***');
  });
});

describe('automatic sign-in state file (fail closed)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function make(opts: { fs?: Partial<AutoLoginFs>; outcome?: AutoLoginOutcome } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'uc-vpn-state-'));
    dirs.push(dir);
    const stateFile = join(dir, 'auto-login.json');
    const keychain = new MemoryKeychain();
    keychain.map.set('shizuoka-vpn-files/username', USER);
    keychain.map.set('shizuoka-vpn-files/password', PASS);
    const clock = advancingClock();
    const runs: { n: number; outcome: AutoLoginOutcome } = {
      n: 0,
      outcome: opts.outcome ?? { status: 'wrong_credentials', path: '/w' },
    };
    const lines: string[] = [];
    const auto = createAutoLogin({
      sourceId: 'shizuoka-vpn-files',
      secrets: keychain,
      config: ShizuokaVpnFilesConfigSchema.parse({}).autoLogin,
      deployment: DEPLOYMENT,
      clock,
      logger: captureLogger(lines),
      stateFile,
      run: () => {
        runs.n++;
        return Promise.resolve(runs.outcome);
      },
      fs: { ...fs, ...(opts.fs ?? {}) } as AutoLoginFs,
    });
    return { auto, stateFile, dir, clock, runs, lines };
  }

  it('a corrupt (half-written) state file: no attempt, auth_required', async () => {
    const { auto, stateFile, runs } = make();
    writeFileSync(stateFile, '{"consecutiveFailures":1,"stoppedAt":"2026-');
    const r = await auto.attempt();
    expect(r?.status).toBe('auth_required');
    expect(r?.message).toMatch(/auto-login\.json/);
    expect(runs.n).toBe(0);
    expect(auto.readState()).toBeUndefined();
  });

  it('a state file that cannot be read (EBUSY from a scanner or sync client): no attempt', async () => {
    const busy = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    const { auto, runs } = make({
      fs: {
        readFileSync: (() => {
          throw busy;
        }) as unknown as AutoLoginFs['readFileSync'],
      },
    });
    expect((await auto.attempt())?.status).toBe('auth_required');
    expect(runs.n).toBe(0);
  });

  it('a state file that cannot be written before the attempt: the browser is never opened', async () => {
    const { auto, runs, stateFile } = make({
      fs: {
        renameSync: () => {
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        },
      },
    });
    const r = await auto.attempt();
    expect(r?.status).toBe('auth_required');
    expect(r?.message).toMatch(/書けない|cannot be written/);
    expect(runs.n).toBe(0);
    // No temp file left behind.
    expect(readdirSync(dirname(stateFile))).toEqual([]);
  });

  it('a stop that could not be saved still holds in this process', async () => {
    let writes = 0;
    const { auto, runs, clock } = make({
      fs: {
        renameSync: ((from: string, to: string) => {
          // The first write (marking the attempt) works, every later one fails.
          if (++writes > 1) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
          fs.renameSync(from, to);
        }) as AutoLoginFs['renameSync'],
      },
    });
    expect((await auto.attempt())?.message).toMatch(/wrong_credentials/);
    clock.set(new Date(clock.now().getTime() + 3 * 3_600_000));
    const again = await auto.attempt();
    expect(again?.status).toBe('auth_required');
    expect(again?.message).toMatch(/止めています|stopped/);
    expect(runs.n).toBe(1);
  });

  it('writes the state atomically (no temp file left, always whole JSON)', async () => {
    const { auto, stateFile } = make();
    await auto.attempt();
    expect(readdirSync(dirname(stateFile))).toEqual(['auto-login.json']);
    expect(auto.readState()?.lastOutcome).toBe('wrong_credentials');
    expect(auto.readState()?.stoppedAt).toBeDefined();
  });

  it('a missing state file is an empty history (the first attempt goes ahead)', async () => {
    const { auto, runs, dir } = make();
    mkdirSync(dir, { recursive: true });
    await auto.attempt();
    expect(runs.n).toBe(1);
  });
});
