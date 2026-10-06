import { type CanonicalEntityInput, stableId } from '@unicontext/canonical-model';
import {
  createUniContext,
  type DetailFetchReport,
  fetchDetailsOnRequest,
  type UniContext,
} from '@unicontext/context-engine';
import {
  defineMetadata,
  type DetailFetchAdapter,
  type DetailFetchResult,
  type NormalizeOutput,
  type Normalizer,
  type RawItem,
} from '../../../packages/connector-sdk/src/index.js';
import { ManualClock } from '@unicontext/core';
import { describe, expect, it } from 'vitest';
import {
  createSyllabusNormalizer,
  emptySyllabusDetail,
  metadata as syllabusMetadata,
  rowKey,
  type SyllabusDetail,
  type SyllabusEntryPayload,
} from '../../../connectors/syllabus/src/index.js';
import {
  getSyllabus,
  getSyllabusFetching,
  searchSyllabus,
  type SyllabusDetailFetcher,
} from '../src/syllabus.js';

/*
 * get_syllabus on a course whose detail the budgeted catalog sync has not read yet (read on the
 * spot through the connector, or queued), and the class of the student's 全学教育 course.
 */

const IN = '2026年度　情報学部 [IN-B]';
const LA_S = '2026年度　全学教育科目（静岡） [LA-S]';
const LA_H = '2026年度　全学教育科目（浜松） [LA-H]';

interface Spec {
  code: string;
  name: string;
  className: string;
  title: string;
  semester: '前期' | '後期';
  slot: string;
  category: string;
}

function entry(spec: Spec, detail?: Partial<SyllabusDetail>): RawItem {
  const columns: Record<string, string> = {
    講義名: spec.name,
    担当教員: '教員　花子',
    クラス: spec.className,
    タイトル: spec.title,
    カテゴリ: spec.category,
    科目コード: spec.code,
    ナンバリング: '',
    学年: '2年、3年',
    開講学期: spec.semester,
    '曜日・時限': spec.slot,
  };
  const payload: SyllabusEntryPayload = {
    strategy: 'lcu-public',
    url: 'https://lcu.example.ac.jp/lcu-web/SC_06001B00_21/init',
    title: spec.title,
    titleCode: '2243',
    year: 2026,
    subjectCode: spec.code,
    className: spec.className,
    categories: [spec.category],
    row: columns,
    detail: detail
      ? { ...emptySyllabusDetail(), name: spec.name, ...detail }
      : emptySyllabusDetail(),
    ...(detail ? {} : { detailFetched: false }),
  };
  return { sourceType: 'syllabus.entry', externalId: rowKey(columns), payload };
}

const OS: Spec = {
  code: '77401230',
  name: 'オペレーティングシステム',
  className: '1クラス',
  title: IN,
  semester: '前期',
  slot: '月3・4',
  category: '情報科学科-情報科学科（必修）',
};
const BIO_SHIZUOKA: Spec = {
  code: '16111007',
  name: '生命科学',
  className: '学部共通２',
  title: LA_S,
  semester: '後期',
  slot: '月5・6',
  category: '教養領域Ｂ（自然）',
};
const BIO_HAMAMATSU: Spec = { ...BIO_SHIZUOKA, className: '情工１', title: LA_H, slot: '火3・4' };

const OS_DETAIL: Partial<SyllabusDetail> = {
  credits: 2,
  requirement: '必修',
  prerequisites: '「計算機アーキテクチャⅠ」を修得していることが望ましい。',
  evaluation: '期末試験 70%、レポート 30%。',
  plan: [{ no: '1', content: 'OSの役割' }],
};

type FetchMode = 'detail' | 'queue' | 'hang';

