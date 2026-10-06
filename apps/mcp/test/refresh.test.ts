import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { UniContext } from '@unicontext/context-engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMcpServer,
  ProposalStore,
  type RefreshResult,
  SERVER_INSTRUCTIONS,
  type SyncStarter,
} from '../src/index.js';
import { createSeeded, type Seeded } from './seeded.js';

const MIN = 60_000;
interface Envelope {
  data: Record<string, unknown>;
  answerHint: string;
}

let seeded: Seeded;
let tmp: string;
const closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  seeded = await createSeeded();
  tmp = mkdtempSync(path.join(tmpdir(), 'uc-refresh-'));
});
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await seeded.uc.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function connect(
  uc: UniContext,
  options: { startSync?: SyncStarter; surface?: 'local' | 'remote' } = {},
): Promise<Client> {
  const server = createMcpServer({
    uc,
    proposals: new ProposalStore(path.join(tmp, 'p'), { clock: uc.clock }),
    ...(options.startSync ? { startSync: options.startSync } : {}),
    ...(options.surface ? { surface: options.surface } : {}),
  });
  const client = new Client({ name: 't', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { text: string }[])[0]?.text ?? '';
  expect(res.isError, text).not.toBe(true);
  return JSON.parse(text) as Envelope;
}

const refresh = async (client: Client, args: Record<string, unknown>): Promise<RefreshResult> =>
  (await call(client, 'refresh_sources', args)).data as unknown as RefreshResult;

/** The seed was last read at 2026-10-01T00:00Z; "now" is moved `minutes` after that. */
const nowAt = (minutes: number): void =>
  seeded.clock.set(new Date(Date.UTC(2026, 9, 1, 0, minutes)).toISOString());
const syncCalls = (sourceId: string): number =>
  (seeded.uc.sync.getSource(sourceId).adapter as unknown as { syncCalls: unknown[] }).syncCalls
    .length;

describe('answerHint when a view is older than its use allows', () => {
  it('get_today points to refresh_sources when the information is old', async () => {
    const client = await connect(seeded.uc);
    nowAt(120);
    const env = await call(client, 'get_today');
    expect(env.answerHint).toContain('は 120分前の情報です。refresh_sources で更新できます');
    const freshness = env.data.freshness as { perUse: { schedule: { staleSources: unknown[] } } };
    expect(freshness.perUse.schedule.staleSources.length).toBeGreaterThan(0);
  });

  it('says nothing about refreshing while every source is within its budget', async () => {
    const client = await connect(seeded.uc);
    nowAt(30);
    const env = await call(client, 'get_today');
    expect(env.answerHint).not.toContain('refresh_sources');
    expect(
      (env.data.freshness as { perUse: { schedule: { fresh: boolean } } }).perUse.schedule.fresh,
    ).toBe(true);
  });

  it('get_course carries capabilityCoverage per kind of information', async () => {
    const client = await connect(seeded.uc);
    const env = await call(client, 'get_course', { courseOfferingId: 'データベース' });
    const cc = env.data.capabilityCoverage as Record<
      string,
      { complete: boolean; sources: { sourceId: string; lastSuccessAt?: string }[] }
    >;
    expect(Object.keys(cc).sort()).toEqual(
      [
        'announcements',
        'assignments',
        'attendance',
        'calendar',
        'grades',
        'materials',
        'messages',
      ].sort(),
    );
    expect(cc.assignments?.sources.map((s) => s.sourceId)).toContain('lms');
    expect(cc.assignments?.sources[0]?.lastSuccessAt).toBeDefined();
  });

  it('the server instructions tell the AI to refresh by itself', () => {
    expect(SERVER_INSTRUCTIONS).toContain('refresh_sources');
  });
});

describe('refresh_sources', () => {
  it('is a read-only tool, on the remote surface too', async () => {
    for (const surface of ['local', 'remote'] as const) {
      const client = await connect(seeded.uc, { surface });
      const tool = (await client.listTools()).tools.find((t) => t.name === 'refresh_sources');
      expect(tool?.annotations, surface).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
    }
  });

  it('reads the sources, and skips the second call within 10 minutes with a reason', async () => {
    const client = await connect(seeded.uc);
    nowAt(120);
    const before = syncCalls('lms');
    const first = await refresh(client, { sources: ['lms'], wait: true });
    expect(first.started).toHaveLength(1);
    expect(first.started[0]?.sourceId).toBe('lms');
    expect(first.started[0]?.jobId).toContain('lms');
    expect(first.skipped).toEqual([]);
    expect(first.freshnessBefore[0]).toMatchObject({
      sourceId: 'lms',
      ageMinutes: 120,
      freshness: 'aging',
    });
    expect(first.finished).toEqual([{ sourceId: 'lms', ok: true }]);
    expect(first.freshnessAfter?.[0]).toMatchObject({ sourceId: 'lms', ageMinutes: 0 });
    const afterFirst = syncCalls('lms');
    expect(afterFirst).toBeGreaterThan(before);

    await seeded.clock.advance(3 * MIN);
    const second = await refresh(client, { sources: ['lms'], wait: true });
    expect(second.started).toEqual([]);
    expect(second.skipped).toMatchObject([
      { sourceId: 'lms', reason: 'recently_forced', retryAfterMinutes: 7 },
    ]);
    expect(second.skipped[0]?.detail).toContain('10分に1回');
    expect(syncCalls('lms')).toBe(afterFirst);

    // a source read by the schedule a few minutes ago is not read again either
    await seeded.clock.advance(30 * MIN);
    await seeded.uc.sync.sync('teams');
    const recent = await refresh(client, { sources: ['teams'] });
    expect(recent.skipped).toMatchObject([{ sourceId: 'teams', reason: 'recently_synced' }]);
  });

  it('skips a source that needs a login, with the reason, and starts nothing', async () => {
    const client = await connect(seeded.uc);
    nowAt(120);
    seeded.uc.sync.stores.health.set('teams', {
      state: 'auth_required',
      checkedAt: seeded.uc.clock.now().toISOString(),
      consecutiveFailures: 2,
    });
    const before = syncCalls('teams');
    const env = await call(client, 'refresh_sources', { sources: ['teams'], wait: true });
    const r = env.data as unknown as RefreshResult;
    expect(r.started).toEqual([]);
    expect(r.skipped).toMatchObject([{ sourceId: 'teams', reason: 'auth_required' }]);
    expect(syncCalls('teams')).toBe(before);
    expect(env.answerHint).toContain('要ログイン');
  });

  it('maps a course and capabilities to the sources that serve them', async () => {
    const client = await connect(seeded.uc);
    nowAt(120);
    const r = await refresh(client, {
      course: 'データベース',
      capabilities: ['deadlines'],
      wait: true,
    });
    const ids = r.freshnessBefore.map((s) => s.sourceId);
    expect(ids).toContain('lms');
    expect(ids).not.toContain('teams'); // reads posts, not assignments
    expect(ids).not.toContain('record');
    for (const s of r.freshnessBefore) expect(s.uses).toContain('deadlines');
    expect(r.started.map((s) => s.sourceId).sort()).toEqual([...ids].sort());
    // sources the student does not use for the course are not read
    const none = await refresh(client, { course: 'データベース', capabilities: ['grades'] });
    expect(none).toMatchObject({ started: [], skipped: [], freshnessBefore: [] });
  });

  it('names an unknown source instead of ignoring it', async () => {
    const client = await connect(seeded.uc);
    const r = await refresh(client, { sources: ['nope'] });
    expect(r.started).toEqual([]);
    expect(r.skipped).toMatchObject([{ sourceId: 'nope', reason: 'unknown_source' }]);
  });

  it('routes the run through the daemon starter when one is given, and reports its 429', async () => {
    const asked: string[] = [];
    const startSync: SyncStarter = async (sourceId) => {
      asked.push(sourceId);
      if (sourceId === 'lms')
        throw Object.assign(
          new Error('on-demand sync refused (hourly_cap): 強制更新は全体で1時間に6回までです'),
          { code: 'rate_limited', retryAfterMs: 25 * MIN },
        );
      return { jobId: `${sourceId}-job1`, finished: async () => ({ ok: true }) };
    };
    const client = await connect(seeded.uc, { startSync });
    nowAt(120);
    const r = await refresh(client, { sources: ['lms', 'lcu'], wait: true });
    expect(asked.sort()).toEqual(['lcu', 'lms']);
    expect(r.started).toEqual([{ sourceId: 'lcu', jobId: 'lcu-job1' }]);
    expect(r.skipped).toMatchObject([
      { sourceId: 'lms', reason: 'hourly_cap', retryAfterMinutes: 25 },
    ]);
    expect(r.skipped[0]?.detail).toContain('1時間に6回');
    expect(r.finished).toEqual([{ sourceId: 'lcu', ok: true }]);
  });

  it('without wait it returns at once, even while the run goes on', async () => {
    const startSync: SyncStarter = async (sourceId) => ({
      jobId: `${sourceId}-job`,
      finished: () => new Promise(() => undefined),
    });
    const client = await connect(seeded.uc, { startSync });
    nowAt(120);
    // wait=false returns at once with only the start
    const r = await refresh(client, { sources: ['lms'] });
    expect(r.started).toHaveLength(1);
    expect(r.finished).toBeUndefined();
  });
});
