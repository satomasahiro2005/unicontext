import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  type CanonicalEntityInput,
  stableId,
  TERM_SLOTS_PREDICATE,
} from '@unicontext/canonical-model';
import { createUniContext, type UniContext } from '@unicontext/context-engine';
import {
  defineMetadata,
  type FactInput,
  type NormalizeOutput,
  type Normalizer,
  type RawItem,
  type SourceAdapter,
} from '../../../packages/connector-sdk/src/index.js';
import { ManualClock } from '@unicontext/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSyllabusNormalizer,
  emptySyllabusDetail,
  metadata as syllabusMetadata,
  rowKey,
  type SyllabusEntryPayload,
} from '../../../connectors/syllabus/src/index.js';
import { createMcpServer, ProposalStore, type McpEnvelope } from '../src/index.js';
import { getCreditSummary, getSyllabus, searchSyllabus } from '../src/syllabus.js';

// 2026 後期 with the Shizuoka profile's halves: 後期後半 starts on Monday 12/7 (Thursday 11/26).

const IN_26 = '2026年度　情報学部 [IN-B]';
const DAY = '日月火水木金土';

interface Spec {
  code: string;
  name: string;
  slots: { dayOfWeek: number; period: number }[];
  termSpan: string;
  credits?: number;
}

function syllabusEntry(spec: Spec): RawItem {
  const dayPeriod = spec.slots
    .map((s) => `${DAY.charAt(s.dayOfWeek)}${s.period * 2 - 1}・${s.period * 2}`)
    .join('、');
  const row: Record<string, string> = {
    講義名: spec.name,
    担当教員: '教員　一郎',
    クラス: '1クラス',
    タイトル: IN_26,
    カテゴリ: '情報科学科-情報科学科（選択）',
    科目コード: spec.code,
    学年: '2年、3年、4年',
    開講学期: '後期',
    '曜日・時限': dayPeriod,
  };
  const payload: SyllabusEntryPayload = {
    strategy: 'lcu-public',
    url: 'https://lcu.example.ac.jp/lcu-web/SC_06001B00_21/init',
    title: IN_26,
    year: 2026,
    subjectCode: spec.code,
    className: '1クラス',
    categories: [row['カテゴリ'] ?? ''],
    row,
    detail: {
      ...emptySyllabusDetail(),
      name: spec.name,
      className: '1クラス',
      semester: '後期',
      termSpan: spec.termSpan,
      dayPeriod,
      slots: spec.slots.map((s) => ({ ...s, rawPeriod: `${s.period * 2 - 1}・${s.period * 2}` })),
      credits: spec.credits ?? 1,
    },
  };
  return { sourceType: 'syllabus.entry', externalId: rowKey(row), payload };
}

const CATALOG: Spec[] = [
  // The student's 後半-only course (月3・4 = 月2).
  {
    code: '77455070',
    name: 'サイバーフィジカルシステム基礎',
    slots: [{ dayOfWeek: 1, period: 2 }],
    termSpan: '後期後半',
  },
  // The student's whole-term course (木3・4 = 木2).
  {
    code: '77403030',
    name: 'データベースシステム論',
    slots: [{ dayOfWeek: 4, period: 2 }],
    termSpan: '後期前半　～　後期後半',
    credits: 2,
  },
  // Not registered: 月2 in 前半 fits (the student's 月2 is 後半 only), 月2 in 後半 does not.
  {
    code: '77000001',
    name: '前半の月曜科目',
    slots: [{ dayOfWeek: 1, period: 2 }],
    termSpan: '後期前半',
  },
  {
    code: '77000002',
    name: '後半の月曜科目',
    slots: [{ dayOfWeek: 1, period: 2 }],
    termSpan: '後期後半',
  },
  {
    code: '77000003',
    name: '通しの水曜科目',
    slots: [{ dayOfWeek: 3, period: 1 }],
    termSpan: '後期前半　～　後期後半',
    credits: 2,
  },
];

