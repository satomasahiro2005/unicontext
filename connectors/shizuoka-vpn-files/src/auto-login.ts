import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hasVisibleCredentialField, type PageLike } from '@unicontext/adapter-browser';
import type { AuthResult, CredentialSecret } from '@unicontext/connector-sdk';
import { type Clock, type Logger, type SecretStore, secretKey } from '@unicontext/core';
import { probePortalSession } from './client.js';
import type { ShizuokaVpnFilesConfig } from './config.js';
import { type VpnDeployment, signInUrl } from './deployment.js';

/*
 * Automatic sign-in with the user name and password the student chose to save in the OS keychain
 * (decided by the student on 2026-10-06: "store the password securely instead of the session").
 * Only the realm's own sign-in form on the portal host is ever filled. OTP/MFA, CAPTCHA and the
 * "other sessions in progress" Continue button are never touched: those stop with auth_required
 * and say what was seen. A wrong password stops at once (no retry until the student saves the
 * credentials again or signs in by hand), so a changed password can never lock the account.
 * The values never leave this module: not in logs, state files, traces, results or errors.
 */

export const USERNAME_SECRET = 'username';
export const PASSWORD_SECRET = 'password';

export const CREDENTIAL_SECRETS: CredentialSecret[] = [
  { secret: USERNAME_SECRET, label: 'VPN ポータルのユーザー名', echo: true },
  { secret: PASSWORD_SECRET, label: 'VPN ポータルのパスワード', echo: false },
];

/** File name inside the source's cacheDir (timestamps and outcome names only). */
export const AUTO_LOGIN_STATE_FILE = 'auto-login.json';

export type AutoLoginOutcome =
  | { status: 'signed_in' }
  /** The portal took the form back (`p=failed`, or the sign-in form again): stop for good. */
  | { status: 'wrong_credentials'; path: string }
  /** `p=user-lockout` and the like: stop for good. */
  | { status: 'locked'; path: string }
  /** A second factor (token, OTP, secondary password) was asked for: stop for good. */
  | { status: 'mfa'; path: string }
  | { status: 'captcha'; path: string }
  /** Ivanti's "other user sessions in progress" page (btnContinue / FormDataStr). Never pressed. */
  | { status: 'session_in_progress'; path: string }
  /** Not the realm's sign-in form where it was expected: nothing was typed. */
  | { status: 'form_not_found'; path: string }
  /** No answer the connector recognises within the submit timeout. */
  | { status: 'timeout'; path: string }
  | { status: 'error'; message: string };

/** Outcomes after which no further attempt is made until the student acts. */
const HARD_STOP = new Set<AutoLoginOutcome['status']>([
  'wrong_credentials',
  'locked',
  'mfa',
  'captcha',
  'form_not_found',
]);

export interface AutoLoginState {
  lastAttemptAt?: string;
  consecutiveFailures: number;
  lastOutcome?: AutoLoginOutcome['status'];
  /** Path (no query) of the page that decided the last outcome. */
  lastPath?: string;
  /** Set on a hard stop or after too many failures: no attempt until the student acts. */
  stoppedAt?: string;
}

export function emptyAutoLoginState(): AutoLoginState {
  return { consecutiveFailures: 0 };
}

export type GateVerdict = { ok: true } | { ok: false; reason: string };

/** Whether an attempt may start now (pure). */
export function autoLoginGate(
  state: AutoLoginState,
  now: Date,
  cfg: ShizuokaVpnFilesConfig['autoLogin'],
): GateVerdict {
  if (state.stoppedAt)
    return {
      ok: false,
      reason: `自動サインインは止めています（${describeOutcomeJa(state.lastOutcome)}）。パスワードを保存し直すか、手動でサインインしてください / automatic sign-in stopped (${state.lastOutcome ?? 'failures'})`,
    };
  const last = state.lastAttemptAt ? Date.parse(state.lastAttemptAt) : NaN;
  const gapMs = cfg.minIntervalMinutes * 60_000;
  if (!Number.isNaN(last) && now.getTime() - last < gapMs && now.getTime() >= last) {
    const waitMin = Math.ceil((gapMs - (now.getTime() - last)) / 60_000);
    return {
      ok: false,
      reason: `自動サインインは${cfg.minIntervalMinutes}分に1回までです（あと${waitMin}分） / automatic sign-in is limited to once per ${cfg.minIntervalMinutes} min`,
    };
  }
  return { ok: true };
}

