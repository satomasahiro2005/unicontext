import * as nodeFs from 'node:fs';
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
 * and say what was seen. Once the form has been submitted, anything but a confirmed sign-in stops
 * at once (a wrong password, a lock-out, an answer the connector does not recognise), and a stop
 * whose cause may be the saved password is lifted only by saving the credentials again (a manual
 * sign-in proves the account works, not that the saved password does). So a saved password is
 * submitted at most once after it stopped working. Only failures before anything was submitted
 * (the page did not load) are retried, at most once per interval and a few times in a row. The
 * attempt history lives in a state file; when it cannot be read or written, no attempt is made.
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
  /** The form was submitted and the portal confirmed the new session. */
  | { status: 'signed_in' }
  /**
   * The sign-in URL did not show the form because a session was still alive (nothing typed). Its
   * real sign-in time is unknown, so it opens no new session window.
   */
  | { status: 'already_signed_in' }
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
  /**
   * No answer the connector recognises within the submit timeout (the form was submitted). It may
   * be a wrong-password page the connector does not know: stop for good.
   */
  | { status: 'timeout'; path: string }
  /** The browser failed after the submit button was pressed: the answer is unknown, stop. */
  | { status: 'submit_error'; message: string; path: string }
  /** The browser failed before anything was submitted (retried after the interval). */
  | { status: 'error'; message: string };

/** The only failures that are retried: nothing was submitted. Every other failure stops. */
const SOFT_FAILURE = new Set<AutoLoginOutcome['status']>(['error']);

/**
 * Stops that a manual sign-in does NOT lift: the password was submitted and not shown to work (it
 * may have changed), so only saving the credentials again does.
 */