const lcuMetadata = defineMetadata({
  name: '@unicontext/livecampusu',
  product: 'livecampusu',
  version: '1.0.0',
  license: 'MIT',
  capabilities: ['courses', 'timetable'],
  adapter: 'native',
  apiStability: 'unofficial',
  risk: 'unsupported',
  testedVersion: 'test',
  defaultAuthority: 'academic-system',
  sourceLabel: '学務情報システム',
  rawTypes: ['test.entities'],
});

const lcu = <K extends 'courseOffering' | 'person' | 'enrollment'>(kind: K, key: string) =>
  stableId(kind, 'lcu', key);
const cps = lcu('courseOffering', 'cps');
const dbs = lcu('courseOffering', 'dbs');

function lcuEntities(): CanonicalEntityInput[] {
  const self = lcu('person', 'self');
  const out: CanonicalEntityInput[] = [
    { id: self, kind: 'person', name: '本人', roles: ['student'], isSelf: true },
  ];
  const add = (
    id: string,
    key: string,
    code: string,
    title: string,
    dayOfWeek: number,
    period: number,
    credits: number,
  ) => {
    out.push({
      id: id as never,
      kind: 'courseOffering',
      title,
      courseCode: code,
      academicYear: 2026,
      term: '後期',
      instructorNames: ['教員 一郎'],
      schedule: [{ dayOfWeek, period, room: '情13' }],
      scheduleType: 'regular',
      extra: { className: '1クラス', credits },
    });
    out.push({
      id: lcu('enrollment', key),
      kind: 'enrollment',
      personId: self,
      courseOfferingId: id as never,
      role: 'student',
      status: 'active',
    });
  };
  // The timetable itself does not say 前半/後半 (as in LiveCampusU).
  add(cps, 'cps', '77455070', 'サイバーフィジカルシステム基礎', 1, 2, 1);
  add(dbs, 'dbs', '77403030', 'データベースシステム論', 4, 2, 2);
  return out;
}

// A notice's subject text 「後期前半/木3・4, 後期後半/木3・4」 as the LiveCampusU normalizer stores it.
const termSlotsFact: FactInput = {
  subject: dbs as never,
  predicate: TERM_SLOTS_PREDICATE,
  value: {
    slots: [
      { half: '前半', dayOfWeek: 4, period: 2 },
      { half: '後半', dayOfWeek: 4, period: 2 },
    ],
  },
  origin: 'authoritative',
  evidence: '後期前半/木3・4, 後期後半/木3・4',
};

function staticAdapter(id: string, items: RawItem[], types: string[]): SourceAdapter {
  return {
    id,
    version: '1',
    capabilities: () => Promise.resolve(['courses']),
    authenticate: () => Promise.resolve({ status: 'not_required' }),
    sync: () => Promise.resolve({ items, hasMore: false, complete: { sourceTypes: types } }),
    health: () => Promise.resolve({ state: 'healthy', checkedAt: '2026-10-05T00:00:00.000Z' }),
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
    facts: [termSlotsFact],
  }),
};

let uc: UniContext;
let clock: ManualClock;
let tmp: string;
const clients: Client[] = [];

async function connect(surface: 'local' | 'remote'): Promise<Client> {
  const server = createMcpServer({
    uc,
    proposals: new ProposalStore(path.join(tmp, 'proposals'), { clock }),
    surface,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'halves-test', version: '0.0.0' });
  await client.connect(b);
  clients.push(client);
  return client;
}

type ClassOut = { course: { title: string }; termPart?: string; summary: string };
type WeekOut = {
  term?: { name: string; part?: string; partNote?: string };
  days: { date: string; classes: ClassOut[] }[];
};

async function callJson<T>(client: Client, name: string): Promise<T> {
  const res = await client.callTool({ name, arguments: {} });
  const text = (res.content as { text: string }[])[0]?.text ?? '';
  expect(res.isError).not.toBe(true);
  return (JSON.parse(text) as McpEnvelope<T>).data;
}

