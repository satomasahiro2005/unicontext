import { createFakeConnector } from '@unicontext/connector-sdk';
import { ManualClock } from '@unicontext/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ageMinutesOf,
  buildViewFreshness,
  createUniContext,
  evaluateFreshness,
  FRESHNESS_BUDGET_MINUTES,
  freshnessHint,
  freshnessLevel,
  sourceServesUse,
  type UniContext,
} from '../src/index.js';

const MIN = 60_000;

describe('freshness budgets', () => {
  it('has the budgets of each use in minutes', () => {
    expect(FRESHNESS_BUDGET_MINUTES).toMatchObject({
      schedule: 45,
      deadlines: 90,
      assignments: 90,
      announcements: 120,
      materials: 24 * 60,
      grades: 24 * 60,
      attendance: 24 * 60,
      calendar: 60,
    });
  });

  it('judges a level from the age and the budget', () => {
    expect(freshnessLevel(45, 45)).toBe('fresh');
    expect(freshnessLevel(46, 45)).toBe('aging');
    expect(freshnessLevel(89, 45)).toBe('aging');
    expect(freshnessLevel(90, 45)).toBe('stale');
    expect(freshnessLevel(undefined, 45)).toBe('unknown');
    const now = new Date('2026-10-05T03:00:00Z');
    expect(ageMinutesOf('2026-10-05T01:30:00Z', now)).toBe(90);
    expect(ageMinutesOf('2026-10-05T04:00:00Z', now)).toBe(0);
    expect(ageMinutesOf(undefined, now)).toBeUndefined();
  });

  it('evaluateFreshness lists the sources over the budget, oldest first', () => {
    const e = evaluateFreshness(
      [
        { sourceId: 'teams', label: 'Teams', ageMinutes: 50 },
        { sourceId: 'lcu', label: '学務情報システム', ageMinutes: 90 },
        { sourceId: 'cancel', label: '休講案内', ageMinutes: 10 },
      ],
      'schedule',
    );
    expect(e.fresh).toBe(false);
    expect(e.oldestAgeMinutes).toBe(90);
    expect(e.staleSources).toEqual([
      { sourceId: 'lcu', label: '学務情報システム', ageMinutes: 90, budgetMinutes: 45 },
      { sourceId: 'teams', label: 'Teams', ageMinutes: 50, budgetMinutes: 45 },
    ]);
    const ok = evaluateFreshness([{ sourceId: 'a', label: 'a', ageMinutes: 45 }], 'schedule');
    expect(ok).toEqual({ fresh: true, oldestAgeMinutes: 45, staleSources: [] });
    const never = evaluateFreshness(
      [{ sourceId: 'a', label: 'a', ageMinutes: undefined }],
      'deadlines',
    );
    expect(never.fresh).toBe(false);
    expect(never.staleSources[0]).toMatchObject({ sourceId: 'a', budgetMinutes: 90 });
    expect(evaluateFreshness([], 'schedule')).toEqual({
      fresh: true,
      oldestAgeMinutes: undefined,
      staleSources: [],
    });
  });

  it('knows which sources feed which use', () => {
    const lcu = {
      capabilities: ['courses', 'enrollments', 'timetable', 'assignments', 'exams', 'calendar'],
      authority: 'academic-system',
      referenceOnly: false,
    };
    const teams = {
      capabilities: ['courses', 'announcements', 'messages', 'materials', 'assignments'],
      authority: 'collaboration',
      referenceOnly: false,
    };
    const syllabus = {
      capabilities: ['courses', 'timetable', 'rooms'],
      authority: 'syllabus',
      referenceOnly: true,
    };
    const files = {
      capabilities: ['files', 'materials'],
      authority: 'local-file',
      referenceOnly: false,
    };
    expect(sourceServesUse(lcu, 'schedule')).toBe(true);
    expect(sourceServesUse(teams, 'schedule')).toBe(true); // a room change posted in a channel
    expect(sourceServesUse(files, 'schedule')).toBe(false);
    expect(sourceServesUse(syllabus, 'schedule')).toBe(false); // a catalog is not live
    expect(sourceServesUse(lcu, 'attendance')).toBe(true);
    expect(sourceServesUse(teams, 'attendance')).toBe(false);
    // the public notices of the same system do not read the student's attendance
    expect(
      sourceServesUse(
        {
          capabilities: ['timetable', 'announcements'],
          authority: 'academic-system',
          referenceOnly: false,
        },
        'attendance',
      ),
    ).toBe(false);
    expect(sourceServesUse(files, 'materials')).toBe(true);
    expect(sourceServesUse({ ...lcu, capabilities: undefined }, 'schedule')).toBe(false);
  });
});

