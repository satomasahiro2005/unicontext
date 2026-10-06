import type { SyncCursor } from '@unicontext/connector-sdk';
import { describe, expect, it } from 'vitest';
import type { SessionMarker } from '../src/index.js';
import { loadState } from '../src/index.js';
import { FakeVpnClient, harness, NOW, testClock } from './helpers.js';

function spyMarker(at?: string): SessionMarker & { writes: (string | undefined)[]; value: string | undefined } {
  const m = {
    value: at,
    writes: [] as (string | undefined)[],
    read: () => m.value,
    write: (v: string | undefined) => {
      m.writes.push(v);
      m.value = v;
    },
  };
  return m;
}

const minutesAgo = (n: number): string => new Date(NOW.getTime() - n * 60_000).toISOString();
const cursorOf = (extra: unknown): SyncCursor => ({ extra: extra as Record<string, unknown> });

describe('a root that was never listed OK is retried, not left poisoned', () => {
  it('the exact live state (empty frontier, no folders, root backoff) lists the root next sync', async () => {
    const h = harness();
    const live = { frontier: [], folders: {}, backoff: { '': { failures: 1 } } };
    const r = await h.adapter.sync({
      mode: 'incremental',
      cursor: cursorOf({ version: 1, roots: { 'fs-share': live } }),
    });
    expect(h.client.listCalls[0]).toBe('');
    expect(r.items.some((i) => i.externalId === 'fs-share:')).toBe(true);
  });

  it('the state read from the student’s database on 2026-10-06 (12:17 sync wrote nothing) lists the root', async () => {
    // sync_state.extra_json of shizuoka-vpn-files, copied verbatim (updated_at 03:17:31Z): the
    // 12:17 "successful" sync ran code that waited 72 h to re-walk a root that was never listed.
    const live = JSON.parse(
      '{"version":1,"roots":{"fs-share":{"frontier":[],"folders":{},"backoff":{"":{"failures":1,"nextAttemptAt":"2026-10-06T02:37:01.653Z"}},"seededAt":"2026-10-06T02:34:56.306Z"}}}',
    ) as unknown;
    const h = harness({ clock: testClock(new Date('2026-10-06T03:17:31Z')) });
    const r = await h.adapter.sync({ mode: 'incremental', cursor: cursorOf(live) });
    expect(h.client.listCalls[0]).toBe('');
    expect(r.items.filter((i) => i.sourceType === 'szvpn.folder').length).toBeGreaterThan(0);
  });

  it('the same state with a seededAt inside the re-walk window is re-seeded too', async () => {
    const h = harness();
    const live = {
      frontier: [],
      folders: {},
      backoff: { '': { failures: 1, nextAttemptAt: minutesAgo(5) } },
      seededAt: minutesAgo(10),
    };
    await h.adapter.sync({ mode: 'incremental', cursor: cursorOf({ version: 1, roots: { 'fs-share': live } }) });
    expect(h.client.listCalls[0]).toBe('');
  });

  it('a backoff that still holds is respected, and capped at 30 minutes for a never-listed root', async () => {
    const h = harness();
    const state = {
      version: 1,
      migrated: 1,
      roots: {
        'fs-share': {
          frontier: [],
          folders: {},
          backoff: { '': { failures: 9, nextAttemptAt: new Date(NOW.getTime() + 6 * 3_600_000).toISOString() } },
          seededAt: minutesAgo(10),
        },
      },
    };
    await h.adapter.sync({ mode: 'incremental', cursor: cursorOf(state) });
    expect(h.client.listCalls).toEqual([]); // 30 min have not passed
    const after = new Date(NOW.getTime() + 31 * 60_000);
    const h2 = harness({ clock: testClock(after) });
    await h2.adapter.sync({ mode: 'incremental', cursor: cursorOf(state) });
    expect(h2.client.listCalls[0]).toBe('');
  });

  it('a failing root backs off for at most 30 minutes until it has been listed OK once', async () => {
    const client = new FakeVpnClient();
    client.script[''] = [
      { status: 'error', httpStatus: 404, message: 'x' },
      { status: 'error', httpStatus: 404, message: 'x' },
    ];
    const h = harness({ client, config: { walk: { retryBaseMs: 4_000_000 } } });
    const r = await h.adapter.sync({ mode: 'initial' });
    const state = loadState(r.cursor?.extra);
    const wait = new Date(state.roots['fs-share']?.backoff['']?.nextAttemptAt ?? 0).getTime() - NOW.getTime();
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(30 * 60_000);
  });

  it('one-time migration: a never-listed root loses the backoff a dead session gave it', () => {
    const state = loadState({
      version: 1,
      roots: {
        'fs-share': {
          frontier: [],
          folders: {},
          backoff: { '': { failures: 3, nextAttemptAt: new Date(NOW.getTime() + 6 * 3_600_000).toISOString() } },
          seededAt: minutesAgo(10),
        },
        listed: {
          frontier: [],
          folders: { '': { listedAt: minutesAgo(10), status: 'ok', fileIds: [], subfolders: [], childFileCount: 0 } },
          backoff: { sub: { failures: 1, nextAttemptAt: minutesAgo(-60) } },
          seededAt: minutesAgo(10),
        },
        locked: {
          frontier: [],
          folders: { '': { listedAt: minutesAgo(10), status: 'forbidden', fileIds: [], subfolders: [], childFileCount: 0 } },
          backoff: { '': { failures: 2, nextAttemptAt: minutesAgo(-20) } },
          seededAt: minutesAgo(10),
        },
      },
    });
    expect(state.roots['fs-share']?.backoff).toEqual({});
    expect(state.roots.listed?.backoff.sub).toBeDefined(); // listed OK before: untouched
    expect(state.roots.locked?.backoff['']).toBeDefined(); // a real 403 keeps its backoff
    expect(state.migrated).toBe(1);
    // Applied once: a later failure recorded after the migration survives a reload.
    state.roots['fs-share']!.backoff[''] = { failures: 1, nextAttemptAt: minutesAgo(-5) };
    expect(loadState(JSON.parse(JSON.stringify(state))).roots['fs-share']?.backoff['']).toBeDefined();
  });
});

