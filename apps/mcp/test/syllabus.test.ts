import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CanonicalEntityInput, stableId } from '@unicontext/canonical-model';
import { createUniContext, parseReportTermText, type UniContext } from '@unicontext/context-engine';
import {
  defineMetadata,
  type NormalizeOutput,
  type Normalizer,
  type RawItem,
  type SourceAdapter,
} from '../../../packages/connector-sdk/src/index.js';
import { loadProfile, ManualClock, NotFoundError, ValidationError } from '@unicontext/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createSyllabusNormalizer,
  emptySyllabusDetail,
  metadata as syllabusMetadata,
  parseDetail,
  parseResults,
  rowKey,
  type SyllabusDetail,
  type SyllabusEntryPayload,
} from '../../../connectors/syllabus/src/index.js';
import { buildEnvelope } from '../src/envelope.js';
import {
  CREDIT_SUMMARY_DESCRIPTION,
  creditSummaryShape,
  GET_SYLLABUS_DESCRIPTION,
  getCreditSummary,
  getSyllabus,
  getSyllabusShape,
  parseGradeYears,
  parseSlotText,
  SEARCH_SYLLABUS_DESCRIPTION,
  searchSyllabus,
  searchSyllabusShape,
} from '../src/syllabus.js';
import { createSeeded } from './seeded.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const samples = path.join(here, '..', '..', '..', 'docs', 'research', 'samples');
const sample = (name: string): string => readFileSync(path.join(samples, name), 'utf8');

// ---------------------------------------------------------------------------------------------
// syllabus entries built from the sanitized LCU samples
// ---------------------------------------------------------------------------------------------

const resultRows = parseResults(sample('lcu-syllabus-search-result-SC_06001B00_21.html')).rows;
const sampleDetail = parseDetail(sample('lcu-syllabus-detail-SC_06001B00_22.html')).detail;
const URL_ENTRY = 'https://lcu.example.ac.jp/lcu-web/SC_06001B00_21/init';
const IN_26 = '2026年度　情報学部 [IN-B]';
const IN_27 = '2027年度　情報学部 [IN-B]';
const LA_26 = '2026年度　全学教育科目（静岡） [LA-S]';

interface EntrySpec {
  base?: number;
  code: string;
  name: string;
  teacher?: string;
  className?: string;
  title?: string;
  category: string;
  numbering?: string;
  grade: string;
  semester: '前期' | '後期';
  slot: string;
  /** Opened syllabus detail: the parsed sample page, or fields on an empty page (omit: list row only). */
  detail?: 'sample' | Partial<SyllabusDetail>;
  year?: number;
}

function entry(spec: EntrySpec): RawItem {
  const columns: Record<string, string> = {
    ...(resultRows[spec.base ?? 0]?.columns ?? {}),
    講義名: spec.name,
    担当教員: spec.teacher ?? '山田　太郎',
    クラス: spec.className ?? '1クラス',
    タイトル: spec.title ?? IN_26,
    カテゴリ: spec.category,
    科目コード: spec.code,
    ナンバリング: spec.numbering ?? '',
    学年: spec.grade,
    開講学期: spec.semester,
    '曜日・時限': spec.slot,
  };
  const payload: SyllabusEntryPayload = {
    strategy: 'lcu-public',
    url: URL_ENTRY,
    title: columns['タイトル'] ?? '',
    titleCode: '2243',
    year: spec.year ?? 2026,
    subjectCode: spec.code,
    className: columns['クラス'] ?? '',
    categories: [spec.category],
    row: columns,
    detail:
      spec.detail === 'sample'
        ? sampleDetail
        : spec.detail
          ? ({ ...emptySyllabusDetail(), name: spec.name, ...spec.detail } as SyllabusDetail)
          : emptySyllabusDetail(),
    ...(spec.detail ? {} : { detailFetched: false }),
  };
  return { sourceType: 'syllabus.entry', externalId: rowKey(columns), payload };
}