const titlesOn = (w: WeekOut, date: string): string[] =>
  w.days.find((d) => d.date === date)?.classes.map((c) => c.course.title) ?? [];

beforeAll(async () => {
  clock = new ManualClock('2026-10-05T00:30:00.000Z'); // Monday 09:30 JST
  uc = createUniContext({
    profile: 'shizuoka-university',
    clock,
    student: { campus: '浜松', faculty: '情報学部' },
  });
  uc.sync.register({
    sourceId: 'syllabus',
    adapter: staticAdapter('syllabus', CATALOG.map(syllabusEntry), ['syllabus.entry']),
    normalizer: createSyllabusNormalizer(),
    metadata: syllabusMetadata,
  });
  uc.sync.register({
    sourceId: 'livecampusu',
    adapter: staticAdapter(
      'livecampusu',
      [{ sourceType: 'test.entities', externalId: 'all', payload: { entities: lcuEntities() } }],
      ['test.entities'],
    ),
    normalizer: lcuNormalizer,
    metadata: lcuMetadata,
  });
  for (const id of ['syllabus', 'livecampusu']) expect((await uc.sync.sync(id)).ok).toBe(true);
  await uc.runPipeline();
  tmp = mkdtempSync(path.join(tmpdir(), 'uc-mcp-halves-'));
});

