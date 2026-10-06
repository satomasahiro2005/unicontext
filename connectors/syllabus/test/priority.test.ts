import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RawItem, SyncResult } from '@unicontext/connector-sdk';
import { ManualClock } from '@unicontext/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DETAIL_RANK,
  MAX_DETAIL_FETCH_PER_CALL,
  orderDetailCandidates,
  SyllabusAdapter,
  SyllabusConfigSchema,
  type SyllabusDetailPriority,
  type SyllabusEntryPayload,
} from '../src/index.js';
import { BASE, makeContext } from './helpers.js';
import { type CatalogRow, createLcuServer, type LcuServerOptions } from './lcu-server.js';

/*
 * Detail priority (the student's courses before the general backlog) and the on-demand detail
 * fetch of one row (get_syllabus on a list-only entry).
 */

const IN = '2026年度　情報学部 [IN-B]';
const LA_H = '2026年度　全学教育科目（浜松） [LA-H]';

function row(
  code: string,
  name: string,
  semester: '前期' | '後期',
  faculty: 'IN-B' | 'LA-H',
  category: string,
  extra: Partial<CatalogRow> = {},
): CatalogRow {
  return {
    name,
    teacher: '教員　花子',
    titleCode: faculty === 'IN-B' ? '2243' : '2249',
    title: faculty === 'IN-B' ? IN : LA_H,
    category,
    code,
    grade: '2年、3年',
    semester,
    slot: '月1・2',
    ...extra,
  };
}

const CATALOG: CatalogRow[] = [
  row('77000001', '一般の科目', '前期', 'IN-B', '情報社会学科-情報社会学科（選択）'),
  row('77000002', '選択の科目', '前期', 'IN-B', '情報科学科-情報科学科（選択）'),
  row('77401230', 'オペレーティングシステム', '前期', 'IN-B', '情報科学科-情報科学科（必修）'),
  // The category text of a department, but listed in the campus 全学教育 catalog.
  row('16000001', '全学の科目', '前期', 'LA-H', '情報科学科-情報科学科（選択）'),
  row('77000004', '履修中の科目', '後期', 'IN-B', '情報科学科-情報科学科（必修）'),
  row('16111007', '生命科学', '後期', 'LA-H', '教養領域B（自然）', { className: 'P1' }),
  row('16111007', '生命科学', '後期', 'LA-H', '教養領域B（自然）', { className: 'P2' }),
];

const PRIORITIES: SyllabusDetailPriority[] = [
  { priority: 'enrolled', subjectCode: '77000004', year: 2026, semester: '2' },
  { priority: 'enrolled', subjectCode: '16111007', year: 2026, semester: '2', className: 'P1' },
  { priority: 'needed', title: 'オペレーティングシステム' },
  { priority: 'department', category: '情報科学科（選択）' },
];

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'uc-syllabus-prio-'));
  tmpDirs.push(d);
  return d;
}

function setup(
  options: {
    detailsPerRun?: number;
    priorities?: unknown[] | (() => never);
    server?: LcuServerOptions;
    cacheDir?: string;
    clock?: ManualClock;
  } = {},
) {
  const srv = createLcuServer({ catalog: CATALOG, ...(options.server ?? {}) });
  const clock = options.clock ?? new ManualClock('2026-10-06T03:00:00.000Z');
  const cfg = SyllabusConfigSchema.parse({
    deployment: 'shizuoka',
    baseUrl: BASE,
    minRequestIntervalMs: 0,
    // IN-B brings its campus 全学教育 LA-H; `year` = 2026 前期 and 後期.
    catalog: { faculties: ['IN-B'], terms: ['year'], detailsPerRun: options.detailsPerRun ?? 0 },
  });
  const adapter = new SyllabusAdapter(
    makeContext(cfg, srv.fetch, undefined, { clock, cacheDir: options.cacheDir }),
  );
  const p = options.priorities;
  if (p)
    adapter.priorityProvider =
      typeof p === 'function' ? p : () => p as readonly SyllabusDetailPriority[];
  return { srv, adapter, clock };
}

async function runAll(
  adapter: SyllabusAdapter,
): Promise<{ items: RawItem[]; pages: SyncResult[] }> {
  const pages: SyncResult[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 30; i++) {
    const res = await adapter.sync({ mode: 'incremental', ...(pageToken ? { pageToken } : {}) });
    pages.push(res);
    if (!res.hasMore) break;
    pageToken = res.nextPageToken;
  }
  return { items: pages.flatMap((p) => p.items), pages };
}

