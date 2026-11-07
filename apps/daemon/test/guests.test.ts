import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemorySecretStore } from '@unicontext/auth';
import { getView } from '@unicontext/context-engine';
import { ConfigSchema } from '@unicontext/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AI_KEY_SECRET, UniContextAi, type AnthropicClientFactory } from '../src/ai.js';
import { guestView } from '../src/remote/guest-view.js';
import { GuestStore } from '../src/remote/guests.js';
import { createRemoteServer, type RemoteServer } from '../src/remote/server.js';
import { RemoteStateStore } from '../src/remote/state.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

let dir: string;
let runtime: Runtime;
let now = new Date('2026-10-01T00:00:00.000Z');
const audit: Record<string, unknown>[] = [];

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'uc-guest-test-'));
  runtime = await createRuntime({ dev: true, dataDir: dir, noKeychain: true, logSink: () => {} });
});

afterAll(async () => {
  await runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GuestStore', () => {
  it('resolves a link until it is revoked or expires, and keeps only the hash', () => {
    const store = new GuestStore(path.join(dir, 'g1.json'), () => now);
    const { guest, token } = store.add({ name: '母', role: 'family' });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(store.read())).not.toContain(token);
    expect(store.resolve(token)?.id).toBe(guest.id);
    expect(store.resolve(`${token.slice(0, -1)}A`)).toBeUndefined();
    expect(store.revoke('母').map((g) => g.id)).toEqual([guest.id]);
    expect(store.resolve(token)).toBeUndefined();

    const short = store.add({ name: '友達', role: 'friend', ttlMs: 3600_000 });
    expect(store.resolve(short.token)).toBeDefined();
    now = new Date(now.getTime() + 2 * 3600_000);
    expect(store.resolve(short.token)).toBeUndefined();
  });
});

describe('guestView', () => {
  it('gives friends the timetable only and never citations or source ids', () => {
    const week = getView(runtime.uc.context, 'week', {});
    const friend = guestView(week, 'friend');
    expect(friend.deadlines).toBeUndefined();
    expect(friend.exams).toBeUndefined();
    const family = guestView(week, 'family', getView(runtime.uc.context, 'deadline', { days: 14 }));
    expect(Array.isArray(family.deadlines)).toBe(true);
    for (const v of [friend, family]) {
      const json = JSON.stringify(v);
      expect(json).not.toMatch(/citations|sourceReference|rawItem|sessionId|taskId/);
    }
    const kinds = week.days.flatMap((d) => d.classes.map((c) => c.sessionKind));
    const shown = friend.days.reduce((n, d) => n + d.classes.length, 0);
    expect(shown).toBe(kinds.filter((k) => k === 'class').length);
  });
});

describe('guest pages', () => {
  let server: RemoteServer;
  let store: GuestStore;
  const calls: unknown[] = [];

  beforeAll(async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(AI_KEY_SECRET, 'sk-ant-test');
    const fake: AnthropicClientFactory = () =>
      ({
        beta: {
          messages: {
            create: async (params: unknown) => {
              calls.push(params);
              return {
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: '<b>水曜は4限まで</b>' }],
              };
            },
          },
        },
      }) as unknown as ReturnType<AnthropicClientFactory>;
    store = new GuestStore(path.join(dir, 'g2.json'));
    const config = ConfigSchema.parse({
      remote: { enabled: true, publicUrl: 'https://uc.example.test' },
      ai: { guestQuestionsPerDay: 1 },
    });
    server = await createRemoteServer({
      runtime: { ...runtime, config },
      version: 'test',
      store: new RemoteStateStore(path.join(dir, 'oauth.json')),
      guests: store,
      ai: new UniContextAi(secrets, config.ai, fake),
      audit: (e) => void audit.push(e),
    });
    await server.app.ready();
  });

  const req = (method: 'GET' | 'POST', url: string, q?: string) =>
    server.app.inject({
      method,
      url,
      headers: {
        host: 'uc.example.test',
        'x-forwarded-proto': 'https',
        ...(q !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(q !== undefined ? { payload: new URLSearchParams({ q }).toString() } : {}),
    });

  it('shows the page for a live link and 404 for others', async () => {
    const { token } = store.add({ name: '母', role: 'family' });
    const res = await req('GET', `/g/${token}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('今週の時間割');
    expect(res.body).toContain('締切');
    expect(res.body).toContain(`action="/g/${token}/ask"`);
    expect((await req('GET', `/g/${'x'.repeat(43)}`)).statusCode).toBe(404);
    store.revoke('母');
    expect((await req('GET', `/g/${token}`)).statusCode).toBe(404);
    expect(audit.some((e) => e.event === 'guest_view' && e.ok === true)).toBe(true);
  });

  it('answers a question from the guest view only, escaped, within the daily limit', async () => {
    const { token } = store.add({ name: '友達', role: 'friend' });
    const res = await req('POST', `/g/${token}/ask`, '水曜は何時まで？');
    expect(res.body).toContain('&lt;b&gt;水曜は4限まで&lt;/b&gt;');
    const sent = JSON.stringify(calls.at(-1));
    expect(sent).toContain('水曜は何時まで？');
    expect(sent).not.toContain('"deadlines"');
    expect(sent).toContain('claude-opus-5-5');
    const again = await req('POST', `/g/${token}/ask`, 'もう一回');
    expect(again.body).toContain('今日はこれ以上質問できません');
    expect(calls).toHaveLength(1);
  });
});
