import { type CanonicalEntityInput, stableId } from '@unicontext/canonical-model';
import { ManualClock } from '@unicontext/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createNormalizeContext,
  defineMetadata,
  type NormalizeOutput,
  type Normalizer,
  type RawItemView,
  type SourceAdapter,
} from '../../connector-sdk/src/index.js';
import { createTeamsWebNormalizer } from '../../../connectors/teams-web/src/index.js';
import {
  attentionRequired,
  createUniContext,
  studentState,
  type UniContext,
} from '../src/index.js';
import { busyConflicts, busyIntervals, nextActionBusy } from '../src/schedule-events.js';

// Monday 2026-10-05 09:30 JST, 後期. ネットワーク 月2 (10:20-11:50, 工3-31) and データベース 月4
// (14:25-15:55, 工5-22); ネットワーク also meets on Tuesdays in the room-change scenarios.
const NOW = '2026-10-05T00:30:00.000Z';
const lcu = <K extends 'courseOffering' | 'person' | 'enrollment'>(kind: K, key: string) =>
  stableId(kind, 'lcu', key);
const self = lcu('person', 'self');
const net = lcu('courseOffering', 'net');
const dbc = lcu('courseOffering', 'db');
const chat = { id: 'local:chatgpt', name: 'ChatGPT' };
const jst = (date: string, hhmm: string): string =>
  new Date(`${date}T${hhmm}:00+09:00`).toISOString();

function offering(id: string, title: string, day: number, period: number, room: string) {
  return [
    {
      id: id as never,
      kind: 'courseOffering',
      title,
      academicYear: 2026,
      term: '後期',
      instructorNames: ['教員 一郎'],
      schedule: [{ dayOfWeek: day, period, room }],
      scheduleType: 'regular',
    },
    {
      id: lcu('enrollment', title),
      kind: 'enrollment',
      personId: self,
      courseOfferingId: id as never,
      role: 'student',
      status: 'active',
    },
  ] as CanonicalEntityInput[];
}

const timetable = (netDay = 1): CanonicalEntityInput[] => [
  { id: self, kind: 'person', name: '本人', roles: ['student'], isSelf: true },
  ...offering(net, 'ネットワーク', netDay, 2, '工３－３１'),
  ...offering(dbc, 'データベース', 1, 4, '工５－２２'),
];

const meta = (product: string, label: string, authority: string, capabilities: string[]) =>
  defineMetadata({
    name: `@unicontext/${product}`,
    product,
    version: '1.0.0',
    license: 'MIT',
    capabilities: capabilities as never,
    adapter: 'native',
    apiStability: 'unofficial',
    risk: 'unsupported',
    testedVersion: 'test',
    defaultAuthority: authority as never,
    sourceLabel: label,
    rawTypes: ['test.entities'],
  });

function staticAdapter(id: string, entities: () => CanonicalEntityInput[]): SourceAdapter {
  return {
    id,
    version: '1',
    capabilities: () => Promise.resolve(['courses']),
    authenticate: () => Promise.resolve({ status: 'not_required' }),
    sync: () =>
      Promise.resolve({
        items: [
          { sourceType: 'test.entities', externalId: 'all', payload: { entities: entities() } },
        ],
        hasMore: false,
        complete: { sourceTypes: ['test.entities'] },
      }),
    health: () => Promise.resolve({ state: 'healthy', checkedAt: NOW }),
    dispose: () => Promise.resolve(),
  };
}

/** Entities and facts given in the raw payload are stored as they are. */
const normalizer: Normalizer = {
  id: 'test-entities',
  version: '1',
  sourceTypes: ['test.entities'],
  normalize: (item): NormalizeOutput => {
    const p = item.payload as { entities: CanonicalEntityInput[]; output?: NormalizeOutput };
    return {
      entities: p.entities.map((entity) => ({ entity, ref: { url: 'https://example.ac.jp/' } })),
      ...(p.output ? { facts: p.output.facts ?? [] } : { facts: [] }),
    };
  },
};

let uc: UniContext;
afterEach(async () => {
  await uc.close();
});

