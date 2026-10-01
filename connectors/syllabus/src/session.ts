import type { HttpClient } from '@unicontext/connector-sdk';
import { ConnectorError } from '@unicontext/core';

/** The server refused to continue the screen flow (expired session, stale csrf, error screen). */
export class SessionExpiredError extends ConnectorError {}

export interface SessionResponse {
  /** Final URL after redirects (without `;jsessionid=`). */
  url: string;
  status: number;
  html: string;
  /** Redirect chain followed to get here (for tests and diagnostics). */
  redirects: string[];
}

export interface SessionRequest {
  method?: 'GET' | 'POST';
  /** application/x-www-form-urlencoded body (encoded as UTF-8). */
  form?: Record<string, string>;
  signal?: AbortSignal;
}

function decode(buffer: ArrayBuffer, contentType: string | null): string {
  const charset = /charset=([^;\s]+)/i.exec(contentType ?? '')?.[1]?.replace(/["']/g, '');
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

/**
 * A minimal browser-like session for server-rendered screen flows (PRG pattern): a cookie jar
 * filled from `set-cookie`, manual redirect handling (`redirect: 'manual'`, so cookies are
 * carried across every hop and `;jsessionid=` URL rewriting is understood) and a strict
 * one-request-at-a-time queue (`exclusive`). Cookies never leave this object: they are not part
 * of any payload, log or return value.
 */
export class HttpSession {
  private readonly cookies = new Map<string, string>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly origin: string;
  /** Free-form per-session state for strategies (csrf token, current screen). */
  readonly state = new Map<string, unknown>();

  constructor(
    private readonly http: HttpClient,
    readonly baseUrl: string,
    private readonly maxRedirects = 8,
  ) {
    this.origin = new URL(baseUrl).origin;
  }

  /** Run `fn` after every previously queued operation finished. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Drop cookies and strategy state (start a new server session). */
  reset(): void {
    this.cookies.clear();
    this.state.clear();
  }

  hasCookie(name: string): boolean {
    return this.cookies.has(name);
  }

  private cookieHeader(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private storeCookies(res: Response): void {
    const headers = res.headers as Headers & { getSetCookie?: () => string[] };
    const lines =
      typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : (headers.get('set-cookie') ?? '').split(/,(?=\s*[^;,=\s]+=)/).filter(Boolean);
    for (const line of lines) {
      const [pair, ...attrs] = line.split(';').map((s) => s.trim());
      const eq = pair?.indexOf('=') ?? -1;
      if (!pair || eq <= 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const expired = attrs.some((a) => /^max-age=0$/i.test(a)) || value === '';
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  /** `;jsessionid=XYZ` path parameters: remember the id as a cookie and strip it from the URL. */
  private absorbPathSession(url: string): string {
    return url.replace(/;jsessionid=([^?#/;]*)/i, (_m, id: string) => {
      if (id && !this.cookies.has('JSESSIONID')) this.cookies.set('JSESSIONID', id);
      return '';
    });
  }

  async fetch(url: string, request: SessionRequest = {}): Promise<SessionResponse> {
    let current = new URL(this.absorbPathSession(url), this.baseUrl).toString();
    let method = request.method ?? 'GET';
    let body = request.form ? new URLSearchParams(request.form).toString() : undefined;
    const redirects: string[] = [];
    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      if (new URL(current).origin !== this.origin)
        throw new SessionExpiredError(`Unexpected redirect off-origin: ${new URL(current).host}`);
      const headers: Record<string, string> = {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'ja,en;q=0.5',
      };
      const cookie = this.cookieHeader();
      if (cookie) headers['cookie'] = cookie;
      if (body !== undefined)
        headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      const res = await this.http.request(current, {
        method,
        headers,
        redirect: 'manual',
        ...(body !== undefined ? { body } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      this.storeCookies(res);
      const location = res.headers.get('location');
      if ([301, 302, 303, 307, 308].includes(res.status) && location) {
        await res.arrayBuffer().catch(() => undefined);
        const next = new URL(this.absorbPathSession(location), current).toString();
        redirects.push(next);
        current = next;
        if (res.status !== 307 && res.status !== 308) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }
      const html = decode(await res.arrayBuffer(), res.headers.get('content-type'));
      if (res.status >= 400)
        throw new ConnectorError(`HTTP ${res.status} from ${new URL(current).host}`, {
          details: { status: res.status },
        });
      return { url: current, status: res.status, html, redirects };
    }
    throw new SessionExpiredError(`Too many redirects (> ${this.maxRedirects})`);
  }
}
