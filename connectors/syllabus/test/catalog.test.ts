import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanonicalEntitySchema, type EntityOfKind } from '@unicontext/canonical-model';
import {
  createNormalizeContext,
  type NormalizedEntity,
  type RawItem,
  type RawItemView,
  type SyncResult,
} from '@unicontext/connector-sdk';
import { ManualClock } from '@unicontext/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSyllabusNormalizer,
  currentTerm,
  nextTerm,
  resolveCatalogTerms,
  SyllabusAdapter,
  SyllabusCatalogSchema,
  SyllabusConfigSchema,
  type SyllabusEntryPayload,
} from '../src/index.js';
import { BASE, makeContext, shizuokaProfile } from './helpers.js';
import { type CatalogRow, createLcuServer, type LcuServerOptions } from './lcu-server.js';

const IN = '2026年度　情報学部 [IN-B]';
const LA = '2026年度　全学教育科目（静岡） [LA-S]';

function row(
  code: string,
  name: string,
  semester: '前期' | '後期',
  titleCode: string,
  slot: string,
  extra: Partial<CatalogRow> = {},
): CatalogRow {
  return {
    name,
    teacher: '教員　花子',
    titleCode,
    title: titleCode === '2243' ? IN : LA,
    category: '情報科学科-情報科学科（選択必修）',
    code,
    numbering: `IN00${code.slice(-3)}`,
    grade: '2年、3年',
    semester,
    slot,
    ...extra,
  };
}

const CATALOG: CatalogRow[] = [
  row('77100001', '前期の科目A', '前期', '2243', '月1・2'),
  row('77100002', '前期の科目B', '前期', '2243', '火3・4'),
  row('77100003', '前期の科目C', '前期', '2243', '水5・6'),
  row('77200001', '後期の科目A', '後期', '2243', '木3・4'),
  row('77200002', '後期の科目B', '後期', '2243', '金1・2'),
  row('77200003', '後期の科目C', '後期', '2243', '月3・4'),
  row('77200004', '後期の科目D', '後期', '2243', '集中'),
  row('11200001', '全学の科目A', '後期', '2250', '火1・2', { grade: '1年' }),
  row('11200002', '全学の科目B', '後期', '2250', '水3・4', { grade: '1年' }),
];

const TITLES = { '2026': { 'IN-B': '2243', 'LA-S': '2250' } };

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'uc-syllabus-'));
  tmpDirs.push(d);
  return d;
}

interface SetupOptions {
  catalog?: Record<string, unknown> | undefined;
  config?: Record<string, unknown>;
  clock?: ManualClock;
  cacheDir?: string;
  server?: LcuServerOptions;
}

