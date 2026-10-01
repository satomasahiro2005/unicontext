import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Hostnames the daemon answers to. Anything else is a DNS-rebinding attempt (§41). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Split a Host header into hostname and optional port. */
export function parseHostHeader(
  host: string | undefined,
): { hostname: string; port: string | undefined } | undefined {
  if (!host) return undefined;
  const m = /^(\[[^\]]+\]|[^:\s]+)(?::(\d{1,5}))?$/.exec(host.trim().toLowerCase());
  if (!m) return undefined;
  return { hostname: m[1] ?? '', port: m[2] };
}

export function isLoopbackHost(host: string | undefined): boolean {
  const parsed = parseHostHeader(host);
  return parsed !== undefined && LOOPBACK_HOSTS.has(parsed.hostname);
}

/** True when an Origin header names a loopback origin. `null` (sandboxed/file) is never accepted. */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && isLoopbackHost(u.host);
  } catch {
    return false;
  }
}

/** Same-origin check for state-changing browser requests: Origin must equal http://<Host>. */
export function originMatchesHost(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  try {
    const u = new URL(origin);
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      u.host.toLowerCase() === host.trim().toLowerCase()
    );
  } catch {
    return false;
  }
}

export const CSRF_COOKIE = 'uc_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/**
 * CSRF tokens for the Web UI: `<nonce>.<hmac(nonce)>` keyed by a secret derived from the API
 * token. The cookie (HttpOnly, SameSite=Strict) and the `X-CSRF-Token` header must carry the same
 * valid value (double submit), and the Origin must equal the Host.
 */
export class CsrfTokens {
  private readonly key: Buffer;

  constructor(apiToken: string) {
    this.key = createHmac('sha256', apiToken).update('unicontext-csrf').digest();
  }

  issue(): string {
    const nonce = randomBytes(18).toString('base64url');
    return `${nonce}.${this.sign(nonce)}`;
  }

  private sign(nonce: string): string {
    return createHmac('sha256', this.key).update(nonce).digest('base64url');
  }

  verify(token: string | undefined): boolean {
    if (!token) return false;
    const [nonce, mac, ...rest] = token.split('.');
    if (!nonce || !mac || rest.length > 0) return false;
    const a = Buffer.from(this.sign(nonce));
    const b = Buffer.from(mac);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m?.[1];
}