/** The state after an attempt (pure). */
export function recordAutoLoginOutcome(
  state: AutoLoginState,
  outcome: AutoLoginOutcome,
  now: Date,
  cfg: ShizuokaVpnFilesConfig['autoLogin'],
): AutoLoginState {
  const at = now.toISOString();
  if (outcome.status === 'signed_in')
    return { lastAttemptAt: at, consecutiveFailures: 0, lastOutcome: 'signed_in' };
  const failures = state.consecutiveFailures + 1;
  const next: AutoLoginState = {
    lastAttemptAt: at,
    consecutiveFailures: failures,
    lastOutcome: outcome.status,
    ...('path' in outcome ? { lastPath: outcome.path } : {}),
  };
  if (HARD_STOP.has(outcome.status) || failures >= cfg.maxConsecutiveFailures) next.stoppedAt = at;
  return next;
}

function describeOutcomeJa(status: AutoLoginOutcome['status'] | undefined): string {
  switch (status) {
    case 'wrong_credentials':
      return 'ユーザー名かパスワードが違うと言われました';
    case 'locked':
      return 'アカウントがロックされていると言われました';
    case 'mfa':
      return '二段階認証（ワンタイムコードなど）を求められました';
    case 'captcha':
      return '画像認証（CAPTCHA）を求められました';
    case 'session_in_progress':
      return '「他のセッションが進行中」の画面が出ました（「続行」は押していません）';
    case 'form_not_found':
      return 'いつものサインイン画面ではありませんでした（何も入力していません）';
    case 'timeout':
      return 'サインイン後にポータルが応答しませんでした';
    case 'error':
      return 'ブラウザでエラーが起きました';
    default:
      return '失敗が続きました';
  }
}

/** One line for the student / the AI (never contains a credential). */
export function describeOutcome(outcome: AutoLoginOutcome): string {
  const where = 'path' in outcome && outcome.path ? ` @ ${outcome.path}` : '';
  return `自動サインインできませんでした: ${describeOutcomeJa(outcome.status)} / automatic sign-in failed: ${outcome.status}${where}`;
}

// ---------------------------------------------------------------------------------------------
// Page classification (no typing here)

const MFA_SELECTORS = [
  'input[name="password#2"]:visible',
  'input[autocomplete="one-time-code"]:visible',
  'input[name="otp"]:visible',
  'input[name="otc"]:visible',
  'input[name="passcode"]:visible',
  'input[name="totpcode"]:visible',
] as const;

