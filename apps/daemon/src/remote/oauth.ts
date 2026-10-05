import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { verifyPassphrase } from './passphrase.js';
import { decodeJwt, SUPPORTED_JWS_ALGS, verifyJwtSignature, type Jwk } from './jwt.js';
import {
  randomToken,
  sha256Hex,
  type RemoteStateStore,
  type StoredClient,
  type StoredGrant,
  type TokenEndpointAuthMethod,
} from './state.js';

/**
 * OAuth 2.1 authorization server for the remote MCP endpoint (docs/remote.md,
 * docs/research/chatgpt-connector.md §3). Single owner: an authorization is approved by unlocking
 * with the owner's passphrase. Framework-free so it can be tested without HTTP.
 *
 *  - RFC 9728 protected resource metadata, RFC 8414 AS metadata, RFC 9207 `iss` in the response
 *  - PKCE S256 only (plain is refused), RFC 8707 `resource` bound into every token
 *  - Dynamic Client Registration (RFC 7591) and Client ID Metadata Documents (https client_id)
 *  - redirect URIs: ChatGPT's and claude.ai's callbacks only (plus `remote.extraRedirectUris`)
 *  - opaque access tokens (short-lived) + rotating refresh tokens, hashed at rest, revocable
 */

export const READ_SCOPE = 'unicontext.read';
/**
 * Adds the record tools (ingest_lecture, record_lecture, add_deadline, add_note, add_task …): writes into
 * UniContext's own database only. Granted only when the owner ticks it on the consent page.
 */
export const WRITE_SCOPE = 'unicontext.write';
export const OFFLINE_SCOPE = 'offline_access';
export const SUPPORTED_SCOPES = [READ_SCOPE, WRITE_SCOPE, OFFLINE_SCOPE];

export function hasScope(scope: string, wanted: string): boolean {
  return scope.split(/\s+/).includes(wanted);
}

const CHATGPT_STABLE_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CHATGPT_CALLBACK_REDIRECT =
  /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9._~-]{1,200}$/;
/** claude.ai's documented callback (and the claude.com host it is moving to). */
const CLAUDE_REDIRECTS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

export const AUTH_CODE_TTL_MS = 60_000;
export const AUTHORIZE_FORM_TTL_MS = 10 * 60_000;
export const MAX_CLIENTS = 100;
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_BASE_MS = 15 * 60_000;
export const LOCKOUT_MAX_MS = 24 * 3600_000;
const CIMD_CACHE_MS = 3600_000;
const CIMD_MAX_BYTES = 64 * 1024;
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

export type AuditEvent = { event: string; clientId?: string; ip?: string } & Record<
  string,
  string | number | boolean | undefined
>;

export interface OAuthServerOptions {
  /** Public https origin, e.g. https://uc.example.ac.jp. Issuer = this; resource = this + /mcp. */
  publicUrl: string;
  store: RemoteStateStore;
  accessTokenTtlMs: number;
  refreshTokenTtlMs: number;
  extraRedirectUris?: readonly string[];
  /** Hosts (and subdomains) whose Client ID Metadata Documents may be fetched. */
  clientMetadataHosts?: readonly string[];
  fetch?: typeof fetch;
  now?: () => Date;
  audit?: (event: AuditEvent) => void;
}

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(`${error}: ${description}`);
  }
}

export interface ResolvedClient {
  clientId: string;
  type: 'dcr' | 'cimd';
  name: string | undefined;
  redirectUris: string[];
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  secretHash?: string | undefined;
  jwks?: Jwk[] | undefined;
  jwksUri?: string | undefined;
}

/** A validated authorization request (GET /authorize), carried through the consent form. */
export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  state: string | undefined;
  codeChallenge: string;
  scope: string;
  resource: string;
}

export type AuthorizeValidation =
  | { ok: true; request: AuthorizeRequest; client: ResolvedClient }
  /** The redirect URI could not be trusted: show the error, never redirect. */
  | { ok: false; error: string; description: string; redirect?: undefined }
  /** The redirect URI is trusted: send the error back to the client. */
  | { ok: false; error: string; description: string; redirect: string };

export type UnlockResult =
  | { ok: true }
  | { ok: false; reason: 'no_passphrase' }
  | { ok: false; reason: 'locked'; until: string }
  | { ok: false; reason: 'wrong'; remaining: number; lockedUntil?: string };

export interface TokenResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export type AccessCheck =
  | { ok: true; clientId: string; clientName: string | undefined; grantId: string; scope: string }
  | { ok: false; error: 'invalid_token' | 'insufficient_scope'; description: string };

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  expiresAt: number;
  used: boolean;
  grantId?: string;
}

