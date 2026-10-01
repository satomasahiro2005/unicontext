import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AuthRequiredError,
  type Clock,
  type FetchLike,
  type SecretStore,
  systemClock,
  UniContextError,
} from '@unicontext/core';

/*
 * OAuth 2.0 Authorization Code + PKCE for native apps (RFC 7636, RFC 8252): the system browser
 * opens the authorization URL and the redirect comes back to http://127.0.0.1:<random port>/callback.
 * Used by connectors such as Microsoft 365 (Entra ID, §25).
 */

export class OAuthError extends UniContextError {
  readonly oauthError: string | undefined;
  constructor(message: string, oauthError?: string) {
    super('auth_required', message, oauthError ? { details: { error: oauthError } } : undefined);
    this.oauthError = oauthError;
  }
}

const base64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

export function pkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

/** 32 random bytes → 43-char verifier (RFC 7636 §4.1). */
export function generatePkce(bytes = 32): PkcePair {
  const verifier = base64url(randomBytes(bytes));
  return { verifier, challenge: pkceChallenge(verifier), method: 'S256' };
}

export function generateState(): string {
  return base64url(randomBytes(16));
}

export interface OAuthClientConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scopes: string[];
  /** Extra query params for the authorization request (e.g. prompt, domain_hint). */
  extraAuthParams?: Record<string, string>;
}

export interface TokenSet {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  idToken?: string;
  scope?: string;
  /** ISO instant. */
  expiresAt?: string;
}

export function buildAuthorizationUrl(
  config: OAuthClientConfig,
  params: { redirectUri: string; state: string; codeChallenge: string; loginHint?: string },
): string {
  const url = new URL(config.authorizationEndpoint);
  const q = url.searchParams;
  q.set('response_type', 'code');
  q.set('client_id', config.clientId);
  q.set('redirect_uri', params.redirectUri);
  q.set('scope', config.scopes.join(' '));
  q.set('state', params.state);
  q.set('code_challenge', params.codeChallenge);
  q.set('code_challenge_method', 'S256');
  if (params.loginHint) q.set('login_hint', params.loginHint);
  for (const [k, v] of Object.entries(config.extraAuthParams ?? {})) q.set(k, v);
  return url.toString();
}

export interface LoopbackListener {
  /** http://127.0.0.1:<port><path> — register this pattern as the redirect URI. */
  redirectUri: string;
  /** Resolves with the authorization code once the browser hits the redirect with the right state. */
  waitForCode(expectedState: string): Promise<string>;
  close(): Promise<void>;
}

const DONE_HTML =
  '<!doctype html><meta charset="utf-8"><title>UniContext</title><body style="font-family:sans-serif"><p>ログインが完了しました。このウィンドウを閉じてください。</p><p>Signed in. You can close this window.</p></body>';
const FAIL_HTML =
  '<!doctype html><meta charset="utf-8"><title>UniContext</title><body style="font-family:sans-serif"><p>ログインに失敗しました。/ Sign-in failed.</p></body>';