async function setup(
  now: string,
  events: () => CanonicalEntityInput[] = () => [],
  netDay = 1,
): Promise<{ clock: ManualClock; setEvents: (f: () => CanonicalEntityInput[]) => void }> {
  const clock = new ManualClock(now);
  uc = createUniContext({
    profile: 'shizuoka-university',
    clock,
    student: { campus: '浜松', faculty: '情報学部' },
  });
  let eventList = events;
  uc.sync.register({
    sourceId: 'livecampusu',
    adapter: staticAdapter('livecampusu', () => timetable(netDay)),
    normalizer,
    metadata: meta('livecampusu', '学務情報システム', 'academic-system', [
      'courses',
      'timetable',
      'enrollments',
    ]),
  });
  uc.sync.register({
    sourceId: 'microsoft365',
    adapter: staticAdapter('microsoft365', () => eventList()),
    normalizer,
    metadata: meta('microsoft365', 'Outlook', 'calendar', ['courses']),
  });
  for (const id of ['livecampusu', 'microsoft365']) expect((await uc.sync.sync(id)).ok).toBe(true);
  await uc.runPipeline();
  return {
    clock,
    setEvents: (f) => {
      eventList = f;
    },
  };
}

const ev = (
  key: string,
  title: string,
  start: string,
  end: string,
  extra: Record<string, unknown> = {},
): CanonicalEntityInput =>
  ({
    id: stableId('calendarEvent', 'ms', key),
    kind: 'calendarEvent',
    title,
    startsAt: jst('2026-10-05', start),
    endsAt: jst('2026-10-05', end),
    allDay: false,
    ...extra,
  }) as CanonicalEntityInput;

const MONDAY_EVENTS = (): CanonicalEntityInput[] => [
  ev('seminar', 'ゼミ', '13:00', '14:00', { location: '工学部' }),
  ev('club', 'サークル', '15:00', '16:30', { location: '体育館' }),
  ev('meeting', 'ミーティング', '16:45', '17:30', { location: 'https://teams.microsoft.com/l/x' }),
  // never busy time
  ev('allday', 'テスト休み', '00:00', '23:59', { allDay: true }),
  ev('holiday', 'スポーツの日', '13:00', '14:00', { category: '祝日' }),
  // the academic system's calendar mirror of its own timetable (not a second thing to attend)
  ev('mirror', '生命科学(後期前半) 3・4限 10:20-11:50 工２－３１', '10:20', '11:50', {
    category: 'TimeTable',
  }),
  // the calendar copy of the data base class
  ev('dbcopy', 'データベース', '14:25', '15:55'),
];

const dayStart = (d: string): Date => new Date(jst(d, '00:00'));
const monday = { from: dayStart('2026-10-05'), to: dayStart('2026-10-06') };

describe('busyIntervals', () => {
  it('merges classes and calendar events, leaving out all-day, holiday and class copies', async () => {
    await setup(NOW, MONDAY_EVENTS);
    const busy = busyIntervals(uc, monday.from, monday.to);
    expect(busy.map((b) => [b.kind, b.title, b.start.slice(11, 16), b.end.slice(11, 16)])).toEqual([
      ['class', '2限 ネットワーク', '01:20', '02:50'], // 10:20-11:50 JST
      ['event', 'ゼミ', '04:00', '05:00'], // 13:00-14:00 JST
      ['class', '4限 データベース', '05:25', '06:55'],
      ['event', 'サークル', '06:00', '07:30'],
      ['event', 'ミーティング', '07:45', '08:30'],
    ]);
    const seminar = busy.find((b) => b.title === 'ゼミ');
    expect(seminar?.location).toBe('工学部');
    expect(seminar?.citations.length).toBeGreaterThan(0);
    expect(busy.find((b) => b.kind === 'class')?.location).toBe('工３－３１');
  });

  it('lists the overlap of an event with a class, with its length', async () => {
    await setup(NOW, MONDAY_EVENTS);
    const conflicts = busyConflicts(uc, monday.from, monday.to);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      a: { kind: 'class', title: '4限 データベース' },
      b: { kind: 'event', title: 'サークル' },
      minutes: 55,
    });
    expect(conflicts[0]?.summary).toContain('55分重なっています');
  });

  it('a cancelled class is not busy time', async () => {
    await setup(NOW, MONDAY_EVENTS);
    const c = uc.context.today().classes.find((x) => x.course.title === 'データベース');
    expect(c).toBeDefined();
    c!.cancelled = true;
    const w = nextActionBusy({}, [c!], '2026-10-05', '2026-10-05');
    expect(w).toEqual([]);
  });
});

