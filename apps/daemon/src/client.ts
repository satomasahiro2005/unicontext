import type { DataPaths, SecretStore } from '@unicontext/core';
import type { ApiErrorBody, HealthResponse } from './api-types.js';
import { readLock } from './lock.js';
import { readApiToken } from './token.js';

export class DaemonApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'DaemonApiError';
  }
}

export interface DaemonClientOptions {
  baseUrl: string;
  /** Bearer token for writes (§41). */
  token?: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Minimal REST client used by the CLI to talk to a running unicontextd. */
export class DaemonClient {
  readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: DaemonClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /**
   * Find a running daemon through its lock file and confirm it answers /api/v1/health.
   * Returns undefined when no daemon is reachable.
   */
  static async discover(
    paths: Pick<DataPaths, 'root'>,
    secrets: SecretStore,
    options: { port?: number; fetch?: typeof fetch; timeoutMs?: number } = {},
  ): Promise<DaemonClient | undefined> {
    const lock = readLock(paths);
    const port = lock?.port ?? options.port;
    if (!port) return undefined;
    const client = new DaemonClient({
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: options.timeoutMs ?? 2_000,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    let health: HealthResponse;
    try {
      health = await client.health();
    } catch {
      return undefined;
    }
    // A stale lock's port may now be served by another (possibly another user's) process: only
    // hand the write token to the daemon that owns the lock.
    if (lock && (health?.ok !== true || health.pid !== lock.pid)) return undefined;
    const token = await readApiToken(secrets, paths);
    return new DaemonClient({
      baseUrl: client.baseUrl,
      token,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  health(): Promise<HealthResponse> {
    return this.get<HealthResponse>('/api/v1/health');
  }

  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>('GET', path, undefined, query);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body ?? {});
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method === 'POST') {
      if (!this.token)
        throw new DaemonApiError(
          'デーモンの書き込みトークンが見つかりません（unicontext doctor で確認してください）',
          401,
          'unauthorized',
        );
      headers.authorization = `Bearer ${this.token}`;
    }
    const res = await this.fetchImpl(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const err = (json as ApiErrorBody | undefined)?.error;
      throw new DaemonApiError(
        err?.message ?? `HTTP ${res.status}`,
        res.status,
        err?.code ?? 'error',
      );
    }
    return json as T;
  }
}