const CATALOG: EntrySpec[] = [
  {
    // the sample syllabus itself: 後期 木3・4, 選必, 2 credits, full detail
    code: '77403030',
    name: 'データベースシステム論',
    teacher: '教員　花子',
    category: '行動情報学科-行動情報学科（選択）',
    numbering: 'IN002160080',
    grade: '2年、3年、4年',
    semester: '後期',
    slot: '木3・4',
    detail: 'sample',
  },
  {
    base: 1,
    code: '77501090',
    name: 'データベース論',
    category: '行動情報学科-行動情報学科（必修）',
    grade: '2年、3年、4年',
    semester: '前期',
    slot: '金9・10',
  },
  {
    code: '11100100',
    name: '線形代数学',
    title: LA_26,
    category: '全学教育科目-基礎科目（必修）',
    grade: '1年',
    semester: '後期',
    slot: '月1・2',
  },
  {
    code: '77100200',
    name: 'プログラミング演習',
    teacher: '佐藤　次郎',
    category: '情報科学科-情報科学科（必修）',
    grade: '1年、2年',
    semester: '後期',
    slot: '木3・4',
    detail: {
      credits: 1,
      requirement: '必修',
      grade: '1年、2年',
      instructors: ['佐藤 次郎'],
      dayPeriod: '木3・4',
      slots: [{ dayOfWeek: 4, period: 2, rawPeriod: '3・4' }],
      semester: '後期',
      goals: 'アルゴリズムを実装できるようになる。' + 'あ'.repeat(2000),
      content: '配列と再帰の演習。',
      keywords: ['プログラミング'],
      room: '情報学部棟202',
      plan: [{ no: '1', content: '導入' }],
      textbook: '配布資料',
    },
  },
  {
    // same course, second class (other teacher), list row only
    code: '77100200',
    name: 'プログラミング演習',
    className: '2クラス',
    teacher: '鈴木　三郎',
    category: '情報科学科-情報科学科（必修）',
    grade: '1年、2年',
    semester: '後期',
    slot: '金1・2',
  },
  {
    code: '77200300',
    name: '機械学習入門',
    title: IN_27,
    year: 2027,
    category: '情報科学科-情報科学科（選択）',
    grade: '3〜4',
    semester: '前期',
    slot: '火5・6',
  },
  {
    code: '77300001',
    name: '集中講義特論',
    category: '情報社会学科-情報社会学科（選択）',
    grade: '全学年',
    semester: '後期',
    slot: '集中',
  },
];

// ---------------------------------------------------------------------------------------------
// the student's own LiveCampusU-like data (offerings with credits, enrollments, grades)
// ---------------------------------------------------------------------------------------------

const lcuMetadata = defineMetadata({
  name: '@unicontext/livecampusu',
  product: 'livecampusu',
  version: '1.0.0',
  license: 'MIT',
  capabilities: ['courses'],
  adapter: 'native',
  apiStability: 'unofficial',
  risk: 'unsupported',
  testedVersion: 'test',
  defaultAuthority: 'academic-system',
  sourceLabel: '学務情報システム',
  rawTypes: ['test.entities'],
});

const lcuId = <K extends 'courseOffering' | 'person' | 'enrollment' | 'grade' | 'course'>(
  kind: K,
  key: string,
) => stableId(kind, 'lcu', key);

interface Offering {
  key: string;
  code: string;
  title: string;
  year: number;
  term: string;
  credits?: number;
  status?: 'active' | 'dropped';
}

const OFFERINGS: Offering[] = [
  {
    key: 'db',
    code: '77403030',
    title: 'データベースシステム論',
    year: 2026,
    term: '後期',
    credits: 2,
  },
  { key: 'la', code: '11100100', title: '線形代数学', year: 2026, term: '後期', credits: 2 },
  {
    key: 'en',
    code: '11000001',
    title: '英語コミュニケーション',
    year: 2026,
    term: '後期',
    credits: 1,
  },
  { key: 'seminar', code: '99900001', title: '情報ゼミナール', year: 2026, term: '後期' },
  {
    key: 'dropped',
    code: '99900002',
    title: 'やめた科目',
    year: 2026,
    term: '後期',
    credits: 2,
    status: 'dropped',
  },
  { key: 'p1', code: '11000100', title: '情報基礎', year: 2026, term: '前期', credits: 2 },
  { key: 'p2', code: '11000200', title: '数学基礎', year: 2026, term: '前期', credits: 2 },
];

interface GradeSpec {
  key: string;
  code?: string;
  term: string;
  credits: number;
  letter?: string;
  gradePoint?: number;
  extra?: Record<string, unknown>;
}
const GRADES: GradeSpec[] = [
  { key: 'g1', term: '2026前期', credits: 2, letter: '秀', gradePoint: 4 },
  { key: 'g2', term: '2026前期', credits: 2, letter: '良', gradePoint: 2 },
  // A retake: failed in 2025 後期 and again in 2026 前期.
  { key: 'g3', code: 'R1', term: '2026前期', credits: 2, letter: '不可', gradePoint: 0 },
  { key: 'g7', code: 'R1', term: '2025後期', credits: 2, letter: '不可', gradePoint: 0 },
  { key: 'g4', term: '2025後期', credits: 3, letter: '優', gradePoint: 3 },
  // No label at all, and a label outside the tables: both unknown, never counted.
  { key: 'g5', term: '2025後期', credits: 1 },
  { key: 'g6', term: '2025後期', credits: 2, letter: 'D', gradePoint: 1 },
  { key: 'g8', term: '2026前期', credits: 1, letter: '認定' },
  // The connector's own classification wins (LiveCampusU 再試 = waiting for the re-exam).
  {
    key: 'g9',
    term: '2026前期',
    credits: 2,
    letter: '再試',
    extra: { evaluation: '再試', outcome: 'not_graded', pendingReexam: true },
  },
];

