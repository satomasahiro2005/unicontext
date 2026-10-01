import {
  AuthRequiredError,
  type Clock,
  ConnectorError,
  OfflineError,
  RateLimitedError,
  systemClock,
  type FetchLike,
} from '@unicontext/core';
import { parseRetryAfter, RateLimiter } from './rate-limiter.js';

export class HttpError extends ConnectorError {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message, { details: { status } });
    this.status = status;
  }
}

export interface HttpClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  rateLimiter?: RateLimiter;
  /** Per-request headers (e.g. Authorization from the SecretStore). Never logged. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  userAgent?: string;
  clock?: Clock;
}

export interface HttpClient {
  request(pathOrUrl: string, init?: RequestInit): Promise<Response>;
  json<T = unknown>(pathOrUrl: string, init?: RequestInit): Promise<T>;
}

export const DEFAULT_USER_AGENT = 'UniContext/1.0 (local-first personal client)';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

/**
 * Follow redirects by hand when credential headers were injected: fetch strips `Authorization`
 * on a cross-origin hop but not custom ones (`X-API-Key`, ...), so those are dropped here before
 * leaving the original origin.
 */
async function fetchWithCredentialHeaders(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
  headers: Headers,
  injected: string[],
): Promise<Response> {
  const origin = new URL(url).origin;
  let current = url;
  let currentInit: RequestInit = { ...init, headers };
  for (let hop = 0; ; hop++) {
    const res = await fetchFn(current, { ...currentInit, redirect: 'manual' });
    const location = res.headers.get('location');
    if (!REDIRECTS.has(res.status) || !location) return res;
    if (hop >= MAX_REDIRECTS)
      throw new ConnectorError(`Too many redirects from ${new URL(url).host}`);
    const next = new URL(location, current);
    const nextHeaders = new Headers(currentInit.headers);
    if (next.origin !== origin)
      for (const name of [...injected, ...CREDENTIAL_HEADERS]) nextHeaders.delete(name);
    const method = (currentInit.method ?? 'GET').toUpperCase();
    const toGet =
      res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST');
    if (toGet) {
      nextHeaders.delete('content-type');
      nextHeaders.delete('content-length');
    }
    await res.body?.cancel().catch(() => undefined);
    currentInit = { ...currentInit, headers: nextHeaders };
    if (toGet) {
      delete currentInit.body;
      currentInit.method = 'GET';
    }
    current = next.toString();
  }
}

/**
 * fetch wrapper for connectors: rate limited, maps 401 → AuthRequiredError, 429/503 → RateLimitedError
 * (Retry-After aware), network failures → OfflineError, and retries 5xx with backoff.
 */
export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const fetchFn: FetchLike = options.fetch ?? ((i, init) => fetch(i, init));
  const limiter = options.rateLimiter ?? new RateLimiter();
  const clock = options.clock ?? systemClock;

  const request = (pathOrUrl: string, init: RequestInit = {}): Promise<Response> =>
    limiter.schedule(
      async () => {
        const url =
          options.baseUrl && !/^https?:\/\//.test(pathOrUrl)
            ? new URL(pathOrUrl, options.baseUrl).toString()
            : pathOrUrl;
        const extra = options.headers ? await options.headers() : {};
        const headers = new Headers(init.headers);
        headers.set('user-agent', options.userAgent ?? DEFAULT_USER_AGENT);
        for (const [k, v] of Object.entries(extra)) headers.set(k, v);
        let res: Response;
        try {
          res =
            Object.keys(extra).length > 0 && init.redirect === undefined
              ? await fetchWithCredentialHeaders(fetchFn, url, init, headers, Object.keys(extra))
              : await fetchFn(url, { ...init, headers });
        } catch (e) {
          if (e instanceof Error && e.name === 'AbortError') throw e;
          throw new OfflineError(`Request failed: ${new URL(url).host}`, { cause: e });
        }
        if (res.status === 401) throw new AuthRequiredError(`HTTP 401 from ${new URL(url).host}`);
        if (res.status === 429 || res.status === 503) {
          const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), clock.now());
          throw new RateLimitedError(
            `HTTP ${res.status} from ${new URL(url).host}`,
            retryAfterMs !== undefined ? { retryAfterMs } : undefined,
          );
        }
        if (res.status >= 500)
          throw new HttpError(res.status, `HTTP ${res.status} from ${new URL(url).host}`);
        return res;
      },
      {
        retryOn: (e) => e instanceof HttpError && e.status >= 500,
        ...(init.signal ? { signal: init.signal } : {}),
      },
    );

  return {
    request,
    async json<T>(pathOrUrl: string, init?: RequestInit): Promise<T> {
      const res = await request(pathOrUrl, init);
      if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}`);
      return (await res.json()) as T;
    },
  };
}