describe('freshness hint', () => {
  it('names the stale source and refresh_sources only when a use of the view is over budget', () => {
    const now = new Date('2026-10-05T03:00:00Z');
    const f = buildViewFreshness(
      [
        {
          sourceId: 'lcu',
          label: '学務情報システム',
          capabilities: ['timetable', 'assignments'],
          authority: 'academic-system',
          referenceOnly: false,
          lastSuccessAt: new Date(now.getTime() - 100 * MIN).toISOString(),
        },
      ],
      now,
    );
    expect(f.perUse.schedule).toMatchObject({
      fresh: false,
      freshness: 'stale',
      budgetMinutes: 45,
    });
    expect(f.perUse.deadlines).toMatchObject({
      fresh: false,
      freshness: 'aging',
      budgetMinutes: 90,
    });
    expect(f.perUse.announcements).toMatchObject({
      sourceCount: 0,
      freshness: 'unknown',
      fresh: true,
    });
    const hint = freshnessHint({ view: 'today', freshness: f });
    expect(hint).toContain('学務情報システム は 100分前の情報です。refresh_sources で更新できます');
    // a view that does not use the stale uses gets no hint
    expect(freshnessHint({ view: 'teams-activity', freshness: f })).toBeUndefined();
    expect(freshnessHint({ view: 'today' })).toBeUndefined();
  });
});

describe('view freshness from a running context', () => {
  let uc: UniContext | undefined;
  afterEach(async () => {
    await uc?.close();
    uc = undefined;
  });

  async function lcuAt(minutesAgo: number): Promise<{ uc: UniContext; clock: ManualClock }> {
    const clock = new ManualClock('2026-10-05T00:00:00Z');
    const ctx = createUniContext({
      profile: 'shizuoka-university',
      clock,
      schedules: { livecampusu: '30m', teams: '30m' },
    });
    uc = ctx;
    const lcu = createFakeConnector({
      product: 'livecampusu',
      sourceLabel: '学務情報システム',
      authority: 'academic-system',
      capabilities: ['courses', 'timetable', 'rooms', 'assignments', 'exams', 'announcements'],
    });
    ctx.sync.register({
      sourceId: 'livecampusu',
      adapter: lcu.adapter,
      normalizer: lcu.normalizer,
      metadata: lcu.metadata,
    });
    expect((await ctx.sync.sync('livecampusu')).ok).toBe(true);
    await clock.advance(minutesAgo * MIN);
    return { uc: ctx, clock };
  }

  it('a 30-minute source read 90 minutes ago is healthy but stale for the schedule', async () => {
    const { uc: ctx } = await lcuAt(90);
    const today = ctx.context.today();
    const lcu = today.coverage.sources.find((s) => s.sourceId === 'livecampusu');
    // health says it works (its run is well within 3 x 30 min = 6 h)...
    expect(lcu?.health).toBe('ok');
    // ...freshness says it is 90 minutes behind a 45-minute budget
    expect(lcu).toMatchObject({ ageMinutes: 90, intervalMinutes: 30 });
    expect(lcu?.lastSuccessAt).toBe('2026-10-05T00:00:00.000Z');
    expect(today.freshness?.perUse.schedule).toMatchObject({
      fresh: false,
      freshness: 'stale',
      oldestAgeMinutes: 90,
      budgetMinutes: 45,
      staleSources: [
        { sourceId: 'livecampusu', label: '学務情報システム', ageMinutes: 90, budgetMinutes: 45 },
      ],
    });
    expect(today.freshness?.perUse.announcements).toMatchObject({ fresh: true });
    expect(today.freshness?.asOf).toBe('2026-10-05T01:30:00.000Z');
    // every view carries it
    expect(ctx.context.deadline().freshness?.perUse.schedule.fresh).toBe(false);
    expect(ctx.context.week().freshness).toBeDefined();
  });

  it('is fresh right after a read', async () => {
    const { uc: ctx } = await lcuAt(10);
    const f = ctx.context.today().freshness;
    expect(f?.perUse.schedule).toMatchObject({
      fresh: true,
      freshness: 'fresh',
      oldestAgeMinutes: 10,
    });
    expect(freshnessHint({ view: 'today', freshness: f })).toBeUndefined();
  });

  it('sourceFreshness lists the sources a use needs, stalest first', async () => {
    const { uc: ctx } = await lcuAt(90);
    const all = ctx.context.sourceFreshness();
    expect(all.map((s) => s.sourceId)).toEqual(['livecampusu']);
    expect(all[0]).toMatchObject({ ageMinutes: 90, freshness: 'stale', budgetMinutes: 45 });
    expect(ctx.context.sourceFreshness({ uses: ['materials'] })).toEqual([]);
    expect(ctx.context.sourceFreshness({ uses: ['grades'] })).toEqual([]);
    expect(ctx.context.sourceFreshness({ uses: ['deadlines'] })[0]?.budgetMinutes).toBe(90);
  });
});