function lcuEntities(): CanonicalEntityInput[] {
  const self = lcuId('person', 'self');
  const out: CanonicalEntityInput[] = [
    { id: self, kind: 'person', name: '本人', roles: ['student'], isSelf: true },
  ];
  for (const o of OFFERINGS) {
    const offering = lcuId('courseOffering', o.key);
    out.push({
      id: offering,
      kind: 'courseOffering',
      title: o.title,
      courseCode: o.code,
      academicYear: o.year,
      term: o.term,
      instructorNames: [],
      schedule: [],
      extra: o.credits === undefined ? {} : { credits: o.credits },
    });
    out.push({
      id: lcuId('enrollment', o.key),
      kind: 'enrollment',
      personId: self,
      courseOfferingId: offering,
      role: 'student',
      status: o.status ?? 'active',
    });
  }
  for (const g of GRADES)
    out.push({
      id: lcuId('grade', g.key),
      kind: 'grade',
      ...(g.letter ? { letter: g.letter } : {}),
      ...(g.gradePoint !== undefined ? { gradePoint: g.gradePoint } : {}),
      extra: {
        credits: g.credits,
        reportTerm: g.term,
        subjectCode: g.code ?? g.key,
        subjectName: `科目${g.code ?? g.key}`,
        ...(g.extra ?? {}),
      },
    });
  return out;
}

function staticAdapter(id: string, items: RawItem[], types: string[]): SourceAdapter {
  return {
    id,
    version: '1',
    capabilities: () => Promise.resolve(['courses']),
    authenticate: () => Promise.resolve({ status: 'not_required' }),
    sync: () => Promise.resolve({ items, hasMore: false, complete: { sourceTypes: types } }),
    health: () => Promise.resolve({ state: 'healthy', checkedAt: '2026-10-01T00:30:00.000Z' }),
    dispose: () => Promise.resolve(),
  };
}

const lcuNormalizer: Normalizer = {
  id: 'test-lcu',
  version: '1',
  sourceTypes: ['test.entities'],
  normalize: (item): NormalizeOutput => ({
    entities: (item.payload as { entities: CanonicalEntityInput[] }).entities.map((entity) => ({
      entity,
      ref: { url: 'https://lcu.example.ac.jp/lcu-web/' },
    })),
  }),
};

async function createUc(
  options: { syllabus?: boolean; lcu?: boolean; capped?: boolean } = {},
): Promise<UniContext> {
  const clock = new ManualClock('2026-10-01T00:30:00.000Z'); // 2026-10-01 09:30 JST -> 2026 後期
  const base = loadProfile('shizuoka-university');
  const { registration, ...withoutCap } = base;
  const profile = options.capped === false ? withoutCap : { ...withoutCap, registration };
  const uc = createUniContext({ profile, clock });
  if (options.syllabus !== false) {
    uc.sync.register({
      sourceId: 'syllabus',
      adapter: staticAdapter('syllabus', CATALOG.map(entry), ['syllabus.entry']),
      normalizer: createSyllabusNormalizer(),
      metadata: syllabusMetadata,
    });
    expect((await uc.sync.sync('syllabus')).ok).toBe(true);
  }
  if (options.lcu !== false) {
    uc.sync.register({
      sourceId: 'lcu',
      adapter: staticAdapter(
        'lcu',
        [{ sourceType: 'test.entities', externalId: 'all', payload: { entities: lcuEntities() } }],
        ['test.entities'],
      ),
      normalizer: lcuNormalizer,
      metadata: lcuMetadata,
    });
    expect((await uc.sync.sync('lcu')).ok).toBe(true);
  }
  await uc.runPipeline();
  return uc;
}

type Item = {
  id: string;
  courseCode: string | null;
  title: string;
  term: string | null;
  academicYear: number | null;
  instructors: string[];
  slots: string | null;
  grade: string | null;
  requirement: string | null;
  credits: number | null;
  className: string | null;
  detailFetched: boolean;
  enrolled: boolean;
  url: string | null;
  source?: string;
  requirementFrom?: string;
};
type SearchData = {
  total: number;
  returned: number;
  items: Item[];
  coverage?: { term: string; count: number }[];
  notes?: string[];
};

const search = (uc: UniContext, args: Parameters<typeof searchSyllabus>[1]) =>
  searchSyllabus(uc, args).data as SearchData;
const codes = (d: SearchData) => d.items.map((i) => i.courseCode);