describe('the session marker only moves when the portal proved the session', () => {
  it('a sync that makes no request does not write the marker', async () => {
    const marker = spyMarker();
    const h = harness({ sessionMarker: marker });
    const first = await h.adapter.sync({ mode: 'initial' });
    expect(marker.writes).toHaveLength(1);
    const listed = h.client.listCalls.length;
    // Everything is fresh: nothing to list.
    const second = await h.adapter.sync({ mode: 'incremental', ...(first.cursor ? { cursor: first.cursor } : {}) });
    expect(h.client.listCalls.length).toBe(listed);
    expect(second.items).toHaveLength(0);
    expect(marker.writes).toHaveLength(1);
  });

  it('a stale marker with zero requests asks the portal once; live renews, not live does not', async () => {
    for (const live of [true, false]) {
      const marker = spyMarker(minutesAgo(30));
      const client = new FakeVpnClient();
      let probes = 0;
      client.probeSession = () => {
        probes++;
        return Promise.resolve(live);
      };
      const h = harness({ sessionMarker: marker, client });
      const first = await h.adapter.sync({ mode: 'initial' });
      marker.writes.length = 0;
      marker.value = minutesAgo(30);
      probes = 0;
      await h.adapter.sync({ mode: 'incremental', ...(first.cursor ? { cursor: first.cursor } : {}) });
      expect(probes).toBe(1);
      expect(marker.writes).toEqual(live ? [NOW.toISOString()] : []);
    }
  });

  it('a fresh marker is not probed again', async () => {
    const marker = spyMarker();
    const client = new FakeVpnClient();
    let probes = 0;
    client.probeSession = () => {
      probes++;
      return Promise.resolve(true);
    };
    const h = harness({ sessionMarker: marker, client });
    const first = await h.adapter.sync({ mode: 'initial' });
    await h.adapter.sync({ mode: 'incremental', ...(first.cursor ? { cursor: first.cursor } : {}) });
    expect(probes).toBe(0);
  });

  it('a run whose only answers are transport errors proves nothing', async () => {
    const marker = spyMarker();
    const client = new FakeVpnClient();
    client.script[''] = [
      { status: 'error', httpStatus: 0, message: 'network' },
      { status: 'error', httpStatus: 0, message: 'network' },
    ];
    const h = harness({ sessionMarker: marker, client });
    await h.adapter.sync({ mode: 'initial' });
    expect(marker.writes).toEqual([]);
  });

  it('forbidden and empty answers do prove it', async () => {
    const marker = spyMarker();
    const client = new FakeVpnClient();
    client.script[''] = [
      { status: 'forbidden', httpStatus: 403, message: 'ファイル参照エラー' },
      { status: 'forbidden', httpStatus: 403, message: 'ファイル参照エラー' },
    ];
    const h = harness({ sessionMarker: marker, client });
    await h.adapter.sync({ mode: 'initial' });
    expect(marker.writes).toEqual([NOW.toISOString()]);
  });
});