function setup(options: SetupOptions = {}) {
  const srv = createLcuServer({ catalog: CATALOG, ...(options.server ?? {}) });
  const clock = options.clock ?? new ManualClock('2026-10-01T03:00:00.000Z');
  const cfg = SyllabusConfigSchema.parse({
    baseUrl: BASE,
    screens: { syllabusSearch: 'SC_06001B00_21', syllabusDetail: 'SC_06001B00_22' },
    titles: TITLES,
    minRequestIntervalMs: 0,
    catalog: { faculties: ['IN-B', 'LA-S'], ...(options.catalog ?? {}) },
    ...(options.config ?? {}),
  });
  const adapter = new SyllabusAdapter(
    makeContext(cfg, srv.fetch, undefined, {
      clock,
      cacheDir: options.cacheDir,
    }),
  );
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

const payloads = (items: RawItem[]) => items.map((i) => i.payload as SyllabusEntryPayload);
const warningsOf = (pages: SyncResult[]) => pages.flatMap((p) => p.warnings ?? []);
const code = (i: RawItem) => (i.payload as SyllabusEntryPayload).subjectCode;

describe('catalog term resolution', () => {
  const at = (iso: string) => new Date(iso);

  it('uses the Japanese academic year (April start) in the profile time zone', () => {
    // 2026-10-01 12:00 JST
    expect(currentTerm(at('2026-10-01T03:00:00Z'))).toEqual({ year: 2026, semester: '2' });
    expect(currentTerm(at('2026-05-10T03:00:00Z'))).toEqual({ year: 2026, semester: '1' });
    expect(currentTerm(at('2027-02-01T03:00:00Z'))).toEqual({ year: 2026, semester: '2' });
    expect(currentTerm(at('2027-03-31T03:00:00Z'))).toEqual({ year: 2026, semester: '2' });
    expect(currentTerm(at('2027-04-01T03:00:00Z'))).toEqual({ year: 2027, semester: '1' });
    expect(currentTerm(at('2026-09-30T03:00:00Z'))).toEqual({ year: 2026, semester: '1' });
    // 2026-09-30 20:00 UTC is already 10-01 05:00 in Tokyo.
    expect(currentTerm(at('2026-09-30T20:00:00Z'))).toEqual({ year: 2026, semester: '2' });
    expect(currentTerm(at('2026-09-30T20:00:00Z'), 'UTC')).toEqual({ year: 2026, semester: '1' });
  });

  it('next follows current: 前期 -> 後期, 後期 -> 前期 of the next year', () => {
    expect(nextTerm({ year: 2026, semester: '2' })).toEqual({ year: 2027, semester: '1' });
    expect(nextTerm({ year: 2026, semester: '1' })).toEqual({ year: 2026, semester: '2' });
  });

  it('resolves current / next / explicit terms without duplicates', () => {
    const oct = at('2026-10-01T03:00:00Z');
    expect(resolveCatalogTerms(['current', 'next'], oct)).toEqual([
      { year: 2026, semester: '2' },
      { year: 2027, semester: '1' },
    ]);
    expect(resolveCatalogTerms(['current', 'next'], at('2026-05-10T03:00:00Z'))).toEqual([
      { year: 2026, semester: '1' },
      { year: 2026, semester: '2' },
    ]);
    expect(
      resolveCatalogTerms(['current', { year: 2026, semester: '2' }, 'next'], oct),
    ).toHaveLength(2);
  });
});

describe('catalog config', () => {
  it('has the documented defaults and is off unless configured', () => {
    expect(SyllabusConfigSchema.parse({}).catalog).toBeUndefined();
    expect(SyllabusConfigSchema.parse({}).minRequestIntervalMs).toBe(1000);
    expect(SyllabusCatalogSchema.parse({ faculties: ['IN-B'] })).toEqual({
      faculties: ['IN-B'],
      titleCodes: [],
      terms: ['current', 'next'],
      detailsPerRun: 30,
      detailMaxAgeDays: 30,
      maxRows: 1500,
    });
  });

  it('accepts explicit terms with a string or numeric semester and requires a faculty or title', () => {
    const parsed = SyllabusCatalogSchema.parse({
      titleCodes: ['2243'],
      terms: [
        { year: 2026, semester: '2' },
        { year: 2027, semester: 1 },
      ],
    });
    expect(parsed.terms).toEqual([
      { year: 2026, semester: '2' },
      { year: 2027, semester: '1' },
    ]);
    expect(SyllabusCatalogSchema.safeParse({}).success).toBe(false);
    expect(SyllabusCatalogSchema.safeParse({ faculties: ['IN-B'], terms: [] }).success).toBe(false);
  });
});

describe('syllabus catalog sync', () => {
  it('searches once per (faculty, term), skips unknown years with a warning and sets complete', async () => {
    const { srv, adapter } = setup({ catalog: { detailsPerRun: 0 } });
    const { items, pages } = await runAll(adapter);

    // 2026 後期 for both faculties; 2027 前期 has no title code.
    expect(srv.state.searches.map((s) => [s['title'], s['semester']])).toEqual([
      ['2243', '2'],
      ['2250', '2'],
    ]);
    expect(srv.state.searches[0]).toMatchObject({ subjectCode: '', subjectName: '', week: '' });
    const warnings = warningsOf(pages);
    expect(warnings).toContain('syllabus for 2027 IN-B is not published/known yet (no title code)');
    expect(warnings).toContain('syllabus for 2027 LA-S is not published/known yet (no title code)');

    // One entry per listed row, from the list row alone.
    expect(items.map(code).sort()).toEqual(
      ['11200001', '11200002', '77200001', '77200002', '77200003', '77200004'].sort(),
    );
    for (const p of payloads(items)) {
      expect(p).toMatchObject({ detailFetched: false, strategy: 'lcu-public' });
      expect(p.detail.instructors).toEqual([]);
      expect(p.row['曜日・時限']).toBeTruthy();
    }
    expect(payloads(items)[0]).toMatchObject({
      titleCode: '2243',
      year: 2026,
      url: `${BASE}SC_06001B00_21/init`,
    });
    expect(items[0]?.externalId).toBe(`77200001|1クラス|${IN.normalize('NFKC')}`);
    // Row-only entries are "seen", so retirement stays enabled, and no detail was requested.
    expect(srv.state.linkselectRows).toEqual([]);
    expect(pages.at(-1)?.complete).toEqual({ sourceTypes: ['syllabus.entry'] });
  });

  it('follows the clock: in May the current and the next term are both 2026', async () => {
    const { srv, adapter } = setup({
      catalog: { faculties: ['IN-B'], detailsPerRun: 0 },
      clock: new ManualClock('2026-05-10T03:00:00.000Z'),
    });
    const { items, pages } = await runAll(adapter);
    expect(srv.state.searches.map((s) => [s['title'], s['semester']])).toEqual([
      ['2243', '1'],
      ['2243', '2'],
    ]);
    expect(items).toHaveLength(7);
    expect(warningsOf(pages).filter((w) => /not published/.test(w))).toEqual([]);
  });

  it('does not fail (and does not retire) when no unit has a title code', async () => {
    const { srv, adapter } = setup({
      catalog: { faculties: ['IN-B'], terms: [{ year: 2030, semester: '1' }] },
    });
    const { items, pages } = await runAll(adapter);
    expect(items).toEqual([]);
    expect(srv.log).toHaveLength(0);
    expect(warningsOf(pages)).toEqual([
      'syllabus for 2030 IN-B is not published/known yet (no title code)',
    ]);
    expect(pages[0]?.complete).toBeUndefined();
  });

  it('resolves titleCodes through the title table and keeps only terms of that year', async () => {
    const { srv, adapter } = setup({
      catalog: { faculties: [], titleCodes: ['2250'], detailsPerRun: 0 },
    });
    const { items, pages } = await runAll(adapter);
    expect(srv.state.searches.map((s) => [s['title'], s['semester']])).toEqual([['2250', '2']]);
    expect(items).toHaveLength(2);
    expect(warningsOf(pages)).toEqual([]);
  });

  it('opens at most detailsPerRun details, splitting the budget over the catalog searches', async () => {
    const { srv, adapter } = setup({ catalog: { detailsPerRun: 3 } });
    const { items, pages } = await runAll(adapter);
    expect(items).toHaveLength(6);
    // IN-B (4 rows): ceil(3/2) = 2 details, LA-S (2 rows) gets the remaining 1.
    expect(srv.state.openedCodes).toEqual(['77200001', '77200002', '11200001']);
    const byCode = new Map(payloads(items).map((p) => [p.subjectCode, p]));
    for (const c of ['77200001', '77200002', '11200001']) {
      expect(byCode.get(c)?.detailFetched).toBeUndefined();
      expect(byCode.get(c)?.detail.room).toBe('共通講義棟３１');
    }
    for (const c of ['77200003', '77200004', '11200002'])
      expect(byCode.get(c)).toMatchObject({ detailFetched: false });
    expect(pages.at(-1)?.complete).toEqual({ sourceTypes: ['syllabus.entry'] });
    expect(pages.at(-1)?.cursor?.extra).toMatchObject({ detailsOpened: 3 });
    expect(srv.state.maxInflight).toBe(1);
  });

  it('gives unused budget of a small unit to the next one', async () => {
    const { srv, adapter } = setup({
      catalog: { faculties: ['LA-S', 'IN-B'], detailsPerRun: 5 },
    });
    await runAll(adapter);
    // LA-S: ceil(5/2) = 3 allowed but only 2 rows -> IN-B may use the remaining 3.
    expect(srv.state.openedCodes).toEqual([
      '11200001',
      '11200002',
      '77200001',
      '77200002',
      '77200003',
    ]);
  });

  it('is the same over several pages (unitsPerPage 1)', async () => {
    const { srv, adapter } = setup({ catalog: { detailsPerRun: 3 }, config: { unitsPerPage: 1 } });
    const { items, pages } = await runAll(adapter);
    expect(pages).toHaveLength(2);
    expect(pages[0]?.complete).toBeUndefined();
    expect(pages[1]?.complete).toEqual({ sourceTypes: ['syllabus.entry'] });
    expect(items).toHaveLength(6);
    expect(srv.state.openedCodes).toEqual(['77200001', '77200002', '11200001']);
  });

  it('reuses cached details: the next run opens only the rows still missing, then none', async () => {
    const { srv, adapter, clock } = setup({ catalog: { detailsPerRun: 3 } });
    const first = await runAll(adapter);
    const opened1 = srv.state.openedCodes.splice(0);
    expect(opened1).toHaveLength(3);

    await clock.advance(24 * 3_600_000);
    const second = await runAll(adapter);
    const opened2 = srv.state.openedCodes.splice(0);
    // Never-fetched rows first; nothing opened twice.
    expect(opened2.sort()).toEqual(['11200002', '77200003', '77200004']);
    expect(second.items).toHaveLength(6);
    expect(payloads(second.items).every((p) => p.detailFetched === undefined)).toBe(true);

    await clock.advance(24 * 3_600_000);
    const third = await runAll(adapter);
    expect(srv.state.openedCodes).toEqual([]);
    expect(third.items).toHaveLength(6);

    // Unchanged payloads are byte-identical to what a fresh open produced (raw store dedupe).
    const byKey = (items: RawItem[]) => new Map(items.map((i) => [i.externalId, i.payload]));
    const m1 = byKey(first.items);
    const m3 = byKey(third.items);
    for (const c of opened1.map((c) => first.items.find((i) => code(i) === c)!.externalId))
      expect(JSON.stringify(m3.get(c))).toBe(JSON.stringify(m1.get(c)));
    // Six details in total over three runs (every detail is opened exactly once).
    expect(srv.state.linkselectRows).toHaveLength(6);
  });

  it('re-opens details older than detailMaxAgeDays, stalest first, never-fetched before stale', async () => {
    const { srv, adapter, clock } = setup({
      catalog: { detailsPerRun: 3, detailMaxAgeDays: 30 },
    });
    await runAll(adapter);
    const opened1 = srv.state.openedCodes.splice(0);
    await clock.advance(24 * 3_600_000);
    await runAll(adapter); // fetches the other three one day later
    srv.state.openedCodes.splice(0);

    await clock.advance(29 * 3_600_000 * 24);
    await runAll(adapter); // day 30: the day-0 details are exactly 30 days old -> stale
    const reopened = srv.state.openedCodes.splice(0);
    expect(reopened.sort()).toEqual([...opened1].sort());

    await clock.advance(3_600_000 * 24);
    await runAll(adapter); // day 31: the day-1 details are stale now
    expect(srv.state.openedCodes).toHaveLength(3);
    expect(srv.state.openedCodes.every((c) => !opened1.includes(c))).toBe(true);
  });

  it('persists the cache atomically under cacheDir and a new adapter reuses it', async () => {
    const dir = await tmp();
    const a = setup({ catalog: { detailsPerRun: 3 }, cacheDir: path.join(dir, 'syllabus') });
    await runAll(a.adapter);
    const files = await readdir(path.join(dir, 'syllabus'));
    expect(files).toEqual(['syllabus-details.json']);
    const saved = JSON.parse(
      await readFile(path.join(dir, 'syllabus', 'syllabus-details.json'), 'utf8'),
    ) as { version: number; entries: Record<string, { fetchedAt: string; url: string }> };
    expect(saved.version).toBe(1);
    expect(Object.keys(saved.entries)).toHaveLength(3);
    expect(Object.values(saved.entries)[0]?.fetchedAt).toBe('2026-10-01T03:00:00.000Z');

    // "Restart": a brand-new adapter on the same directory only opens the missing rows.
    const b = setup({
      catalog: { detailsPerRun: 3 },
      cacheDir: path.join(dir, 'syllabus'),
      clock: a.clock,
    });
    await runAll(b.adapter);
    expect([...b.srv.state.openedCodes].sort()).toEqual(['11200002', '77200003', '77200004']);
    const fresh = JSON.parse(
      await readFile(path.join(dir, 'syllabus', 'syllabus-details.json'), 'utf8'),
    ) as { entries: Record<string, unknown> };
    expect(Object.keys(fresh.entries)).toHaveLength(6);
  });

  it('ignores a corrupt cache file with a warning', async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, 'syllabus-details.json'), '{not json', 'utf8');
    const { adapter } = setup({ catalog: { detailsPerRun: 1 }, cacheDir: dir });
    const { items, pages } = await runAll(adapter);
    expect(items).toHaveLength(6);
    expect(warningsOf(pages).some((w) => /not valid JSON/.test(w))).toBe(true);
    // ...and the next save replaced it with a valid file.
    expect(
      JSON.parse(await readFile(path.join(dir, 'syllabus-details.json'), 'utf8')),
    ).toMatchObject({
      version: 1,
    });
  });

  it('prunes cached rows the source no longer lists after a full pass', async () => {
    const dir = await tmp();
    const a = setup({ catalog: { detailsPerRun: 20 }, cacheDir: dir });
    await runAll(a.adapter);
    const first = JSON.parse(await readFile(path.join(dir, 'syllabus-details.json'), 'utf8')) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(first.entries)).toHaveLength(6);

    const b = setup({
      catalog: { detailsPerRun: 20 },
      cacheDir: dir,
      clock: a.clock,
      server: { catalog: CATALOG.filter((r) => r.code !== '77200004') },
    });
    const { pages } = await runAll(b.adapter);
    expect(pages.at(-1)?.complete).toBeDefined();
    const second = JSON.parse(await readFile(path.join(dir, 'syllabus-details.json'), 'utf8')) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(second.entries)).toHaveLength(5);
  });

  it('does not claim completeness when a listing is capped, empty or broken', async () => {
    const capped = setup({ catalog: { detailsPerRun: 0, maxRows: 2 } });
    const c = await runAll(capped.adapter);
    expect(c.items).toHaveLength(4); // 2 + 2
    expect(warningsOf(c.pages).some((w) => /limited to 2/.test(w))).toBe(true);
    expect(c.pages.at(-1)?.complete).toBeUndefined();

    const empty = setup({
      catalog: { detailsPerRun: 0 },
      server: { catalog: CATALOG.filter((r) => r.titleCode === '2243') },
    });
    const e = await runAll(empty.adapter);
    expect(e.items).toHaveLength(4);
    expect(e.pages.at(-1)?.complete).toBeUndefined();

    const broken = setup({ catalog: { detailsPerRun: 0 }, server: { failPostNumber: 1 } });
    // The server drops the session once; the strategy starts a new one, so it still completes.
    expect((await runAll(broken.adapter)).pages.at(-1)?.complete).toBeDefined();

    const html = setup({
      catalog: { detailsPerRun: 0 },
      server: {
        catalog: undefined,
        resultsHtml: '<html><body><p>メンテナンス中</p></body></html>',
      },
    });
    await expect(html.adapter.sync({ mode: 'incremental' })).rejects.toThrow(/neither a table/);
  });

  it('keeps targets and searches working next to a catalog (no duplicate rows)', async () => {
    const { srv, adapter } = setup({
      catalog: { faculties: ['IN-B'], terms: ['current'], detailsPerRun: 0 },
      config: { targets: [{ year: 2026, faculty: 'IN-B', subjectCode: '77200001' }] },
    });
    const { items, pages } = await runAll(adapter);
    // The target is opened in full (as before); the catalog does not emit it again.
    expect(items.filter((i) => code(i) === '77200001')).toHaveLength(1);
    expect(
      payloads(items).find((p) => p.subjectCode === '77200001')?.detailFetched,
    ).toBeUndefined();
    expect(items).toHaveLength(4);
    expect(srv.state.openedCodes).toEqual(['77200001']);
    expect(pages.at(-1)?.complete).toEqual({ sourceTypes: ['syllabus.entry'] });
  });

  it('survives unreadable detail pages: rows stay row-only, health degrades, run does not fail', async () => {
    const { srv, adapter } = setup({
      catalog: { detailsPerRun: 10 },
      server: { detailHtml: '<html><body><p>想定外の画面</p></body></html>' },
    });
    const { items, pages } = await runAll(adapter);
    expect(items).toHaveLength(6);
    expect(payloads(items).every((p) => p.detailFetched === false)).toBe(true);
    // Stops hammering the broken screen after three failures in a row.
    expect(srv.state.openedCodes).toHaveLength(3);
    expect(warningsOf(pages).some((w) => /in a row failed/.test(w))).toBe(true);
    expect(pages.at(-1)?.complete).toEqual({ sourceTypes: ['syllabus.entry'] });
    expect(await adapter.health()).toMatchObject({ state: 'degraded' });
  });
});