describe('tool metadata', () => {
  it('descriptions avoid wording that remote connector scanners flag', () => {
    const forbidden =
      /個人情報|personal information|authentication|no auth|password|パスワード|token|トークン|認証/i;
    for (const text of [
      SEARCH_SYLLABUS_DESCRIPTION,
      GET_SYLLABUS_DESCRIPTION,
      CREDIT_SUMMARY_DESCRIPTION,
    ]) {
      expect(text).not.toMatch(forbidden);
      expect(text).toMatch(/[぀-ヿ]/); // Japanese
      expect(text).toMatch(/ \/ [A-Z]/); // English part
    }
  });

  it('shapes accept the documented inputs (and null for omitted ones)', () => {
    const searchShape = z.object(searchSyllabusShape);
    expect(
      searchShape.parse({ query: 'データベース', dayOfWeek: '木', period: 2, grade: 2, limit: 5 }),
    ).toMatchObject({ dayOfWeek: '木', period: 2 });
    expect(searchShape.parse({ dayOfWeek: 4, term: null, query: null })).toMatchObject({
      dayOfWeek: 4,
    });
    expect(searchShape.safeParse({ limit: 51 }).success).toBe(false);
    expect(searchShape.safeParse({ period: 8 }).success).toBe(false);
    expect(z.object(getSyllabusShape).safeParse({}).success).toBe(false);
    expect(z.object(creditSummaryShape).parse({})).toEqual({});
  });
});

describe('helpers', () => {
  it('parses grade ranges, slots, report terms and marks', () => {
    expect([...(parseGradeYears('2年、3年、4年') as Set<number>)]).toEqual([2, 3, 4]);
    expect([...(parseGradeYears('1年,2年') as Set<number>)]).toEqual([1, 2]);
    expect([...(parseGradeYears('2〜4') as Set<number>)]).toEqual([2, 3, 4]);
    expect(parseGradeYears('全学年')).toBe('all');
    expect(parseSlotText('月3')).toEqual([{ dayOfWeek: 1, period: 3 }]);
    expect(parseSlotText('木3・4')).toEqual([{ dayOfWeek: 4, period: 2 }]);
    expect(() => parseSlotText('いつか')).toThrow(ValidationError);
    expect(parseReportTermText('2026前期')).toEqual({ academicYear: 2026, term: '前期' });
    expect(parseReportTermText('2025年度後期')).toEqual({ academicYear: 2025, term: '後期' });
    expect(parseReportTermText('2025年度 後期 後期前半')).toEqual({
      academicYear: 2025,
      term: '後期',
      termPart: '後期前半',
    });
  });
});

