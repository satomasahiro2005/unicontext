import { type ChangeEvent, makeId, stableId } from '@unicontext/canonical-model';
import { createFakeConnector } from '@unicontext/connector-sdk';
import { ManualClock } from '@unicontext/core';
import { ChangeEventStore } from '@unicontext/database';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHANGE_LIMITS,
  collapseByEntity,
  compactChangeValues,
  createUniContext,
  isHiddenChange,
  type UniContext,
} from '../src/index.js';

/*
 * The views list changes compactly: a first sync writes thousands of field-level events (document
 * chunks, notice bodies being fetched, catalogue courses), which made get_week several MB.
 */

const MON = stableId('courseOffering', 'livecampusu', 'C-MON');
const OTHER = stableId('courseOffering', 'livecampusu', 'C-OTHER');

const open: UniContext[] = [];
afterEach(async () => {
  for (const uc of open.splice(0)) await uc.close();
});

function event(over: Partial<ChangeEvent>): ChangeEvent {
  return {
    id: makeId('changeEvent'),
    entityId: stableId('announcement', 'x', String(Math.random())),
    entityKind: 'announcement',
    type: 'created',
    changedFields: [],
    before: null,
    after: null,
    source: { sourceId: 'livecampusu' },
    occurredAt: '2026-11-15T00:00:00.000Z',
    observedAt: '2026-11-15T00:00:00.000Z',
    ...over,
  };
}

async function setup(): Promise<UniContext> {
  const clock = new ManualClock('2026-11-10T00:00:00.000Z');
  const uc = createUniContext({ profile: 'shizuoka-university', clock });
  open.push(uc);
  const lcu = createFakeConnector({
    product: 'livecampusu',
    sourceLabel: '学務情報システム',
    authority: 'academic-system',
    capabilities: ['courses', 'enrollments', 'timetable'],
    dataset: {
      courses: [
        {
          id: 'C-MON',
          code: 'J3101',
          title: 'ソフトウェア工学',
          year: 2026,
          term: '後期',
          enrolled: true,
          schedule: [{ day: 1, period: 2 }],
        },
        {
          id: 'C-OTHER',
          code: 'J3999',
          title: '他学部の講義',
          year: 2026,
          term: '後期',
          schedule: [{ day: 2, period: 3 }],
        },
      ],
    },
  });
  uc.sync.register({
    sourceId: 'livecampusu',
    adapter: lcu.adapter,
    normalizer: lcu.normalizer,
    metadata: lcu.metadata,
  });
  expect((await uc.sync.sync('livecampusu')).ok).toBe(true);
  clock.set('2026-11-16T03:00:00.000Z');
  return uc;
}

