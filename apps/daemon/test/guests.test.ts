import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemorySecretStore } from '@unicontext/auth';
import { getView } from '@unicontext/context-engine';
import { ConfigSchema } from '@unicontext/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AI_KEY_SECRET,
  OPENAI_KEY_SECRET,
  UniContextAi,
  type AnthropicClientFactory,
} from '../src/ai.js';
import { guestPage, parseGuestTurns } from '../src/remote/guest-page.js';
import { guestView, type GuestView } from '../src/remote/guest-view.js';
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

describe('guest deadlines', () => {
  const at = '2026-10-15T00:00:00.000Z';
  const item = (o: Record<string, unknown>) => ({
    taskId: String(o.title),
    kind: 'assignment',
    course: { id: 'c', title: 'DB', courseCode: undefined, linkedIds: [] },
    status: 'pending',
    overdue: false,
    ...o,
  });
  const week = (deadlines: unknown[]) =>
    ({
      generatedAt: at,
      timezone: 'Asia/Tokyo',
      from: at,
      to: at,
      days: [],
      deadlines,
      exams: [],
    }) as never;

  it('hides past dates read from notices and never calls a past assignment 期限切れ', () => {
    const v = guestView(
      week([
        item({
          title: 'past notice',
          kind: 'extracted',
          dueAt: '2026-10-14T08:00:00.000Z',
          overdue: true,
        }),
        item({ title: 'past report', dueAt: '2026-10-14T08:00:00.000Z', overdue: true }),
        item({ title: 'old report', dueAt: '2026-10-01T08:00:00.000Z', overdue: true }),
        item({ title: 'handed in', dueAt: '2026-10-13T08:00:00.000Z', status: 'submitted' }),
        item({ title: 'x'.repeat(80), dueAt: '2026-10-20T08:00:00.000Z' }),
        item({ title: 'personal', course: undefined, dueAt: '2026-10-20T08:00:00.000Z' }),
      ]),
      'family',
    );
    expect(v.deadlines?.map((d) => [d.title.slice(0, 11), d.done, d.overdue])).toEqual([
      ['handed in', true, false],
      ['past report', false, true],
      ['xxxxxxxxxxx', false, false],
    ]);
    expect(v.deadlines?.[2]?.title).toHaveLength(60);
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
      now: () => new Date('2026-10-01T03:00:00.000Z'), // a Thursday: this week's timetable
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
    const asked = calls.at(-1) as { messages: { content: string }[] };
    expect(asked.messages[0]?.content).toContain('"nextWeek":true'); // the next week too: 「来週は？」
    const again = await req('POST', `/g/${token}/ask`, 'もう一回');
    expect(again.body).toContain('今日はこれ以上質問できません');
    expect(calls).toHaveLength(1);
  });
});

describe('guest answers', () => {
  const view = {
    role: 'family',
    nextWeek: false,
    generatedAt: '2026-10-01T00:00:00.000Z',
    timezone: 'Asia/Tokyo',
    today: '2026-10-01',
    from: '2026-09-27T15:00:00.000Z',
    to: '2026-10-04T15:00:00.000Z',
    days: [],
  } as unknown as GuestView;

  it('falls back to OpenAI when Claude fails, carrying the conversation', async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(AI_KEY_SECRET, 'sk-ant-test');
    await secrets.set(OPENAI_KEY_SECRET, 'sk-proj-test');
    const failing: AnthropicClientFactory = () =>
      ({
        beta: { messages: { create: async () => Promise.reject(new Error('credit balance')) } },
      }) as unknown as ReturnType<AnthropicClientFactory>;
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(
        JSON.stringify({
          output: [
            { type: 'reasoning', summary: [] },
            { type: 'message', content: [{ type: 'output_text', text: '詳しくはこうです' }] },
          ],
        }),
        { status: 200 },
      );
    };
    const ai = new UniContextAi(secrets, { provider: 'none' }, failing, fetchFn);
    expect(await ai.backends()).toEqual(['anthropic', 'openai']);
    const answer = await ai.answerGuest([{ ...view }], 'もっと詳しく', [
      { q: '水曜は？', a: '4限まで' },
    ]);
    expect(answer).toBe('詳しくはこうです');
    expect(sent[0]?.url).toBe('https://api.openai.com/v1/responses');
    expect(sent[0]?.body).toMatchObject({ model: 'gpt-6.1-sol', store: false });
    const input = sent[0]?.body.input as { role: string; content: string }[];
    expect(input.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(input[0]?.content).toContain('<data>');
    expect(input[0]?.content).toContain('質問: 水曜は？');
    expect(input[2]?.content).toBe('質問: もっと詳しく');

    const openaiFirst = new UniContextAi(secrets, { provider: 'openai' }, failing, fetchFn);
    expect(await openaiFirst.backends()).toEqual(['openai', 'anthropic']);
    const off = new UniContextAi(secrets, { provider: 'ollama' }, failing, fetchFn);
    expect(await off.available()).toBe(false);
  });

  it('carries earlier turns in the page and trusts nothing malformed coming back', () => {
    const page = guestPage({
      view: { ...view },
      guestName: '母',
      askUrl: '/g/x/ask',
      question: '次は？',
      answer: '金曜です',
      history: [{ q: '水曜は？', a: '4限まで' }],
    });
    expect(page).toContain('name="h"');
    const carried = /name="h" value="([^"]*)"/.exec(page)?.[1]?.replaceAll('&quot;', '"');
    expect(parseGuestTurns(carried)).toEqual([
      { q: '水曜は？', a: '4限まで' },
      { q: '次は？', a: '金曜です' },
    ]);
    expect(page.indexOf('水曜は？')).toBeLessThan(page.indexOf('次は？'));
    expect(parseGuestTurns('not json')).toEqual([]);
    expect(
      parseGuestTurns(
        JSON.stringify([
          { q: 1, a: 'x' },
          { q: 'ok', a: 'y' },
        ]),
      ),
    ).toEqual([{ q: 'ok', a: 'y' }]);
    const many = Array.from({ length: 9 }, (_, i) => ({ q: `q${i}`, a: 'a'.repeat(20_000) }));
    const kept = parseGuestTurns(JSON.stringify(many));
    expect(kept.map((t) => t.q)).toEqual(['q6', 'q7', 'q8']);
    expect(kept[0]?.a).toHaveLength(12_000);
  });
});