describe('search_syllabus', () => {
  it('lists the catalog newest first, concisely, with coverage and citations', async () => {
    const uc = await createUc();
    const out = searchSyllabus(uc, {});
    const d = out.data as SearchData;
    expect(d.total).toBe(7);
    expect(d.returned).toBe(7);
    // 2027 前期 first, then 2026 後期 (by day/period), then 2026 前期.
    expect(d.items[0]).toMatchObject({ courseCode: '77200300', academicYear: 2027, term: '前期' });
    expect(d.items.at(-1)).toMatchObject({ courseCode: '77501090', term: '前期' });
    expect(d.coverage).toEqual([
      { term: '2027年度 前期', count: 1 },
      { term: '2026年度 後期', count: 5 },
      { term: '2026年度 前期', count: 1 },
    ]);
    const db = d.items.find((i) => i.courseCode === '77403030')!;
    expect(db).toMatchObject({
      title: 'データベースシステム論',
      academicYear: 2026,
      term: '後期',
      instructors: ['教員 花子'],
      slots: '木3・4',
      grade: '2年、3年、4年',
      requirement: '選択必修', // "選必" on the syllabus page, spelled out
      credits: 2,
      className: '1クラス',
      detailFetched: true,
      url: URL_ENTRY,
    });
    expect(db.source).toMatch(/シラバス.*取得$/);
    const rowOnly = d.items.find((i) => i.courseCode === '11100100')!;
    expect(rowOnly).toMatchObject({
      detailFetched: false,
      credits: null,
      slots: '月1・2',
      grade: '1年',
      requirement: '必修', // derived from the category "（必修）"
      requirementFrom: 'category',
    });
    expect(d.notes?.join(' ')).toMatch(/詳細をまだ取得しておらず/);

    const envelope = buildEnvelope(out.data, out.options);
    expect(envelope.citations.length).toBeGreaterThan(0);
    expect(envelope.citations.length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(envelope).length).toBeLessThan(9000);
  });

  it('matches keywords in title, code, numbering, instructor and syllabus text (AND)', async () => {
    const uc = await createUc();
    expect(codes(search(uc, { query: 'データベース' })).sort()).toEqual(['77403030', '77501090']);
    expect(codes(search(uc, { query: '77403030' }))).toEqual(['77403030']);
    expect(codes(search(uc, { query: 'in002160080' }))).toEqual(['77403030']);
    expect(codes(search(uc, { query: '佐藤' }))).toEqual(['77100200']);
    expect(codes(search(uc, { query: '山田 線形' }))).toEqual(['11100100']);
    // only in the syllabus text of the opened detail ("アルゴリズムを実装")
    expect(codes(search(uc, { query: 'アルゴリズムを実装' }))).toEqual(['77100200']);
    expect(codes(search(uc, { query: '山田 アルゴリズム' }))).toEqual([]);
    expect(search(uc, { query: '存在しない科目名' }).total).toBe(0);
  });

  it('filters by year and term', async () => {
    const uc = await createUc();
    expect(codes(search(uc, { year: 2027 }))).toEqual(['77200300']);
    expect(search(uc, { year: 2026, term: '後期' }).total).toBe(5);
    expect(codes(search(uc, { term: '前期' })).sort()).toEqual(['77200300', '77501090']);
    expect(search(uc, { term: '2', year: 2026 }).total).toBe(5);
  });

  it('filters by day and period (pair index) and by slot text', async () => {
    const uc = await createUc();
    expect(codes(search(uc, { dayOfWeek: '木', period: 2 })).sort()).toEqual([
      '77100200',
      '77403030',
    ]);
    expect(search(uc, { dayOfWeek: 4 }).total).toBe(2);
    expect(codes(search(uc, { dayOfWeek: '木曜日', period: 1 }))).toEqual([]);
    expect(codes(search(uc, { dayOfWeek: '金', period: 1 }))).toEqual(['77100200']);
    // 金9・10 is the 5th period; 火5・6 the 3rd.
    expect(codes(search(uc, { period: 5 }))).toEqual(['77501090']);
    expect(codes(search(uc, { period: 3 }))).toEqual(['77200300']);
    // "月3" = Monday 3rd period; the printed "木3・4" = Thursday 2nd period; 月1・2 = period 1.
    expect(search(uc, { slot: '月3' }).total).toBe(0);
    expect(codes(search(uc, { slot: '月1' }))).toEqual(['11100100']);
    expect(codes(search(uc, { slot: '木3・4' })).sort()).toEqual(['77100200', '77403030']);
    // intensive courses have no slot, so day/period filters never return them
    expect(codes(search(uc, { dayOfWeek: '月' }))).toEqual(['11100100']);
    expect(() => searchSyllabus(uc, { dayOfWeek: 'あ' })).toThrow(ValidationError);
    expect(() => searchSyllabus(uc, { slot: 'xyz' })).toThrow(ValidationError);
  });

  it('filters by grade year, including ranges and "all grades"', async () => {
    const uc = await createUc();
    expect(codes(search(uc, { grade: 1 })).sort()).toEqual([
      '11100100',
      '77100200',
      '77100200',
      '77300001',
    ]);
    expect(codes(search(uc, { grade: 3 })).sort()).toEqual(
      ['77200300', '77300001', '77403030', '77501090'].sort(),
    );
    expect(codes(search(uc, { grade: 4 })).sort()).toContain('77200300');
    expect(codes(search(uc, { grade: 2, year: 2027 }))).toEqual([]);
  });

  it('filters by required / elective, using the page value or the category', async () => {
    const uc = await createUc();
    // 必修: 線形代数学 (category), プログラミング演習 (page), データベース論 (category); not 選択必修.
    expect(codes(search(uc, { requirement: '必修' })).sort()).toEqual([
      '11100100',
      '77100200',
      '77100200',
      '77501090',
    ]);
    expect(codes(search(uc, { requirement: '選択必修' }))).toEqual(['77403030']);
    expect(codes(search(uc, { requirement: '選択' })).sort()).toEqual(
      ['77200300', '77300001'].sort(),
    );
    expect(codes(search(uc, { requirement: '選必' }))).toEqual([]);
  });

  it('filters by credits (only rows whose credits are known)', async () => {
    const uc = await createUc();
    expect(codes(search(uc, { credits: 2 }))).toEqual(['77403030']);
    // both classes of the subject: the second one is a list row, its credits come from the subject
    expect(codes(search(uc, { credits: 1 }))).toEqual(['77100200', '77100200']);
    expect(codes(search(uc, { minCredits: 1, maxCredits: 2 })).sort()).toEqual([
      '77100200',
      '77100200',
      '77403030',
    ]);
    expect(search(uc, { minCredits: 3 }).total).toBe(0);
  });

  it('filters by faculty and category and combines filters', async () => {
    const uc = await createUc();
    expect(search(uc, { faculty: '全学教育' }).total).toBe(1);
    expect(search(uc, { faculty: 'IN-B', year: 2027 }).total).toBe(1);
    expect(codes(search(uc, { category: '情報社会学科' }))).toEqual(['77300001']);
    expect(
      codes(
        search(uc, { faculty: '情報学部', term: '後期', dayOfWeek: '木', requirement: '必修' }),
      ),
    ).toEqual(['77100200']);
  });

  it('caps the result size and says so', async () => {
    const uc = await createUc();
    const d = search(uc, { limit: 3 });
    expect(d.total).toBe(7);
    expect(d.returned).toBe(3);
    expect(d.notes?.join(' ')).toMatch(/先頭3件/);
    expect(search(uc, { limit: null }).returned).toBe(7);
  });

  it('marks courses the student is already taking', async () => {
    const uc = await createUc();
    const d = search(uc, { year: 2026, term: '後期' });
    const enrolled = d.items.filter((i) => i.enrolled).map((i) => i.courseCode);
    expect(enrolled.sort()).toEqual(['11100100', '77403030']);
  });

  it('reports an empty catalog without failing', async () => {
    const seeded = await createSeeded();
    const d = searchSyllabus(seeded.uc, { query: 'データ' }).data as SearchData;
    expect(d).toMatchObject({ total: 0, returned: 0, items: [] });
    expect(d.notes?.[0]).toMatch(/取り込まれていません/);
    expect(() => getSyllabus(seeded.uc, { course: 'x' })).toThrow(NotFoundError);
    const credits = getCreditSummary(seeded.uc, {}).data as CreditData;
    expect(credits.notes.join(' ')).toMatch(/目安|上限/);
  });
});