const DcrRequestSchema = z.looseObject({
  redirect_uris: z.array(z.string()).min(1).max(10),
  client_name: z.string().max(200).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().optional(),
});

const CimdSchema = z.looseObject({
  client_id: z.string(),
  client_name: z.string().max(200).optional(),
  redirect_uris: z.array(z.string()).min(1),
  token_endpoint_auth_method: z.string().optional(),
  jwks_uri: z.string().optional(),
  jwks: z.object({ keys: z.array(z.looseObject({ kty: z.string() })) }).optional(),
});

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => {
    const d = a.toLowerCase().replace(/^\.+/, '');
    return h === d || h.endsWith(`.${d}`);
  });
}

function str(v: unknown): string | undefined {
  if (Array.isArray(v)) return str(v[0]);
  return typeof v === 'string' ? v : undefined;
}

/** Strip characters that would break out of a log line or HTML attribute. */
export function displayName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const clean = [...name]
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c >= 0x20 && c !== 0x7f && !'<>"\'`'.includes(ch);
    })
    .join('')
    .trim();
  return clean ? clean.slice(0, 80) : undefined;
}

export class OAuthServer {
  readonly issuer: string;
  readonly resource: string;
  private readonly codes = new Map<string, CodeRecord>();
  private readonly cimdCache = new Map<string, { client: ResolvedClient; until: number }>();
  private readonly jtis = new Map<string, number>();
  private readonly formKey = randomBytes(32);
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;
  /** Unlock attempts run one at a time, so parallel guesses cannot all slip past the lockout. */
  private unlockQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: OAuthServerOptions) {
    const u = new URL(options.publicUrl);
    if (u.pathname !== '/' || u.search || u.hash)
      throw new Error(
        'remote.publicUrl must be an origin without path, e.g. https://uc.example.ac.jp',
      );
    this.issuer = trimSlash(u.origin);
    this.resource = `${this.issuer}/mcp`;
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetch ?? fetch;
  }

  get store(): RemoteStateStore {
    return this.options.store;
  }

  private audit(event: AuditEvent): void {
    try {
      this.options.audit?.(event);
    } catch {
      // auditing must never break the flow
    }
  }

  // ---- metadata -------------------------------------------------------------------------

  get resourceMetadataUrl(): string {
    return `${this.issuer}/.well-known/oauth-protected-resource/mcp`;
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: SUPPORTED_SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: 'UniContext',
    };
  }

  authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      registration_endpoint: `${this.issuer}/register`,
      revocation_endpoint: `${this.issuer}/revoke`,
      scopes_supported: SUPPORTED_SCOPES,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: [
        'none',
        'client_secret_post',
        'client_secret_basic',
        'private_key_jwt',
      ],
      token_endpoint_auth_signing_alg_values_supported: SUPPORTED_JWS_ALGS,
      revocation_endpoint_auth_methods_supported: [
        'none',
        'client_secret_post',
        'client_secret_basic',
        'private_key_jwt',
      ],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    };
  }

  /** `WWW-Authenticate` value for a 401/403 from the MCP endpoint (RFC 6750 + RFC 9728). */
  wwwAuthenticate(error?: { error: string; description: string }): string {
    // Clients ask for what this lists; the owner still decides on the consent page whether the
    // write scope is granted (unticking it gives a read-only connection).
    const parts = [
      `resource_metadata="${this.resourceMetadataUrl}"`,
      `scope="${READ_SCOPE} ${WRITE_SCOPE}"`,
    ];
    if (error)
      parts.push(
        `error="${error.error}"`,
        `error_description="${error.description.replace(/["\\]/g, '')}"`,
      );
    return `Bearer ${parts.join(', ')}`;
  }

  // ---- redirect URIs --------------------------------------------------------------------

  isAllowedRedirect(uri: string): boolean {
    if (uri === CHATGPT_STABLE_REDIRECT || CHATGPT_CALLBACK_REDIRECT.test(uri)) return true;
    if (CLAUDE_REDIRECTS.includes(uri)) return true;
    return (this.options.extraRedirectUris ?? []).includes(uri);
  }

  // ---- clients --------------------------------------------------------------------------

  /** RFC 7591 dynamic client registration. */
  register(body: unknown, ip: string | undefined): TokenResponse {
    const parsed = DcrRequestSchema.safeParse(body);
    if (!parsed.success)
      return this.regError('invalid_client_metadata', 'redirect_uris (array) is required');
    const req = parsed.data;
    for (const uri of req.redirect_uris)
      if (!this.isAllowedRedirect(uri))
        return this.regError(
          'invalid_redirect_uri',
          `redirect URI is not allowed by this server: ${uri.slice(0, 200)}`,
        );
    const method = (req.token_endpoint_auth_method ??
      'client_secret_basic') as TokenEndpointAuthMethod;
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method))
      return this.regError(
        'invalid_client_metadata',
        'token_endpoint_auth_method must be none, client_secret_post or client_secret_basic',
      );
    const grantTypes = req.grant_types ?? ['authorization_code', 'refresh_token'];
    if (grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token'))
      return this.regError(
        'invalid_client_metadata',
        'only authorization_code and refresh_token are supported',
      );
    const responseTypes = req.response_types ?? ['code'];
    if (responseTypes.some((r) => r !== 'code'))
      return this.regError('invalid_client_metadata', 'only response_type code is supported');

    const clientId = randomToken('ucc_', 16);
    const secret = method === 'none' ? undefined : randomToken('ucs_');
    const at = this.now();
    const name = displayName(req.client_name);
    const ok = this.store.update((state) => {
      // Forget registrations that never completed an authorization within a day.
      const used = new Set(Object.values(state.grants).map((g) => g.clientId));
      for (const c of Object.values(state.clients))
        if (
          !used.has(c.clientId) &&
          !c.lastUsedAt &&
          Date.parse(c.createdAt) + 24 * 3600_000 < at.getTime()
        )
          delete state.clients[c.clientId];
      if (Object.keys(state.clients).length >= MAX_CLIENTS) return false;
      state.clients[clientId] = {
        clientId,
        type: 'dcr',
        name,
        redirectUris: [...req.redirect_uris],
        tokenEndpointAuthMethod: method,
        ...(secret ? { secretHash: sha256Hex(secret) } : {}),
        createdAt: at.toISOString(),
      };
      return true;
    });
    if (!ok)
      return this.regError(
        'invalid_client_metadata',
        'too many registered clients; revoke unused ones with `unicontext remote revoke`',
      );
    this.audit({ event: 'register', clientId, clientName: name, ip });
    return {
      status: 201,
      body: {
        client_id: clientId,
        client_id_issued_at: Math.floor(at.getTime() / 1000),
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        client_name: name,
        redirect_uris: req.redirect_uris,
        token_endpoint_auth_method: method,
        grant_types: grantTypes,
        response_types: responseTypes,
        scope: READ_SCOPE,
      },
    };
  }

  private regError(error: string, description: string): TokenResponse {
    return { status: 400, body: { error, error_description: description } };
  }

  /** A registered (DCR) client, or a Client ID Metadata Document client (https client_id). */
  async resolveClient(clientId: string): Promise<ResolvedClient> {
    if (/^https:\/\//i.test(clientId)) return this.resolveCimd(clientId);
    const c: StoredClient | undefined = this.store.read().clients[clientId];
    if (!c || c.type !== 'dcr') throw new OAuthError('invalid_client', 'unknown client', 401);
    return {
      clientId: c.clientId,
      type: 'dcr',
      name: c.name,
      redirectUris: c.redirectUris,
      tokenEndpointAuthMethod: c.tokenEndpointAuthMethod,
      secretHash: c.secretHash,
    };
  }

  private checkFetchUrl(raw: string, what: string): URL {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new OAuthError('invalid_client', `${what} is not a URL`, 401);
    }
    if (u.protocol !== 'https:' || u.username || u.password || u.hash)
      throw new OAuthError('invalid_client', `${what} must be a plain https URL`, 401);
    if (!hostAllowed(u.hostname, this.options.clientMetadataHosts ?? []))
      throw new OAuthError(
        'invalid_client',
        `${what} host ${u.hostname} is not in remote.clientMetadataHosts`,
        401,
      );
    return u;
  }

  private async fetchJson(url: URL): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(url.href, {
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new OAuthError('invalid_client', `could not fetch ${url.href}`, 401);
    }
    if (!res.ok) throw new OAuthError('invalid_client', `${url.href} returned ${res.status}`, 401);
    const text = await res.text();
    if (text.length > CIMD_MAX_BYTES)
      throw new OAuthError('invalid_client', `${url.href} is too large`, 401);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new OAuthError('invalid_client', `${url.href} is not JSON`, 401);
    }
  }

  private async resolveCimd(clientId: string): Promise<ResolvedClient> {
    const cached = this.cimdCache.get(clientId);
    const t = this.now().getTime();
    if (cached && cached.until > t) return cached.client;
    const url = this.checkFetchUrl(clientId, 'client_id');
    if (url.pathname === '/' || url.pathname === '')
      throw new OAuthError('invalid_client', 'client_id URL must have a path', 401);
    const parsed = CimdSchema.safeParse(await this.fetchJson(url));
    if (!parsed.success)
      throw new OAuthError('invalid_client', 'client metadata document is invalid', 401);
    const doc = parsed.data;
    if (doc.client_id !== clientId)
      throw new OAuthError('invalid_client', 'client metadata client_id does not match', 401);
    const method = (doc.token_endpoint_auth_method ?? 'none') as TokenEndpointAuthMethod;
    if (method !== 'none' && method !== 'private_key_jwt')
      throw new OAuthError(
        'invalid_client',
        'metadata-document clients must use none or private_key_jwt',
        401,
      );
    if (method === 'private_key_jwt' && !doc.jwks && !doc.jwks_uri)
      throw new OAuthError('invalid_client', 'private_key_jwt needs jwks or jwks_uri', 401);
    const client: ResolvedClient = {
      clientId,
      type: 'cimd',
      name: displayName(doc.client_name),
      redirectUris: doc.redirect_uris,
      tokenEndpointAuthMethod: method,
      ...(doc.jwks ? { jwks: doc.jwks.keys as Jwk[] } : {}),
      ...(doc.jwks_uri ? { jwksUri: doc.jwks_uri } : {}),
    };
    this.cimdCache.set(clientId, { client, until: t + CIMD_CACHE_MS });
    return client;
  }

  private async clientKeys(client: ResolvedClient): Promise<Jwk[]> {
    if (client.jwks) return client.jwks;
    if (!client.jwksUri) return [];
    const doc = (await this.fetchJson(this.checkFetchUrl(client.jwksUri, 'jwks_uri'))) as {
      keys?: unknown;
    };
    return Array.isArray(doc.keys) ? (doc.keys as Jwk[]) : [];
  }

  // ---- authorization endpoint -----------------------------------------------------------

  private errorRedirect(
    redirectUri: string,
    state: string | undefined,
    error: string,
    description: string,
  ): string {
    const u = new URL(redirectUri);
    u.searchParams.set('error', error);
    u.searchParams.set('error_description', description);
    if (state !== undefined) u.searchParams.set('state', state);
    u.searchParams.set('iss', this.issuer);
    return u.href;
  }

  /** Accept the canonical MCP URL (with or without a trailing slash); default to it when absent. */
  private resourceOf(raw: string | undefined): string | undefined {
    if (raw === undefined || raw === '') return this.resource;
    return trimSlash(raw) === this.resource ? this.resource : undefined;
  }

  /**
   * What the request asks for, reduced to what we know: read always, write and offline_access
   * only when asked. Write is granted later only if the owner ticks it on the consent page.
   */
  private grantedScope(requested: string | undefined): string {
    // Unknown scopes are dropped (the AS may issue less than asked, RFC 6749 §3.3).
    const want = new Set((requested ?? '').split(/\s+/).filter(Boolean));
    return [
      READ_SCOPE,
      ...(want.has(WRITE_SCOPE) ? [WRITE_SCOPE] : []),
      ...(want.has(OFFLINE_SCOPE) ? [OFFLINE_SCOPE] : []),
    ].join(' ');
  }

  async validateAuthorize(params: Record<string, unknown>): Promise<AuthorizeValidation> {
    const clientId = str(params.client_id);
    const redirectUri = str(params.redirect_uri);
    const state = str(params.state);
    if (!clientId)
      return { ok: false, error: 'invalid_request', description: 'client_id is missing' };
    let client: ResolvedClient;
    try {
      client = await this.resolveClient(clientId);
    } catch (e) {
      return {
        ok: false,
        error: 'invalid_client',
        description: e instanceof OAuthError ? e.description : 'unknown client',
      };
    }
    if (
      !redirectUri ||
      !client.redirectUris.includes(redirectUri) ||
      !this.isAllowedRedirect(redirectUri)
    )
      return {
        ok: false,
        error: 'invalid_request',
        description: 'redirect_uri is missing, not registered for this client, or not allowed',
      };
    const fail = (error: string, description: string): AuthorizeValidation => ({
      ok: false,
      error,
      description,
      redirect: this.errorRedirect(redirectUri, state, error, description),
    });
    if (str(params.response_type) !== 'code')
      return fail('unsupported_response_type', 'response_type must be code');
    const challenge = str(params.code_challenge);
    if (!challenge) return fail('invalid_request', 'PKCE code_challenge is required');
    if (str(params.code_challenge_method) !== 'S256')
      return fail('invalid_request', 'code_challenge_method must be S256');
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge))
      return fail('invalid_request', 'code_challenge is not a S256 challenge');
    const resource = this.resourceOf(str(params.resource));
    if (!resource) return fail('invalid_target', `resource must be ${this.resource}`);
    return {
      ok: true,
      client,
      request: {
        clientId,
        redirectUri,
        state,
        codeChallenge: challenge,
        scope: this.grantedScope(str(params.scope)),
        resource,
      },
    };
  }

  /** Seal a validated request into the consent form (tamper-proof, expires). */
  sealRequest(request: AuthorizeRequest): string {
    const body = Buffer.from(
      JSON.stringify({ r: request, t: this.now().getTime() }),
      'utf8',
    ).toString('base64url');
    const mac = createHmac('sha256', this.formKey).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  unsealRequest(sealed: string | undefined): AuthorizeRequest | undefined {
    if (!sealed) return undefined;
    const [body, mac, ...rest] = sealed.split('.');
    if (!body || !mac || rest.length) return undefined;
    const expected = createHmac('sha256', this.formKey).update(body).digest('base64url');
    if (!safeEqual(expected, mac)) return undefined;
    try {
      const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
        r: AuthorizeRequest;
        t: number;
      };
      if (this.now().getTime() - v.t > AUTHORIZE_FORM_TTL_MS) return undefined;
      return v.r;
    } catch {
      return undefined;
    }
  }

  /** Check the owner's passphrase with a persistent lockout after repeated failures. */
  unlock(passphrase: string, ip: string | undefined): Promise<UnlockResult> {
    const run = this.unlockQueue.then(() => this.unlockNow(passphrase, ip));
    this.unlockQueue = run.catch(() => undefined);
    return run;
  }

  private async unlockNow(passphrase: string, ip: string | undefined): Promise<UnlockResult> {
    const owner = this.store.read().owner;
    if (!owner.passphrase) return { ok: false, reason: 'no_passphrase' };
    const t = this.now();
    if (owner.lockedUntil && Date.parse(owner.lockedUntil) > t.getTime())
      return { ok: false, reason: 'locked', until: owner.lockedUntil };
    const good = await verifyPassphrase(passphrase, owner.passphrase);
    if (good) {
      this.store.update((s) => {
        s.owner.failures = 0;
        s.owner.lockouts = 0;
        delete s.owner.lockedUntil;
      });
      this.audit({ event: 'unlock_ok', ip });
      return { ok: true };
    }
    const result = this.store.update((s): UnlockResult => {
      s.owner.failures = (s.owner.failures ?? 0) + 1;
      if (s.owner.failures >= LOCKOUT_THRESHOLD) {
        const ms = Math.min(LOCKOUT_BASE_MS * 2 ** (s.owner.lockouts ?? 0), LOCKOUT_MAX_MS);
        s.owner.lockedUntil = new Date(t.getTime() + ms).toISOString();
        s.owner.lockouts = (s.owner.lockouts ?? 0) + 1;
        s.owner.failures = 0;
        return { ok: false, reason: 'wrong', remaining: 0, lockedUntil: s.owner.lockedUntil };
      }
      return { ok: false, reason: 'wrong', remaining: LOCKOUT_THRESHOLD - s.owner.failures };
    });
    this.audit({
      event:
        result.ok === false && result.reason === 'wrong' && result.lockedUntil
          ? 'lockout'
          : 'unlock_failed',
      ip,
    });
    return result;
  }

  /**
   * Approve: mint a one-time code and build the redirect back to the client. `write` is the
   * owner's consent-page checkbox: the write scope is in the grant only when it is ticked.
   */
  approve(
    request: AuthorizeRequest,
    client: ResolvedClient,
    ip: string | undefined,
    options: { write?: boolean } = {},
  ): string {
    const code = randomToken('ucd_');
    this.sweepCodes();
    const scope = [
      READ_SCOPE,
      ...(options.write === true ? [WRITE_SCOPE] : []),
      ...(hasScope(request.scope, OFFLINE_SCOPE) ? [OFFLINE_SCOPE] : []),
    ].join(' ');
    this.codes.set(sha256Hex(code), {
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scope,
      resource: request.resource,
      expiresAt: this.now().getTime() + AUTH_CODE_TTL_MS,
      used: false,
    });
    if (client.type === 'cimd')
      this.store.update((s) => {
        s.clients[client.clientId] ??= {
          clientId: client.clientId,
          type: 'cimd',
          name: client.name,
          redirectUris: client.redirectUris,
          tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
          createdAt: this.now().toISOString(),
        };
      });
    this.audit({
      event: 'authorize',
      clientId: request.clientId,
      clientName: client.name,
      scope,
      ip,
    });
    const u = new URL(request.redirectUri);
    u.searchParams.set('code', code);
    if (request.state !== undefined) u.searchParams.set('state', request.state);
    u.searchParams.set('iss', this.issuer);
    return u.href;
  }

  deny(request: AuthorizeRequest, ip: string | undefined): string {
    this.audit({ event: 'authorize_denied', clientId: request.clientId, ip });
    return this.errorRedirect(
      request.redirectUri,
      request.state,
      'access_denied',
      'the owner denied the request',
    );
  }

  private sweepCodes(): void {
    const t = this.now().getTime();
    for (const [k, c] of this.codes) if (c.expiresAt + AUTH_CODE_TTL_MS < t) this.codes.delete(k);
    for (const [k, exp] of this.jtis) if (exp < t) this.jtis.delete(k);
  }

  // ---- token endpoint -------------------------------------------------------------------

  private tokenError(error: string, description: string, status = 400): TokenResponse {
    return {
      status,
      body: { error, error_description: description },
      headers: {
        'cache-control': 'no-store',
        pragma: 'no-cache',
        ...(status === 401 ? { 'www-authenticate': 'Basic realm="unicontext"' } : {}),
      },
    };
  }

  /** Authenticate the client at the token/revocation endpoint by its registered method. */
  private async authenticateClient(
    params: Record<string, unknown>,
    authorization: string | undefined,
  ): Promise<ResolvedClient> {
    let clientId = str(params.client_id);
    let secret: string | undefined;
    let method: TokenEndpointAuthMethod = 'none';
    const basic = /^Basic\s+(\S+)$/i.exec(authorization ?? '');
    if (basic?.[1]) {
      const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i < 0) throw new OAuthError('invalid_client', 'malformed Basic credentials', 401);
      const id = decodeURIComponent(decoded.slice(0, i));
      if (clientId && clientId !== id)
        throw new OAuthError('invalid_client', 'client_id mismatch', 401);
      clientId = id;
      secret = decodeURIComponent(decoded.slice(i + 1));
      method = 'client_secret_basic';
    } else if (str(params.client_assertion_type) !== undefined) {
      method = 'private_key_jwt';
    } else if (str(params.client_secret) !== undefined) {
      secret = str(params.client_secret);
      method = 'client_secret_post';
    }
    const assertion = str(params.client_assertion);
    if (method === 'private_key_jwt' && !clientId && assertion) {
      const iss = decodeJwt(assertion)?.payload.iss;
      if (typeof iss === 'string') clientId = iss;
    }
    if (!clientId) throw new OAuthError('invalid_client', 'client_id is missing', 401);
    const client = await this.resolveClient(clientId);
    if (client.tokenEndpointAuthMethod !== method)
      throw new OAuthError(
        'invalid_client',
        `client must authenticate with ${client.tokenEndpointAuthMethod}`,
        401,
      );
    if (method === 'client_secret_basic' || method === 'client_secret_post') {
      if (!secret || !client.secretHash || !safeEqual(sha256Hex(secret), client.secretHash))
        throw new OAuthError('invalid_client', 'client authentication failed', 401);
    }
    if (method === 'private_key_jwt') await this.verifyAssertion(client, params);
    return client;
  }

  private async verifyAssertion(
    client: ResolvedClient,
    params: Record<string, unknown>,
  ): Promise<void> {
    const fail = (why: string): never => {
      throw new OAuthError('invalid_client', `client assertion rejected: ${why}`, 401);
    };
    if (str(params.client_assertion_type) !== CLIENT_ASSERTION_TYPE) fail('unsupported type');
    const jwt = decodeJwt(str(params.client_assertion) ?? '');
    if (!jwt) return fail('malformed');
    const keys = await this.clientKeys(client);
    if (!verifyJwtSignature(jwt, keys)) fail('bad signature');
    const p = jwt.payload;
    const t = Math.floor(this.now().getTime() / 1000);
    if (p.iss !== client.clientId || p.sub !== client.clientId)
      fail('iss/sub must be the client_id');
    const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
    const tokenUrl = `${this.issuer}/token`;
    if (!aud.some((a) => a === tokenUrl || a === this.issuer)) fail('wrong audience');
    if (typeof p.exp !== 'number' || p.exp < t - 30 || p.exp > t + 3600) fail('expired');
    if (typeof p.jti !== 'string' || !p.jti) fail('jti is required');
    const jti = `${client.clientId}|${String(p.jti)}`;
    if (this.jtis.has(jti)) fail('replayed');
    this.jtis.set(jti, (p.exp as number) * 1000 + 60_000);
  }

  async token(
    params: Record<string, unknown>,
    authorization: string | undefined,
    ip: string | undefined,
  ): Promise<TokenResponse> {
    let client: ResolvedClient;
    try {
      client = await this.authenticateClient(params, authorization);
    } catch (e) {
      if (e instanceof OAuthError) return this.tokenError(e.error, e.description, e.status);
      throw e;
    }
    const grantType = str(params.grant_type);
    try {
      if (grantType === 'authorization_code') return this.exchangeCode(client, params, ip);
      if (grantType === 'refresh_token') return this.refresh(client, params, ip);
    } catch (e) {
      if (e instanceof OAuthError) return this.tokenError(e.error, e.description, e.status);
      throw e;
    }
    return this.tokenError('unsupported_grant_type', 'use authorization_code or refresh_token');
  }

  private issueTokens(grant: StoredGrant, refresh: string): TokenResponse {
    const access = randomToken('uca_');
    const t = this.now().getTime();
    const ttl = this.options.accessTokenTtlMs;
    this.store.update((s) => {
      s.accessTokens[sha256Hex(access)] = {
        grantId: grant.grantId,
        clientId: grant.clientId,
        scope: grant.scope,
        resource: grant.resource,
        expiresAt: new Date(t + ttl).toISOString(),
      };
    });
    return {
      status: 200,
      body: {
        access_token: access,
        token_type: 'Bearer',
        expires_in: Math.floor(ttl / 1000),
        refresh_token: refresh,
        scope: grant.scope,
      },
      headers: { 'cache-control': 'no-store', pragma: 'no-cache' },
    };
  }

  private exchangeCode(
    client: ResolvedClient,
    params: Record<string, unknown>,
    ip: string | undefined,
  ): TokenResponse {
    const code = str(params.code);
    const rec = code ? this.codes.get(sha256Hex(code)) : undefined;
    if (!code || !rec) throw new OAuthError('invalid_grant', 'unknown authorization code');
    if (rec.used) {
      // A replayed code: revoke whatever was issued from it (OAuth 2.1 §4.1.3).
      if (rec.grantId) this.revokeGrant(rec.grantId);
      throw new OAuthError('invalid_grant', 'authorization code was already used');
    }
    if (rec.expiresAt < this.now().getTime())
      throw new OAuthError('invalid_grant', 'authorization code expired');
    if (rec.clientId !== client.clientId)
      throw new OAuthError('invalid_grant', 'code was issued to another client');
    if (str(params.redirect_uri) !== rec.redirectUri)
      throw new OAuthError('invalid_grant', 'redirect_uri does not match');
    const verifier = str(params.code_verifier);
    if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
      throw new OAuthError('invalid_grant', 'code_verifier is missing or malformed');
    if (!safeEqual(s256(verifier), rec.codeChallenge))
      throw new OAuthError('invalid_grant', 'PKCE verification failed');
    const resource = str(params.resource);
    if (resource !== undefined && this.resourceOf(resource) !== rec.resource)
      throw new OAuthError('invalid_target', 'resource does not match the authorization');
    rec.used = true;

    const refresh = randomToken('ucr_');
    const t = this.now();
    const grant: StoredGrant = {
      grantId: randomToken('ucg_', 12),
      clientId: client.clientId,
      scope: rec.scope,
      resource: rec.resource,
      createdAt: t.toISOString(),
      lastUsedAt: t.toISOString(),
      refreshHash: sha256Hex(refresh),
      refreshExpiresAt: new Date(t.getTime() + this.options.refreshTokenTtlMs).toISOString(),
      rotatedRefreshHashes: [],
    };
    rec.grantId = grant.grantId;
    this.store.update((s) => {
      s.grants[grant.grantId] = grant;
      const c = s.clients[client.clientId];
      if (c) c.lastUsedAt = t.toISOString();
    });
    this.audit({ event: 'token', clientId: client.clientId, grant: grant.grantId, ip });
    return this.issueTokens(grant, refresh);
  }

  private refresh(
    client: ResolvedClient,
    params: Record<string, unknown>,
    ip: string | undefined,
  ): TokenResponse {
    const presented = str(params.refresh_token);
    if (!presented) throw new OAuthError('invalid_request', 'refresh_token is missing');
    const hash = sha256Hex(presented);
    const t = this.now();
    const state = this.store.read();
    const grants = Object.values(state.grants);
    const grant = grants.find((g) => g.refreshHash === hash);
    if (!grant) {
      const stolen = grants.find((g) => g.rotatedRefreshHashes.includes(hash));
      if (stolen && !stolen.revokedAt) {
        // Refresh token reuse: assume it leaked and kill the whole grant.
        this.revokeGrant(stolen.grantId);
        this.audit({ event: 'refresh_reuse', clientId: stolen.clientId, ip });
      }
      throw new OAuthError('invalid_grant', 'unknown or rotated refresh token');
    }
    if (grant.revokedAt) throw new OAuthError('invalid_grant', 'grant was revoked');
    if (Date.parse(grant.refreshExpiresAt) <= t.getTime())
      throw new OAuthError('invalid_grant', 'refresh token expired');
    if (grant.clientId !== client.clientId)
      throw new OAuthError('invalid_grant', 'refresh token belongs to another client');
    const resource = str(params.resource);
    if (resource !== undefined && this.resourceOf(resource) !== grant.resource)
      throw new OAuthError('invalid_target', 'resource does not match the grant');
    // A `scope` on refresh can only narrow; anything not in the grant is ignored rather than
    // refused, because clients replay their original request (which may hold scopes we dropped).
    // The issued tokens always carry the grant's scope.
    const next = randomToken('ucr_');
    const updated = this.store.update((s) => {
      const g = s.grants[grant.grantId];
      if (!g || g.revokedAt || g.refreshHash !== hash) return undefined;
      g.rotatedRefreshHashes = [...g.rotatedRefreshHashes, g.refreshHash].slice(-20);
      g.refreshHash = sha256Hex(next);
      g.refreshExpiresAt = new Date(t.getTime() + this.options.refreshTokenTtlMs).toISOString();
      g.lastUsedAt = t.toISOString();
      return { ...g };
    });
    if (!updated) throw new OAuthError('invalid_grant', 'refresh token is no longer valid');
    this.audit({ event: 'refresh', clientId: client.clientId, grant: grant.grantId, ip });
    return this.issueTokens(updated, next);
  }

  revokeGrant(grantId: string): void {
    this.store.update((s) => {
      const g = s.grants[grantId];
      if (g && !g.revokedAt) g.revokedAt = this.now().toISOString();
      for (const [h, a] of Object.entries(s.accessTokens))
        if (a.grantId === grantId) delete s.accessTokens[h];
    });
  }

  /** RFC 7009: revoke a refresh or access token (always 200 for unknown tokens). */
  async revoke(
    params: Record<string, unknown>,
    authorization: string | undefined,
    ip: string | undefined,
  ): Promise<TokenResponse> {
    let client: ResolvedClient;
    try {
      client = await this.authenticateClient(params, authorization);
    } catch (e) {
      if (e instanceof OAuthError) return this.tokenError(e.error, e.description, e.status);
      throw e;
    }
    const token = str(params.token);
    if (token) {
      const hash = sha256Hex(token);
      const state = this.store.read();
      const access = state.accessTokens[hash];
      const grant =
        Object.values(state.grants).find((g) => g.refreshHash === hash) ??
        (access ? state.grants[access.grantId] : undefined);
      if (grant && grant.clientId === client.clientId) {
        this.revokeGrant(grant.grantId);
        this.audit({ event: 'revoke', clientId: client.clientId, grant: grant.grantId, ip });
      }
    }
    return { status: 200, body: {}, headers: { 'cache-control': 'no-store' } };
  }

  // ---- resource server ------------------------------------------------------------------

  /** Validate a bearer token for the MCP endpoint: known, unexpired, unrevoked, our audience. */
  checkAccessToken(token: string | undefined): AccessCheck {
    if (!token) return { ok: false, error: 'invalid_token', description: 'missing bearer token' };
    const state = this.store.read();
    const rec = state.accessTokens[sha256Hex(token)];
    const t = this.now().getTime();
    if (!rec || Date.parse(rec.expiresAt) <= t)
      return { ok: false, error: 'invalid_token', description: 'unknown or expired token' };
    const grant = state.grants[rec.grantId];
    if (!grant || grant.revokedAt)
      return { ok: false, error: 'invalid_token', description: 'token was revoked' };
    if (rec.resource !== this.resource || grant.resource !== this.resource)
      return { ok: false, error: 'invalid_token', description: 'token audience mismatch' };
    if (!rec.scope.split(' ').includes(READ_SCOPE))
      return { ok: false, error: 'insufficient_scope', description: `${READ_SCOPE} is required` };
    const last = grant.lastUsedAt ? Date.parse(grant.lastUsedAt) : 0;
    if (t - last > 5 * 60_000) {
      try {
        this.store.update((s) => {
          const g = s.grants[rec.grantId];
          if (g) g.lastUsedAt = new Date(t).toISOString();
        });
      } catch {
        // bookkeeping only
      }
    }
    return {
      ok: true,
      clientId: rec.clientId,
      clientName: state.clients[rec.clientId]?.name,
      grantId: rec.grantId,
      scope: rec.scope,
    };
  }
}
