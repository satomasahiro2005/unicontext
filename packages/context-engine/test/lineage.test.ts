import { stableId } from '@unicontext/canonical-model';
import { createFakeConnector } from '@unicontext/connector-sdk';
import { ManualClock } from '@unicontext/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeLineage,
  createUniContext,
  lineageTitleKey,
  priorYearLabel,
  type UniContext,
} from '../src/index.js';

/*
 * Prior-year lineage. 2026-10: the student takes データベースシステム論 (LiveCampusU + Ed db2026).
 * Ed also still holds last year's course db2025 with its lessons and threads — the best study
 * material for this year, but not this year's course: no identity link, no deadlines from it.
 */

const LCU_DB = stableId('courseOffering', 'livecampusu', 'C-DB');
const ED_2026 = stableId('courseOffering', 'edstem', 'db2026');
const ED_2025 = stableId('courseOffering', 'edstem', 'db2025');
const ED_2024 = stableId('courseOffering', 'edstem', 'db2024');
const REPORT_2025 = stableId('assignment', 'edstem', 'lesson-92580');
const LABEL_2025 = '前年度（2025）の参考資料';

const open: UniContext[] = [];
afterEach(async () => {
  for (const uc of open.splice(0)) await uc.close();
});

interface Options {
  /** Number of lesson documents of db2025. */
  lessons?: number;
  /** An older offering that only shares the registrar course code with this year's. */
  codeOnly?: boolean;
}