const PASSWORD_SUSPECT = new Set<AutoLoginOutcome['status']>([
  'wrong_credentials',
  'locked',
  'captcha',
  'timeout',
  'submit_error',
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

/** A stop that only saving the credentials again lifts (see {@link PASSWORD_SUSPECT}). */
export function needsNewCredentials(state: AutoLoginState): boolean {
  return state.stoppedAt !== undefined && PASSWORD_SUSPECT.has(state.lastOutcome ?? 'error');
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
      reason: needsNewCredentials(state)
        ? `自動サインインは止めています（${describeOutcomeJa(state.lastOutcome)}）。保存したパスワードが今も正しいか確かめて、保存し直してください（手動でサインインしても再開しません） / automatic sign-in stopped (${state.lastOutcome ?? 'failures'}); save the credentials again to resume`
        : `自動サインインは止めています（${describeOutcomeJa(state.lastOutcome)}）。パスワードを保存し直すか、手動でサインインしてください / automatic sign-in stopped (${state.lastOutcome ?? 'failures'})`,
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
  // Nothing was typed: the attempt does not count either way.
  if (outcome.status === 'already_signed_in') return { ...state };
  if (outcome.status === 'signed_in')
    return { lastAttemptAt: at, consecutiveFailures: 0, lastOutcome: 'signed_in' };
  const failures = state.consecutiveFailures + 1;
  const next: AutoLoginState = {
    lastAttemptAt: at,
    consecutiveFailures: failures,
    lastOutcome: outcome.status,
    ...('path' in outcome ? { lastPath: outcome.path } : {}),
  };
  if (!SOFT_FAILURE.has(outcome.status) || failures >= cfg.maxConsecutiveFailures)
    next.stoppedAt = at;
  return next;
}

/**
 * The state after the student signed in by hand (pure): a stop whose cause may be the saved
 * password stays; anything else (soft failures, the interval, a stop at an MFA page, the Continue
 * page or an unknown form) is forgotten.
 */
export function afterManualSignIn(state: AutoLoginState): AutoLoginState {
  return needsNewCredentials(state) ? { ...state } : emptyAutoLoginState();
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
      return '送信した後のポータルの返事を確かめられませんでした';
    case 'submit_error':
      return '送信した後にブラウザでエラーが起きました';
    case 'error':
      return 'ブラウザでエラーが起きました（何も送信していません）';
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

function safeUrl(page: PageLike): string {
  try {
    return page.url();
  } catch {
    return '';
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
 * a second factor, a CAPTCHA or a Continue press. Browser errors are returned, never thrown,
 * with only their first line kept and both values scrubbed from it.
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
    if ((await probePortalSession(page, deployment)).live) return { status: 'already_signed_in' };
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

  const secrets = [creds.username, creds.password];
  try {
    await user.first().fill!(creds.username, { timeout: 10_000 });
    await pass.first().fill!(creds.password, { timeout: 10_000 });
  } catch (e) {
    // Nothing was submitted. (Playwright's message carries a call log with `fill("<value>")`.)
    return { status: 'error', message: scrubBrowserError(e, secrets) };
  }
  try {
    await page.locator(submitSel).first().click({ timeout: 10_000 });
    return await awaitAnswer(page, deployment, start, options);
  } catch (e) {
    // The click may well have gone through: the portal's answer is unknown.
    return {
      status: 'submit_error',
      message: scrubBrowserError(e, secrets),
      path: pathOf(safeUrl(page)),
    };
  }
}

/** Classify the portal's answer to the submitted form (nothing is typed here). */
async function awaitAnswer(
  page: PageLike,
  deployment: VpnDeployment,
  start: string,
  options: SignInOptions,
): Promise<AutoLoginOutcome> {
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
      // The sign-in form again after a submit: the portal refused the credentials. (The same URL
      // with no `p=` may still be the page before navigation: it ends as a timeout, also a stop.)
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

/** The file operations the state file needs (tests replace them to make them fail). */
export type AutoLoginFs = Pick<
  typeof nodeFs,
  'readFileSync' | 'writeFileSync' | 'renameSync' | 'rmSync' | 'mkdirSync'
>;

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
  /** Default: node:fs. */
  fs?: AutoLoginFs;
}

/** What an attempt gives the adapter: an AuthResult, plus whether a new session was signed in. */
export type AutoSignInResult = AuthResult & {
  /**
   * `true` only when the form was submitted and the new session confirmed: its sign-in time is
   * now (the session window starts). Absent for a session that was already live (time unknown).
   */
  fresh?: boolean;
};

export interface AutoLogin {
  /** Saved credentials exist and auto sign-in is enabled (no attempt is made). */
  available(): Promise<boolean>;
  /**
   * One rate-limited attempt. `undefined` when there is nothing to try with (no saved
   * credentials, or disabled); otherwise `authenticated` or `auth_required` with the reason.
   */
  attempt(): Promise<AutoSignInResult | undefined>;
  /** The credentials were saved again (or deleted): forget the whole attempt history. */
  reset(): void;
  /** The student signed in by hand: see {@link afterManualSignIn}. */
  resetAfterManualSignIn(): void;
  /** The recorded state, or `undefined` when the file cannot be read or parsed. */
  readState(): AutoLoginState | undefined;
}

/**
 * Replace every occurrence of the given values (credentials) in a message, the longest first, so a
 * password that contains the user name is not left half-replaced.
 */
export function redact(message: string, values: readonly string[]): string {
  const all = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    all.add(v);
    // As a JS/JSON string literal would print it (quotes or backslashes escaped).
    all.add(JSON.stringify(v).slice(1, -1));
  }
  let out = message;
  for (const v of [...all].sort((a, b) => b.length - a.length))
    if (v) out = out.split(v).join('***');
  return out;
}

/**
 * A browser error as one safe line: Playwright appends a "Call log:" that repeats every action
 * with its arguments (`fill("<value>")`), so only the first line is kept, scrubbed of the values.
 */
export function scrubBrowserError(e: unknown, values: readonly string[]): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? '';
  return redact(firstLine, values).slice(0, 300);
}

type StateRead = { ok: true; state: AutoLoginState } | { ok: false; reason: string };

function parseState(text: string): AutoLoginState {
  const v = JSON.parse(text) as unknown;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
  const o = v as Partial<AutoLoginState>;
  if (typeof o.consecutiveFailures !== 'number') throw new Error('no consecutiveFailures');
  return {
    consecutiveFailures: o.consecutiveFailures,
    ...(typeof o.lastAttemptAt === 'string' ? { lastAttemptAt: o.lastAttemptAt } : {}),
    ...(typeof o.lastOutcome === 'string' ? { lastOutcome: o.lastOutcome } : {}),
    ...(typeof o.lastPath === 'string' ? { lastPath: o.lastPath } : {}),
    ...(typeof o.stoppedAt === 'string' ? { stoppedAt: o.stoppedAt } : {}),
  };
}

const STATE_UNREADABLE =
  '自動サインインの記録（auto-login.json）を読めないため、自動サインインはしません。パスワードを保存し直すと記録が作り直されます / automatic sign-in skipped: its state file cannot be read';
const STATE_UNWRITABLE =
  '自動サインインの記録（auto-login.json）を書けないため、自動サインインはしません / automatic sign-in skipped: its state file cannot be written';

export function createAutoLogin(deps: AutoLoginDeps): AutoLogin {
  const fs = deps.fs ?? nodeFs;
  let tmpSeq = 0;
  /**
   * The outcome of an attempt whose state could not be saved, honoured by this process while the
   * file still shows that attempt (`startedAt`); a reset (credentials saved again) removes it.
   */
  let unsaved: { startedAt: string; state: AutoLoginState } | undefined;

  const read = (): StateRead => {
    let text: string;
    try {
      text = fs.readFileSync(deps.stateFile, 'utf8');
    } catch (e) {
      // Only a missing file means "no history". Anything else (EBUSY/EPERM from a scanner or a
      // sync client) could be hiding a stop: refuse.
      if ((e as NodeJS.ErrnoException | undefined)?.code === 'ENOENT')
        return { ok: true, state: emptyAutoLoginState() };
      return { ok: false, reason: (e as NodeJS.ErrnoException | undefined)?.code ?? 'read' };
    }
    try {
      return { ok: true, state: parseState(text) };
    } catch {
      return { ok: false, reason: 'parse' };
    }
  };
  /** Atomic (temp file + rename in the same directory), so a reader never sees half a file. Throws. */
  const writeState = (s: AutoLoginState): void => {
    fs.mkdirSync(dirname(deps.stateFile), { recursive: true });
    const tmp = `${deps.stateFile}.${process.pid}.${++tmpSeq}.tmp`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(s)}\n`);
      fs.renameSync(tmp, deps.stateFile);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // nothing more to do
      }
      throw e;
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
  const refuse = (message: string, fields: Record<string, unknown>): AutoSignInResult => {
    deps.logger.warn('vpn automatic sign-in skipped', { sourceId: deps.sourceId, ...fields });
    return { status: 'auth_required', message };
  };
  return {
    readState() {
      const r = read();
      return r.ok ? r.state : undefined;
    },
    reset() {
      unsaved = undefined;
      try {
        fs.rmSync(deps.stateFile, { force: true });
      } catch {
        // A file that cannot be removed keeps its stop: fail closed.
      }
    },
    resetAfterManualSignIn() {
      if (unsaved) unsaved = { ...unsaved, state: afterManualSignIn(unsaved.state) };
      const r = read();
      // Unreadable: nothing is known, so nothing is lifted.
      if (!r.ok) return;
      const next = afterManualSignIn(r.state);
      try {
        if (next.stoppedAt === undefined && next.lastAttemptAt === undefined)
          fs.rmSync(deps.stateFile, { force: true });
        else writeState(next);
      } catch {
        // The old state stays: fail closed.
      }
    },
    async available() {
      return (await credentials()) !== undefined;
    },
    async attempt() {
      const creds = await credentials();
      if (!creds) return undefined;
      const now = deps.clock.now();
      const r = read();
      if (!r.ok) return refuse(STATE_UNREADABLE, { reason: r.reason });
      let state = r.state;
      if (unsaved) {
        if (state.lastAttemptAt === unsaved.startedAt) {
          // The file still shows the attempt whose outcome was lost: that outcome holds.
          state = unsaved.state;
          try {
            writeState(state);
            unsaved = undefined;
          } catch {
            // still unsaved; the gate below uses it
          }
        } else unsaved = undefined;
      }
      const gate = autoLoginGate(state, now, deps.config);
      if (!gate.ok)
        return {
          status: 'auth_required',
          message: needsNewCredentials(state)
            ? `${gate.reason} (unicontext secrets set ${deps.sourceId} password)`
            : gate.reason,
        };
      // Counted before the browser opens: a crash in the middle still waits out the interval. If
      // even this cannot be recorded, nothing is tried (no interval and no stop could hold).
      const startedAt = now.toISOString();
      try {
        writeState({ ...state, lastAttemptAt: startedAt });
      } catch (e) {
        return refuse(STATE_UNWRITABLE, {
          reason: (e as NodeJS.ErrnoException | undefined)?.code ?? 'write',
        });
      }
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
          try {
            writeState(state);
          } catch {
            // the interval then holds once more: harmless
          }
          return {
            status: 'auth_required',
            message: 'SSL-VPN: the browser profile is in use by another UniContext process',
          };
        }
        // Thrown outside the form (opening the browser, loading the page): nothing was submitted.
        outcome = {
          status: 'error',
          message: scrubBrowserError(e, [creds.username, creds.password]),
        };
      }
      const next = recordAutoLoginOutcome(state, outcome, deps.clock.now(), deps.config);
      try {
        writeState(next);
      } catch (e) {
        unsaved = { startedAt, state: next };
        deps.logger.warn('vpn automatic sign-in state not saved', {
          sourceId: deps.sourceId,
          reason: (e as NodeJS.ErrnoException | undefined)?.code ?? 'write',
        });
      }
      deps.logger.info('vpn automatic sign-in', {
        sourceId: deps.sourceId,
        outcome: outcome.status,
        ...('path' in outcome ? { path: outcome.path } : {}),
        ...('message' in outcome ? { error: outcome.message } : {}),
      });
      if (outcome.status === 'signed_in')
        return {
          status: 'authenticated',
          message: 'SSL-VPN portal: signed in automatically with the saved credentials',
          fresh: true,
        };
      if (outcome.status === 'already_signed_in')
        return { status: 'authenticated', message: 'SSL-VPN portal session is still live' };
      return {
        status: 'auth_required',
        message: redact(describeOutcome(outcome), [creds.username, creds.password]),
      };
    },
  };
}
