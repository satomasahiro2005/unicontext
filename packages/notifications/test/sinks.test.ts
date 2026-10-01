import { createHmac } from 'node:crypto';
import { createMemoryLogger, defaultConfig, type SecretStore } from '@unicontext/core';
import { describe, expect, it, vi } from 'vitest';
import {
  createConsoleSink,
  createDesktopSink,
  createSinksFromConfig,
  createWebhookSink,
  formatNotificationLine,
  type Notification,
  type NotifierLike,
} from '../src/index.js';

function note(over: Partial<Notification> = {}): Notification {
  return {
    id: 'ntf_1',
    kind: 'room_change',
    priority: 'critical',
    title: '教室変更: データベースシステム論',
    body: '10月1日(木)2限の教室が「21教室」から「11教室」に変更されました。',
    createdAt: '2026-10-01T00:00:00.000Z',
    dedupeKey: 'k',
    citations: [],
    ...over,
  };
}

function secrets(values: Record<string, string>): SecretStore {
  return {
    backend: 'memory',
    get: async (k) => values[k],
    set: async () => {},
    delete: async () => false,
  };
}

describe('console sink', () => {
  it('formats a Japanese priority label, title and body on one line', () => {
    const lines: string[] = [];
    const sink = createConsoleSink({ write: (l) => lines.push(l) });
    sink.send(note());
    sink.send(note({ priority: 'low', title: 'a', body: 'b\nc' }));
    expect(lines).toEqual([
      '[緊急] 教室変更: データベースシステム論 — 10月1日(木)2限の教室が「21教室」から「11教室」に変更されました。',
      '[低] a — b c',
    ]);
    expect(formatNotificationLine(note({ priority: 'normal', body: '' }))).toBe(
      '[通常] 教室変更: データベースシステム論',
    );
  });

  it('writes to stderr by default, never stdout', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      createConsoleSink().send(note());
      expect(err).toHaveBeenCalledTimes(1);
      expect(out).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });
});

describe('desktop sink', () => {
  it('returns undefined when the module cannot be loaded', async () => {
    const { logger } = createMemoryLogger();
    expect(
      await createDesktopSink({
        load: () => Promise.reject(new Error('Cannot find module')),
        logger,
      }),
    ).toBeUndefined();
    expect(await createDesktopSink({ load: async () => undefined })).toBeUndefined();
  });

  it('shows notifications at or above its minimum priority through the notifier', async () => {
    const shown: { title: string; message: string; sound?: boolean }[] = [];
    const notifier: NotifierLike = {
      notify(opts, cb) {
        shown.push(opts);
        cb?.(null);
        return undefined;
      },
    };
    const sink = await createDesktopSink({ load: async () => notifier });
    expect(sink?.id).toBe('desktop');
    await sink?.send(note());
    await sink?.send(note({ priority: 'low' }));
    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe('[緊急] 教室変更: データベースシステム論');
    expect(shown[0]?.sound).toBe(true);
  });

  it('propagates notifier errors to the service (which isolates them)', async () => {
    const sink = await createDesktopSink({
      load: async () => ({
        notify(_opts, cb) {
          cb?.(new Error('no daemon'));
          return undefined;
        },
      }),
    });
    await expect(sink?.send(note())).rejects.toThrow('no daemon');
  });

  it('the default loader never throws (node-notifier present or not)', async () => {
    const sink = await createDesktopSink();
    expect(sink === undefined || sink.id === 'desktop').toBe(true);
  });
});