type SyllabusData = {
  ambiguous: boolean;
  message?: string;
  candidates?: { id: string; courseCode: string | null; title: string }[];
  syllabus?: Record<string, unknown> & { id: string };
  sections?: { heading: string; text: string; truncated?: boolean }[];
  sectionsTruncated?: boolean;
  otherOfferings?: { id: string; className: string | null }[];
  notes?: string[];
};

const syllabus = (uc: UniContext, args: Parameters<typeof getSyllabus>[1]) =>
  getSyllabus(uc, args).data as SyllabusData;

describe('get_syllabus', () => {
  it('returns header fields and the syllabus sections of a fetched detail', async () => {
    const uc = await createUc();
    const out = getSyllabus(uc, { course: '77403030' });
    const d = out.data as SyllabusData;
    expect(d.ambiguous).toBe(false);
    expect(d.syllabus).toMatchObject({
      courseCode: '77403030',
      numbering: 'IN002160080',
      title: 'データベースシステム論',
      titleEn: 'Database System',
      academicYear: 2026,
      term: '後期',
      slots: '木3・4',
      room: '共通講義棟３１',
      credits: 2,
      requirement: '選択必修',
      detailFetched: true,
      department: '情報学領域',
    });
    const headings = (d.sections ?? []).map((s) => s.heading);
    expect(headings).toEqual(
      expect.arrayContaining(['キーワード', '授業の目標', '授業計画', '成績評価の方法・基準']),
    );
    expect(headings).not.toContain('概要');
    const plan = d.sections?.find((s) => s.heading === '授業計画');
    expect(plan?.text).toContain('第1回');
    for (const s of d.sections ?? []) expect(s.text.length).toBeLessThanOrEqual(1501);
    const total = (d.sections ?? []).reduce((n, s) => n + s.text.length, 0);
    expect(total).toBeLessThanOrEqual(8000 + 20);

    const envelope = buildEnvelope(out.data, out.options);
    expect(envelope.citations.length).toBeGreaterThan(0);
  });

  it('truncates long sections and the total', async () => {
    const uc = await createUc();
    const d = syllabus(uc, { course: 'プログラミング演習', year: 2026 });
    expect(d.ambiguous).toBe(false);
    const goals = d.sections?.find((s) => s.heading === '授業の目標');
    expect(goals?.truncated).toBe(true);
    expect(goals?.text.length).toBe(1501);
    expect(d.sectionsTruncated).toBe(true);
  });

  it('resolves by id, code, numbering and (partial) title; prefers the newest year', async () => {
    const uc = await createUc();
    const id = (search(uc, { query: '77403030' }).items[0] as Item).id;
    expect(syllabus(uc, { course: id }).syllabus?.id).toBe(id);
    expect(syllabus(uc, { course: 'IN002160080' }).syllabus?.courseCode).toBe('77403030');
    expect(syllabus(uc, { course: 'データベースシステム論' }).syllabus?.courseCode).toBe(
      '77403030',
    );
    expect(syllabus(uc, { course: '機械学習' }).syllabus).toMatchObject({
      academicYear: 2027,
      title: '機械学習入門',
    });
    // the same course of another source: the student's own offering id maps to the syllabus
    const lcuOffering = lcuId('courseOffering', 'db');
    expect(syllabus(uc, { course: lcuOffering }).syllabus?.id).toBe(id);
  });

  it('lists candidates when the title matches several courses', async () => {
    const uc = await createUc();
    const d = syllabus(uc, { course: 'データベース' });
    expect(d.ambiguous).toBe(true);
    expect(d.candidates?.map((c) => c.courseCode).sort()).toEqual(['77403030', '77501090']);
    expect(d.syllabus).toBeUndefined();
    expect(d.message).toMatch(/複数/);
  });

  it('picks one class and lists the other classes of the same course', async () => {
    const uc = await createUc();
    const d = syllabus(uc, { course: '77100200' });
    expect(d.ambiguous).toBe(false);
    expect(d.otherOfferings).toHaveLength(1);
    expect(d.notes?.join(' ')).toMatch(/otherOfferings/);
    const other = d.otherOfferings?.[0];
    const second = syllabus(uc, { course: other?.id ?? '' });
    expect(second.syllabus).toMatchObject({ className: '2クラス', detailFetched: false });
    expect(second.sections).toEqual([]);
    expect(second.notes?.join(' ')).toMatch(/まだ取得していません/);
  });

  it('honors year and reports unknown courses as not found', async () => {
    const uc = await createUc();
    expect(() => getSyllabus(uc, { course: '機械学習入門', year: 2026 })).toThrow(NotFoundError);
    expect(() => getSyllabus(uc, { course: '存在しない科目' })).toThrow(NotFoundError);
    expect(syllabus(uc, { course: '機械学習入門', year: 2027 }).syllabus?.title).toBe(
      '機械学習入門',
    );
  });
});

