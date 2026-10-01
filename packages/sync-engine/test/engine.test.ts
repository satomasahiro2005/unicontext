import { type ChangeEvent, stableId } from '@unicontext/canonical-model';
import { AuthRequiredError, loadProfile, ManualClock } from '@unicontext/core';
import {
  createFakeConnector,
  type FakeConnector,
  type Normalizer,
} from '@unicontext/connector-sdk';
import { openDatabase, purgeSource, type UniContextDatabase } from '@unicontext/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type HealthChangedEvent, SyncEngine, SyncScheduler } from '../src/index.js';

let db: UniContextDatabase;
let clock: ManualClock;
let engine: SyncEngine;
let fake: FakeConnector;
const profile = loadProfile('shizuoka-university');
const id = <K extends Parameters<typeof stableId>[0]>(kind: K, ...parts: string[]) =>
  stableId(kind, 'lms', ...parts);

function dataset() {
  return {
    courses: [
      {
        id: 'c1',
        code: 'DB101',
        title: 'データベースシステム論',
        year: 2026,
        term: '後期',
        teacher: '山田太郎',
        schedule: [{ day: 4, period: 2, room: '21教室' }],
      },
    ],
    sessions: [{ id: 's1', courseId: 'c1', date: '2026-10-01', period: 2, room: '21教室' }],
    assignments: [
      {
        id: 'a1',
        courseId: 'c1',
        title: '課題1',
        due: '2026-10-08T23:59:00+09:00',
        updatedAt: '2026-09-25T00:00:00Z',
      },
      {
        id: 'a2',
        courseId: 'c1',
        title: '課題2',
        due: '2026-10-15T23:59:00+09:00',
        updatedAt: '2026-09-25T00:00:00Z',
      },
    ],
    documents: [
      { id: 'd1', courseId: 'c1', title: 'Lecture 3.pdf', text: '第1節\n\n第2節 正規化' },
    ],
  };
}

beforeEach(() => {
  db = openDatabase();
  clock = new ManualClock('2026-10-01T00:00:00Z');
  fake = createFakeConnector({
    product: 'fake-lms',
    sourceLabel: 'LMS',
    authority: 'submission-system',
    pageSize: 3,
    dataset: dataset(),
  });
  engine = new SyncEngine({ db, clock, profile });
  engine.register({
    sourceId: 'lms',
    adapter: fake.adapter,
    normalizer: fake.normalizer,
    metadata: fake.metadata,
  });
});
afterEach(() => db.close());