const payload = (i: RawItem) => i.payload as SyllabusEntryPayload;
const find = (items: RawItem[], code: string, cls = '1クラス') =>
  items.find((i) => payload(i).subjectCode === code && payload(i).className === cls)!;

describe('orderDetailCandidates', () => {
  it('orders by rank, never-fetched before stale (stalest first), listings taking turns', () => {
    const c = (key: string, rank: number, unit: number, fetchedAt?: string) => ({
      key,
      rank,
      unit,
      fetchedAt,
    });
    const order = orderDetailCandidates([
      c('other-a', DETAIL_RANK.other, 0),
      c('ge-stale-new', DETAIL_RANK.generalEducation, 1, '2026-09-01T00:00:00Z'),
      c('ge-stale-old', DETAIL_RANK.generalEducation, 1, '2026-08-01T00:00:00Z'),
      c('ge-never', DETAIL_RANK.generalEducation, 1),
      c('dept-u0-1', DETAIL_RANK.department, 0),
      c('dept-u0-2', DETAIL_RANK.department, 0),
      c('dept-u2-1', DETAIL_RANK.department, 2),
      c('requested', DETAIL_RANK.requested, 3),
      c('enrolled', DETAIL_RANK.enrolled, 2),
    ]).map((x) => x.key);
    expect(order).toEqual([
      'requested',
      'enrolled',
      'dept-u0-1',
      'dept-u2-1',
      'dept-u0-2',
      'ge-never',
      'ge-stale-old',
      'ge-stale-new',
      'other-a',
    ]);
  });
});

describe('catalog detail priority', () => {
  it("opens the student's courses first: enrolled, needed, department, 全学教育, then the rest", async () => {
    const { srv, adapter } = setup({ detailsPerRun: 7, priorities: PRIORITIES });
    const { items, pages } = await runAll(adapter);
    expect(srv.state.openedCodes).toEqual([
      '77000004', // enrolled (IN-B 後期)
      '16111007', // enrolled class P1 (LA-H 後期)
      '77401230', // needed (by title)
      '77000002', // department 選択 (category)
      '16000001', // campus 全学教育 (the category rule does not apply there)
      '16111007', // P2: 全学教育
      '77000001', // everything else
    ]);
    expect(items).toHaveLength(7);
    expect(pages.at(-1)?.complete).toEqual({ sourceTypes: ['syllabus.entry'] });
  });

  it('matches the class: only the enrolled class of a 全学教育 course is ranked enrolled', async () => {
    const { items } = await runAll(setup({ detailsPerRun: 2, priorities: PRIORITIES }).adapter);
    expect(payload(find(items, '77000004')).detailFetched).toBeUndefined();
    expect(payload(find(items, '16111007', 'P1')).detailFetched).toBeUndefined();
    expect(payload(find(items, '16111007', 'P2')).detailFetched).toBe(false);
    expect(payload(find(items, '77401230')).detailFetched).toBe(false);
  });

  it('without priorities the campus 全学教育 listing comes before the rest of the backlog', async () => {
    const { srv } = await (async () => {
      const s = setup({ detailsPerRun: 3 });
      await runAll(s.adapter);
      return s;
    })();
    expect(srv.state.openedCodes).toEqual(['16000001', '16111007', '16111007']);
  });

  it('ignores invalid priorities and a failing provider with a warning', async () => {
    const bad = setup({
      detailsPerRun: 1,
      priorities: [{ priority: 'needed' }, { priority: 'urgent', subjectCode: '77000001' }],
    });
    const b = await runAll(bad.adapter);
    expect(b.pages.flatMap((p) => p.warnings ?? [])).toContain(
      'ignored 2 invalid syllabus detail priorities',
    );
    expect(bad.srv.state.openedCodes).toEqual(['16000001']);

    const failing = setup({
      detailsPerRun: 1,
      priorities: () => {
        throw new Error('db closed');
      },
    });
    const f = await runAll(failing.adapter);
    expect(f.pages.flatMap((p) => p.warnings ?? [])).toContain(
      'priorityProvider failed: db closed',
    );
    expect(f.pages.at(-1)?.complete).toEqual({ sourceTypes: ['syllabus.entry'] });
  });
});

