import type { IncomingMessage } from 'node:http';
import { errorMessage, parseDuration, type Logger } from '@unicontext/core';
import { handleMcpHttp } from '@unicontext/mcp';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Runtime } from '../runtime.js';
import { bearerToken, parseHostHeader } from '../security.js';
import { createAuditLog, remoteAuditFile, type AuditRecord } from './audit.js';
import { hasScope, OAuthServer, WRITE_SCOPE, type AuditEvent } from './oauth.js';
import { consentPage, messagePage } from './pages.js';
import { WindowRateLimiter } from './ratelimit.js';
import { RemoteStateStore } from './state.js';

export interface RemoteServerOptions {
  runtime: Runtime;
  version: string;
  /** Overrides for tests. */
  store?: RemoteStateStore;
  fetch?: typeof fetch;
  now?: () => Date;
  audit?: (event: Omit<AuditRecord, 'at'>) => void;
}

export interface RemoteRequestInfo {
  /** Effective scheme as seen by the client (from X-Forwarded-Proto when the peer is trusted). */
  proto: string;
  /** Effective host (X-Forwarded-Host when trusted, else Host). */
  host: string | undefined;
  /** Client address (CF-Connecting-IP / X-Forwarded-For when trusted, else the socket peer). */
  ip: string | undefined;
  trustedPeer: boolean;
}

function first(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.split(',')[0]?.trim() || undefined;
}

/**
 * Forwarded headers are honoured only from a configured proxy (the local cloudflared). Anything
 * else connecting to the listener gets its socket address and its own Host header.
 */
export function remoteRequestInfo(
  req: Pick<IncomingMessage, 'headers' | 'socket'>,
  trustedProxies: readonly string[],
): RemoteRequestInfo {
  const peer = req.socket.remoteAddress;
  const trustedPeer = peer !== undefined && trustedProxies.includes(peer);
  const h = req.headers;
  return {
    trustedPeer,
    proto: (trustedPeer ? first(h['x-forwarded-proto'])?.toLowerCase() : undefined) ?? 'http',
    host: (trustedPeer ? first(h['x-forwarded-host']) : undefined) ?? first(h.host),
    ip:
      (trustedPeer ? (first(h['cf-connecting-ip']) ?? first(h['x-forwarded-for'])) : undefined) ??
      peer,
  };
}

const CORS_PATHS = /^\/(\.well-known\/|register$|token$|revoke$|mcp$)/;
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers':
    'authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id',
  'access-control-expose-headers': 'www-authenticate, mcp-session-id',
  'access-control-max-age': '600',
};

function formParser(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) {
    // RFC 6749 §3.1: request parameters must not be repeated
    if (k in out) throw Object.assign(new Error(`parameter ${k} is repeated`), { statusCode: 400 });
    out[k] = v;
  }
  return out;
}

export interface RemoteServer {
  app: FastifyInstance;
  oauth: OAuthServer;
  store: RemoteStateStore;
}

/**
 * The remote listener: OAuth authorization server + read-only MCP at /mcp. It is a separate
 * Fastify instance from the local REST/Web UI server and has none of its routes.
 */