describe('SyncEngine', () => {
  it('ingests raw first, normalizes with provenance, paginates (§6, §10)', async () => {
    const r = await engine.sync('lms');
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('initial');
    expect(r.pages).toBe(2);
    expect(r.raw.inserted).toBe(5);
    expect(engine.stores.raw.list({ sourceId: 'lms' })).toHaveLength(5);
    const session = engine.stores.entities.getOfKind('classSession', id('classSession', 's1'));
    expect(session?.startsAt).toBe('2026-10-01T01:20:00.000Z'); // 2限 10:20 JST from the profile
    const refs = engine.stores.sourceRefs.forEntity(id('assignment', 'a1'));
    expect(refs[0]).toMatchObject({
      sourceSystem: 'fake-lms',
      sourceLabel: 'LMS',
      authority: 'submission-system',
      sourceItemId: 'a1',
    });
    expect(refs[0]?.rawItemId).toMatch(/^raw:/);
    const due = engine.facts.active({
      subjects: [id('assignment', 'a1')],
      predicate: 'assignment_due',
    });
    expect(due.map((f) => f.value)).toEqual(['2026-10-08T23:59:00+09:00']);
    // initial import is not reported as "changes"
    expect(engine.stores.changes.list()).toHaveLength(0);
    expect(engine.health('lms')?.state).toBe('healthy');
  });

  it('emits ChangeEvents with before/after for a changed deadline (§13, §45)', async () => {
    await engine.sync('lms');
    const seen: ChangeEvent[] = [];
    engine.bus.on('change', (e) => {
      seen.push(e);
    });
    fake.adapter.dataset.assignments = [
      {
        id: 'a1',
        courseId: 'c1',
        title: '課題1',
        due: '2026-10-10T23:59:00+09:00',
        updatedAt: '2026-10-01T00:00:00Z',
      },
      {
        id: 'a2',
        courseId: 'c1',
        title: '課題2',
        due: '2026-10-15T23:59:00+09:00',
        updatedAt: '2026-09-25T00:00:00Z',
      },
    ];
    clock.set('2026-10-01T10:00:00Z');
    const r = await engine.sync('lms');
    expect(r.mode).toBe('incremental');
    expect(r.raw.updated).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: 'updated',
      changedFields: ['dueAt'],
      before: { dueAt: '2026-10-08T23:59:00+09:00' },
      after: { dueAt: '2026-10-10T23:59:00+09:00' },
    });
    expect(seen[0]?.summary).toBe('課題「課題1」の締切: 10/8 23:59 → 10/10 23:59');
    const history = engine.facts.history(id('assignment', 'a1'), 'assignment_due');
    expect(history.map((f) => [f.value, f.retractedAt !== undefined])).toEqual([
      ['2026-10-08T23:59:00+09:00', true],
      ['2026-10-10T23:59:00+09:00', false],
    ]);
  });

  it('detects deletions on full refresh and incremental delete feeds', async () => {
    await engine.sync('lms');
    fake.adapter.dataset.assignments = dataset().assignments.slice(0, 1);
    const full = await engine.sync('lms', { mode: 'full' });
    expect(full.raw.deleted).toBe(1);
    expect(engine.stores.entities.get(id('assignment', 'a2'))).toBeUndefined();
    expect(engine.facts.active({ subjects: [id('assignment', 'a2')] })).toHaveLength(0);
    expect(engine.stores.changes.list({ types: ['deleted'] }).map((e) => e.entityId)).toEqual([
      id('assignment', 'a2'),
    ]);

    fake.adapter.dataset.deleted = [{ type: 'fake.course', id: 'c1' }];
    const inc = await engine.sync('lms', { mode: 'incremental' });
    expect(inc.raw.deleted).toBe(1);
    expect(engine.stores.entities.get(id('courseOffering', 'c1'))).toBeUndefined();
  });

  it('reprocesses from raw without refetching (§6)', async () => {
    await engine.sync('lms');
    const calls = fake.adapter.syncCalls.length;
    const patched: Normalizer = {
      ...fake.normalizer,
      version: '2',
      normalize: async (item, ctx) => {
        const out = await fake.normalizer.normalize(item, ctx);
        return {
          ...out,
          entities: out.entities.map((e) =>
            e.entity.kind === 'assignment'
              ? { ...e, entity: { ...e.entity, title: `${e.entity.title} (fixed)` } }
              : e,
          ),
        };
      },
    };
    engine.register({
      sourceId: 'lms',
      adapter: fake.adapter,
      normalizer: patched,
      metadata: fake.metadata,
    });
    const r = await engine.reprocess('lms');
    expect(fake.adapter.syncCalls.length).toBe(calls);
    expect(r.entities.updated).toBe(2);
    expect(engine.stores.entities.getOfKind('assignment', id('assignment', 'a1'))?.title).toBe(
      '課題1 (fixed)',
    );
  });

  it('skips unchanged raw items on the next run', async () => {
    await engine.sync('lms');
    const r = await engine.sync('lms', { mode: 'full' });
    expect(r.raw.unchanged).toBe(5);
    expect(r.normalized.items).toBe(0);
  });

  it('tracks health transitions (§38)', async () => {
    const health: HealthChangedEvent[] = [];
    engine.bus.on('health', (h) => {
      health.push(h);
    });
    fake.adapter.failNext = new AuthRequiredError('token expired');
    expect((await engine.sync('lms')).health).toBe('auth_required');
    for (let i = 0; i < 3; i++) {
      fake.adapter.failNext = new Error('500');
      await engine.sync('lms');
    }
    expect(engine.health('lms')).toMatchObject({ state: 'failed', consecutiveFailures: 4 });
    await engine.sync('lms');
    expect(engine.health('lms')).toMatchObject({ state: 'healthy', consecutiveFailures: 0 });
    expect(health.map((h) => h.current.state)).toEqual([
      'auth_required',
      'degraded',
      'failed',
      'healthy',
    ]);
  });

  it('marks untested product versions and missing fields as degraded (§72, §73)', async () => {
    const v = createFakeConnector({
      product: 'lcu',
      authority: 'academic-system',
      apiStability: 'unofficial',
      testedVersion: '3.1',
      productVersion: '4.0',
      dataset: { courses: [{ id: 'c1', title: 'x', unexpected: true } as never] },
    });
    engine.register({
      sourceId: 'lcu',
      adapter: v.adapter,
      normalizer: v.normalizer,
      metadata: v.metadata,
    });
    await engine.sync('lcu');
    expect(engine.health('lcu')).toMatchObject({ state: 'degraded', detectedVersion: '4.0' });
    expect(engine.stores.versions.latest('lcu')).toMatchObject({ version: '4.0', known: false });
    expect(
      engine.stores.drift.list({ sourceId: 'lcu' }).map((d) => [d.fieldPath, d.driftKind]),
    ).toEqual([['unexpected', 'unknown']]);
  });

  it('accepts pushed raw items (watchers/importers) via ingest()', async () => {
    await engine.sync('lms');
    const { normalized } = await engine.ingest('lms', {
      items: [
        {
          sourceType: 'fake.announcement',
          externalId: 'n9',
          payload: { id: 'n9', courseId: 'c1', title: '休講', body: '10/8は休講' },
        },
      ],
    });
    expect(normalized.entities.created).toBe(1);
    expect(engine.stores.changes.list({ types: ['created'] })).toHaveLength(1);
  });

  it('does not let a full refresh delete an item a watcher ingested during the run', async () => {
    const original = fake.adapter.sync.bind(fake.adapter);
    let pushed: Promise<unknown> | undefined;
    fake.adapter.sync = async (input) => {
      const result = await original(input);
      // A file event arrives while the multi-page full listing is still in flight.
      pushed ??= engine.ingest('lms', {
        items: [
          {
            sourceType: 'fake.announcement',
            externalId: 'n-pushed',
            payload: { id: 'n-pushed', courseId: 'c1', title: '休講', body: '10/8は休講' },
          },
        ],
      });
      return result;
    };
    const report = await engine.sync('lms', { mode: 'full' });
    await pushed;
    expect(report.ok).toBe(true);
    expect(report.raw.deleted).toBe(0);
    const item = engine.stores.raw.find('lms', 'fake.announcement', 'n-pushed');
    expect(item?.deletedAt).toBeUndefined();
    expect(engine.stores.entities.get(id('announcement', 'n-pushed'))).toBeDefined();
  });

  it('keeps syncing a source purged by another process (§63)', async () => {
    expect((await engine.sync('lms')).ok).toBe(true);
    purgeSource(db, 'lms'); // e.g. `unicontext purge source lms` while the daemon runs
    const r = await engine.sync('lms');
    expect(r.ok).toBe(true);
    expect(engine.stores.raw.countBySource('lms').live).toBeGreaterThan(0);
  });

  it('never stores or broadcasts secrets from adapter errors (§59)', async () => {
    const failed: string[] = [];
    engine.bus.on('sync:failed', (e) => void failed.push(e.error));
    fake.adapter.failNext = new Error(
      'GET https://api.example/x?access_token=SECRET123 failed: Authorization: Bearer SECRET456',
    );
    const r = await engine.sync('lms');
    expect(r.ok).toBe(false);
    const stored = JSON.stringify([engine.health('lms'), r.error, failed]);
    expect(stored).not.toContain('SECRET123');
    expect(stored).not.toContain('SECRET456');
    expect(engine.health('lms')?.message).toContain('access_token=');
  });

  it('runs post-processors with the changed entity ids', async () => {
    const seen: string[][] = [];
    engine.addPostProcessor({
      name: 'spy',
      run: ({ changedEntityIds }) => void seen.push(changedEntityIds),
    });
    await engine.sync('lms');
    expect(seen[0]?.length).toBeGreaterThan(5);
  });
});