/** Start a one-shot HTTP listener on 127.0.0.1 with an OS-assigned port (RFC 8252 §7.3). */
export async function startLoopbackListener(
  options: { path?: string; timeoutMs?: number; clock?: Clock } = {},
): Promise<LoopbackListener> {
  const callbackPath = options.path ?? '/callback';
  const clock = options.clock ?? systemClock;
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  let settle:
    { resolve: (code: string) => void; reject: (e: Error) => void; state: string } | undefined;
  const early: { query: URLSearchParams }[] = [];

  const handle = (query: URLSearchParams): boolean => {
    if (!settle) {
      early.push({ query });
      return true;
    }
    if (query.get('state') !== settle.state) {
      settle.reject(new OAuthError('OAuth state mismatch (possible CSRF)'));
      return false;
    }
    const err = query.get('error');
    if (err) {
      settle.reject(
        new OAuthError(`Authorization failed: ${query.get('error_description') ?? err}`, err),
      );
      return false;
    }
    const code = query.get('code');
    if (!code) {
      settle.reject(new OAuthError('Authorization response without code'));
      return false;
    }
    settle.resolve(code);
    return true;
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== callbackPath) {
      res.writeHead(404).end();
      return;
    }
    const ok = handle(url.searchParams);
    res
      .writeHead(ok ? 200 : 400, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      .end(ok ? DONE_HTML : FAIL_HTML);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  let timer: ReturnType<Clock['setTimeout']> | undefined;
  let closed = false;
  const close = (): Promise<void> => {
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
    // A waiter that never got its callback (browser failed to open, caller gave up) is settled
    // here instead of by the timeout later, after the listener is already gone.
    settle?.reject(new OAuthError('Login listener closed'));
    if (closed) return Promise.resolve();
    closed = true;
    return new Promise((resolve) => {
      server.close(() => resolve());
      // Browsers keep the loopback connection alive; do not wait for their keep-alive to expire.
      server.closeIdleConnections();
    });
  };

  return {
    redirectUri: `http://127.0.0.1:${port}${callbackPath}`,
    waitForCode(expectedState: string): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        if (closed) {
          reject(new OAuthError('Login listener closed'));
          return;
        }
        let done = false;
        const t = clock.setTimeout(() => {
          done = true;
          reject(new OAuthError('Timed out waiting for the browser login'));
        }, timeoutMs);
        timer = t;
        settle = {
          state: expectedState,
          resolve: (c) => {
            if (done) return;
            done = true;
            clock.clearTimeout(t);
            resolve(c);
          },
          reject: (e) => {
            if (done) return;
            done = true;
            clock.clearTimeout(t);
            reject(e);
          },
        };
        const first = early.shift();
        if (first) handle(first.query);
      });
    },
    close,
  };
}

function parseTokenResponse(json: unknown, now: Date, previousRefresh?: string): TokenSet {
  const j = (json ?? {}) as Record<string, unknown>;
  if (typeof j.error === 'string')
    throw new OAuthError(
      `Token endpoint error: ${typeof j.error_description === 'string' ? j.error_description : j.error}`,
      j.error,
    );
  if (typeof j.access_token !== 'string')
    throw new OAuthError('Token response without access_token');
  const expiresIn =
    typeof j.expires_in === 'number'
      ? j.expires_in
      : typeof j.expires_in === 'string'
        ? Number(j.expires_in)
        : undefined;
  const refresh = typeof j.refresh_token === 'string' ? j.refresh_token : previousRefresh;
  return {
    accessToken: j.access_token,
    tokenType: typeof j.token_type === 'string' ? j.token_type : 'Bearer',
    ...(refresh ? { refreshToken: refresh } : {}),
    ...(typeof j.id_token === 'string' ? { idToken: j.id_token } : {}),
    ...(typeof j.scope === 'string' ? { scope: j.scope } : {}),
    ...(expiresIn && Number.isFinite(expiresIn)
      ? { expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString() }
      : {}),
  };
}

async function tokenRequest(
  config: OAuthClientConfig,
  body: Record<string, string>,
  fetchFn: FetchLike,
  now: Date,
  previousRefresh?: string,
): Promise<TokenSet> {
  const res = await fetchFn(config.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: config.clientId, ...body }).toString(),
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new OAuthError(`Token endpoint returned HTTP ${res.status} without JSON`);
  }
  if (!res.ok && !(json && typeof json === 'object' && 'error' in json))
    throw new OAuthError(`Token endpoint returned HTTP ${res.status}`);
  return parseTokenResponse(json, now, previousRefresh);
}

export function exchangeCode(
  config: OAuthClientConfig,
  params: { code: string; verifier: string; redirectUri: string; fetch?: FetchLike; now?: Date },
): Promise<TokenSet> {
  return tokenRequest(
    config,
    {
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.verifier,
      scope: config.scopes.join(' '),
    },
    params.fetch ?? ((i, init) => fetch(i, init)),
    params.now ?? new Date(),
  );
}