describe('request pacing', () => {
  class SteppingClock extends ManualClock {
    readonly sleeps: number[] = [];
    override sleep(ms: number): Promise<void> {
      this.sleeps.push(ms);
      this.set(new Date(this.now().getTime() + ms));
      return Promise.resolve();
    }
  }

  it('waits minRequestIntervalMs between requests on the injected clock', async () => {
    const clock = new SteppingClock('2026-10-01T03:00:00.000Z');
    const srv = createLcuServer();
    const adapter = new SyllabusAdapter(
      makeContext(
        SyllabusConfigSchema.parse({
          baseUrl: BASE,
          screens: { syllabusSearch: 'SC_06001B00_21', syllabusDetail: 'SC_06001B00_22' },
          titles: TITLES,
          targets: [{ year: 2026, faculty: 'IN-B', subjectCode: '77403030' }],
        }),
        srv.fetch,
        undefined,
        { clock },
      ),
    );
    await adapter.sync({ mode: 'incremental' });
    // 6 requests (init, form, search, results, linkselect, detail): 5 gaps of one second.
    expect(srv.log).toHaveLength(6);
    expect(clock.sleeps).toEqual([1000, 1000, 1000, 1000, 1000]);
  });

  it('does not sleep when the interval is 0', async () => {
    const clock = new SteppingClock('2026-10-01T03:00:00.000Z');
    const { adapter } = setup({
      clock,
      catalog: { detailsPerRun: 0 },
    });
    await runAll(adapter);
    expect(clock.sleeps).toEqual([]);
  });
});