describe('views', () => {
  it('today and the week list the events with location and place, and the overlap', async () => {
    await setup(NOW, MONDAY_EVENTS);
    const today = uc.context.today();
    expect(today.events?.map((e) => e.title)).toEqual(['ゼミ', 'サークル', 'ミーティング']);
    const seminar = today.events?.[0];
    expect(seminar).toMatchObject({
      location: '工学部',
      place: { room: '工学部', building: '工', campus: '浜松' },
    });
    expect(seminar?.citations.length).toBeGreaterThan(0);
    // an online location is not a place
    expect(today.events?.[2]?.place).toBeUndefined();
    expect(today.overlaps).toHaveLength(1);
    expect(today.overlaps?.[0]).toMatchObject({ minutes: 55 });

    const week = uc.context.week();
    expect(week.events?.map((e) => e.title)).toEqual(['ゼミ', 'サークル', 'ミーティング']);
    expect(week.overlaps).toHaveLength(1);
    // tomorrow has no events: the fields are absent
    expect(uc.context.tomorrow().events).toBeUndefined();
  });

  it('classes carry their room as a place with a derived Location id', async () => {
    await setup(NOW);
    const c = uc.context.today().classes.find((x) => x.course.title === 'データベース');
    expect(c?.place).toMatchObject({ building: '工', room: '工5-22', campus: '浜松' });
    expect(c?.locationId).toBe(c?.place?.locationId);
    const net2 = uc.context.today().classes.find((x) => x.course.title === 'ネットワーク');
    // another room of the same building: the same Location id is not shared, the building key is
    expect(net2?.locationId).toBeDefined();
  });

  it('the student state carries the day’s events and overlaps', async () => {
    await setup(NOW, MONDAY_EVENTS);
    const s = studentState(uc);
    expect(s.today.events?.length).toBe(3);
    expect(s.today.overlaps?.length).toBe(1);
  });
});

describe('next action', () => {
  const withAssignment = (events: () => CanonicalEntityInput[]) => () => [...events()];

  async function farFreeHours(events: () => CanonicalEntityInput[]): Promise<number> {
    await setup(NOW, withAssignment(events));
    uc.sync.register({
      sourceId: 'edstem',
      adapter: staticAdapter('edstem', () => [
        {
          id: stableId('assignment', 'ed', 'far'),
          kind: 'assignment',
          courseOfferingId: dbc,
          title: '大きなレポート',
          dueAt: '2026-10-12T14:59:00.000Z',
        } as CanonicalEntityInput,
      ]),
      normalizer,
      metadata: meta('edstem', 'EdStem', 'submission-system', ['courses', 'assignments']),
    });
    expect((await uc.sync.sync('edstem')).ok).toBe(true);
    await uc.runPipeline();
    const far = uc.context
      .nextActions({ count: 5 })
      .next.concat(uc.context.nextActions({ count: 5 }).top ?? []);
    const item = far.find((a) => a.title === '大きなレポート');
    expect(item?.freeHoursBeforeDue).toBeDefined();
    const hours = item?.freeHoursBeforeDue as number;
    await uc.close();
    return hours;
  }

  it('a 13:00-14:00 calendar event takes an hour off the free time', async () => {
    const without = await farFreeHours(() => []);
    const withEvent = await farFreeHours(() => [ev('seminar', 'ゼミ', '13:00', '14:00')]);
    expect(without - withEvent).toBeCloseTo(1, 1);
  });
});

