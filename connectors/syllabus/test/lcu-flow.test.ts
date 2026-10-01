import {
  instantiateConnector,
  type RawItem,
  type SyncInput,
  type SyncResult,
} from '@unicontext/connector-sdk';
import { ConfigError, loadProfile, type FetchLike } from '@unicontext/core';
import { describe, expect, it } from 'vitest';
import {
  createSyllabusConnector,
  SyllabusAdapter,
  type SyllabusConfig,
  SyllabusConfigSchema,
  type SyllabusEntryPayload,
  type SyllabusTarget,
  syllabusConnector,
} from '../src/index.js';
import { BASE, makeContext, memorySecrets } from './helpers.js';
import { createLcuServer, type LcuServerOptions } from './lcu-server.js';

const TITLES = { '2026': { 'IN-B': '2243' } };

function config(partial: Record<string, unknown> = {}): SyllabusConfig {
  return SyllabusConfigSchema.parse({
    baseUrl: BASE,
    screens: { syllabusSearch: 'SC_06001B00_21', syllabusDetail: 'SC_06001B00_22' },
    titles: TITLES,
    ...partial,
  });
}

function setup(partial: Record<string, unknown> = {}, server: LcuServerOptions = {}) {
  const srv = createLcuServer(server);
  const adapter = new SyllabusAdapter(makeContext(config(partial), srv.fetch));
  return { srv, adapter };
}

async function runAll(
  adapter: SyllabusAdapter,
  input: Partial<SyncInput> = {},
): Promise<{ items: RawItem[]; pages: SyncResult[] }> {
  const pages: SyncResult[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 20; i++) {
    const res = await adapter.sync({
      mode: 'initial',
      ...input,
      ...(pageToken ? { pageToken } : {}),
    });
    pages.push(res);
    if (!res.hasMore) break;
    pageToken = res.nextPageToken;
  }
  return { items: pages.flatMap((p) => p.items), pages };
}

const target = (subjectCode: string, extra: Partial<SyllabusTarget> = {}): SyllabusTarget => ({
  year: 2026,
  faculty: 'IN-B',
  subjectCode,
  ...extra,
});

