import type { CanonicalEntityInput } from '@unicontext/canonical-model';
import type { RawItem } from '@unicontext/connector-sdk';
import { ManualClock } from '@unicontext/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createUniContext,
  semesterOfTerm,
  syllabusDetailPriorities,
  type UniContext,
} from '../src/index.js';

/*
 * Which syllabus details the student needs first (synthetic data, no real grades): the host side
 * of the syllabus connector's priorityProvider.
 */

const clock = new ManualClock('2026-10-06T00:00:00Z');
let uc: UniContext;
afterEach(async () => uc.close());

const SELF = 'person:self';

function offering(
  id: string,
  code: string,
  title: string,
  term: string,
  extra: Record<string, unknown>,
): CanonicalEntityInput {
  return {
    id: `courseOffering:${id}`,
    kind: 'courseOffering',
    title,
    courseCode: code,
    academicYear: 2026,
    term,
    instructorNames: [],
    schedule: [],
    extra,
  } as CanonicalEntityInput;
}

/** The student's own data (registrations and grades) as the academic system lists it. */
const OWN: CanonicalEntityInput[] = [
  {
    id: SELF,
    kind: 'person',
    name: '本人',
    roles: ['student'],
    isSelf: true,
  } as CanonicalEntityInput,
  offering('lcu-bio', '16111007', '生命科学', '後期', { className: '情工１' }),
  offering('lcu-intro', '77301020', 'コンピュータ入門', '前期', { className: '再履修（情）１' }),
  ...['bio', 'intro'].map(
    (k) =>
      ({
        id: `enrollment:${k}`,
        kind: 'enrollment',
        personId: SELF,
        courseOfferingId: `courseOffering:lcu-${k}`,
        role: 'student',
        status: 'active',
      }) as CanonicalEntityInput,
  ),
];

function grade(key: string, extra: Record<string, unknown>): CanonicalEntityInput {
  return { id: `grade:${key}`, kind: 'grade', extra } as CanonicalEntityInput;
}

const GRADES: CanonicalEntityInput[] = [
  grade('net', {
    subjectCode: '77401180',
    subjectName: 'コンピュータネットワーク',
    creditType: '必',
    credits: 2,
    evaluation: '不可',
    outcome: 'failed',
    academicYear: 2025,
    term: '前期',
  }),
  grade('museum', {
    subjectCode: '74500130',
    subjectName: '博物館教育論',
    creditType: '選択',
    credits: 2,
    evaluation: '不可',
    outcome: 'failed',
    academicYear: 2025,
    term: '後期',
  }),
  // Failed before, taking it again now: not "needed" (the registration covers it).
  grade('exp-old', {
    subjectCode: '77451170',
    subjectName: '情報科学実験B',
    creditType: '必',
    credits: 2,
    evaluation: '不可',
    outcome: 'failed',
    academicYear: 2025,
    term: '後期',
  }),
  grade('exp-now', {
    subjectCode: '77451170',
    subjectName: '情報科学実験B',
    creditType: '必',
    credits: 2,
    evaluation: '',
    outcome: 'in_progress',
    academicYear: 2026,
    term: '後期',
  }),
];

/** The syllabus catalog (what the syllabus connector stored). */
const CATALOG: CanonicalEntityInput[] = [
  offering('syl-bio-s', '16111007', '生命科学', '後期', { className: '学部共通２' }),
  offering('syl-bio-h', '16111007', '生命科学', '後期', { className: '情工１' }),
  offering('syl-intro', '77301020', 'コンピュータ入門', '前期', {
    className: '1クラス',
    categories: ['学部共通科目-学部共通科目（必修）'],
  }),
  offering('syl-net', '77401180', 'コンピュータネットワーク', '前期', {
    className: '1クラス',
    categories: ['行動情報学科-行動情報学科（選択）', '情報科学科-情報科学科（必修）'],
  }),
];

const REQUIREMENTS = {
  rows: [
    { depth: 0, name: '専門科目', required: 86, expected: 53, status: '不足', courses: [] },
    {
      depth: 1,
      name: '学科専門科目／必修',
      required: 47,
      expected: 22,
      status: '不足',
      courses: [],
    },
    {
      depth: 2,
      name: '必修',
      creditType: '必',
      courses: [
        { title: 'コンピュータネットワーク', creditType: '必', credits: 2, status: '不合格' },
        { title: 'オペレーティングシステム', creditType: '必', credits: 2 },
        { title: 'プログラミング', creditType: '必', credits: 2, status: '合格' },
        { title: '情報科学実験B', creditType: '必', credits: 2, status: '履修中' },
      ],
    },
    { depth: 1, name: '学科専門科目／選択', required: 7, expected: 5, status: '不足', courses: [] },
    {
      depth: 2,
      name: '選択',
      creditType: '選択',
      expected: 5,
      courses: [{ title: 'ネットワークプログラミング', creditType: '選択', credits: 2 }],
    },
    { depth: 0, name: '教養展開科目', required: 6, expected: 6, status: '充足', courses: [] },
    {
      depth: 1,
      name: '教養領域Ａ 人文',
      creditType: '選必',
      required: 2,
      expected: 2,
      status: '充足',
      courses: [{ title: '心理と行動Ａ', creditType: '選必', credits: 2, status: '不合格' }],
    },
    { depth: 0, name: '自由科目', courses: [] },
    {
      depth: 1,
      name: '自由科目',
      creditType: '選択',
      courses: [{ title: '博物館教育論', creditType: '選択', credits: 2, status: '不合格' }],
    },
    { depth: 0, name: '教養科目', required: 28, expected: 24, status: '不足', courses: [] },
    { depth: 1, name: '教養基礎科目', required: 9, expected: 9, status: '充足', courses: [] },
    // No required number while its sibling groups have one: does not count toward 教養科目.
    { depth: 1, name: '留学生科目', expected: 0, courses: [] },
    {
      depth: 2,
      name: '日本語',
      creditType: '選択',
      expected: 0,
      courses: [{ title: '日本語Ⅰ', creditType: '選択', credits: 1 }],
    },
    { depth: 1, name: '教養科目 選択', required: 13, expected: 9, status: '不足', courses: [] },
    { depth: 2, name: '教養科目 選択', expected: 9, courses: [] },
    {
      depth: 3,
      name: '英語 選択',
      creditType: '選択',
      expected: 4,
      courses: [{ title: '中級英語Ａ', creditType: '選択', credits: 2 }],
    },
  ],
};