describe('attention', () => {
  it('an event overlapping a class is an alert for today', async () => {
    await setup(NOW, MONDAY_EVENTS);
    const att = attentionRequired(uc, 'watcher', { dryRun: true });
    const alert = att.items.find((i) => i.line.includes('予定が重なっています'));
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe('warning');
    expect(alert?.line).toContain('今日');
    expect(alert?.line).toContain('サークル');
    expect(alert?.recommendedAction).toContain('どちらに出るか');
    expect(alert?.citations.length).toBeGreaterThan(0);
  });

  it('an event whose location changed since the last call is an alert', async () => {
    const { clock, setEvents } = await setup(NOW, MONDAY_EVENTS);
    // the first call tells everything there is; later calls only what is new
    attentionRequired(uc, 'watcher');
    clock.advance(10 * 60_000);
    setEvents(() => [
      ev('seminar', 'ゼミ', '13:00', '14:00', { location: '工学部5号館 301' }),
      ev('club', 'サークル', '15:00', '16:30', { location: '体育館' }),
    ]);
    expect((await uc.sync.sync('microsoft365')).ok).toBe(true);
    await uc.runPipeline();
    const att = attentionRequired(uc, 'watcher', { dryRun: true });
    const alert = att.items.find((i) => i.line.includes('場所変更'));
    expect(alert).toBeDefined();
    expect(alert?.line).toContain('ゼミ');
    expect(alert?.line).toContain('工学部5号館 301');
  });
});

describe('travel time (set_travel_time)', () => {
  it('home→工学部 10 minutes: the first class of the day shows it and it is busy time; retract removes it', async () => {
    await setup(NOW, MONDAY_EVENTS);
    const first = () => uc.context.today().classes.find((c) => c.course.title === 'ネットワーク');
    expect(first()?.travelFromPrevious).toBeUndefined();

    const r = await uc.additions.setTravelTime(chat, {
      from: 'home',
      to: '工学部',
      minutes: 10,
      mode: 'bike',
      statement: '家から工学部まで自転車で10分',
    });
    expect(r.status).toBe('created');
    expect(r.addition).toMatchObject({
      kind: 'place',
      tool: 'set_travel_time',
      status: 'unconfirmed',
    });
    const f = uc.resolver.facts.getMany(r.addition.stored ? r.audit.factIds : []);
    expect(f[0]).toMatchObject({
      subject: 'location:home',
      predicate: 'travel:minutes',
      origin: 'user',
      value: { to: '工', minutes: 10, mode: 'bike' },
    });

    expect(first()?.travelFromPrevious).toMatchObject({ minutes: 10, from: '自宅', mode: 'bike' });
    // the seminar is in the same area as the class before it: no trip
    expect(uc.context.today().events?.[0]?.travelFromPrevious).toBeUndefined();

    const busy = busyIntervals(uc, monday.from, monday.to);
    const trip = busy.find((b) => b.kind === 'travel');
    expect(trip).toMatchObject({
      start: jst('2026-10-05', '10:10'),
      end: jst('2026-10-05', '10:20'),
    });

    // next-action: the trip is busy time before the class
    const host = uc.context.nextActionHost();
    const classes = host.classes('2026-10-05', '2026-10-05');
    const sum = (list: { start: number; end: number }[]): number =>
      list.reduce((t, x) => t + (x.end - x.start), 0) / 60_000;
    const withTrip = sum(nextActionBusy(host, classes, '2026-10-05', '2026-10-05'));
    await uc.additions.retract(chat, r.addition.id);
    const without = sum(
      nextActionBusy(uc.context.nextActionHost(), classes, '2026-10-05', '2026-10-05'),
    );
    expect(withTrip - without).toBe(10);

    expect(first()?.travelFromPrevious).toBeUndefined();
    expect(busyIntervals(uc, monday.from, monday.to).some((b) => b.kind === 'travel')).toBe(false);
  });

  it('a trip counts both ways, and the newest statement of a pair wins', async () => {
    await setup(NOW, () => [ev('lab', 'ラボ', '13:00', '14:00', { location: '情１３' })]);
    const r8 = await uc.additions.setTravelTime(chat, {
      from: '情13',
      to: '工5-22',
      minutes: 8,
      statement: '情13から工5は歩いて8分',
    });
    // Monday: ネットワーク (工) → ラボ (情) → データベース (工)
    const lab = () => uc.context.today().events?.find((e) => e.title === 'ラボ');
    const dbClass = () => uc.context.today().classes.find((c) => c.course.title === 'データベース');
    expect(lab()?.travelFromPrevious).toMatchObject({ minutes: 8, from: '工学部' });
    expect(dbClass()?.travelFromPrevious).toMatchObject({ minutes: 8, from: '情報学部' });

    const r12 = await uc.additions.setTravelTime(chat, {
      from: '情13',
      to: '工学部',
      minutes: 12,
      mode: 'walk',
      statement: 'やっぱり12分かかる',
    });
    expect(r12.status).toBe('created');
    expect(lab()?.travelFromPrevious).toMatchObject({ minutes: 12, mode: 'walk' });
    expect(dbClass()?.travelFromPrevious?.minutes).toBe(12);
    // the older statement is replaced, not kept beside it
    const live = uc.resolver.facts.active({
      subjects: ['location:情'],
      predicate: 'travel:minutes',
    });
    expect(live).toHaveLength(1);
    expect(r8.audit.factIds).not.toEqual(r12.audit.factIds);
  });

  it('rejects a trip from a place to itself and a silly length', async () => {
    await setup(NOW);
    await expect(
      uc.additions.setTravelTime(chat, {
        from: '工学部',
        to: '工5-22',
        minutes: 5,
        statement: 'x',
      }),
    ).rejects.toThrow(/same place/);
    await expect(
      uc.additions.setTravelTime(chat, { from: 'home', to: '工学部', minutes: 0, statement: 'x' }),
    ).rejects.toThrow(/minutes/);
  });
});