async function setup(o: Options = {}): Promise<UniContext> {
  const clock = new ManualClock('2026-10-05T03:56:00.000Z');
  const uc = createUniContext({ profile: 'shizuoka-university', clock });
  open.push(uc);
  const lcu = createFakeConnector({
    product: 'livecampusu',
    sourceLabel: '学務情報システム',
    authority: 'academic-system',
    capabilities: ['courses', 'enrollments', 'timetable', 'assignments'],
    dataset: {
      courses: [
        {
          id: 'C-DB',
          code: '77403030',
          title: 'データベースシステム論',
          year: 2026,
          term: '後期',
          teacher: '山本 泰生',
          enrolled: true,
          schedule: [{ day: 4, period: 2, room: '共通講義棟31' }],
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
  const lessons = Array.from({ length: o.lessons ?? 3 }, (_, i) => ({
    id: `lesson-doc-${i + 1}`,
    courseId: 'db2025',
    title: `第${i + 1}回 講義資料`,
    text: `第${i + 1}回: ER図と関係スキーマ\n\nエンティティと関連を図にする。`,
    path: `/Ed Lessons/第${i + 1}回/第${i + 1}回 講義資料`,
  }));
  const ed = createFakeConnector({
    product: 'edstem',
    sourceLabel: 'Ed Discussion',
    authority: 'lms',
    capabilities: ['courses', 'assignments', 'materials', 'messages'],
    dataset: {
      courses: [
        { id: 'db2026', code: 'db2026', title: 'データベースシステム論', year: 2026, term: '後期' },
        { id: 'db2025', code: 'db2025', title: 'データベースシステム論', year: 2025 },
        // A different title and the same registrar code: counts by the course code.
        ...(o.codeOnly
          ? [{ id: 'db2024', code: '77403030', title: 'データベース論（旧課程）', year: 2024 }]
          : []),
      ],
      assignments: [
        {
          id: 'lesson-119755',
          courseId: 'db2026',
          title: '当日課題 (小レポート1)',
          due: '2026-10-06T17:00:00+09:00',
        },
        {
          id: 'lesson-92580',
          courseId: 'db2025',
          title: '当日課題 (小レポート1)',
          due: '2025-10-07T17:00:00+09:00',
        },
      ],
      documents: [
        ...lessons,
        {
          id: 'lesson-doc-2026',
          courseId: 'db2026',
          title: '第1回 講義資料（今年度）',
          text: '今年度の第1回: データベースとは',
          path: '/Ed Lessons/第1回/第1回 講義資料（今年度）',
        },
      ],
      messages: [
        {
          id: 'th-1',
          courseId: 'db2025',
          thread: 'ER図の多重度がわかりません',
          body: '多重度の書き方を教えてください',
          sentAt: '2025-10-10T01:00:00+09:00',
          isQuestion: true,
        },
      ],
    },
  });
  uc.sync.register({
    sourceId: 'edstem',
    adapter: ed.adapter,
    normalizer: ed.normalizer,
    metadata: ed.metadata,
  });
  expect((await uc.sync.sync('livecampusu')).ok).toBe(true);
  expect((await uc.sync.sync('edstem')).ok).toBe(true);
  await uc.runPipeline();
  return uc;
}

describe('course lineage: last year of the same course', () => {
  it('links nothing: the 2025 offering stays a separate course', async () => {
    const uc = await setup();
    expect(uc.identity.expand(LCU_DB)).toContain(ED_2026);
    expect(uc.identity.expand(ED_2025)).toEqual([ED_2025]);
    expect(uc.identity.listLinks({ entityId: ED_2025 })).toEqual([]);
    expect(uc.context.course(LCU_DB).course.linkedIds).not.toContain(ED_2025);
  });

  it('stores course:lineage as a derived fact on the current offering, recomputed by the pipeline', async () => {
    const uc = await setup();
    const canonical = uc.identity.canonical(LCU_DB);
    const facts = uc.resolver.facts.active({ subjects: [canonical], predicate: 'course:lineage' });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      origin: 'inferred',
      producer: { type: 'rule', id: 'course-lineage' },
      value: { priorOfferingIds: [ED_2025], basis: { [ED_2025]: ['title'] } },
    });
    const id = facts[0]?.id;
    await uc.runPipeline();
    const again = uc.resolver.facts.active({ subjects: [canonical], predicate: 'course:lineage' });
    expect(again.map((f) => f.id)).toEqual([id]);
    // No conflict and no identity link came out of it.
    expect(uc.resolver.listConflicts({ status: 'open' }).map((c) => c.predicate)).not.toContain(
      'course:lineage',
    );
    expect(uc.identity.listLinks({ entityId: ED_2025 })).toEqual([]);
  });

  it("get_course names the prior offerings and labels last year's lessons and threads", async () => {
    const uc = await setup();
    const course = uc.context.course(LCU_DB);
    expect(course.lineage?.priorOfferings).toEqual([
      {
        id: ED_2025,
        year: 2025,
        title: 'データベースシステム論',
        sources: ['edstem'],
        basis: ['title'],
      },
    ]);
    const res = course.historicalResources ?? [];
    const titles = res.map((r) => r.title);
    expect(titles).toEqual(
      expect.arrayContaining(['第1回 講義資料', '第2回 講義資料', '第3回 講義資料']),
    );
    expect(res.some((r) => r.kind === 'thread' && r.title.includes('多重度'))).toBe(true);
    for (const r of res) {
      expect(r.label).toBe(LABEL_2025);
      expect(r.academicYear).toBe(2025);
      expect(r.course).toEqual({ id: ED_2025, title: 'データベースシステム論' });
      expect(r.citations.length).toBeGreaterThan(0);
    }
    const lesson = res.find((r) => r.title === '第1回 講義資料');
    expect(lesson?.path).toBe('/Ed Lessons/第1回/第1回 講義資料');
    expect(lesson?.snippet).toContain('ER図');
    // This year's own material is not "historical".
    expect(titles).not.toContain('第1回 講義資料（今年度）');
    expect(priorYearLabel(2025)).toBe(LABEL_2025);
  });

  it('shows at most 20, newest year first', async () => {
    const uc = await setup({ lessons: 30, codeOnly: true });
    const res = uc.context.course(LCU_DB).historicalResources ?? [];
    expect(res).toHaveLength(20);
    const years = res.map((r) => r.academicYear);
    expect(years).toEqual([...years].sort((a, b) => (b ?? 0) - (a ?? 0)));
    expect(new Set(years)).toEqual(new Set([2025]));
    // A few threads are reserved so questions are not crowded out by 30 lessons.
    expect(res.filter((r) => r.kind === 'thread').length).toBeGreaterThan(0);
  });

  it('nothing from the prior year reaches deadlines, assignments or the next action', async () => {
    const uc = await setup();
    const shown = JSON.stringify([
      uc.context.deadline({ days: 400 }),
      uc.context.today(),
      uc.context.week(),
      uc.context.nextActions(),
      uc.context.estimatedDeadlines(),
      uc.context.course(LCU_DB).deadlines,
      uc.context.course(LCU_DB).assignments,
    ]);
    expect(shown).not.toContain(REPORT_2025);
    expect(shown).not.toContain(stableId('task', 'assignment', REPORT_2025));
    expect(shown).not.toContain('2025-10-07');
    // This year's assignment is there as before.
    expect(shown).toContain('2026-10-06');
    // The engine keeps last year's task only as an expired record; no view lists it.
    for (const t of uc.tasks.list({}).filter((x) => x.assignmentId === REPORT_2025))
      expect(t.status).toBe('expired_past_term');
  });

  it("search hits from the prior-year offering are labelled, this year's are not", async () => {
    const uc = await setup();
    const { hits } = await uc.search.search('講義資料');
    const labelled = uc.context.labelPriorYearHits(hits);
    const old = labelled.filter((h) => h.courseOfferingId === ED_2025);
    const now = labelled.filter((h) => h.courseOfferingId === ED_2026);
    expect(old.length).toBeGreaterThan(0);
    expect(now.length).toBeGreaterThan(0);
    for (const h of old) expect(h).toMatchObject({ priorYear: 2025, label: LABEL_2025 });
    for (const h of now) expect('label' in h).toBe(false);
  });

  it('the same course code counts too, with its basis', async () => {
    const uc = await setup({ codeOnly: true });
    const lineage = uc.context.course(LCU_DB).lineage;
    expect(lineage?.priorOfferings.map((p) => [p.year, p.basis])).toEqual([
      [2025, ['title']],
      [2024, ['courseCode']],
    ]);
    expect(uc.identity.expand(ED_2024)).toEqual([ED_2024]);
  });
});

describe('computeLineage', () => {
  const o = (id: string, title: string, academicYear?: number, courseCode?: string) => ({
    id,
    title,
    academicYear,
    courseCode,
  });
  const same = (id: string): string => id;

  it('only earlier years count, never this year, a later year or an offering without a year', () => {
    const r = computeLineage(
      [o('cur', 'データベース システム論', 2026)],
      [
        o('p25', 'データベースシステム論', 2025),
        o('p24', 'ﾃﾞｰﾀﾍﾞｰｽｼｽﾃﾑ論', 2024),
        o('same-year', 'データベースシステム論', 2026),
        o('next', 'データベースシステム論', 2027),
        o('nodate', 'データベースシステム論'),
        o('other', 'ネットワーク論', 2025),
      ],
      same,
    );
    expect(r?.priorOfferingIds).toEqual(['p25', 'p24']);
    expect(computeLineage([o('cur', 'x', undefined)], [o('p', 'x', 2025)], same)).toBeUndefined();
    expect(computeLineage([o('cur', 'データベース', 2026)], [], same)).toBeUndefined();
  });

  it('linked earlier offerings are one prior offering named by their canonical id', () => {
    const canonical = (id: string): string => (id === 'lcu25' || id === 'ed25' ? 'lcu25' : id);
    const r = computeLineage(
      [o('cur', 'データベース', 2026, 'J3101')],
      [o('lcu25', 'データベース', 2025, 'J3101'), o('ed25', 'データベース', 2025, 'db2025')],
      canonical,
    );
    expect(r).toEqual({
      priorOfferingIds: ['lcu25'],
      basis: { lcu25: ['courseCode', 'title'] },
    });
  });

  it('compares titles as the identity package does: width, years, brackets and endings are ignored', () => {
    expect(lineageTitleKey('Ｄａｔａｂａｓｅ　Ｓｙｓｔｅｍｓ')).toBe(
      lineageTitleKey('database systems'),
    );
    expect(lineageTitleKey('2025 データベースシステム論')).toBe(
      lineageTitleKey('データベースシステム論'),
    );
    expect(lineageTitleKey('情報科学実験B')).not.toBe(lineageTitleKey('情報科学実験C'));
  });
});