describe('change digest helpers', () => {
  it('keeps short scalar before/after values of an update and drops bodies', () => {
    const c = event({
      type: 'updated',
      changedFields: ['dueAt', 'body', 'extra'],
      before: { dueAt: '2026-11-20T14:59:00Z', body: 'a'.repeat(500), extra: { read: false } },
      after: { dueAt: '2026-11-22T14:59:00Z', body: 'b'.repeat(500), extra: { read: true } },
    });
    expect(compactChangeValues(c)).toEqual({
      before: { dueAt: '2026-11-20T14:59:00Z' },
      after: { dueAt: '2026-11-22T14:59:00Z' },
    });
    expect(compactChangeValues(event({ after: { title: 'x' } }))).toEqual({
      before: null,
      after: null,
    });
  });

  it('hides index entries, catalogue courses and bodies fetched later', () => {
    expect(isHiddenChange(event({ entityKind: 'documentChunk' }))).toBe(true);
    expect(isHiddenChange(event({ entityKind: 'courseOffering' }))).toBe(true);
    expect(
      isHiddenChange(
        event({
          type: 'updated',
          changedFields: ['body', 'extra'],
          before: { body: '' },
          after: { body: '本文' },
        }),
      ),
    ).toBe(true);
    expect(
      isHiddenChange(
        event({
          type: 'updated',
          changedFields: ['body'],
          before: { body: '旧' },
          after: { body: '新' },
        }),
      ),
    ).toBe(false);
  });

  it('folds the events of one entity, preferring its creation', () => {
    const id = stableId('assignment', 'x', 'a');
    const out = collapseByEntity([
      event({
        entityId: id,
        entityKind: 'assignment',
        type: 'updated',
        observedAt: '2026-11-16T00:00:00Z',
      }),
      event({
        entityId: id,
        entityKind: 'assignment',
        type: 'created',
        observedAt: '2026-11-15T00:00:00Z',
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ count: 2, latestAt: '2026-11-16T00:00:00Z' });
    expect(out[0]?.event.type).toBe('created');
  });
});

describe('views list a compact, relevant set of changes', () => {
  it('get_week: one item per entity, my courses only, capped, short values', async () => {
    const uc = await setup();
    const store = new ChangeEventStore(uc.db);
    const at = (i: number): string =>
      new Date(Date.parse('2026-11-13T00:00:00Z') + i * 60_000).toISOString();
    // 300 updates of 60 notices of my course, 500 index chunks, 50 changes of a course I do not take.
    for (let i = 0; i < 300; i++)
      store.append(
        event({
          entityId: stableId('announcement', 'mine', String(i % 60)),
          courseOfferingId: MON,
          type: 'updated',
          changedFields: ['body'],
          before: { body: `旧${'x'.repeat(2000)}` },
          after: { body: `新${'y'.repeat(2000)}` },
          summary: `お知らせ${i % 60}の本文: ${'z'.repeat(1000)}`,
          observedAt: at(i),
          occurredAt: at(i),
        }),
      );
    for (let i = 0; i < 500; i++)
      store.append(event({ entityKind: 'documentChunk', observedAt: at(i), occurredAt: at(i) }));
    for (let i = 0; i < 50; i++)
      store.append(event({ courseOfferingId: OTHER, observedAt: at(i), occurredAt: at(i) }));
    const due = stableId('assignment', 'mine', 'due');
    store.append(
      event({
        entityId: due,
        entityKind: 'assignment',
        courseOfferingId: MON,
        type: 'updated',
        changedFields: ['dueAt'],
        before: { dueAt: '2026-11-20T14:59:00Z' },
        after: { dueAt: '2026-11-27T14:59:00Z' },
        summary: '課題「レポート2」の締切: 11/20 23:59 → 11/27 23:59',
        observedAt: at(0),
        occurredAt: at(0),
      }),
    );

    const week = uc.context.week();
    expect(week.changes).toHaveLength(CHANGE_LIMITS.week);
    expect(week.changesTotal).toBe(61);
    expect(week.changesOmitted).toBe(61 - CHANGE_LIMITS.week);
    expect(week.changes.some((c) => c.entityKind === 'documentChunk')).toBe(false);
    expect(week.changes.some((c) => c.course?.id === OTHER)).toBe(false);
    expect(new Set(week.changes.map((c) => c.entityId)).size).toBe(week.changes.length);
    // The due-date change ranks first even though it is the oldest.
    expect(week.changes.find((c) => c.entityId === due)).toMatchObject({
      before: { dueAt: '2026-11-20T14:59:00Z' },
      after: { dueAt: '2026-11-27T14:59:00Z' },
    });
    for (const c of week.changes) {
      expect(c.summary.length).toBeLessThanOrEqual(201);
      expect(c.citations.length).toBeLessThanOrEqual(2);
    }
    expect(week.changes.find((c) => c.entityKind === 'announcement')).toMatchObject({
      before: null,
      after: null,
      eventCount: 5,
    });
    expect(JSON.stringify(week).length).toBeLessThan(50_000);

    // get_recent_changes keeps every course but is capped too, with a limit.
    const recent = uc.context.changesSince({ since: '2026-11-01T00:00:00Z', limit: 10 });
    expect(recent.changes).toHaveLength(10);
    expect(recent.changesTotal).toBe(111);
  });
});
