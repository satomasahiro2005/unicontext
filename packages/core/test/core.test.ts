import { describe, expect, it } from 'vitest';
import {
  addZonedDays,
  assertAiOrigin,
  contentHash,
  createAiProvider,
  createMemoryLogger,
  dataPathsFromRoot,
  defaultConfig,
  endOfZonedDay,
  EventBus,
  formatShortJa,
  loadProfile,
  ManualClock,
  noneAiProvider,
  parseConfig,
  parseDuration,
  PolicyViolationError,
  redact,
  resolveDataPaths,
  stableUuid,
  startOfZonedDay,
  startOfZonedWeek,
  toZonedIso,
  zonedParts,
  zonedTime,
} from '../src/index.js';

describe('logger redaction (§60)', () => {
  it('redacts sensitive keys, bearer tokens, cookies, JWTs and student IDs', () => {
    const { logger, records } = createMemoryLogger();
    logger.info('request Authorization: Bearer abc.def.ghi', {
      headers: { Authorization: 'Bearer xyz', Cookie: 'ESTSAUTH=secret', accept: 'json' },
      password: 'hunter2',
      refresh_token: 'rt',
      studentId: '70312345',
      url: 'https://x/cb?code=SECRET&state=1',
      note: '学籍番号: 70312345 の課題',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
    });
    const r = records[0];
    const text = JSON.stringify(r);
    for (const secret of [
      'abc.def.ghi',
      'xyz',
      'ESTSAUTH',
      'hunter2',
      '"rt"',
      '70312345',
      'SECRET',
      'eyJhbGciOiJIUzI1NiJ9',
    ])
      expect(text).not.toContain(secret);
    expect(text).toContain('"accept":"json"');
    expect(text).toContain('state=1');
  });

  it('supports extra patterns from the university profile', () => {
    const out = redact({ msg: 'id 70312345 failed' }, { extraValuePatterns: [/\b\d{8}\b/g] });
    expect(out).toEqual({ msg: 'id [REDACTED] failed' });
  });

  it('respects levels and child fields', () => {
    const { logger, records } = createMemoryLogger('warn');
    logger.info('hidden');
    logger.child({ sourceId: 'lcu' }).warn('shown');
    expect(records.map((r) => [r.msg, r.sourceId])).toEqual([['shown', 'lcu']]);
  });
});

describe('Asia/Tokyo dates', () => {
  it('converts wall-clock times and day boundaries', () => {
    const t = zonedTime({ year: 2026, month: 10, day: 15, hour: 23, minute: 59 });
    expect(t.toISOString()).toBe('2026-10-15T14:59:00.000Z');
    expect(toZonedIso(t)).toBe('2026-10-15T23:59:00+09:00');
    const midnightUtc = new Date('2026-09-30T15:30:00Z'); // 2026-10-01 00:30 JST
    expect(startOfZonedDay(midnightUtc).toISOString()).toBe('2026-09-30T15:00:00.000Z');
    expect(endOfZonedDay(midnightUtc).toISOString()).toBe('2026-10-01T14:59:59.999Z');
    expect(zonedParts(midnightUtc).weekday).toBe(4); // Thursday
    expect(startOfZonedWeek(midnightUtc).toISOString()).toBe('2026-09-27T15:00:00.000Z'); // Mon 9/28 JST
    expect(addZonedDays(midnightUtc, 31).toISOString()).toBe('2026-10-31T15:30:00.000Z');
    expect(formatShortJa(new Date('2026-10-01T00:42:00Z'))).toBe('10/1 09:42');
  });
});