/** A syllabus source that lists rows only and reads a detail on request (like the connector). */
function syllabusAdapter(state: { mode: FetchMode; calls: string[][] }): DetailFetchAdapter {
  const rows = [OS, BIO_SHIZUOKA, BIO_HAMAMATSU].map((s) => entry(s));
  return {
    id: 'syllabus',
    version: '1',
    capabilities: () => Promise.resolve(['courses']),
    authenticate: () => Promise.resolve({ status: 'not_required' }),
    sync: () =>
      Promise.resolve({
        items: rows,
        hasMore: false,
        complete: { sourceTypes: ['syllabus.entry'] },
      }),
    health: () => Promise.resolve({ state: 'healthy', checkedAt: '2026-10-06T00:00:00.000Z' }),
    dispose: () => Promise.resolve(),
    fetchDetails(requests): Promise<DetailFetchResult> {
      state.calls.push(requests.map((r) => r.externalId));
      if (state.mode === 'hang') return new Promise(() => undefined);
      if (state.mode === 'queue')
        return Promise.resolve({
          items: [],
          results: requests.map((r) => ({
            externalId: r.externalId,
            status: 'queued' as const,
            error: 'rate limited',
          })),
          warnings: [],
        });
      const item = entry(OS, OS_DETAIL);
      return Promise.resolve({
        items: [item],
        results: requests.map((r) => ({
          externalId: r.externalId,
          status: r.externalId === item.externalId ? ('fetched' as const) : ('notFound' as const),
        })),
        warnings: [],
      });
    },
  };
}

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

const SELF = stableId('person', 'lcu', 'self');
const LCU_BIO = stableId('courseOffering', 'lcu', 'bio');

const lcuNormalizer: Normalizer = {
  id: 'test-lcu',
  version: '1',
  sourceTypes: ['test.entities'],
  normalize: (): NormalizeOutput => ({
    entities: (
      [
        { id: SELF, kind: 'person', name: '本人', roles: ['student'], isSelf: true },
        {
          id: LCU_BIO,
          kind: 'courseOffering',
          title: '生命科学',
          courseCode: '16111007',
          academicYear: 2026,
          term: '後期',
          instructorNames: [],
          schedule: [],
          extra: { className: '情工１', credits: 2 },
        },
        {
          id: stableId('enrollment', 'lcu', 'bio'),
          kind: 'enrollment',
          personId: SELF,
          courseOfferingId: LCU_BIO,
          role: 'student',
          status: 'active',
        },
      ] as CanonicalEntityInput[]
    ).map((entity) => ({ entity, ref: { url: 'https://lcu.example.ac.jp/lcu-web/' } })),
  }),
};

async function createUc(mode: FetchMode = 'detail') {
  const state = { mode, calls: [] as string[][] };
  const uc = createUniContext({
    profile: 'shizuoka-university',
    clock: new ManualClock('2026-10-06T00:30:00.000Z'),
  });
  uc.sync.register({
    sourceId: 'syllabus',
    adapter: syllabusAdapter(state),
    normalizer: createSyllabusNormalizer(),
    metadata: syllabusMetadata,
  });
  uc.sync.register({
    sourceId: 'lcu',
    adapter: {
      id: 'lcu',
      version: '1',
      capabilities: () => Promise.resolve(['courses']),
      authenticate: () => Promise.resolve({ status: 'not_required' }),
      sync: () =>
        Promise.resolve({
          items: [{ sourceType: 'test.entities', externalId: 'all', payload: {} }],
          hasMore: false,
        }),
      health: () => Promise.resolve({ state: 'healthy', checkedAt: '2026-10-06T00:00:00.000Z' }),
      dispose: () => Promise.resolve(),
    },
    normalizer: lcuNormalizer,
    metadata: lcuMetadata,
  });
  expect((await uc.sync.sync('syllabus')).ok).toBe(true);
  expect((await uc.sync.sync('lcu')).ok).toBe(true);
  await uc.runPipeline();
  return { uc, state };
}

type Data = {
  ambiguous: boolean;
  syllabus?: Record<string, unknown> & { id: string };
  sections?: { heading: string; text: string }[];
  notes?: string[];
};

const inProcess = (uc: UniContext, waitMs?: number): SyllabusDetailFetcher => ({
  fetch: (ids) => fetchDetailsOnRequest(uc, ids),
  ...(waitMs !== undefined ? { waitMs } : {}),
});

