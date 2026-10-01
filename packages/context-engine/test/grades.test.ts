import type { RawItem } from '@unicontext/connector-sdk';
import { ManualClock } from '@unicontext/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildGradeReport, createUniContext, type UniContext } from '../src/index.js';

const clock = new ManualClock('2026-10-01T00:00:00Z');
let uc: UniContext;

interface G {
  code: string;
  title: string;
  year: number;
  term: string;
  credits: number;
  evaluation: string;
  outcome: string;
  examType?: string;
  pendingReexam?: boolean;
  markers?: { symbol: string; label?: string }[];
}

// Synthetic grade history (no real data).
const GRADES: G[] = [
  {
    code: 'A1',
    title: '入門',
    year: 2024,
    term: '前期',
    credits: 2,
    evaluation: '不可',
    outcome: 'failed',
  },
  {
    code: 'A1',
    title: '入門',
    year: 2025,
    term: '前期',
    credits: 2,
    evaluation: '不可',
    outcome: 'failed',
  },
  {
    code: 'A1',
    title: '入門',
    year: 2026,
    term: '前期',
    credits: 2,
    evaluation: '不可',
    outcome: 'failed',
  },
  {
    code: 'B1',
    title: '演習',
    year: 2024,
    term: '前期',
    credits: 2,
    evaluation: '不可',
    outcome: 'failed',
  },
  {
    code: 'B1',
    title: '演習',
    year: 2025,
    term: '前期',
    credits: 2,
    evaluation: '優',
    outcome: 'passed',
  },
  {
    code: 'C1',
    title: '教養',
    year: 2024,
    term: '後期',
    credits: 1,
    evaluation: '合',
    outcome: 'passed',
    markers: [{ symbol: '+', label: 'オンライン科目' }],
  },
  {
    code: 'D1',
    title: '統計',
    year: 2026,
    term: '前期',
    credits: 2,
    evaluation: '再試',
    outcome: 'not_graded',
    pendingReexam: true,
  },
  {
    code: 'E1',
    title: '外国語',
    year: 2025,
    term: '前期',
    credits: 2,
    evaluation: '認定',
    outcome: 'transferred',
  },
  {
    code: 'F1',
    title: '特論',
    year: 2025,
    term: '後期',
    credits: 2,
    evaluation: '評価保留中',
    outcome: 'unknown',
  },
  {
    code: 'G1',
    title: '後期科目',
    year: 2026,
    term: '後期',
    credits: 2,
    evaluation: '',
    outcome: 'in_progress',
  },
];

beforeEach(async () => {
  uc = createUniContext({ profile: 'shizuoka-university', clock });
  const items: RawItem[] = [
    ...GRADES.map((g, i) => ({ sourceType: 'grade', externalId: `g${i}`, payload: { ...g } })),
    {
      sourceType: 'req',
      externalId: '01',
      payload: {
        requirementType: { code: '01', name: '卒業要件（学士課程）' },
        rows: [
          {
            depth: 0,
            name: '卒業要件（学士課程）',
            required: 124,
            expected: 30,
            status: '不足',
            courses: [],
          },
          {
            depth: 3,
            name: '選択群',
            creditType: '選必',
            required: 4,
            expected: 4,
            status: '充足',
            courses: [{ title: '統計', credits: 2, status: '合格' }],
          },
        ],
      },
    },
  ];
  uc.sync.register({
    sourceId: 'lcu',
    adapter: {
      id: 'lcu',
      version: '1',
      capabilities: () => Promise.resolve(['grades']),
      authenticate: () => Promise.resolve({ status: 'not_required' }),
      sync: () =>
        Promise.resolve({ items, hasMore: false, complete: { sourceTypes: ['grade', 'req'] } }),
      health: () => Promise.resolve({ state: 'healthy', checkedAt: clock.now().toISOString() }),
      dispose: () => Promise.resolve(),
    },
    normalizer: {
      id: 'test',
      version: '1',
      sourceTypes: ['grade', 'req'],
      normalize(item, ctx) {
        const self = ctx.id('person', 'self');
        if (item.sourceType === 'req')
          return {
            entities: [
              {
                entity: {
                  id: self,
                  kind: 'person',
                  name: '本人',
                  roles: ['student'],
                  isSelf: true,
                },
                deriveFacts: false,
              },
            ],
            facts: [
              {
                subject: self,
                predicate: 'credit_requirements',
                value: item.payload as never,
                origin: 'authoritative',
              },
            ],
          };
        const g = item.payload as G;
        return {
          entities: [
            {
              entity: {
                id: ctx.id('grade', item.externalId),
                kind: 'grade',
                ...(g.evaluation ? { letter: g.evaluation } : {}),
                extra: {
                  subjectCode: g.code,
                  subjectName: g.title,
                  credits: g.credits,
                  evaluation: g.evaluation,
                  outcome: g.outcome,
                  academicYear: g.year,
                  term: g.term,
                  reportTerm: `${g.year}年度 ${g.term}`,
                  ...(g.pendingReexam ? { pendingReexam: true } : {}),
                  ...(g.markers ? { markers: g.markers } : {}),
                },
              },
            },
          ],
        };
      },
    },
    metadata: {
      id: 'lcu',
      name: 'lcu',
      version: '1',
      product: 'lcu',
      sourceLabel: '学務情報システム',
      defaultAuthority: 'academic-system',
      capabilities: ['grades'],
      rawTypes: ['grade', 'req'],
    } as never,
  });
  await uc.sync.sync('lcu');
});
afterEach(async () => uc.close());