describe('SyncScheduler (§36)', () => {
  it('runs per-source intervals, skips push/event sources and backs off', async () => {
    const files = createFakeConnector({ product: 'files', authority: 'local-file' });
    engine.register({
      sourceId: 'files',
      adapter: files.adapter,
      normalizer: files.normalizer,
      metadata: files.metadata,
    });
    const sched = new SyncScheduler(engine, {
      clock,
      schedules: { lms: '15m', files: 'event' },
      jitterRatio: 0,
    });
    sched.start();
    await clock.advance(0);
    expect(fake.adapter.syncCalls).toHaveLength(2); // two pages
    expect(files.adapter.syncCalls).toHaveLength(0);
    await clock.advance(15 * 60_000);
    expect(fake.adapter.syncCalls).toHaveLength(3);
    fake.adapter.failNext = new Error('boom');
    await clock.advance(15 * 60_000);
    expect(engine.health('lms')?.consecutiveFailures).toBe(1);
    await clock.advance(15 * 60_000);
    expect(fake.adapter.syncCalls).toHaveLength(4); // backed off to 30m
    await clock.advance(15 * 60_000);
    expect(fake.adapter.syncCalls).toHaveLength(5);
    await sched.trigger('files');
    expect(files.adapter.syncCalls).toHaveLength(1);
    expect(sched.status().find((s) => s.sourceId === 'files')?.intervalMs).toBeUndefined();
    sched.stop();
    await clock.advance(60 * 60_000);
    expect(fake.adapter.syncCalls).toHaveLength(5);
  });

  it('drops the timer of a source unregistered while armed instead of crashing', async () => {
    const sched = new SyncScheduler(engine, { clock, schedules: { lms: '15m' }, jitterRatio: 0 });
    const rejections: unknown[] = [];
    const onRejection = (e: unknown): void => void rejections.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      sched.start();
      await clock.advance(0);
      await engine.unregister('lms');
      await clock.advance(60 * 60_000);
      await new Promise((r) => setTimeout(r, 0));
      expect(rejections).toEqual([]);
      expect(sched.status()).toEqual([]);
    } finally {
      sched.stop();
      process.off('unhandledRejection', onRejection);
    }
  });
});