export async function createRemoteServer(options: RemoteServerOptions): Promise<RemoteServer> {
  const { runtime } = options;
  const cfg = runtime.config.remote;
  if (!cfg.publicUrl)
    throw new Error(
      'remote.publicUrl is not set (e.g. https://uc.example.ac.jp); see docs/remote.md',
    );
  const publicUrl = new URL(cfg.publicUrl);
  const loopbackPublic = ['127.0.0.1', 'localhost', '[::1]'].includes(publicUrl.hostname);
  if (publicUrl.protocol !== 'https:' && !loopbackPublic)
    throw new Error(
      'remote.publicUrl must use https (http is allowed only for a loopback test URL)',
    );
  const log: Logger = runtime.logger.child({ component: 'remote' });
  const store = options.store ?? RemoteStateStore.forPaths(runtime.paths, options.now);
  const auditLog = options.audit ?? createAuditLog(remoteAuditFile(runtime.paths), options.now);
  const audit = (e: AuditEvent): void => auditLog(e);
  const oauth = new OAuthServer({
    publicUrl: publicUrl.origin,
    store,
    accessTokenTtlMs: parseDuration(cfg.accessTokenTtl),
    refreshTokenTtlMs: parseDuration(cfg.refreshTokenTtl),
    extraRedirectUris: cfg.extraRedirectUris,
    clientMetadataHosts: cfg.clientMetadataHosts,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
    audit,
  });
  const expectedHost = parseHostHeader(publicUrl.host);
  const requireHttps = publicUrl.protocol === 'https:';

  const unlockLimiter = new WindowRateLimiter(10, 15 * 60_000);
  const registerLimiter = new WindowRateLimiter(20, 3600_000);
  const tokenLimiter = new WindowRateLimiter(60, 60_000);
  const mcpLimiter = new WindowRateLimiter(240, 60_000);

  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, trustProxy: false });
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 64 * 1024 },
    (_req, body, done) => {
      try {
        done(null, formParser(body as string));
      } catch (e) {
        done(e as Error, undefined);
      }
    },
  );

  const infoOf = (request: FastifyRequest): RemoteRequestInfo =>
    remoteRequestInfo(request.raw, cfg.trustedProxies);

  app.addHook('onRequest', async (request, reply) => {
    const info = infoOf(request);
    const host = parseHostHeader(info.host);
    const hostOk =
      host !== undefined &&
      expectedHost !== undefined &&
      host.hostname === expectedHost.hostname &&
      (host.port ?? '') === (expectedHost.port ?? '');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (!hostOk) {
      log.warn('remote request for an unexpected host', { host: info.host, ip: info.ip });
      return reply
        .code(421)
        .send({ error: 'misdirected_request', error_description: 'unexpected host' });
    }
    if (requireHttps && info.proto !== 'https') {
      return reply.code(403).send({
        error: 'https_required',
        error_description: 'this endpoint is served only over https through the configured tunnel',
      });
    }
    const pathname = request.url.split('?')[0] ?? '';
    if (CORS_PATHS.test(pathname)) {
      for (const [k, v] of Object.entries(CORS_HEADERS)) reply.header(k, v);
      if (request.method === 'OPTIONS') return reply.code(204).send();
    }
    return undefined;
  });

  app.setErrorHandler((error, request, reply) => {
    const fe = error as { statusCode?: number };
    const status =
      fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500 ? fe.statusCode : 500;
    if (status >= 500)
      log.error('remote request failed', {
        url: request.url.split('?')[0],
        error: errorMessage(error),
      });
    void reply.code(status).send({
      error: status >= 500 ? 'server_error' : 'invalid_request',
      error_description: status >= 500 ? 'internal error' : errorMessage(error),
    });
  });

  const tooMany = (reply: FastifyReply, limiter: WindowRateLimiter, key: string): FastifyReply =>
    reply
      .code(429)
      .header('retry-after', String(Math.ceil(limiter.retryAfterMs(key) / 1000)))
      .send({ error: 'too_many_requests', error_description: 'slow down' });

  // ---- discovery --------------------------------------------------------------------------
  const prm = async () => oauth.protectedResourceMetadata();
  app.get('/.well-known/oauth-protected-resource', prm);
  app.get('/.well-known/oauth-protected-resource/mcp', prm);
  const asm = async () => oauth.authorizationServerMetadata();
  app.get('/.well-known/oauth-authorization-server', asm);
  app.get('/.well-known/oauth-authorization-server/mcp', asm);
  app.get('/.well-known/openid-configuration', asm);
  app.get('/.well-known/openid-configuration/mcp', asm);

  // ---- dynamic client registration --------------------------------------------------------
  app.post('/register', async (request, reply) => {
    const ip = infoOf(request).ip ?? '?';
    if (!registerLimiter.hit(ip)) return tooMany(reply, registerLimiter, ip);
    const r = oauth.register(request.body, ip);
    return reply.code(r.status).send(r.body);
  });

  // ---- authorization endpoint -------------------------------------------------------------
  const html = (reply: FastifyReply, status: number, body: string, formAction?: string[]) =>
    reply
      .code(status)
      .header(
        'Content-Security-Policy',
        `default-src 'none'; style-src 'unsafe-inline'; form-action ${["'self'", ...(formAction ?? [])].join(' ')}; frame-ancestors 'none'; base-uri 'none'`,
      )
      .type('text/html; charset=utf-8')
      .send(body);

  const renderConsent = (
    reply: FastifyReply,
    sealed: string,
    req: { clientId: string; redirectUri: string; scope: string },
    clientName: string | undefined,
    message?: string,
    status = 200,
  ) => {
    const redirect = new URL(req.redirectUri);
    return html(
      reply,
      status,
      consentPage({
        clientName,
        clientId: req.clientId,
        redirectHost: redirect.host,
        scope: '読み取り（unicontext.read）',
        writeRequested: hasScope(req.scope, WRITE_SCOPE),
        sealed,
        message,
        canUnlock: store.hasPassphrase(),
      }),
      // Chrome applies form-action to the redirect that follows the POST.
      [redirect.origin],
    );
  };

  app.get('/authorize', async (request, reply) => {
    const v = await oauth.validateAuthorize((request.query ?? {}) as Record<string, unknown>);
    if (!v.ok) {
      if (v.redirect) return reply.redirect(v.redirect, 302);
      return html(reply, 400, messagePage('接続できません', `${v.error}: ${v.description}`));
    }
    return renderConsent(reply, oauth.sealRequest(v.request), v.request, v.client.name);
  });

  app.post('/authorize', async (request, reply) => {
    const ip = infoOf(request).ip ?? '?';
    const body = (request.body ?? {}) as Record<string, unknown>;
    const sealed = typeof body.request === 'string' ? body.request : undefined;
    const req = oauth.unsealRequest(sealed);
    if (!req || !sealed)
      return html(
        reply,
        400,
        messagePage(
          'やり直してください',
          '画面の有効期限が切れました。ChatGPT / claude.aiから接続をやり直してください。',
        ),
      );
    let client;
    try {
      client = await oauth.resolveClient(req.clientId);
    } catch {
      return html(
        reply,
        400,
        messagePage('接続できません', 'このクライアントは取り消されています。'),
      );
    }
    if (!client.redirectUris.includes(req.redirectUri) || !oauth.isAllowedRedirect(req.redirectUri))
      return html(
        reply,
        400,
        messagePage('接続できません', 'リダイレクト先が許可されていません。'),
      );
    if (body.action === 'deny') return reply.redirect(oauth.deny(req, ip), 303);
    if (!unlockLimiter.hit(ip))
      return renderConsent(
        reply,
        sealed,
        req,
        client.name,
        '試行回数が多すぎます。しばらく待ってからやり直してください。',
        429,
      );
    const passphrase = typeof body.passphrase === 'string' ? body.passphrase : '';
    const result = await oauth.unlock(passphrase, ip);
    if (result.ok)
      return reply.redirect(
        oauth.approve(req, client, ip, { write: body.write === '1' || body.write === 'on' }),
        303,
      );
    if (result.reason === 'no_passphrase')
      return renderConsent(reply, sealed, req, client.name, undefined, 403);
    if (result.reason === 'locked' || result.lockedUntil) {
      const until = result.reason === 'locked' ? result.until : (result.lockedUntil ?? '');
      log.warn('remote unlock locked out', { until });
      return renderConsent(
        reply,
        sealed,
        req,
        client.name,
        `失敗が続いたためロックしました（${new Date(until).toLocaleString('ja-JP', { timeZone: runtime.uc.timezone })}まで）。`,
        429,
      );
    }
    return renderConsent(
      reply,
      sealed,
      req,
      client.name,
      `パスフレーズが違います（あと${result.remaining}回でロック）。`,
      401,
    );
  });

  // ---- token / revocation -----------------------------------------------------------------
  const tokenRoute =
    (kind: 'token' | 'revoke') => async (request: FastifyRequest, reply: FastifyReply) => {
      const ip = infoOf(request).ip ?? '?';
      if (!tokenLimiter.hit(ip)) return tooMany(reply, tokenLimiter, ip);
      const params = (request.body ?? {}) as Record<string, unknown>;
      const auth = request.headers.authorization;
      const r =
        kind === 'token'
          ? await oauth.token(params, auth, ip)
          : await oauth.revoke(params, auth, ip);
      for (const [k, v] of Object.entries(r.headers ?? {})) reply.header(k, v);
      return reply.code(r.status).send(r.body);
    };
  app.post('/token', tokenRoute('token'));
  app.post('/revoke', tokenRoute('revoke'));

  // ---- read-only MCP ----------------------------------------------------------------------
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    handler: async (request, reply) => {
      const info = infoOf(request);
      const check = oauth.checkAccessToken(bearerToken(request.headers.authorization));
      if (!check.ok) {
        return reply
          .code(check.error === 'insufficient_scope' ? 403 : 401)
          .header(
            'WWW-Authenticate',
            oauth.wwwAuthenticate(
              request.headers.authorization
                ? { error: check.error, description: check.description }
                : undefined,
            ),
          )
          .send({ error: check.error, error_description: check.description });
      }
      if (!mcpLimiter.hit(check.grantId)) return tooMany(reply, mcpLimiter, check.grantId);
      // hijack() bypasses Fastify's header handling: copy what the hooks set onto the raw response.
      for (const [k, v] of Object.entries(reply.getHeaders()))
        if (v !== undefined) reply.raw.setHeader(k, v as string);
      reply.hijack();
      try {
        await handleMcpHttp(
          {
            uc: runtime.uc,
            proposals: runtime.proposals,
            logger: runtime.logger,
            version: options.version,
            surface: 'remote',
            allowWrite: hasScope(check.scope, WRITE_SCOPE),
            client: { id: check.clientId, name: check.clientName },
            onToolCall: (e) =>
              audit({
                event: 'tool',
                clientId: check.clientId,
                clientName: check.clientName,
                tool: e.tool,
                ok: e.ok,
                ms: e.ms,
                ip: info.ip,
                // Writes: what was stored (ids only, never the text).
                ...(e.write
                  ? {
                      write: e.write.status,
                      additionId: e.write.additionId,
                      entityIds: e.write.entityIds.join(' ').slice(0, 4000),
                      factIds: e.write.factIds.join(' ').slice(0, 2000),
                    }
                  : {}),
              }),
          },
          request.raw,
          reply.raw,
          request.body,
        );
      } catch (e) {
        log.error('remote mcp request failed', { error: errorMessage(e) });
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { 'content-type': 'application/json' });
          reply.raw.end(JSON.stringify({ error: 'server_error' }));
        }
      }
    },
  });

  app.get('/', async (_request, reply) =>
    reply.type('text/plain; charset=utf-8').send('UniContext remote MCP endpoint: /mcp\n'),
  );
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: 'not_found', error_description: 'Not found' }),
  );

  return { app, oauth, store };
}