function passThrough(sourceId: string, items: RawItem[]): void {
  uc.sync.register({
    sourceId,
    adapter: {
      id: sourceId,
      version: '1',
      capabilities: () => Promise.resolve(['courses']),
      authenticate: () => Promise.resolve({ status: 'not_required' }),
      sync: () =>
        Promise.resolve({ items, hasMore: false, complete: { sourceTypes: ['all', 'req'] } }),
      health: () => Promise.resolve({ state: 'healthy', checkedAt: clock.now().toISOString() }),
      dispose: () => Promise.resolve(),
    },
    normalizer: {
      id: `test-${sourceId}`,
      version: '1',
      sourceTypes: ['all', 'req'],
      normalize(item) {
        if (item.sourceType === 'req')
          return {
            entities: [],
            facts: [
              {
                subject: SELF,
                predicate: 'credit_requirements',
                value: item.payload as never,
                origin: 'authoritative',
              },
            ],
          };
        return {
          entities: (item.payload as CanonicalEntityInput[]).map((entity) => ({
            entity,
            deriveFacts: false,
          })),
        };
      },
    },
    metadata: {
      id: sourceId,
      name: sourceId,
      version: '1',
      product: sourceId,
      sourceLabel: sourceId,
      defaultAuthority: 'academic-system',
      capabilities: ['courses'],
      rawTypes: ['all', 'req'],
    } as never,
  });
}

async function setup(withRequirements: boolean): Promise<void> {
  uc = createUniContext({ clock });
  passThrough('lcu', [
    { sourceType: 'all', externalId: 'own', payload: [...OWN, ...GRADES] },
    ...(withRequirements
      ? [{ sourceType: 'req', externalId: 'req', payload: REQUIREMENTS } as RawItem]
      : []),
  ]);
  passThrough('syllabus', [{ sourceType: 'all', externalId: 'catalog', payload: CATALOG }]);
  expect((await uc.sync.sync('lcu')).ok).toBe(true);
  expect((await uc.sync.sync('syllabus')).ok).toBe(true);
}

const strip = (rules: ReturnType<typeof syllabusDetailPriorities>) =>
  rules.map(({ reason: _reason, ...r }) => r);

describe('syllabusDetailPriorities', () => {
  it('ranks registrations (by class when listed), unfilled requirements and the department', async () => {
    await setup(true);
    const rules = strip(syllabusDetailPriorities(uc, { syllabusSourceIds: ['syllabus'] }));
    expect(rules).toEqual([
      // The syllabus lists 情工１, so only that class of 生命科学 is "enrolled".
      {
        priority: 'enrolled',
        subjectCode: '16111007',
        year: 2026,
        semester: '2',
        className: '情工１',
      },
      // 再履修（情）１ is not a syllabus class: every class of the course that term.
      { priority: 'enrolled', subjectCode: '77301020', year: 2026, semester: '1' },
      // Not passed, in an unfilled requirement (the grades give the code of a title).
      { priority: 'needed', subjectCode: '77401180' },
      { priority: 'needed', title: 'オペレーティングシステム' },
      // 選択 of an unfilled requirement.
      { priority: 'department', title: 'ネットワークプログラミング' },
      // 選択 of the unfilled 教養科目 選択 (inherited through the groups without numbers).
      { priority: 'department', title: '中級英語Ａ' },
      // The group whose （必修） course is the student's 必 course.
      { priority: 'department', category: '情報科学科-情報科学科(選択)' },
      { priority: 'department', category: '情報科学科-情報科学科(選択必修)' },
    ]);
    // Not there: passed (プログラミング), taking now (情報科学実験B), a filled requirement
    // (心理と行動Ａ) and courses outside the graduation requirement (博物館教育論).
    const titles = rules.map((r) => r.title);
    for (const t of ['プログラミング', '情報科学実験B', '心理と行動Ａ', '博物館教育論', '日本語Ⅰ'])
      expect(titles).not.toContain(t);
  });

  it('falls back to the grades without requirement data: failed 必 needed, failed 選択 department', async () => {
    await setup(false);
    const rules = strip(syllabusDetailPriorities(uc, { syllabusSourceIds: ['syllabus'] }));
    expect(rules.filter((r) => r.priority !== 'enrolled')).toEqual([
      { priority: 'needed', subjectCode: '77401180' },
      { priority: 'department', subjectCode: '74500130' },
      { priority: 'department', category: '情報科学科-情報科学科(選択)' },
      { priority: 'department', category: '情報科学科-情報科学科(選択必修)' },
    ]);
  });

  it('reads the semester of printed terms', () => {
    expect(semesterOfTerm('前期')).toBe('1');
    expect(semesterOfTerm('後期')).toBe('2');
    expect(semesterOfTerm('前期　～　後期（通年）')).toBe('1');
    expect(semesterOfTerm('集中')).toBeUndefined();
    expect(semesterOfTerm(undefined)).toBeUndefined();
  });
});