afterAll(async () => {
  for (const c of clients) await c.close();
  await uc.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('前半 / 後半 in the MCP views', () => {
  it('tool descriptions explain the halves briefly', async () => {
    for (const surface of ['local', 'remote'] as const) {
      const tools = (await (await connect(surface)).listTools()).tools;
      for (const name of ['get_today', 'get_week']) {
        const d = tools.find((t) => t.name === name)?.description ?? '';
        expect(d).toMatch(/前半・後半/);
        expect(d).toMatch(/termPart/);
      }
    }
  });

  it('get_week in 後期前半: the 後半-only course is absent, the term names the half', async () => {
    clock.set('2026-10-05T00:30:00.000Z');
    for (const surface of ['local', 'remote'] as const) {
      const w = await callJson<WeekOut>(await connect(surface), 'get_week');
      expect(w.term).toMatchObject({ name: '2026年度 後期', part: '後期前半' });
      expect(w.term?.partNote).toBeUndefined();
      expect(titlesOn(w, '2026-10-05')).toEqual([]);
      const thu = w.days.find((d) => d.date === '2026-10-08')?.classes ?? [];
      expect(thu.map((c) => [c.course.title, c.termPart])).toEqual([
        ['データベースシステム論', '後期（前半・後半）'],
      ]);
    }
  });

  it('get_week in 後期後半 (December): the 後半-only course meets, labelled as such', async () => {
    clock.set('2026-12-08T00:30:00.000Z');
    const w = await callJson<WeekOut>(await connect('remote'), 'get_week');
    expect(w.term).toMatchObject({ part: '後期後半' });
    const mon = w.days.find((d) => d.date === '2026-12-07')?.classes ?? [];
    expect(mon.map((c) => [c.course.title, c.termPart])).toEqual([
      ['サイバーフィジカルシステム基礎', '後期後半'],
    ]);
    expect(mon[0]?.summary).toMatch(/サイバーフィジカルシステム基礎［後期後半のみ］/);
    expect(titlesOn(w, '2026-12-10')).toEqual(['データベースシステム論']);
  });

  it('get_week in the switch-over week says the boundary depends on the weekday', async () => {
    clock.set('2026-11-30T00:30:00.000Z'); // Mon 11/30 is 月8 (前半), Fri 12/4 is 金9 (後半)
    const w = await callJson<WeekOut>(await connect('local'), 'get_week');
    expect(w.term?.part).toBe('後期前半');
    expect(w.term?.partNote).toMatch(/後期前半と後期後半の切り替わり/);
    expect(titlesOn(w, '2026-11-30')).toEqual([]);
  });

  it('get_today carries the current half', async () => {
    clock.set('2026-12-07T00:30:00.000Z');
    const t = await callJson<{ term?: { part?: string }; classes: ClassOut[] }>(
      await connect('remote'),
      'get_today',
    );
    expect(t.term?.part).toBe('後期後半');
    expect(t.classes.map((c) => c.termPart)).toEqual(['後期後半']);
  });

  it('get_course shows the half and where it comes from', () => {
    clock.set('2026-10-05T00:30:00.000Z');
    const course = uc.context.course(cps);
    expect(course.termPart).toBe('後期後半');
    expect(course.termPartCitations?.[0]?.label).toMatch(/シラバス/);
    expect(course.upcomingClasses[0]?.date).toBe('2026-12-07');
    const db = uc.context.course(dbs);
    expect(db.termPart).toBe('後期（前半・後半）');
    expect(db.termPartCitations?.[0]?.label).toMatch(/学務情報システム/);
  });
});

describe('前半 / 後半 in registration planning', () => {
  it('search_syllabus filters by half and by the free slots of the registered timetable', () => {
    clock.set('2026-10-05T00:30:00.000Z');
    type Out = { items: { title: string; termPart: string | null; enrolled: boolean }[] };
    const titles = (args: Parameters<typeof searchSyllabus>[1]) =>
      (searchSyllabus(uc, args).data as Out).items.map((i) => i.title).sort();
    expect(titles({ termPart: '後期後半' })).toEqual(
      [
        'サイバーフィジカルシステム基礎',
        'データベースシステム論',
        '後半の月曜科目',
        '通しの水曜科目',
      ].sort(),
    );
    expect(titles({ termPart: '後半のみ' })).toEqual(
      ['サイバーフィジカルシステム基礎', '後半の月曜科目'].sort(),
    );
    expect(titles({ term: '後期前半' })).toEqual(
      ['データベースシステム論', '前半の月曜科目', '通しの水曜科目'].sort(),
    );
    // 「後期後半に空いているコマで取れる科目」: 月2 is taken in 後半 by the student's course.
    expect(titles({ termPart: '後期後半', fitsMyTimetable: true })).toEqual(['通しの水曜科目']);
    expect(titles({ fitsMyTimetable: true })).toEqual(['前半の月曜科目', '通しの水曜科目'].sort());
    const item = (searchSyllabus(uc, { query: '前半の月曜' }).data as Out).items[0];
    expect(item?.termPart).toBe('後期前半');
    expect(() => searchSyllabus(uc, { termPart: '真ん中' })).toThrow(/前半 or 後半/);
    const one = getSyllabus(uc, { course: '77455070' }).data as { syllabus: { termPart: string } };
    expect(one.syllabus.termPart).toBe('後期後半');
  });

  it('get_credit_summary lists this term by half with the free slots of each half', () => {
    clock.set('2026-10-05T00:30:00.000Z');
    const d = getCreditSummary(uc, {}).data as {
      timetableThisTerm: {
        courses: { title: string; termPart: string | null; slots: string }[];
        freeSlots: Record<string, string>;
      };
    };
    const tt = d.timetableThisTerm;
    expect(tt.courses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'サイバーフィジカルシステム基礎',
          termPart: '後期後半',
          slots: '月2',
        }),
        expect.objectContaining({
          title: 'データベースシステム論',
          termPart: '後期（前半・後半）',
          slots: '木2',
        }),
      ]),
    );
    const free = (label: string) => (tt.freeSlots[label] ?? '').split(' ');
    expect(free('後期前半')).toContain('月2');
    expect(free('後期後半')).not.toContain('月2');
    expect(free('後期前半')).not.toContain('木2');
    expect(free('後期後半')).not.toContain('木2');
  });
});