type Outcomes = Record<string, number>;
type CreditTerm = {
  term: string;
  registeredCredits: number;
  registeredCourses: number;
  earnedCredits: number;
  failedCredits: number;
  inProgressCredits: number;
  notGradedCredits: number;
  withdrawnCredits: number;
  transferredCredits: number;
  unknownCredits: number;
  gradedCourses: number;
  outcomeCounts: Outcomes | null;
};
type CreditAttempt = {
  academicYear: number | null;
  term: string | null;
  evaluation: string;
  outcome: string;
  pendingReexam?: boolean;
};
type CreditData = {
  currentTerm: { academicYear: number; term: string; label: string };
  cap: { perTerm: number | null; perYear: number | null; note: string | null } | null;
  registeredThisTerm: { credits: number; courses: number; unknownCreditCourses: number };
  remainingUnderCap: number | null;
  terms: CreditTerm[];
  years: { academicYear: number | null; earnedCredits: number; failedCredits: number }[];
  totals: Omit<CreditTerm, 'term' | 'registeredCourses' | 'gradedCourses' | 'outcomeCounts'>;
  earnedCreditsAllYears: number;
  evaluationLabels: { evaluation: string; outcome: string; count: number }[];
  courses: {
    subjectCode?: string;
    title: string;
    status: string;
    statusEvaluation: string;
    earned: boolean;
    attemptCount: number;
    failedAttempts: number;
    latest: CreditAttempt;
    attempts: CreditAttempt[];
  }[];
  coursesNotEarned: { subjectCode?: string; latestOutcome: string; failedAttempts: number }[];
  requirements: unknown;
  notes: string[];
};