describe('row-only entries through the normalizer', () => {
  async function rowOnlyView(): Promise<RawItemView> {
    const { adapter } = setup({
      catalog: { faculties: ['IN-B'], terms: ['current'], detailsPerRun: 0 },
    });
    const { items } = await runAll(adapter);
    const raw = items.find((i) => code(i) === '77200001')!;
    return {
      id: 'raw:1',
      sourceId: 'syllabus',
      sourceType: raw.sourceType,
      externalId: raw.externalId,
      payload: JSON.parse(JSON.stringify(raw.payload)) as unknown,
      fetchedAt: '2026-10-01T00:00:00.000Z',
      sourceUpdatedAt: undefined,
      contentHash: 'h',
    };
  }

  const of = <K extends NormalizedEntity['entity']['kind']>(es: NormalizedEntity[], kind: K) =>
    es.filter((e) => e.entity.kind === kind) as (NormalizedEntity & {
      entity: EntityOfKind[K];
    })[];

  it('fills course, offering and document from the list row alone', async () => {
    const view = await rowOnlyView();
    const ctx = createNormalizeContext({
      sourceId: 'syllabus',
      sourceSystem: 'syllabus',
      sourceLabel: 'シラバス',
      defaultAuthority: 'syllabus',
      profile: shizuokaProfile(),
    });
    const out = await createSyllabusNormalizer().normalize(view, ctx);
    expect(out.drift).toEqual([]);
    expect(out.warnings).toBeUndefined();
    for (const e of out.entities)
      expect(CanonicalEntitySchema.safeParse(e.entity).success).toBe(true);

    const [course] = of(out.entities, 'course');
    expect(course?.entity).toMatchObject({ courseCode: '77200001', title: '後期の科目A' });
    expect(course?.entity.credits).toBeUndefined();

    const [offering] = of(out.entities, 'courseOffering');
    expect(offering?.entity).toMatchObject({
      courseCode: '77200001',
      academicYear: 2026,
      term: '後期',
      title: '後期の科目A',
      instructorNames: ['教員 花子'],
    });
    expect(offering?.entity.schedule).toEqual([
      { dayOfWeek: 4, period: 2, startTime: '10:20', endTime: '11:50' },
    ]);
    expect(offering?.entity.room).toBeUndefined();
    expect(offering?.entity.extra).toMatchObject({
      detailFetched: false,
      grade: '2年、3年',
      rawSchedule: '木3・4',
      className: '1クラス',
      slots: [{ dayOfWeek: 4, period: 2, rawPeriod: '3・4' }],
    });
    expect(offering?.entity.extra).not.toHaveProperty('requirement');
    expect(offering?.entity.extra).not.toHaveProperty('credits');

    const [doc] = of(out.entities, 'document');
    expect(doc?.entity.courseOfferingId).toBe(offering?.entity.id);
    expect(doc?.entity.text).toContain('後期の科目A');
    expect(doc?.entity.text).toContain('担当教員: 教員 花子');
    expect(doc?.entity.text).toContain('2年、3年');
    expect(doc?.entity.text).toContain('未取得');
  });

  it('a payload without detailFetched (older entries) still means "detail read"', async () => {
    const { adapter } = setup({ catalog: { detailsPerRun: 1 }, config: {} });
    const { items } = await runAll(adapter);
    const full = items.find(
      (i) => (i.payload as SyllabusEntryPayload).detailFetched === undefined,
    )!;
    const ctx = createNormalizeContext({ sourceId: 'syllabus', sourceSystem: 'syllabus' });
    const out = await createSyllabusNormalizer().normalize(
      {
        id: 'raw:2',
        sourceId: 'syllabus',
        sourceType: full.sourceType,
        externalId: full.externalId,
        payload: JSON.parse(JSON.stringify(full.payload)) as unknown,
        fetchedAt: '2026-10-01T00:00:00.000Z',
        sourceUpdatedAt: undefined,
        contentHash: 'h',
      },
      ctx,
    );
    const [offering] = of(out.entities, 'courseOffering');
    expect(offering?.entity.extra).not.toHaveProperty('detailFetched');
    expect(offering?.entity.extra).toMatchObject({ credits: 2 });
  });
});