describe('on-demand detail fetch', () => {
  it('reads one list-only row with a narrow search and its detail, then reuses it', async () => {
    const dir = await tmp();
    const { srv, adapter } = setup({ cacheDir: dir });
    const first = await runAll(adapter);
    const os = find(first.items, '77401230');
    expect(payload(os).detailFetched).toBe(false);
    const before = srv.log.length;

    const out = await adapter.fetchDetails([
      { externalId: os.externalId, previousPayload: os.payload },
    ]);
    expect(out.results).toEqual([{ externalId: os.externalId, status: 'fetched' }]);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.externalId).toBe(os.externalId);
    expect(payload(out.items[0]!).detailFetched).toBeUndefined();
    expect(payload(out.items[0]!).detail.room).toBe('共通講義棟３１');
    // init, search, linkselect with their redirects; the search names year x faculty and the code.
    expect(srv.log.length - before).toBe(6);
    expect(srv.state.searches.at(-1)).toMatchObject({ title: '2243', subjectCode: '77401230' });
    expect(srv.state.openedCodes).toEqual(['77401230']);
    expect(srv.state.maxInflight).toBe(1);

    // Already there: no request at all.
    const again = await adapter.fetchDetails([
      { externalId: os.externalId, previousPayload: os.payload },
    ]);
    expect(again.results[0]?.status).toBe('alreadyFetched');
    expect(payload(again.items[0]!).detail.room).toBe('共通講義棟３１');
    expect(srv.log.length - before).toBe(6);

    // The next sync emits it with the detail without opening it again.
    const next = await runAll(adapter);
    expect(payload(find(next.items, '77401230')).detailFetched).toBeUndefined();
    expect(srv.state.openedCodes).toEqual(['77401230']);
  });

  it('queues a row it cannot read now; the next sync opens it before everything else', async () => {
    const dir = await tmp();
    const clock = new ManualClock('2026-10-06T03:00:00.000Z');
    const broken = setup({
      cacheDir: dir,
      clock,
      server: { detailHtml: '<html><body><p>想定外の画面</p></body></html>' },
    });
    const { items } = await runAll(broken.adapter);
    const other = find(items, '77000001');
    const out = await broken.adapter.fetchDetails([
      { externalId: other.externalId, previousPayload: other.payload },
    ]);
    expect(out.results[0]).toMatchObject({ externalId: other.externalId, status: 'queued' });
    expect(out.items).toEqual([]);
    const saved = JSON.parse(await readFile(path.join(dir, 'syllabus-details.json'), 'utf8')) as {
      requested?: Record<string, string>;
    };
    expect(Object.keys(saved.requested ?? {})).toEqual([other.externalId]);

    // Asked again right away: queued without hitting the server.
    const requests = broken.srv.log.length;
    const again = await broken.adapter.fetchDetails([
      { externalId: other.externalId, previousPayload: other.payload },
    ]);
    expect(again.results[0]?.status).toBe('queued');
    expect(broken.srv.log.length).toBe(requests);

    // A new run (server fine again) spends its single detail on the queued row, although the
    // campus 全学教育 rows would normally come first.
    const healthy = setup({ cacheDir: dir, clock, detailsPerRun: 1 });
    const run = await runAll(healthy.adapter);
    expect(healthy.srv.state.openedCodes).toEqual(['77000001']);
    expect(payload(find(run.items, '77000001')).detailFetched).toBeUndefined();
    const after = JSON.parse(await readFile(path.join(dir, 'syllabus-details.json'), 'utf8')) as {
      requested?: Record<string, string>;
    };
    expect(after.requested).toBeUndefined();
  });

  it(`reads at most ${MAX_DETAIL_FETCH_PER_CALL} rows per call and queues the rest`, async () => {
    const { srv, adapter } = setup();
    const { items } = await runAll(adapter);
    const requests = items.map((i) => ({ externalId: i.externalId, previousPayload: i.payload }));
    expect(requests.length).toBeGreaterThan(MAX_DETAIL_FETCH_PER_CALL);
    const out = await adapter.fetchDetails(requests);
    expect(out.results.filter((r) => r.status === 'fetched')).toHaveLength(
      MAX_DETAIL_FETCH_PER_CALL,
    );
    expect(out.results.filter((r) => r.status === 'queued')).toHaveLength(
      requests.length - MAX_DETAIL_FETCH_PER_CALL,
    );
    expect(srv.state.openedCodes).toHaveLength(MAX_DETAIL_FETCH_PER_CALL);
  });

  it('refuses payloads that are not syllabus entries without any request', async () => {
    const { srv, adapter } = setup();
    const out = await adapter.fetchDetails([{ externalId: 'x', previousPayload: { foo: 1 } }]);
    expect(out.results).toEqual([
      { externalId: 'x', status: 'failed', error: 'not a syllabus entry' },
    ]);
    expect(srv.log).toHaveLength(0);
  });
});