describe('webhook sink', () => {
  it('POSTs JSON with an HMAC-SHA256 signature of the exact body', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const sink = createWebhookSink({
      url: 'https://hooks.example.invalid/in?token=abc',
      secret: 's3cret',
      fetch: fetchMock,
    });
    await sink.send(note());
    expect(calls).toHaveLength(1);
    const init: RequestInit = calls[0]?.init ?? {};
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    const body = String(init.body);
    expect(headers.get('x-unicontext-signature')).toBe(
      `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`,
    );
    expect(JSON.parse(body)).toMatchObject({
      event: 'notification',
      notification: { id: 'ntf_1', kind: 'room_change' },
    });
  });

  it('omits the signature without a secret and filters by minPriority', async () => {
    const calls: RequestInit[] = [];
    const fetchMock = (async (_u: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response('ok');
    }) as typeof fetch;
    const sink = createWebhookSink({
      url: 'https://h.example.invalid/',
      fetch: fetchMock,
      minPriority: 'high',
    });
    await sink.send(note({ priority: 'normal' }));
    expect(calls).toHaveLength(0);
    await sink.send(note({ priority: 'high' }));
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]?.headers).has('x-unicontext-signature')).toBe(false);
  });

  it('errors never include the URL or its query string', async () => {
    const url = 'https://h.example.invalid/hook?token=SUPERSECRET';
    const bad = createWebhookSink({
      url,
      fetch: (async () => new Response('no', { status: 500 })) as typeof fetch,
    });
    await expect(bad.send(note())).rejects.toThrow('HTTP 500');
    const down = createWebhookSink({
      url,
      fetch: (async () => {
        throw new Error(`connect ECONNREFUSED ${url}`);
      }) as typeof fetch,
    });
    const err = await Promise.resolve(down.send(note())).catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain('SUPERSECRET');
  });

  it('aborts on timeout', async () => {
    const sink = createWebhookSink({
      url: 'https://h.example.invalid/',
      timeoutMs: 20,
      fetch: ((_u: string | URL | Request, init?: RequestInit) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener('abort', () => rej(new DOMException('x', 'AbortError')));
        })) as typeof fetch,
    });
    await expect(sink.send(note())).rejects.toThrow('webhook delivery failed (AbortError)');
  });
});

describe('createSinksFromConfig', () => {
  it('defaults: console on, webhook off (desktop only if node-notifier loads)', async () => {
    const sinks = await createSinksFromConfig(defaultConfig().notifications, {
      secrets: secrets({}),
    });
    const ids = sinks.map((s) => s.id);
    expect(ids).toContain('console');
    expect(ids).not.toContain('webhook');
  });

  it('creates a signed webhook sink from the secret store', async () => {
    const config = defaultConfig().notifications;
    config.sinks.desktop.enabled = false;
    config.sinks.webhook = {
      enabled: true,
      url: 'https://h.example.invalid/in',
      secretRef: 'notifications/webhook',
      minPriority: 'high',
    };
    const calls: RequestInit[] = [];
    const sinks = await createSinksFromConfig(config, {
      secrets: secrets({ 'notifications/webhook': 'k' }),
      fetch: (async (_u: string | URL | Request, init?: RequestInit) => {
        calls.push(init ?? {});
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });
    expect(sinks.map((s) => s.id)).toEqual(['console', 'webhook']);
    await sinks[1]?.send(note({ priority: 'low' })); // below the webhook's minPriority
    expect(calls).toHaveLength(0);
    await sinks[1]?.send(note());
    expect(new Headers(calls[0]?.headers).get('x-unicontext-signature')).toMatch(
      /^sha256=[0-9a-f]{64}$/,
    );
  });

  it('skips the webhook when enabled without url, or when its secret is missing', async () => {
    const { logger, records } = createMemoryLogger();
    const config = defaultConfig().notifications;
    config.sinks.desktop.enabled = false;
    config.sinks.console.enabled = false;
    config.sinks.webhook = { enabled: true, minPriority: 'high' };
    expect(await createSinksFromConfig(config, { secrets: secrets({}), logger })).toEqual([]);
    config.sinks.webhook = {
      enabled: true,
      url: 'https://h.example.invalid/',
      secretRef: 'missing',
      minPriority: 'high',
    };
    expect(await createSinksFromConfig(config, { secrets: secrets({}), logger })).toEqual([]);
    expect(records.some((r) => r.msg.startsWith('webhook disabled'))).toBe(true);
  });

  it('returns no sinks when notifications are disabled', async () => {
    const config = defaultConfig().notifications;
    config.enabled = false;
    expect(await createSinksFromConfig(config, { secrets: secrets({}) })).toEqual([]);
  });
});