describe('a room change for one session', () => {
  // The Teams post 「本日の授業は21教室で行います」 of Tuesday 2026-10-06 08:50 JST, through the real
  // Teams normalizer; ネットワーク meets on Tuesdays in 工３－３１.
  const GROUP = 'group-net';
  const teams = createTeamsWebNormalizer();
  const teamsCtx = createNormalizeContext({
    sourceId: 'teams-web',
    sourceSystem: 'teams-web',
    sourceLabel: 'Teams',
    defaultAuthority: 'collaboration',
    timezone: 'Asia/Tokyo',
    now: new Date('2026-10-06T00:00:00Z'),
  });
  const teamsOffering = teamsCtx.id('courseOffering', GROUP);

  async function post(text: string, at: string): Promise<NormalizeOutput> {
    const payload = {
      teamGroupId: GROUP,
      teamId: '19:team@thread.tacv2',
      teamName: 'ネットワーク',
      spaceType: 'class',
      channelId: '19:general@thread.tacv2',
      channelName: 'General',
      instructorMris: ['8:orgid:teacher'],
      replyChainId: '1790000000001',
      messages: [
        {
          id: '1790000000001',
          parentMessageId: '1790000000001',
          type: 'Message',
          messageType: 'RichText/Html',
          originalArrivalTime: Date.parse(at),
          imDisplayName: '教員 一郎',
          creator: '8:orgid:teacher',
          content: `<p>${text}</p>`,
          properties: {},
        },
      ],
    };
    const view: RawItemView = {
      id: 'raw:1',
      sourceId: 'teams-web',
      sourceType: 'teamsweb.replychain',
      externalId: 'chain-1',
      payload,
      fetchedAt: at,
      sourceUpdatedAt: undefined,
      contentHash: 'h',
    };
    return teams.normalize(view, teamsCtx) as NormalizeOutput;
  }

  async function withPost(
    text: string,
    at = '2026-10-06T08:50:00+09:00',
  ): Promise<NormalizeOutput> {
    const out = await post(text, at);
    const { clock } = await setup('2026-10-06T00:00:00.000Z', () => [], 2);
    void clock;
    uc.sync.register({
      sourceId: 'teams-web',
      adapter: staticAdapter('teams-web', () => [
        {
          id: teamsOffering,
          kind: 'courseOffering',
          title: 'ネットワーク',
          academicYear: 2026,
          term: '後期',
          instructorNames: [],
          schedule: [],
        } as CanonicalEntityInput,
      ]),
      normalizer: {
        ...normalizer,
        normalize: (item) => ({
          entities: (item.payload as { entities: CanonicalEntityInput[] }).entities.map(
            (entity) => ({ entity, ref: { url: 'https://example.ac.jp/' } }),
          ),
          facts: out.facts ?? [],
        }),
      },
      metadata: meta('teams-web', 'Teams', 'collaboration', ['courses']),
    });
    expect((await uc.sync.sync('teams-web')).ok).toBe(true);
    uc.identity.confirm(net, teamsOffering);
    await uc.runPipeline();
    return out;
  }

  const netOn = (date: string) =>
    uc.context.classesOn(date).find((c) => c.course.title === 'ネットワーク');

  it('本日 → the room is the post day’s only; the next week shows the regular room', async () => {
    const out = await withPost('本日の授業は21教室で行います');
    expect(out.facts).toHaveLength(1);
    expect(out.facts?.[0]).toMatchObject({
      predicate: 'room',
      value: '21教室',
      validFrom: jst('2026-10-06', '00:00'),
      validUntil: jst('2026-10-07', '00:00'),
    });
    expect(netOn('2026-10-06')?.room.value).toBe('21教室');
    expect(netOn('2026-10-13')?.room.value).toBe('工３－３１');
    // the course's own room is untouched by a one-day change
    const course = uc.context.course(net);
    expect(course.room.value ?? '工３－３１').not.toBe('21教室');
    expect(course.upcomingClasses.find((c) => c.date === '2026-10-13')?.room.value).toBe(
      '工３－３１',
    );
  });

  it('no date: no room fact; the post stays news with roomHint.unresolved', async () => {
    const out = await withPost('教室を21教室に変更します');
    expect(out.facts ?? []).toEqual([]);
    expect(netOn('2026-10-06')?.room.value).toBe('工３－３１');
    const ann = out.entities.find((e) => e.entity.kind === 'announcement');
    expect(ann?.entity.extra).toMatchObject({ roomHint: { room: '21教室', unresolved: true } });
  });

  it('今後 changes the course’s room for every session', async () => {
    await withPost('今後は21教室で行います');
    expect(netOn('2026-10-06')?.room.value).toBe('21教室');
    expect(netOn('2026-10-13')?.room.value).toBe('21教室');
    expect(uc.context.course(net).room.value).toBe('21教室');
  });
});