export function refreshAccessToken(
  config: OAuthClientConfig,
  refreshToken: string,
  options: { fetch?: FetchLike; now?: Date } = {},
): Promise<TokenSet> {
  return tokenRequest(
    config,
    { grant_type: 'refresh_token', refresh_token: refreshToken, scope: config.scopes.join(' ') },
    options.fetch ?? ((i, init) => fetch(i, init)),
    options.now ?? new Date(),
    refreshToken,
  );
}

/** Open a URL in the user's default browser without going through a shell. */
export function openSystemBrowser(url: string): Promise<void> {
  if (!/^https?:\/\//.test(url))
    return Promise.reject(new RangeError('Only http(s) URLs can be opened'));
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export interface AuthorizeOptions {
  /** Defaults to openSystemBrowser. Tests pass a function that follows the redirect itself. */
  openBrowser?: (url: string) => Promise<void>;
  fetch?: FetchLike;
  clock?: Clock;
  timeoutMs?: number;
  loginHint?: string;
  callbackPath?: string;
}

/** Full interactive flow: PKCE + state, loopback listener, browser, code exchange. */
export async function authorizeWithPkce(
  config: OAuthClientConfig,
  options: AuthorizeOptions = {},
): Promise<TokenSet> {
  const clock = options.clock ?? systemClock;
  const pkce = generatePkce();
  const state = generateState();
  const listener = await startLoopbackListener({
    clock,
    ...(options.callbackPath ? { path: options.callbackPath } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  try {
    const url = buildAuthorizationUrl(config, {
      redirectUri: listener.redirectUri,
      state,
      codeChallenge: pkce.challenge,
      ...(options.loginHint ? { loginHint: options.loginHint } : {}),
    });
    const codePromise = listener.waitForCode(state);
    // If opening the browser throws, nobody awaits codePromise; close() rejects it in `finally`,
    // and this keeps that rejection from surfacing as an unhandled rejection (process crash).
    codePromise.catch(() => undefined);
    await (options.openBrowser ?? openSystemBrowser)(url);
    const code = await codePromise;
    return await exchangeCode(config, {
      code,
      verifier: pkce.verifier,
      redirectUri: listener.redirectUri,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      now: clock.now(),
    });
  } finally {
    await listener.close();
  }
}

/** Persists a TokenSet as JSON in the SecretStore (never in the DB) and refreshes when needed. */
export class OAuthTokenStore {
  constructor(
    private readonly secrets: SecretStore,
    /** e.g. secretKey("microsoft365", "oauth") */
    private readonly key: string,
    private readonly clock: Clock = systemClock,
  ) {}

  async load(): Promise<TokenSet | undefined> {
    const raw = await this.secrets.get(this.key);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as TokenSet;
    } catch {
      return undefined;
    }
  }

  save(tokens: TokenSet): Promise<void> {
    return this.secrets.set(this.key, JSON.stringify(tokens));
  }

  clear(): Promise<boolean> {
    return this.secrets.delete(this.key);
  }

  /** Valid access token, refreshing via refresh_token when expired (skew 60 s). Throws AuthRequiredError when login is needed. */
  async getAccessToken(
    config: OAuthClientConfig,
    options: { fetch?: FetchLike; skewMs?: number } = {},
  ): Promise<string> {
    const tokens = await this.load();
    if (!tokens) throw new AuthRequiredError('Not signed in');
    const now = this.clock.now();
    const skew = options.skewMs ?? 60_000;
    if (!tokens.expiresAt || new Date(tokens.expiresAt).getTime() - skew > now.getTime())
      return tokens.accessToken;
    if (!tokens.refreshToken) throw new AuthRequiredError('Access token expired');
    try {
      const fresh = await refreshAccessToken(config, tokens.refreshToken, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        now,
      });
      await this.save(fresh);
      return fresh.accessToken;
    } catch (e) {
      if (e instanceof OAuthError)
        throw new AuthRequiredError('Refresh token rejected; sign in again', { cause: e });
      throw e;
    }
  }
}
