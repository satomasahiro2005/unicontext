import type { SessionResponse } from './types';

/** An error response from the daemon (`{ error: { code, message } }`) or a network failure. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const BASE = '/api/v1';

function url(path: string): string {
  return path.startsWith('/') ? path : `${BASE}/${path}`;
}

async function parseError(res: Response): Promise<ApiError> {
  let code = 'http_error';
  let message = `リクエストに失敗しました (${res.status})`;
  try {
    const body: unknown = await res.json();
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const err = (body as { error?: { code?: unknown; message?: unknown } }).error;
      if (typeof err?.code === 'string') code = err.code;
      if (typeof err?.message === 'string' && err.message !== '') message = err.message;
    }
  } catch {
    // not JSON: keep the generic message
  }
  return new ApiError(message, res.status, code);
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url(path), { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError('デーモンに接続できません', 0, 'network_error');
  }
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const init: RequestInit = { headers: { Accept: 'application/json' } };
  if (signal) init.signal = signal;
  const res = await send(path, init);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

let csrfToken: string | undefined;
let csrfInFlight: Promise<string> | undefined;

async function fetchCsrfToken(): Promise<string> {
  const session = await apiGet<SessionResponse>('/api/v1/session');
  csrfToken = session.csrfToken;
  return session.csrfToken;
}

async function getCsrfToken(refresh: boolean): Promise<string> {
  if (!refresh && csrfToken) return csrfToken;
  csrfInFlight ??= fetchCsrfToken().finally(() => {
    csrfInFlight = undefined;
  });
  return csrfInFlight;
}

type WriteMethod = 'POST' | 'PUT' | 'DELETE';

async function write(
  method: WriteMethod,
  path: string,
  body: unknown,
  refresh: boolean,
): Promise<Response> {
  const token = await getCsrfToken(refresh);
  const headers: Record<string, string> = { Accept: 'application/json', 'X-CSRF-Token': token };
  const init: RequestInit = { method, headers };
  // A DELETE has no body (and must not claim a JSON one).
  if (method !== 'DELETE') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  return send(path, init);
}

async function apiWrite<T>(method: WriteMethod, path: string, body?: unknown): Promise<T> {
  let res = await write(method, path, body, false);
  if (res.status === 403) res = await write(method, path, body, true);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

/** POST with the CSRF token from /api/v1/session; on a 403 the token is refetched once and the call retried. */
export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiWrite<T>('POST', path, body);
}

export function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return apiWrite<T>('PUT', path, body);
}

export function apiDelete<T>(path: string): Promise<T> {
  return apiWrite<T>('DELETE', path);
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '不明なエラーが発生しました';
}

export const enc = encodeURIComponent;