describe('re-deriving stored room posts with a newer normalizer', () => {
  // An install that stored 「本日の授業は21教室で行います」 with the old normalizer holds a course-wide room
  // fact. The fact id does not cover the validity window, so the new normalizer's dated fact has the
  // same id: the stored fact must get its window instead of being kept as it is.
  const GROUP = 'group-net';
  const teams = createTeamsWebNormalizer();
  const teamsCtx = createNormalizeContext({
    sourceId: 'teams-web',
    sourceSystem: 'teams-web',
    sourceLabel: 'Teams',
    defaultAuthority: 'collaboration',
    timezone: 'Asia/Tokyo',
    now: new Date('2026-10-06T00:00:00Z'),
  });
  const teamsOffering = teamsCtx.id('courseOffering', GROUP);
  const at = '2026-10-06T08:50:00+09:00';

  const chainItem = {
    sourceType: 'teamsweb.replychain',
    externalId: 'chain-1',
    payload: {
      teamGroupId: GROUP,
      teamId: '19:team@thread.tacv2',
      teamName: 'ネットワーク',
      spaceType: 'class',
      channelId: '19:general@thread.tacv2',
      channelName: 'General',
      instructorMris: ['8:orgid:teacher'],
      replyChainId: '1790000000001',
      messages: [
        {
          id: '1790000000001',
          parentMessageId: '1790000000001',
          type: 'Message',
          messageType: 'RichText/Html',
          originalArrivalTime: Date.parse(at),
          imDisplayName: '教員 一郎',
          creator: '8:orgid:teacher',
          content: '<p>本日の授業は21教室で行います</p>',
          properties: {},
        },
      ],
    },
  };
  const offeringItem = {
    sourceType: 'test.entities',
    externalId: 'offering',
    payload: {
      entities: [
        {
          id: teamsOffering,
          kind: 'courseOffering',
          title: 'ネットワーク',
          academicYear: 2026,
          term: '後期',
          instructorNames: [],
          schedule: [],
        },
      ],
    },
  };

  /** The Teams normalizer; `old` drops the validity window like the version before the day scoping. */
  const teamsNormalizer = (version: string, old: boolean): Normalizer => ({
    ...teams,
    version,
    sourceTypes: [...teams.sourceTypes, 'test.entities'],
    normalize: async (item, ctx) => {
      if (item.sourceType === 'test.entities') return normalizer.normalize(item, ctx);
      const out = await teams.normalize(item, ctx);
      if (!old) return out;
      return {
        ...out,
        facts: (out.facts ?? []).map(({ validFrom: _f, validUntil: _u, ...rest }) => rest),
      };
    },
  });

  const register = (n: Normalizer): void =>
    uc.sync.register({
      sourceId: 'teams-web',
      adapter: {
        ...staticAdapter('teams-web', () => []),
        sync: () =>
          Promise.resolve({
            items: [chainItem, offeringItem],
            hasMore: false,
            complete: { sourceTypes: ['teamsweb.replychain', 'test.entities'] },
          }),
      },
      normalizer: n,
      metadata: {
        ...meta('teams-web', 'Teams', 'collaboration', ['courses']),
        rawTypes: ['teamsweb.replychain', 'test.entities'],
      },
    });

  const netOn = (date: string) =>
    uc.context.classesOn(date).find((c) => c.course.title === 'ネットワーク');

  it('the course-wide fact stored by the old version gets its one-day window', async () => {
    await setup('2026-10-06T00:00:00.000Z', () => [], 2);
    register(teamsNormalizer('old', true));
    expect((await uc.sync.sync('teams-web')).ok).toBe(true);
    uc.identity.confirm(net, teamsOffering);
    await uc.runPipeline();
    // the old behaviour: the one-day room became the course's room, for every session
    expect(uc.context.course(net).room.value).toBe('21教室');
    expect(netOn('2026-10-13')?.room.value).toBe('21教室');

    register(teamsNormalizer(teams.version, false));
    const r = await uc.sync.sync('teams-web', { mode: 'full' });
    expect(r.ok).toBe(true);
    expect(r.normalized.items).toBeGreaterThan(0);
    await uc.runPipeline();

    const history = uc.sync.facts.history(teamsOffering, 'room');
    const live = history.filter((f) => !f.retractedAt);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      value: '21教室',
      validFrom: jst('2026-10-06', '00:00'),
      validUntil: jst('2026-10-07', '00:00'),
    });
    expect(netOn('2026-10-06')?.room.value).toBe('21教室');
    expect(netOn('2026-10-13')?.room.value).toBe('工３－３１');
    expect(uc.context.course(net).room.value ?? '工３－３１').not.toBe('21教室');
  });
});

