import type { HealthState } from '@unicontext/canonical-model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotificationService } from '../src/index.js';
import { createSeedHarness, memorySink, type SeedHarness } from './helpers.js';

let h: SeedHarness;
let sink: ReturnType<typeof memorySink>;
let svc: NotificationService;

function health(sourceId: string, state: HealthState, message?: string) {
  return {
    sourceId,
    previous: undefined,
    current: {
      sourceId,
      state,
      checkedAt: '2026-10-01T00:00:00.000Z',
      lastFailureAt: undefined,
      ...(message ? { message } : {}),
    },
  };
}

beforeEach(() => {
  h = createSeedHarness();
  sink = memorySink();
  svc = new NotificationService({ uc: h.uc, sinks: [sink], dedupeWindowMs: 6 * 3_600_000 });
  svc.start();
});
afterEach(async () => {
  svc.stop();
  await h.uc.close();
});

describe('health and sync failures', () => {
  it('auth_required health becomes auth_expired with the login hint', async () => {
    await h.uc.bus.emit('health', health('lms', 'auth_required'));
    expect(sink.sent).toHaveLength(1);
    const n = sink.sent[0];
    expect(n).toMatchObject({ kind: 'auth_expired', priority: 'high', sourceId: 'lms' });
    expect(n?.body).toContain('unicontext login lms');
  });

  it('sync:failed with auth_required does not duplicate the auth_expired notification', async () => {
    await h.uc.bus.emit('health', health('lms', 'auth_required'));
    await h.uc.bus.emit('sync:failed', { sourceId: 'lms', error: 'auth', health: 'auth_required' });
    expect(sink.sent.map((n) => n.kind)).toEqual(['auth_expired']);
  });

  it('suppresses repeats until the source recovers, then notifies again', async () => {
    await h.uc.bus.emit('health', health('lms', 'auth_required'));
    await h.uc.bus.emit('health', health('lms', 'auth_required'));
    expect(sink.sent).toHaveLength(1);
    await h.uc.bus.emit('health', health('lms', 'healthy'));
    await h.uc.bus.emit('health', health('lms', 'auth_required'));
    expect(sink.sent).toHaveLength(2);
  });

  it('repeats a still-failing notification only after the dedupe window', async () => {
    await h.uc.bus.emit('health', health('lms', 'auth_required'));
    await h.clock.advance(5 * 3_600_000);
    await h.uc.bus.emit('health', health('lms', 'auth_required'));
    expect(sink.sent).toHaveLength(1);
    await h.clock.advance(2 * 3_600_000);
    await h.uc.bus.emit('health', health('lms', 'auth_required'));
    expect(sink.sent).toHaveLength(2);
  });

  it('sync:failed is normal, escalates to high once when the source is failed, and is once per source', async () => {
    await h.uc.bus.emit('sync:failed', { sourceId: 'teams', error: 'timeout', health: 'offline' });
    await h.uc.bus.emit('sync:failed', { sourceId: 'teams', error: 'timeout', health: 'degraded' });
    expect(sink.sent.map((n) => [n.kind, n.priority])).toEqual([['sync_failure', 'normal']]);
    await h.uc.bus.emit('sync:failed', { sourceId: 'teams', error: 'x', health: 'failed' });
    await h.uc.bus.emit('health', health('teams', 'failed'));
    expect(sink.sent.map((n) => n.priority)).toEqual(['normal', 'high']);
    await h.uc.bus.emit('sync:failed', { sourceId: 'lms', error: 'x', health: 'offline' });
    expect(sink.sent).toHaveLength(3);
  });

  it('uses the registered source label and redacts secrets from error text', async () => {
    await h.uc.bus.emit('sync:failed', {
      sourceId: 'lms',
      error: 'request failed: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
      health: 'offline',
    });
    const n = sink.sent[0];
    expect(n?.body).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(n?.title).toContain('同期に失敗しました');
  });

  it('degraded, offline and rate_limited health states do not notify by themselves', async () => {
    for (const s of ['degraded', 'offline', 'rate_limited'] as const)
      await h.uc.bus.emit('health', health('lms', s));
    expect(sink.sent).toEqual([]);
  });

  it('schema drift is low priority, once per set of findings, and respects minPriority', async () => {
    const finding = {
      id: 'd1',
      sourceId: 'lms',
      sourceType: 'assignment',
      fieldPath: 'dueDate',
      driftKind: 'unknown' as const,
      firstSeenAt: '2026-10-01T00:00:00.000Z',
      lastSeenAt: '2026-10-01T00:00:00.000Z',
      occurrences: 1,
      sampleRawItemId: undefined,
      resolvedAt: undefined,
    };
    await h.uc.bus.emit('drift', { sourceId: 'lms', findings: [finding] });
    await h.uc.bus.emit('drift', { sourceId: 'lms', findings: [finding] });
    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]).toMatchObject({ kind: 'schema_drift', priority: 'low' });
    expect(sink.sent[0]?.body).toContain('dueDate');

    const quiet = memorySink();
    const filtered = new NotificationService({
      uc: h.uc,
      sinks: [quiet],
      minPriority: 'normal',
    });
    expect(await filtered.handleDrift({ sourceId: 'lms', findings: [finding] })).toEqual([]);
  });

  it('a throwing listener is contained: handlers never reject into the bus', async () => {
    const broken = new NotificationService({
      uc: { ...h.uc, sync: undefined as never },
      sinks: [sink],
    });
    broken.start();
    await expect(
      h.uc.bus.emit('sync:failed', { sourceId: 'x', error: 'e', health: 'offline' }),
    ).resolves.toBeUndefined();
    broken.stop();
  });
});