describe('get_credit_summary', () => {
  it('sums registered and earned credits per term and applies the profile cap', async () => {
    const uc = await createUc();
    const out = getCreditSummary(uc, {});
    const d = out.data as CreditData;
    expect(d.currentTerm).toEqual({ academicYear: 2026, term: '後期', label: '2026 後期' });
    // 2026 後期: データベース 2 + 線形代数 2 + 英語 1 = 5 (ゼミ has no credits; やめた科目 dropped)
    expect(d.registeredThisTerm).toEqual({ credits: 5, courses: 4, unknownCreditCourses: 1 });
    expect(d.cap).toMatchObject({ perTerm: 24, perYear: null });
    expect(d.cap?.note).toMatch(/履修制限科目/);
    expect(d.remainingUnderCap).toBe(19);

    const byTerm = Object.fromEntries(d.terms.map((t) => [t.term, t]));
    expect(d.terms.map((t) => t.term)).toEqual(['2025 後期', '2026 前期', '2026 後期']);
    expect(byTerm['2026 前期']).toMatchObject({
      registeredCredits: 4,
      registeredCourses: 2,
      earnedCredits: 5, // 秀 2 + 良 2 + 認定 1
      transferredCredits: 1,
      failedCredits: 2, // 不可
      notGradedCredits: 2, // 再試 (waiting for the re-exam)
      unknownCredits: 0,
      gradedCourses: 5,
    });
    expect(byTerm['2025 後期']).toMatchObject({
      registeredCourses: 0,
      earnedCredits: 3, // 優 3; D is not a known label
      failedCredits: 2,
      unknownCredits: 3, // no label (1) + D (2): never counted as passed or failed
      gradedCourses: 4,
    });
    expect(byTerm['2026 後期']).toMatchObject({ registeredCredits: 5, earnedCredits: 0 });
    expect(d.totals).toMatchObject({
      registeredCredits: 9,
      earnedCredits: 8,
      failedCredits: 4,
      notGradedCredits: 2,
      unknownCredits: 3,
    });
    expect(d.earnedCreditsAllYears).toBe(8);
    expect(d.years.map((y) => [y.academicYear, y.earnedCredits, y.failedCredits])).toEqual([
      [2025, 3, 2],
      [2026, 5, 2],
    ]);

    // Every attempt per course, oldest first, with the verbatim label and its outcome.
    const retake = d.courses.find((c) => c.subjectCode === 'R1');
    expect(retake).toMatchObject({
      title: '科目R1',
      attemptCount: 2,
      failedAttempts: 2,
      earned: false,
      status: 'failed',
      statusEvaluation: '不可',
      latest: { academicYear: 2026, term: '前期', evaluation: '不可', outcome: 'failed' },
    });
    expect(retake?.attempts.map((a) => [a.academicYear, a.term])).toEqual([
      [2025, '後期'],
      [2026, '前期'],
    ]);
    expect(d.courses.find((c) => c.subjectCode === 'g9')?.latest).toMatchObject({
      evaluation: '再試',
      outcome: 'not_graded',
      pendingReexam: true,
    });
    expect(d.courses.find((c) => c.subjectCode === 'g6')).toMatchObject({
      statusEvaluation: 'D',
      status: 'unknown',
    });
    expect(d.coursesNotEarned.map((c) => c.subjectCode).sort()).toEqual(['R1', 'g5', 'g6', 'g9']);
    expect(d.evaluationLabels).toEqual(
      expect.arrayContaining([
        { evaluation: '不可', outcome: 'failed', count: 2 },
        { evaluation: 'D', outcome: 'unknown', count: 1 },
        { evaluation: '', outcome: 'unknown', count: 1 },
        { evaluation: '認定', outcome: 'transferred', count: 1 },
      ]),
    );
    const notes = d.notes.join('\n');
    expect(notes).toMatch(/目安/);
    expect(notes).toMatch(/単位数が不明/);
    expect(notes).toMatch(
      /区分を判定できない評価があります（空欄、D）|区分を判定できない評価があります（D、空欄）/,
    );

    const envelope = buildEnvelope(out.data, out.options);
    expect(envelope.citations.length).toBeGreaterThan(0);
    expect(envelope.citations.length).toBeLessThanOrEqual(5);
  });

  it('can be limited to one academic year', async () => {
    const uc = await createUc();
    const d = getCreditSummary(uc, { year: 2025 }).data as CreditData;
    expect(d.terms.map((t) => t.term)).toEqual(['2025 後期']);
    expect(d.totals).toMatchObject({ earnedCredits: 3, registeredCredits: 0 });
    // the retake is listed with its whole history even when only one year is asked for
    expect(d.courses.find((c) => c.subjectCode === 'R1')?.attemptCount).toBe(2);
    // registered-this-term and all-years earned credits do not depend on the filter
    expect(d.registeredThisTerm.credits).toBe(5);
    expect(d.earnedCreditsAllYears).toBe(8);
    expect(getCreditSummary(uc, { year: null }).data).toHaveProperty('terms');
  });

  it('says the cap is unknown when the profile has none', async () => {
    const uc = await createUc({ capped: false });
    const d = getCreditSummary(uc, {}).data as CreditData;
    expect(d.cap).toBeNull();
    expect(d.remainingUnderCap).toBeNull();
    expect(d.notes.join('\n')).toMatch(/上限単位数はプロフィールに設定されていません（不明）/);
    expect(d.registeredThisTerm.credits).toBe(5);
  });

  it('works without any student data', async () => {
    const uc = await createUc({ lcu: false, syllabus: false });
    const d = getCreditSummary(uc, {}).data as CreditData;
    expect(d.terms).toEqual([]);
    expect(d.registeredThisTerm).toEqual({ credits: 0, courses: 0, unknownCreditCourses: 0 });
    expect(d.remainingUnderCap).toBe(24);
    expect(d.notes.join('\n')).toMatch(/まだ取り込まれていません/);
  });
});