describe('buildGradeReport', () => {
  it('groups every attempt per course with the latest status and failed attempts', () => {
    const r = buildGradeReport(uc);
    expect(r.attempts).toHaveLength(GRADES.length);
    const intro = r.courses.find((c) => c.subjectCode === 'A1');
    expect(intro).toMatchObject({ failedAttempts: 3, earned: false, status: 'failed' });
    expect(intro?.attempts.map((a) => [a.academicYear, a.attemptNo, a.evaluation])).toEqual([
      [2024, 1, '不可'],
      [2025, 2, '不可'],
      [2026, 3, '不可'],
    ]);
    const exercise = r.courses.find((c) => c.subjectCode === 'B1');
    expect(exercise).toMatchObject({
      failedAttempts: 1,
      earned: true,
      status: 'passed',
      statusEvaluation: '優',
    });
    expect(r.courses.find((c) => c.subjectCode === 'C1')?.markers).toEqual([
      { symbol: '+', label: 'オンライン科目' },
    ]);
  });

  it('totals credits per term, per year and overall; unknown is never earned or failed', () => {
    const r = buildGradeReport(uc);
    expect(r.terms.map((t) => t.key)).toEqual([
      '2024 前期',
      '2024 後期',
      '2025 前期',
      '2025 後期',
      '2026 前期',
      '2026 後期',
    ]);
    const t2025 = r.years.find((y) => y.academicYear === 2025);
    expect(t2025).toMatchObject({ earnedCredits: 4, failedCredits: 2 }); // 優 2 + 認定 2
    expect(t2025?.credits.unknown).toBe(2);
    expect(r.totals).toMatchObject({ earnedCredits: 5, failedCredits: 8, attempts: 10 });
    expect(r.totals.credits).toMatchObject({
      not_graded: 2,
      in_progress: 2,
      transferred: 2,
      unknown: 2,
    });
    expect(r.unknownLabels).toEqual(['評価保留中']);
    expect(r.labels).toContainEqual({ evaluation: '不可', outcome: 'failed', count: 4 });
  });

  it('filters by year, failed attempts and outcome or label, keeping full course histories', () => {
    const y = buildGradeReport(uc, { year: 2026 });
    expect(y.attempts.map((a) => a.subjectCode)).toEqual(['A1', 'D1', 'G1']);
    expect(y.courses.find((c) => c.subjectCode === 'A1')?.attempts).toHaveLength(3);
    expect(y.totals.attempts).toBe(3);

    const failed = buildGradeReport(uc, { failedOnly: true });
    expect(failed.attempts).toHaveLength(4);
    expect(failed.totals.attempts).toBe(10); // totals ignore the listing filters

    expect(
      buildGradeReport(uc, { statuses: ['not_graded'] }).attempts.map((a) => a.evaluation),
    ).toEqual(['再試']);
    expect(buildGradeReport(uc, { statuses: ['認定', 'unknown'] }).attempts).toHaveLength(2);
  });

  it('exposes the requirement status fact', () => {
    const r = buildGradeReport(uc);
    expect(r.requirements?.requirementType).toEqual({ code: '01', name: '卒業要件（学士課程）' });
    expect(r.requirements?.rows[0]).toMatchObject({ required: 124, expected: 30, shortfall: 94 });
    expect(r.requirements?.rows[1]?.shortfall).toBeUndefined();
    expect(r.requirements?.sourceReferenceId).toBeTruthy();
  });
});
