import { createFakeConnector } from '@unicontext/connector-sdk';
import { loadProfile, ManualClock, RateLimitedError } from '@unicontext/core';
import { openDatabase, type UniContextDatabase } from '@unicontext/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OnDemandRefusedError, SyncEngine, SyncScheduler } from '../src/index.js';

const MIN = 60_000;
let db: UniContextDatabase;
let clock: ManualClock;
let engine: SyncEngine;
const adapters = new Map<string, ReturnType<typeof createFakeConnector>['adapter']>();

function addSource(sourceId: string): void {
  const fake = createFakeConnector({ product: `fake-${sourceId}`, authority: 'lms' });
  adapters.set(sourceId, fake.adapter);
  engine.register({
    sourceId,
    adapter: fake.adapter,
    normalizer: fake.normalizer,
    metadata: fake.metadata,
  });
}

beforeEach(() => {
  db = openDatabase();
  clock = new ManualClock('2026-10-01T00:00:00Z');
  engine = new SyncEngine({ db, clock, profile: loadProfile('shizuoka-university') });
  adapters.clear();
  addSource('lms');
});
afterEach(() => db.close());

describe('SyncScheduler on-demand runs (refresh_sources, REST ?reason=on-demand)', () => {
  it('refuses a second forced run of one source within the interval, then allows it', async () => {
    const sched = new SyncScheduler(engine, { clock });
    clock.set('2026-10-01T03:00:00Z');
    await sched.trigger('lms', { reason: 'on-demand' });
    const calls = adapters.get('lms')?.syncCalls.length ?? 0;
    expect(calls).toBeGreaterThan(0);

    await clock.advance(3 * MIN);
    const err = await sched.trigger('lms', { reason: 'on-demand' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OnDemandRefusedError);
    // it is a RateLimitedError, so the REST layer answers 429
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as OnDemandRefusedError).reason).toBe('recently_forced');
    expect((err as OnDemandRefusedError).retryAfterMs).toBe(7 * MIN);
    expect((err as Error).message).toContain('(recently_forced)');
    expect(adapters.get('lms')?.syncCalls.length).toBe(calls);

    await clock.advance(8 * MIN);
    await sched.trigger('lms', { reason: 'on-demand' });
    expect(adapters.get('lms')?.syncCalls.length).toBeGreaterThan(calls);
  });

  it('does not limit unforced runs (CLI sync, change notifications)', async () => {
    const sched = new SyncScheduler(engine, { clock });
    for (let i = 0; i < 4; i++) await sched.trigger('lms');
    for (let i = 0; i < 4; i++) await sched.trigger('lms', { reason: 'manual' });
    expect(sched.checkOnDemand('lms').reason).toBe('recently_synced');
  });

  it('caps forced runs at 6 per hour over all sources', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) addSource(id);
    const sched = new SyncScheduler(engine, { clock });
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (const id of ids) {
      await sched.trigger(id, { reason: 'on-demand' });
      await clock.advance(MIN);
    }
    const err = await sched.trigger('g', { reason: 'on-demand' }).catch((e: unknown) => e);
    expect((err as OnDemandRefusedError).reason).toBe('hourly_cap');
    expect(adapters.get('g')?.syncCalls.length).toBe(0);
    // the first of the six leaves the window 60 minutes after it started
    expect((err as OnDemandRefusedError).retryAfterMs).toBe(54 * MIN);
    await clock.advance(55 * MIN);
    await sched.trigger('g', { reason: 'on-demand' });
    expect(adapters.get('g')?.syncCalls.length).toBeGreaterThan(0);
  });

  it('honours configured limits', async () => {
    addSource('x');
    addSource('y');
    const sched = new SyncScheduler(engine, {
      clock,
      onDemand: { minIntervalMs: MIN, maxPerHour: 1 },
    });
    await sched.trigger('x', { reason: 'on-demand' });
    await clock.advance(2 * MIN);
    expect(sched.checkOnDemand('x')).toMatchObject({ ok: false, reason: 'hourly_cap' });
    expect(sched.checkOnDemand('y')).toMatchObject({ ok: false, reason: 'hourly_cap' });
  });

  it('skips a source that needs a login, and one that is backing off', async () => {
    const sched = new SyncScheduler(engine, { clock });
    const at = clock.now().toISOString();
    engine.stores.health.set('lms', {
      state: 'auth_required',
      checkedAt: at,
      consecutiveFailures: 1,
    });
    expect(sched.checkOnDemand('lms')).toMatchObject({ ok: false, reason: 'auth_required' });
    const calls = adapters.get('lms')?.syncCalls.length ?? 0;
    await expect(sched.trigger('lms', { reason: 'on-demand' })).rejects.toMatchObject({
      reason: 'auth_required',
    });
    expect(adapters.get('lms')?.syncCalls.length).toBe(calls);

    engine.stores.health.set('lms', {
      state: 'rate_limited',
      checkedAt: at,
      retryAfter: new Date(clock.now().getTime() + 20 * MIN).toISOString(),
      consecutiveFailures: 1,
    });
    expect(sched.checkOnDemand('lms')).toMatchObject({
      ok: false,
      reason: 'backoff',
      retryAfterMs: 20 * MIN,
    });
    engine.stores.health.set('lms', { state: 'failed', checkedAt: at, consecutiveFailures: 3 });
    expect(sched.checkOnDemand('lms').reason).toBe('backoff');
  });

  it('skips a source read less than the interval ago, by the stored health', async () => {
    const sched = new SyncScheduler(engine, { clock });
    const now = clock.now().getTime();
    engine.stores.health.set('lms', {
      state: 'healthy',
      checkedAt: new Date(now).toISOString(),
      lastSuccessAt: new Date(now - 4 * MIN).toISOString(),
      consecutiveFailures: 0,
    });
    expect(sched.checkOnDemand('lms')).toMatchObject({
      ok: false,
      reason: 'recently_synced',
      retryAfterMs: 6 * MIN,
    });
    engine.stores.health.set('lms', {
      state: 'healthy',
      checkedAt: new Date(now).toISOString(),
      lastSuccessAt: new Date(now - 11 * MIN).toISOString(),
      consecutiveFailures: 0,
    });
    expect(sched.checkOnDemand('lms').ok).toBe(true);
    // the caller's own interval wins over the default
    expect(sched.checkOnDemand('lms', { minIntervalMs: 30 * MIN }).reason).toBe('recently_synced');
  });
});