describe('a room post that names no fact-grade day (roomHint)', () => {
  // 次回 / no day: the normalizer only keeps extra.roomHint; the engine resolves it with the
  // course's sessions, shows the room next to the timetable's and raises an alert.
  const GROUP = 'group-net';
  const teams = createTeamsWebNormalizer();
  const teamsCtx = createNormalizeContext({
    sourceId: 'teams-web',
    sourceSystem: 'teams-web',
    sourceLabel: 'Teams',
    defaultAuthority: 'collaboration',
    timezone: 'Asia/Tokyo',
    now: new Date('2026-10-06T00:00:00Z'),
  });
  const teamsOffering = teamsCtx.id('courseOffering', GROUP);

  async function withHintPost(text: string, at: string): Promise<NormalizeOutput> {
    const view: RawItemView = {
      id: 'raw:1',
      sourceId: 'teams-web',
      sourceType: 'teamsweb.replychain',
      externalId: 'chain-1',
      payload: {
        teamGroupId: GROUP,
        teamId: '19:team@thread.tacv2',
        teamName: 'ネットワーク',
        spaceType: 'class',
        channelId: '19:general@thread.tacv2',
        channelName: 'General',
        instructorMris: ['8:orgid:teacher'],
        replyChainId: '1790000000001',
        messages: [
          {
            id: '1790000000001',
            parentMessageId: '1790000000001',
            type: 'Message',
            messageType: 'RichText/Html',
            originalArrivalTime: Date.parse(at),
            imDisplayName: '教員 一郎',
            creator: '8:orgid:teacher',
            content: `<p>${text}</p>`,
            properties: {},
          },
        ],
      },
      fetchedAt: at,
      sourceUpdatedAt: undefined,
      contentHash: 'h',
    };
    const out = (await teams.normalize(view, teamsCtx)) as NormalizeOutput;
    await setup('2026-10-06T00:00:00.000Z', () => [], 2);
    uc.sync.register({
      sourceId: 'teams-web',
      adapter: staticAdapter('teams-web', () => []),
      normalizer: {
        ...normalizer,
        normalize: () => ({
          entities: [
            {
              entity: {
                id: teamsOffering,
                kind: 'courseOffering',
                title: 'ネットワーク',
                academicYear: 2026,
                term: '後期',
                instructorNames: [],
                schedule: [],
              } as CanonicalEntityInput,
              ref: { url: 'https://example.ac.jp/' },
            },
            ...out.entities,
          ],
          facts: out.facts ?? [],
        }),
      },
      metadata: meta('teams-web', 'Teams', 'collaboration', ['courses']),
    });
    expect((await uc.sync.sync('teams-web')).ok).toBe(true);
    uc.identity.confirm(net, teamsOffering);
    await uc.runPipeline();
    return out;
  }

  const netOn = (date: string) =>
    uc.context.classesOn(date).find((c) => c.course.title === 'ネットワーク');

  it('次回 → the next meeting shows the hinted room next to the timetable’s, and an alert', async () => {
    const out = await withHintPost('次回の授業は21教室で行います', '2026-10-06T08:50:00+09:00');
    expect(out.facts ?? []).toEqual([]);
    const next = netOn('2026-10-13');
    expect(next?.roomHint).toMatchObject({
      room: '21教室',
      basis: 'named-day',
      otherRoom: '工３－３１',
    });
    expect(next?.room.status).toBe('conflict');
    expect(next?.room.candidates.map((c) => c.value).sort()).toEqual(['21教室', '工３－３１']);
    expect(next?.room.value).toBe('工３－３１');
    expect(next?.summary).toContain('食い違');
    // today's meeting and the one after are untouched
    expect(netOn('2026-10-06')?.roomHint).toBeUndefined();
    expect(netOn('2026-10-06')?.room.value).toBe('工３－３１');
    expect(netOn('2026-10-20')?.roomHint).toBeUndefined();
    // the course's own room stays the regular one
    expect(uc.context.course(net).room.value ?? '工３－３１').not.toBe('21教室');
    const att = attentionRequired(uc, 'watcher', { dryRun: true });
    const alert = att.items.find((i) => i.kind === 'room_change' && i.line.includes('21教室'));
    expect(alert).toBeDefined();
    expect(alert?.line).toContain('教室変更の可能性');
    expect(alert?.line).toContain('工３－３１');
    expect(alert?.severity).toBe('info');
    expect(alert?.citations.length).toBeGreaterThan(0);
    expect(alert?.recommendedAction).toContain('確かめる');
  });

  it('no day at all → the first meeting after the post (today’s, still ahead), warning', async () => {
    await withHintPost('教室を21教室に変更します', '2026-10-06T08:50:00+09:00');
    const today = netOn('2026-10-06');
    expect(today?.roomHint?.basis).toBe('next-session');
    expect(today?.room.status).toBe('conflict');
    expect(netOn('2026-10-13')?.roomHint).toBeUndefined();
    const att = attentionRequired(uc, 'watcher', { dryRun: true });
    const alert = att.items.find((i) => i.kind === 'room_change' && i.line.includes('21教室'));
    expect(alert?.severity).toBe('warning');
  });

  it('a hint that names the room the meeting already has changes nothing', async () => {
    await withHintPost('次回の授業は工３－３１で行います', '2026-10-06T08:50:00+09:00');
    expect(netOn('2026-10-13')?.roomHint).toBeUndefined();
    expect(netOn('2026-10-13')?.room.status).toBe('resolved');
  });
});
