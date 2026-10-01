import { AuthRequiredError, ManualClock, OfflineError, RateLimitedError } from '@unicontext/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createHttpClient,
  defineMetadata,
  detectSchemaDrift,
  evaluateProductVersion,
  RateLimiter,
} from '../src/index.js';

describe('detectSchemaDrift (§73)', () => {
  const schema = z.object({
    id: z.string(),
    title: z.string(),
    room: z.string().optional(),
    teacher: z.object({ name: z.string() }).nullable(),
    schedule: z.array(z.object({ day: z.number(), period: z.number() })),
  });

  it('reports unknown, missing and type-mismatched fields including nested arrays', () => {
    const findings = detectSchemaDrift(
      {
        id: '1',
        title: 5,
        teacher: { name: 'x', email: 'e' },
        schedule: [{ day: 1, period: '2', extra: true }],
        newField: 1,
      },
      schema,
    );
    expect(findings).toEqual([
      { path: 'newField', kind: 'unknown' },
      { path: 'schedule[].extra', kind: 'unknown' },
      { path: 'schedule[].period', kind: 'type_mismatch' },
      { path: 'teacher.email', kind: 'unknown' },
      { path: 'title', kind: 'type_mismatch' },
    ]);
  });

  it('treats optional fields as non-missing and nullable values as fine', () => {
    expect(detectSchemaDrift({ id: '1', title: 't', teacher: null, schedule: [] }, schema)).toEqual(
      [],
    );
    expect(detectSchemaDrift({ id: '1', title: 't', schedule: [] }, schema)).toEqual([
      { path: 'teacher', kind: 'missing' },
    ]);
  });

  it('never throws on garbage', () => {
    expect(detectSchemaDrift('nope', schema)).toEqual([{ path: '$', kind: 'type_mismatch' }]);
  });
});

describe('connector metadata (§55, §27, §72)', () => {
  const base = {
    name: '@unicontext/x',
    product: 'X',
    version: '1.0.0',
    license: 'MIT',
    capabilities: ['courses'] as const,
    adapter: 'native' as const,
  };
  it('requires risk and testedVersion for unofficial APIs', () => {
    expect(() =>
      defineMetadata({ ...base, capabilities: ['courses'], apiStability: 'unofficial' }),
    ).toThrow(/risk|testedVersion/);
    const ok = defineMetadata({
      ...base,
      capabilities: ['courses'],
      apiStability: 'unofficial',
      risk: 'unsupported',
      testedVersion: '3.2.1',
    });
    expect(ok.risk).toBe('unsupported');
  });

  it('flags untested product versions as degraded', () => {
    const m = defineMetadata({
      ...base,
      capabilities: ['courses'],
      apiStability: 'unofficial',
      risk: 'unsupported',
      testedVersion: '3.2.1',
      testedVersions: ['3.3.x'],
    });
    expect(evaluateProductVersion(m, '3.2.1').state).toBe('healthy');
    expect(evaluateProductVersion(m, '3.3.7').known).toBe(true);
    const unknown = evaluateProductVersion(m, '4.0.0');
    expect(unknown).toMatchObject({ known: false, state: 'degraded' });
    expect(unknown.message).toContain('4.0.0');
  });
});

describe('createHttpClient', () => {
  const resp = (status: number, headers: Record<string, string> = {}) =>
    new Response(status === 204 ? null : '{"ok":true}', { status, headers });

  it('maps 401 to AuthRequiredError and sends a user agent + auth header', async () => {
    let seen: Headers | undefined;
    const http = createHttpClient({
      baseUrl: 'https://lms.example.ac.jp/api/',
      headers: () => ({ authorization: 'Bearer secret' }),
      fetch: async (_url, init) => {
        seen = new Headers(init?.headers);
        return resp(401);
      },
    });
    await expect(http.request('courses')).rejects.toBeInstanceOf(AuthRequiredError);
    expect(seen?.get('authorization')).toBe('Bearer secret');
    expect(seen?.get('user-agent')).toContain('UniContext');
  });

  it('drops injected credential headers when a redirect leaves the origin', async () => {
    const seen: { url: string; key: string | null; method: string | undefined }[] = [];
    const http = createHttpClient({
      headers: () => ({ 'x-api-key': 'k-secret' }),
      fetch: async (url, init) => {
        seen.push({
          url,
          key: new Headers(init?.headers).get('x-api-key'),
          method: init?.method,
        });
        if (url === 'https://api.example.ac.jp/a')
          return resp(302, { location: 'https://api.example.ac.jp/b' });
        if (url === 'https://api.example.ac.jp/b')
          return resp(303, { location: 'https://evil.example.com/c' });
        return resp(200);
      },
    });
    const res = await http.request('https://api.example.ac.jp/a', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(seen).toEqual([
      { url: 'https://api.example.ac.jp/a', key: 'k-secret', method: 'POST' },
      { url: 'https://api.example.ac.jp/b', key: 'k-secret', method: 'GET' },
      { url: 'https://evil.example.com/c', key: null, method: 'GET' },
    ]);
  });

  it('retries 429 using Retry-After, and 5xx with backoff', async () => {
    const clock = new ManualClock();
    const statuses = [429, 502, 200];
    const urls: string[] = [];
    const http = createHttpClient({
      clock,
      rateLimiter: new RateLimiter({ clock, capacity: 10, refillPerSecond: 10, random: () => 0 }),
      fetch: async (url) => {
        urls.push(url);
        return resp(statuses.shift() ?? 200, { 'retry-after': '2' });
      },
    });
    const p = http.json<{ ok: boolean }>('https://x.example/a');
    await clock.advance(5000);
    await expect(p).resolves.toEqual({ ok: true });
    expect(urls).toHaveLength(3);
  });

  it('maps network failures to OfflineError (after retries)', async () => {
    const clock = new ManualClock();
    const http = createHttpClient({
      clock,
      rateLimiter: new RateLimiter({ clock, maxRetries: 1, random: () => 0 }),
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const p = http.request('https://x.example/a');
    const assertion = expect(p).rejects.toBeInstanceOf(OfflineError);
    await clock.advance(10_000);
    await assertion;
  });

  it('surfaces RateLimitedError once retries are exhausted', async () => {
    const clock = new ManualClock();
    const http = createHttpClient({
      clock,
      rateLimiter: new RateLimiter({ clock, maxRetries: 0 }),
      fetch: async () => resp(429),
    });
    await expect(http.request('https://x.example/a')).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe('instantiateConnector', () => {
  it('validates config and builds adapter + normalizer', async () => {
    const { instantiateConnector, defineConnector, createFakeConnector } =
      await import('../src/index.js');
    const fake = createFakeConnector({ product: 'x', authority: 'lms' });
    const module = defineConnector({
      metadata: fake.metadata,
      configSchema: z.object({ baseUrl: z.string().url() }),
      createAdapter: () => fake.adapter,
      createNormalizer: () => fake.normalizer,
    });
    const secrets = {
      backend: 'memory',
      get: async () => undefined,
      set: async () => {},
      delete: async () => false,
    };
    expect(() => instantiateConnector(module, { sourceId: 'x', config: {}, secrets })).toThrow(
      /Invalid config/,
    );
    const inst = instantiateConnector(module, {
      sourceId: 'x',
      config: { baseUrl: 'https://lms.example.ac.jp' },
      secrets,
    });
    expect(inst.context.config.baseUrl).toBe('https://lms.example.ac.jp');
    expect(inst.adapter).toBe(fake.adapter);
  });
});