describe('SyncScheduler.checkOnDemand: fresh, schedule floor and reference-only sources', () => {
  const setOk = (sourceId: string, minutesAgo: number): void => {
    const now = clock.now().getTime();
    engine.stores.health.set(sourceId, {
      state: 'healthy',
      checkedAt: new Date(now).toISOString(),
      lastSuccessAt: new Date(now - minutesAgo * MIN).toISOString(),
      consecutiveFailures: 0,
    });
  };

  it('refuses a source still within maxAgeMs as fresh, and allows it once older', () => {
    const sched = new SyncScheduler(engine, { clock });
    setOk('lms', 30);
    expect(sched.checkOnDemand('lms', { maxAgeMs: 45 * MIN })).toMatchObject({
      ok: false,
      reason: 'fresh',
      retryAfterMs: 15 * MIN,
    });
    setOk('lms', 50);
    expect(sched.checkOnDemand('lms', { maxAgeMs: 45 * MIN }).ok).toBe(true);
    // a source never read successfully is not fresh
    clock.set('2026-10-02T00:00:00Z');
    engine.stores.health.set('lms', {
      state: 'healthy',
      checkedAt: clock.now().toISOString(),
      consecutiveFailures: 0,
    });
    expect(sched.checkOnDemand('lms', { maxAgeMs: 45 * MIN }).ok).toBe(true);
  });

  it('with respectSchedule never reads before the source schedule interval has passed', () => {
    const sched = new SyncScheduler(engine, { clock, schedules: { lms: '1h' } });
    setOk('lms', 50);
    expect(sched.checkOnDemand('lms', { respectSchedule: true })).toMatchObject({
      ok: false,
      reason: 'recently_synced',
      retryAfterMs: 10 * MIN,
    });
    // without it only the 10-minute floor applies
    expect(sched.checkOnDemand('lms').ok).toBe(true);
    setOk('lms', 61);
    expect(sched.checkOnDemand('lms', { respectSchedule: true }).ok).toBe(true);
  });

  it('never forces a reference-only source', async () => {
    const fake = createFakeConnector({
      product: 'fake-syllabus',
      authority: 'syllabus',
      referenceOnly: true,
    });
    engine.register({
      sourceId: 'syllabus',
      adapter: fake.adapter,
      normalizer: fake.normalizer,
      metadata: fake.metadata,
    });
    const sched = new SyncScheduler(engine, { clock });
    expect(sched.checkOnDemand('syllabus')).toMatchObject({ ok: false, reason: 'reference_only' });
    const err = await sched.trigger('syllabus', { reason: 'on-demand' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OnDemandRefusedError);
    expect((err as OnDemandRefusedError).reason).toBe('reference_only');
    expect(fake.adapter.syncCalls.length).toBe(0);
    // a plain run (CLI sync, schedule) still works
    await sched.trigger('syllabus');
    expect(fake.adapter.syncCalls.length).toBeGreaterThan(0);
  });
});