describe('syllabus adapter + lcu-public strategy', () => {
  it('replays init -> search -> linkselect for one target, one request at a time', async () => {
    const { srv, adapter } = setup({ targets: [target('77403030')] });
    const { items, pages } = await runAll(adapter);

    expect(srv.log.map((r) => `${r.method} ${r.path.replace('/lcu-web/', '')}`)).toEqual([
      'GET SC_06001B00_21/init',
      'GET SC_06001B00_21',
      'POST SC_06001B00_21/search',
      'GET SC_06001B00_21',
      'POST SC_06001B00_21/linkselect',
      'GET SC_06001B00_22',
    ]);
    expect(srv.state.maxInflight).toBe(1);
    // Cookie carried across every hop after it was issued.
    expect(srv.log[0]?.cookie).toBeUndefined();
    for (const r of srv.log.slice(1)) expect(r.cookie).toBe('JSESSIONID=sess-1');

    const search = srv.state.searches[0]!;
    expect(search).toMatchObject({
      title: '2243',
      subjectCode: '77403030',
      subjectName: '',
      week: '',
    });
    expect(Object.keys(search)).toEqual(
      expect.arrayContaining([
        'title',
        'category',
        'jikanwariSubjectName',
        'staffName',
        'practitionerFlag',
        'semester',
        'term',
        'subjectCode',
        'numbering',
        'subjectName',
        'subjectType',
        'week',
        'period',
        'freeword',
        '_csrf',
      ]),
    );
    expect(srv.log[2]?.contentType).toMatch(/application\/x-www-form-urlencoded; charset=UTF-8/);
    expect(srv.state.linkselectRows).toEqual([0]);

    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.sourceType).toBe('syllabus.entry');
    expect(item.externalId).toBe('77403030|1クラス|2026年度 情報学部 [IN-B]');
    const payload = item.payload as SyllabusEntryPayload;
    expect(payload).toMatchObject({
      strategy: 'lcu-public',
      subjectCode: '77403030',
      className: '1クラス',
      year: 2026,
      titleCode: '2243',
    });
    // Same subject listed under two departments is one entry with both categories.
    expect(payload.categories).toEqual([
      '行動情報学科-行動情報学科（選択）',
      '情報科学科-情報科学科（選択必修）',
    ]);
    expect(payload.detail.room).toBe('共通講義棟３１');
    expect(JSON.stringify(payload)).not.toMatch(/csrf|JSESSIONID|cookie/i);
    expect(pages.at(-1)?.complete).toEqual({ sourceTypes: ['syllabus.entry'] });
    expect(await adapter.health()).toMatchObject({ state: 'healthy' });
  });

  it('encodes Japanese search terms as UTF-8 and re-searches before each further detail', async () => {
    const { srv, adapter } = setup({
      searches: [{ year: 2026, faculty: 'IN-B', subjectName: 'データベース', maxRows: 5 }],
    });
    const { items } = await runAll(adapter);
    expect(items.map((i) => (i.payload as SyllabusEntryPayload).subjectCode).sort()).toEqual([
      '77403030',
      '77501090',
    ]);
    const post = srv.log.find((r) => r.path.endsWith('/search'))!;
    expect(post.rawBody).toContain(
      'subjectName=%E3%83%87%E3%83%BC%E3%82%BF%E3%83%99%E3%83%BC%E3%82%B9',
    );
    // Two details need two searches: the detail screen cannot be re-used for the next row.
    expect(srv.state.searches).toHaveLength(2);
    expect(srv.state.linkselectRows).toEqual([0, 1]);
    expect(srv.state.maxInflight).toBe(1);
  });

  it('pages over targets and sets complete only on the last page', async () => {
    const { adapter } = setup({
      unitsPerPage: 1,
      targets: [target('77403030'), target('77501090'), target('77403030')],
    });
    const { items, pages } = await runAll(adapter);
    expect(pages).toHaveLength(2); // duplicate target removed
    expect(pages[0]).toMatchObject({ hasMore: true, nextPageToken: '1' });
    expect(pages[0]?.complete).toBeUndefined();
    expect(pages[1]?.complete).toEqual({ sourceTypes: ['syllabus.entry'] });
    expect(items.map((i) => i.externalId)).toEqual([
      '77403030|1クラス|2026年度 情報学部 [IN-B]',
      '77501090|1クラス|2026年度 情報学部 [IN-B]',
    ]);
    expect(JSON.parse(JSON.stringify(pages[1]?.cursor))).toEqual(pages[1]?.cursor);
  });

  it('a run resumed at a later page without its state (restart) does not retire entries', async () => {
    const { adapter } = setup({
      unitsPerPage: 1,
      targets: [target('77403030'), target('77501090')],
    });
    // Fresh adapter instance asked for the last page of a run it never started.
    const last = await adapter.sync({ mode: 'initial', pageToken: '1' });
    expect(last.hasMore).toBe(false);
    expect(last.complete).toBeUndefined();
  });

  it('accepts a host-injected targetProvider (option and property)', async () => {
    const srv = createLcuServer();
    const module = createSyllabusConnector({
      targetProvider: () => [target('77403030')],
    });
    const inst = instantiateConnector(module, {
      sourceId: 'syllabus',
      config: {
        baseUrl: BASE,
        screens: { syllabusSearch: 'SC_06001B00_21', syllabusDetail: 'SC_06001B00_22' },
        titles: TITLES,
      },
      secrets: memorySecrets(),
      fetch: srv.fetch,
      rateLimit: { capacity: 1000, refillPerSecond: 1000 },
    });
    const adapter = inst.adapter as SyllabusAdapter;
    expect((await runAll(adapter)).items).toHaveLength(1);

    adapter.targetProvider = () => [
      target('77501090'),
      { year: 2026, subjectCode: '' } as SyllabusTarget,
    ];
    const { items, pages } = await runAll(adapter);
    expect(items.map((i) => (i.payload as SyllabusEntryPayload).subjectCode)).toEqual(['77501090']);
    expect(pages[0]?.warnings?.join('\n')).toMatch(/invalid target/);
    // An ignored target means the list was not complete: nothing may be retired.
    expect(pages.at(-1)?.complete).toBeUndefined();
  });

  it('does not claim completeness when a target finds nothing', async () => {
    const { adapter } = setup({ targets: [target('99999999')] });
    const { items, pages } = await runAll(adapter);
    expect(items).toHaveLength(0);
    expect(pages[0]?.warnings?.join()).toMatch(/no syllabus found for 2026\/99999999/);
    expect(pages[0]?.complete).toBeUndefined();
  });

  it('does not sync anything (and does not retire entries) without targets', async () => {
    const { srv, adapter } = setup();
    const { items, pages } = await runAll(adapter);
    expect(items).toEqual([]);
    expect(pages[0]?.complete).toBeUndefined();
    expect(srv.log).toHaveLength(0);
  });

  it('filters rows of other years and by class', async () => {
    const wrongYear = setup({ targets: [target('77403030', { year: 2025 })] });
    expect((await runAll(wrongYear.adapter)).items).toHaveLength(0);
    const wrongClass = setup({ targets: [target('77403030', { classCode: '2クラス' })] });
    expect((await runAll(wrongClass.adapter)).items).toHaveLength(0);
    const rightClass = setup({ targets: [target('77403030', { classCode: '1クラス' })] });
    expect((await runAll(rightClass.adapter)).items).toHaveLength(1);
    const byHidden = setup({ targets: [target('77403030', { classCode: '61' })] });
    expect((await runAll(byHidden.adapter)).items).toHaveLength(1);
  });

  it('starts a new session when the server shows its error screen', async () => {
    const { srv, adapter } = setup({ targets: [target('77403030')] }, { failPostNumber: 1 });
    const { items } = await runAll(adapter);
    expect(items).toHaveLength(1);
    expect(srv.state.sessionsCreated).toBe(2);
    expect(srv.state.maxInflight).toBe(1);
  });

  it('understands ;jsessionid= URL rewriting', async () => {
    const { srv, adapter } = setup({ targets: [target('77403030')] }, { jsessionidInUrl: true });
    expect((await runAll(adapter)).items).toHaveLength(1);
    expect(srv.log.every((r) => !r.path.includes(';'))).toBe(true);
  });

  it('fails the run when every lookup breaks (layout change), reporting degraded health', async () => {
    const { adapter } = setup(
      { targets: [target('77403030')] },
      { resultsHtml: '<html><body><p>メンテナンス中</p></body></html>' },
    );
    await expect(adapter.sync({ mode: 'initial' })).rejects.toThrow(/neither a table nor a form/);
    expect(await adapter.health()).toMatchObject({ state: 'degraded', consecutiveFailures: 1 });
  });

  it('uses the Shizuoka deployment profile by name, from config or profile settings', async () => {
    const srv = createLcuServer({ host: 'gakujo.shizuoka.ac.jp' });
    const adapter = new SyllabusAdapter(
      makeContext(
        SyllabusConfigSchema.parse({ deployment: 'shizuoka', targets: [target('77403030')] }),
        srv.fetch,
      ),
    );
    expect((await runAll(adapter)).items).toHaveLength(1);
    expect(srv.state.searches[0]?.['title']).toBe('2243');

    const base = loadProfile('shizuoka-university');
    const profile = {
      ...base,
      products: { ...base.products, syllabus: { deployment: 'shizuoka' } },
    };
    const srv2 = createLcuServer({ host: 'gakujo.shizuoka.ac.jp' });
    const viaProfile = new SyllabusAdapter(
      makeContext(
        SyllabusConfigSchema.parse({ targets: [target('77403030', { faculty: 'LA-S' })] }),
        srv2.fetch,
        profile,
      ),
    );
    await runAll(viaProfile);
    expect(srv2.state.searches[0]?.['title']).toBe('2250');
  });

  it('refuses to start without a base URL or with an unknown deployment', () => {
    const base = { sourceId: 'x', secrets: memorySecrets() };
    expect(() => instantiateConnector(syllabusConnector, { ...base, config: {} })).toThrow(
      ConfigError,
    );
    expect(() =>
      instantiateConnector(syllabusConnector, { ...base, config: { deployment: 'atlantis' } }),
    ).toThrow(/Unknown deployment/);
    expect(() =>
      instantiateConnector(syllabusConnector, { ...base, config: { baseUrl: BASE } }),
    ).toThrow(/screen id/);
    expect(() =>
      instantiateConnector(syllabusConnector, {
        ...base,
        config: { strategy: 'nope', baseUrl: BASE },
      }),
    ).toThrow(/Unknown syllabus strategy/);
  });

  it('never leaves the configured origin', async () => {
    const calls: string[] = [];
    const fetchFn: FetchLike = (input) => {
      calls.push(input);
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'https://idp.example.org/login' } }),
      );
    };
    const adapter = new SyllabusAdapter(
      makeContext(config({ targets: [target('77403030')] }), fetchFn),
    );
    await expect(adapter.sync({ mode: 'initial' })).rejects.toThrow(/off-origin/);
    expect(calls.every((u) => u.startsWith(BASE))).toBe(true);
  });
});