describe('config (§53) and paths (§52)', () => {
  it('parses the spec example and expands ~', () => {
    const cfg = parseConfig(
      `profile: shizuoka-university
sources:
  microsoft365: { enabled: true }
  livecampusu: { enabled: true }
  edstem: { adapter: mcp }
  files: { roots: [~/University] }
sync: { background: true }
`,
      { home: '/home/s' },
    );
    expect(cfg.profile).toBe('shizuoka-university');
    expect(cfg.sources.edstem?.adapter).toBe('mcp');
    expect(cfg.sources.edstem?.enabled).toBe(true);
    expect(cfg.sources.files?.roots?.[0]?.replace(/\\/g, '/')).toBe('/home/s/University');
    expect(cfg.ai.provider).toBe('none');
    expect(cfg.telemetry.enabled).toBe(false);
  });

  it('rejects inline secrets', () => {
    expect(() => parseConfig('sources:\n  lcu: { password: hunter2 }\n')).toThrow(/keychain/);
    expect(() =>
      parseConfig('ai: { provider: openai, apiKeyRef: openai/api_key, model: gpt }\n'),
    ).not.toThrow();
  });

  it('defaults to safe values', () => {
    expect(defaultConfig()).toMatchObject({
      sync: { background: true },
      ai: { provider: 'none' },
      embeddings: { provider: 'none' },
    });
  });

  it('resolves platform data dirs', () => {
    expect(resolveDataPaths({ platform: 'linux', env: {}, homedir: '/home/s' }).database).toBe(
      '/home/s/.local/share/unicontext/unicontext.db',
    );
    expect(
      resolveDataPaths({ platform: 'linux', env: { XDG_DATA_HOME: '/x' }, homedir: '/home/s' })
        .root,
    ).toBe('/x/unicontext');
    expect(resolveDataPaths({ platform: 'linux', env: {}, homedir: '/home/s' }).configFile).toBe(
      '/home/s/.config/unicontext/config.yaml',
    );
    expect(resolveDataPaths({ platform: 'darwin', env: {}, homedir: '/Users/s' }).root).toBe(
      '/Users/s/Library/Application Support/unicontext',
    );
    expect(
      resolveDataPaths({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\s\\AppData\\Local' },
        homedir: 'C:\\Users\\s',
      }).database,
    ).toBe('C:\\Users\\s\\AppData\\Local\\unicontext\\unicontext.db');
    expect(
      resolveDataPaths({ platform: 'linux', env: { UNICONTEXT_DATA_DIR: '/data' }, homedir: '/h' })
        .blobs,
    ).toBe('/data/blobs');
    expect(dataPathsFromRoot('/r', '/r', 'linux').logs).toBe('/r/logs');
  });
});

describe('profile (§54)', () => {
  it('loads the Shizuoka University profile', () => {
    const p = loadProfile('shizuoka-university');
    expect(p.academicCalendar.timezone).toBe('Asia/Tokyo');
    expect(p.sources.academic?.product).toBe('livecampusu');
    expect(p.academicCalendar.periods).toHaveLength(7);
  });
  it('rejects unknown or unsafe profile ids', () => {
    expect(() => loadProfile('nope-university')).toThrow(/not found/);
    expect(() => loadProfile('../etc')).toThrow(/Invalid/);
  });
});

describe('AI policy (§47, §48)', () => {
  it('only allows extracted/inferred origins for AI output', () => {
    expect(() => assertAiOrigin('extracted')).not.toThrow();
    expect(() => assertAiOrigin('authoritative')).toThrow(PolicyViolationError);
    expect(() => assertAiOrigin('user')).toThrow(PolicyViolationError);
  });

  it('defaults to the none provider, which is unavailable', async () => {
    expect(createAiProvider({ provider: 'none' })).toBe(noneAiProvider);
    await expect(
      noneAiProvider.complete({ task: 'deadline_extraction', instructions: '', input: '' }),
    ).rejects.toThrow(/No AI provider/);
  });

  it('calls a provider over HTTP and refuses tasks outside §47', async () => {
    const p = createAiProvider({
      provider: 'ollama',
      model: 'llama',
      fetch: async () =>
        new Response(JSON.stringify({ message: { content: '10/15' } }), { status: 200 }),
    });
    await expect(
      p.complete({ task: 'deadline_extraction', instructions: 'x', input: 'y' }),
    ).resolves.toMatchObject({ text: '10/15', provider: 'ollama' });
    await expect(
      p.complete({ task: 'write_essay' as never, instructions: 'x', input: 'y' }),
    ).rejects.toBeInstanceOf(PolicyViolationError);
  });
});

describe('misc', () => {
  it('hashes stably and builds deterministic UUIDs', () => {
    expect(contentHash({ a: 1, b: [1, { c: 2, d: undefined }] })).toBe(
      contentHash({ b: [1, { c: 2 }], a: 1 }),
    );
    expect(stableUuid('a', 'b')).toBe(stableUuid('a', 'b'));
    expect(stableUuid('a', 'b')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('parses durations', () => {
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(() => parseDuration('soon')).toThrow();
  });

  it('isolates event listener failures', async () => {
    const errors: unknown[] = [];
    const bus = new EventBus<{ x: number }>((e) => errors.push(e));
    const got: number[] = [];
    bus.on('x', () => {
      throw new Error('boom');
    });
    bus.on('x', (n) => {
      got.push(n);
    });
    await bus.emit('x', 1);
    expect(got).toEqual([1]);
    expect(errors).toHaveLength(1);
  });

  it('ManualClock fires timers in order', async () => {
    const c = new ManualClock();
    const order: string[] = [];
    c.setTimeout(() => order.push('b'), 200);
    c.setTimeout(() => order.push('a'), 100);
    await c.advance(150);
    expect(order).toEqual(['a']);
    await c.advance(100);
    expect(order).toEqual(['a', 'b']);
  });
});
