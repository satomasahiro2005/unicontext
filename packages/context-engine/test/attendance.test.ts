import { stableId } from '@unicontext/canonical-model';
import { createFakeConnector } from '@unicontext/connector-sdk';
import { ManualClock } from '@unicontext/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createUniContext, type UniContext } from '../src/index.js';

/*
 * Attendance (出欠) the academic system publishes: LiveCampusU's `attendance` fact per enrolled
 * offering (raw counts + 公開状況). Monday 2026-10-05 09:30 JST, 後期.
 */

const NOW = '2026-10-05T00:30:00.000Z';
const DB = stableId('courseOffering', 'livecampusu', 'C-DB');
const NET = stableId('courseOffering', 'livecampusu', 'C-NET');
const OS = stableId('courseOffering', 'livecampusu', 'C-OS');

const open: UniContext[] = [];
afterEach(async () => {
  for (const uc of open.splice(0)) await uc.close();
});

/** What the connector writes for LiveCampusU's 出欠 screen (connectors/livecampusu normalizer). */
const ATTENDANCE: Record<string, Record<string, string | number>> = {
  'C-DB': {
    attended: 5,
    absent: 1,
    late: 1,
    earlyLeave: 0,
    excused: 0,
    invalid: 0,
    published: '公開',
  },
  // The university states a total for this one: shares are derived from it.
  'C-OS': { attended: 6, absent: 2, total: 8, published: '公開' },
};

async function setup(withAttendance = true): Promise<UniContext> {
  const clock = new ManualClock(NOW);
  const uc = createUniContext({ profile: 'shizuoka-university', clock });
  open.push(uc);
  const lcu = createFakeConnector({
    product: 'livecampusu',
    sourceLabel: '学務情報システム',
    authority: 'academic-system',
    capabilities: ['courses', 'enrollments', 'timetable'],
    dataset: {
      courses: [
        ['C-DB', 'データベースシステム論', 4, 2],
        ['C-NET', 'ネットワーク論', 3, 3],
        ['C-OS', 'オペレーティングシステム', 2, 1],
      ].map(([id, title, day, period]) => ({
        id: id as string,
        code: id as string,
        title: title as string,
        year: 2026,
        term: '後期',
        enrolled: true,
        schedule: [{ day: day as number, period: period as number }],
      })),
    },
  });
  const normalizer = {
    ...lcu.normalizer,
    normalize: async (
      item: Parameters<typeof lcu.normalizer.normalize>[0],
      ctx: Parameters<typeof lcu.normalizer.normalize>[1],
    ) => {
      const out = await lcu.normalizer.normalize(item, ctx);
      const row =
        withAttendance && item.sourceType === 'fake.course'
          ? ATTENDANCE[item.externalId]
          : undefined;
      if (!row) return out;
      return {
        ...out,
        facts: [
          ...(out.facts ?? []),
          {
            subject: ctx.id('courseOffering', item.externalId),
            predicate: 'attendance',
            value: row,
            origin: 'authoritative' as const,
            ref: { url: 'https://example.ac.jp/attendance' },
          },
        ],
      };
    },
  };
  uc.sync.register({
    sourceId: 'livecampusu',
    adapter: lcu.adapter,
    normalizer,
    metadata: lcu.metadata,
  });
  expect((await uc.sync.sync('livecampusu')).ok).toBe(true);
  await uc.runPipeline();
  return uc;
}

describe('attendance of a course (get_course)', () => {
  it('carries the raw LiveCampusU counts with a citation and the time it was read', async () => {
    const uc = await setup();
    const a = uc.context.course(DB).attendance;
    expect(a).toBeDefined();
    expect(a?.counts).toEqual({
      attended: 5,
      absent: 1,
      late: 1,
      earlyLeave: 0,
      excused: 0,
      invalid: 0,
    });
    expect(a?.published).toBe('公開');
    expect(a?.asOf).toBe(NOW);
    expect(a?.absencesSoFar).toBe(1);
    expect(a?.text).toBe('出席 5・欠席 1・遅刻 1・早退 0・公欠 0・無効 0');
    expect(a?.citations[0]).toMatchObject({
      sourceSystem: 'livecampusu',
      authority: 'academic-system',
      url: 'https://example.ac.jp/attendance',
    });
    expect(a?.citations[0]?.label).toContain('学務情報システム');
  });

  it('derives no share when the university gave no total, and a share when it did', async () => {
    const uc = await setup();
    expect(uc.context.course(DB).attendance?.derived).toBeUndefined();
    const os = uc.context.course(OS).attendance;
    expect(os?.counts).toMatchObject({ attended: 6, absent: 2, total: 8 });
    expect(os?.derived).toEqual({ total: 8, attendedShare: 0.75, absentShare: 0.25 });
  });

  it('omits attendance for a course the university has no row for', async () => {
    const uc = await setup();
    expect(uc.context.course(NET).attendance).toBeUndefined();
    expect('attendance' in uc.context.course(NET)).toBe(false);
  });
});

describe('attendance overview (get_attendance)', () => {
  it('lists every course of the term, says which have no row, and when the academic system was last read', async () => {
    const uc = await setup();
    const o = uc.context.attendanceOverview();
    expect(o.courses.map((c) => c.course.title).sort()).toEqual(
      ['オペレーティングシステム', 'データベースシステム論', 'ネットワーク論'].sort(),
    );
    const db = o.courses.find((c) => c.course.id === DB);
    expect(db?.attendance?.counts.absent).toBe(1);
    const net = o.courses.find((c) => c.course.id === NET);
    expect(net?.attendance).toBeUndefined();
    expect(net?.note).toContain('出欠の行がありません');
    expect(o.coverage).toMatchObject({ complete: false, missing: 1 });
    expect(o.coverage.sources).toEqual([
      expect.objectContaining({ sourceId: 'livecampusu', health: 'ok', lastSuccessAt: NOW }),
    ]);
    expect(o.coverage.note).toContain('10/5 09:30');
    expect(o.coverage.note).toContain('1科目は出欠の行がありません');
  });

  it('one course only', async () => {
    const uc = await setup();
    const o = uc.context.attendanceOverview({ courseOfferingId: DB });
    expect(o.courses).toHaveLength(1);
    expect(o.courses[0]?.course.id).toBe(DB);
    expect(o.coverage.complete).toBe(true);
  });

  it('when the academic system has not given attendance at all, it says so instead of listing zeros', async () => {
    const uc = await setup(false);
    const o = uc.context.attendanceOverview();
    expect(o.courses).toHaveLength(3);
    expect(o.courses.every((c) => c.attendance === undefined)).toBe(true);
    expect(o.coverage.complete).toBe(false);
    expect(o.coverage.missing).toBe(3);
    expect(o.coverage.note).toContain('出欠はまだ取り込めていません');
    expect(o.coverage.note).toContain('最終同期は10/5 09:30');
    expect(o.coverage.note).toContain('推測');
  });
});