/** Ivanti secondary-auth / token forms and generic MFA wording. */
const MFA_HTML =
  /\b(?:frmDefender|frmNextToken|frmTotpToken|frmTotpRegister|frmSecondaryAuth|frmGrid|password#2)\b|one-time (?:code|password)|verification code|ワンタイム|二段階認証|二要素|多要素|認証コード|確認コード/i;
const CAPTCHA_HTML = /captcha|recaptcha|hcaptcha|g-recaptcha|turnstile/i;

async function count(page: PageLike, selector: string): Promise<number> {
  try {
    return await page.locator(selector).count();
  } catch {
    return 0;
  }
}

async function anyVisible(page: PageLike, selectors: readonly string[]): Promise<boolean> {
  for (const s of selectors) if ((await count(page, s)) > 0) return true;
  return false;
}

async function html(page: PageLike): Promise<string> {
  try {
    return await page.content();
  } catch {
    return '';
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

function queryParam(url: string, name: string): string | undefined {
  try {
    return new URL(url).searchParams.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

async function continuePrompt(page: PageLike): Promise<boolean> {
  return (
    (await count(page, 'input[name="btnContinue"]')) > 0 ||
    (await count(page, 'input[name="FormDataStr"]')) > 0
  );
}

/** The realm's own sign-in form on the portal host over HTTPS (the only place anything is typed). */
export function isRealmSignInPage(deployment: VpnDeployment, url: string): boolean {
  try {
    const u = new URL(url);
    const expected = new URL(signInUrl(deployment));
    return (
      u.protocol === 'https:' &&
      u.host === expected.host &&
      u.pathname.toLowerCase() === expected.pathname.toLowerCase()
    );
  } catch {
    return false;
  }
}

/** What a page in the middle of a sign-in asks for, or undefined when it is none of those. */
async function blocker(
  page: PageLike,
): Promise<'session_in_progress' | 'captcha' | 'mfa' | undefined> {
  if (await continuePrompt(page)) return 'session_in_progress';
  const body = await html(page);
  if (CAPTCHA_HTML.test(body)) return 'captcha';
  if ((await anyVisible(page, MFA_SELECTORS)) || MFA_HTML.test(body)) return 'mfa';
  return undefined;
}

export interface SignInOptions {
  clock: Clock;
  submitTimeoutMs: number;
  pollMs?: number;
}

/**
 * Fill the realm sign-in form once and classify the answer. The page must already be on the
 * realm's sign-in URL (`withHeadlessPage` opened it). Nothing is typed unless the page is that
 * form on the portal host over HTTPS with exactly the expected fields and nothing that asks for
 * a second factor, a CAPTCHA or a Continue press.
 */
export async function signInWithPassword(
  page: PageLike,
  deployment: VpnDeployment,
  creds: { username: string; password: string },
  options: SignInOptions,
): Promise<AutoLoginOutcome> {
  const start = page.url();
  // A session that is still alive lands somewhere else: confirm it without typing anything.
  if (!isRealmSignInPage(deployment, start)) {
    if ((await probePortalSession(page, deployment)).live) return { status: 'signed_in' };
    return { status: 'form_not_found', path: pathOf(start) };
  }
  const first = await blocker(page);
  if (first) return { status: first, path: pathOf(start) };
  const user = page.locator('form[name="frmLogin"] input[name="username"]:visible');
  const pass = page.locator('form[name="frmLogin"] input[name="password"]:visible');
  if ((await user.count()) !== 1 || (await pass.count()) !== 1 || !user.fill || !pass.fill)
    return { status: 'form_not_found', path: pathOf(start) };
  const submit = [
    'form[name="frmLogin"] input[name="btnSubmit"]',
    'form[name="frmLogin"] button[type="submit"]',
    'form[name="frmLogin"] input[type="submit"]',
  ];
  let submitSel: string | undefined;
  for (const s of submit)
    if ((await count(page, s)) > 0) {
      submitSel = s;
      break;
    }
  if (!submitSel) return { status: 'form_not_found', path: pathOf(start) };

  await user.first().fill!(creds.username, { timeout: 10_000 });
  await pass.first().fill!(creds.password, { timeout: 10_000 });
  await page.locator(submitSel).first().click({ timeout: 10_000 });

  const deadline = options.clock.now().getTime() + options.submitTimeoutMs;
  const poll = options.pollMs ?? 1000;
  for (;;) {
    const url = page.url();
    const path = pathOf(url);
    const p = queryParam(url, 'p');
    if (p && /lock/i.test(p)) return { status: 'locked', path };
    if (p && /fail/i.test(p)) return { status: 'wrong_credentials', path };
    const b = await blocker(page);
    if (b) return { status: b, path };
    if (await hasVisibleCredentialField(page)) {
      // The sign-in form again after a submit: the portal refused the credentials.
      if (url !== start || p !== undefined) return { status: 'wrong_credentials', path };
    } else if ((await probePortalSession(page, deployment)).live) {
      return { status: 'signed_in' };
    }
    if (options.clock.now().getTime() >= deadline) return { status: 'timeout', path };
    await options.clock.sleep(poll);
  }
}

// ---------------------------------------------------------------------------------------------
// The attempt (keychain → gate → page → state)

export interface AutoLoginDeps {
  sourceId: string;
  secrets: SecretStore;
  config: ShizuokaVpnFilesConfig['autoLogin'];
  deployment: VpnDeployment;
  clock: Clock;
  logger: Logger;
  stateFile: string;
  /** Open a headless page on the sign-in URL and run `fn` (BrowserSession.withHeadlessPage). */
  run: (fn: (page: PageLike) => Promise<AutoLoginOutcome>) => Promise<AutoLoginOutcome>;
}

export interface AutoLogin {
  /** Saved credentials exist and auto sign-in is enabled (no attempt is made). */
  available(): Promise<boolean>;
  /**
   * One rate-limited attempt. `undefined` when there is nothing to try with (no saved
   * credentials, or disabled); otherwise `authenticated` or `auth_required` with the reason.
   */
  attempt(): Promise<AuthResult | undefined>;
  /** Forget the attempt history (credentials saved again, or a manual sign-in worked). */
  reset(): void;
  readState(): AutoLoginState;
}

/** Replace every occurrence of the given values (credentials) in a message. */
export function redact(message: string, values: readonly string[]): string {
  let out = message;
  for (const v of values) if (v && v.length >= 1) out = out.split(v).join('***');
  return out;
}

export function createAutoLogin(deps: AutoLoginDeps): AutoLogin {
  const readState = (): AutoLoginState => {
    try {
      const v = JSON.parse(readFileSync(deps.stateFile, 'utf8')) as Partial<AutoLoginState>;
      return {
        consecutiveFailures: typeof v.consecutiveFailures === 'number' ? v.consecutiveFailures : 0,
        ...(typeof v.lastAttemptAt === 'string' ? { lastAttemptAt: v.lastAttemptAt } : {}),
        ...(typeof v.lastOutcome === 'string' ? { lastOutcome: v.lastOutcome } : {}),
        ...(typeof v.lastPath === 'string' ? { lastPath: v.lastPath } : {}),
        ...(typeof v.stoppedAt === 'string' ? { stoppedAt: v.stoppedAt } : {}),
      };
    } catch {
      return emptyAutoLoginState();
    }
  };
  const writeState = (s: AutoLoginState): void => {
    try {
      mkdirSync(dirname(deps.stateFile), { recursive: true });
      writeFileSync(deps.stateFile, `${JSON.stringify(s)}\n`);
    } catch {
      // best effort: a lost state file only means the interval starts over
    }
  };
  const credentials = async (): Promise<{ username: string; password: string } | undefined> => {
    if (!deps.config.enabled) return undefined;
    try {
      const username = await deps.secrets.get(secretKey(deps.sourceId, USERNAME_SECRET));
      const password = await deps.secrets.get(secretKey(deps.sourceId, PASSWORD_SECRET));
      if (!username || !password) return undefined;
      return { username, password };
    } catch {
      return undefined;
    }
  };
  return {
    readState,
    reset() {
      try {
        rmSync(deps.stateFile, { force: true });
      } catch {
        // best effort
      }
    },
    async available() {
      return (await credentials()) !== undefined;
    },
    async attempt() {
      const creds = await credentials();
      if (!creds) return undefined;
      const now = deps.clock.now();
      const state = readState();
      const gate = autoLoginGate(state, now, deps.config);
      if (!gate.ok) return { status: 'auth_required', message: gate.reason };
      // Counted before the browser opens: a crash in the middle still waits out the interval.
      writeState({ ...state, lastAttemptAt: now.toISOString() });
      let outcome: AutoLoginOutcome;
      try {
        outcome = await deps.run((page) =>
          signInWithPassword(page, deps.deployment, creds, {
            clock: deps.clock,
            submitTimeoutMs: deps.config.submitTimeoutMs,
          }),
        );
      } catch (e) {
        const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        if (/BrowserProfileInUse|profile is in use/i.test(raw)) {
          // Nothing was typed: the attempt does not count.
          writeState(state);
          return {
            status: 'auth_required',
            message: 'SSL-VPN: the browser profile is in use by another UniContext process',
          };
        }
        outcome = {
          status: 'error',
          message: redact(raw, [creds.username, creds.password]).slice(0, 300),
        };
      }
      writeState(recordAutoLoginOutcome(state, outcome, deps.clock.now(), deps.config));
      deps.logger.info('vpn automatic sign-in', {
        sourceId: deps.sourceId,
        outcome: outcome.status,
        ...('path' in outcome ? { path: outcome.path } : {}),
        ...(outcome.status === 'error' ? { error: outcome.message } : {}),
      });
      if (outcome.status === 'signed_in')
        return {
          status: 'authenticated',
          message: 'SSL-VPN portal: signed in automatically with the saved credentials',
        };
      return {
        status: 'auth_required',
        message: redact(describeOutcome(outcome), [creds.username, creds.password]),
      };
    },
  };
}