describe('get_syllabus reads a missing detail on the spot', () => {
  it('fetches the detail of a list-only course and answers with credits, 受講要件 and 成績評価', async () => {
    const { uc, state } = await createUc();
    const before = getSyllabus(uc, { course: '77401230' }).data as Data;
    expect(before.syllabus).toMatchObject({ detailFetched: false, credits: null });
    expect(before.notes?.[0]).toMatch(/まだ取得していません/);

    const d = (await getSyllabusFetching(uc, { course: '77401230' }, inProcess(uc))).data as Data;
    expect(state.calls).toEqual([[entry(OS).externalId]]);
    expect(d.syllabus).toMatchObject({
      id: before.syllabus?.id,
      detailFetched: true,
      credits: 2,
      requirement: '必修',
    });
    const sections = new Map((d.sections ?? []).map((s) => [s.heading, s.text]));
    expect(sections.get('受講要件')).toContain('計算機アーキテクチャⅠ');
    expect(sections.get('成績評価の方法・基準')).toContain('期末試験');
    expect(d.notes).toContain('シラバス詳細は、いま大学のシラバスから取得しました。');

    // Stored now: the next call reads it from the store without asking the connector again.
    const again = (await getSyllabusFetching(uc, { course: '77401230' }, inProcess(uc)))
      .data as Data;
    expect(again.syllabus).toMatchObject({ detailFetched: true, credits: 2 });
    expect(again.notes ?? []).toEqual([]);
    expect(state.calls).toHaveLength(1);
  });

  it('says the course is queued for the next sync when it cannot be read now', async () => {
    const { uc } = await createUc('queue');
    const d = (await getSyllabusFetching(uc, { course: '77401230' }, inProcess(uc))).data as Data;
    expect(d.syllabus).toMatchObject({ detailFetched: false });
    expect(d.notes?.[0]).toMatch(/次のシラバスの同期で最優先に取得します（理由: rate limited）/);
  });

  it('does not wait forever: answers with the list row and says the fetch is running', async () => {
    const { uc } = await createUc('hang');
    const d = (await getSyllabusFetching(uc, { course: '77401230' }, inProcess(uc, 20)))
      .data as Data;
    expect(d.syllabus).toMatchObject({ detailFetched: false });
    expect(d.notes?.[0]).toMatch(/いま取得しています/);
  });

  it('reports a failing fetch (e.g. daemon unreachable) without failing the tool', async () => {
    const { uc } = await createUc();
    const failing: SyllabusDetailFetcher = {
      fetch: (): Promise<DetailFetchReport> => Promise.reject(new Error('daemon unreachable')),
    };
    const d = (await getSyllabusFetching(uc, { course: '77401230' }, failing)).data as Data;
    expect(d.syllabus).toMatchObject({ detailFetched: false });
    expect(d.notes?.[0]).toMatch(/daemon unreachable/);
  });

  it('fetchDetailsOnRequest reports unknown ids and sources that cannot fetch details', async () => {
    const { uc } = await createUc();
    const report = await fetchDetailsOnRequest(uc, ['courseOffering:nope', LCU_BIO]);
    expect(report.results).toEqual([
      { id: 'courseOffering:nope', status: 'notFound' },
      { id: LCU_BIO, status: 'unsupported' },
    ]);
    await expect(fetchDetailsOnRequest(uc, [])).rejects.toThrow(/at least one/);
  });
});

describe('the class of the student 全学教育 course', () => {
  type Item = { id: string; className: string | null; enrolled: boolean };

  it('marks only the class the student takes as enrolled (not the other campus class)', async () => {
    const { uc } = await createUc();
    const d = searchSyllabus(uc, { query: '生命科学' }).data as { items: Item[] };
    expect(d.items.map((i) => [i.className, i.enrolled]).sort()).toEqual([
      ['学部共通２', false],
      ['情工１', true],
    ]);
  });

  it('get_syllabus with the student own offering id shows that class', async () => {
    const { uc } = await createUc();
    const d = getSyllabus(uc, { course: LCU_BIO }).data as Data;
    expect(d.syllabus).toMatchObject({ className: '情工１', slots: '火3・4' });
  });

  it('fitsMyTimetable does not offer another class of a course the student takes', async () => {
    const { uc } = await createUc();
    const d = searchSyllabus(uc, { query: '生命科学', fitsMyTimetable: true }).data as {
      items: Item[];
    };
    expect(d.items).toEqual([]);
  });
});
