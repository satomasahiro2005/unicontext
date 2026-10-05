import { type CanonicalEntityInput, stableId } from '@unicontext/canonical-model';
import { ManualClock } from '@unicontext/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defineMetadata,
  type NormalizeOutput,
  type Normalizer,
  type SourceAdapter,
} from '../../connector-sdk/src/index.js';
import {
  attentionRequired,
  createUniContext,
  studentState,
  type UniContext,
} from '../src/index.js';

// 情報科学実験B is in the timetable on Monday 3–5 for everybody, but taught in two groups: the
// distributed 実施スケジュール puts group A on Mondays (C&C) and group B on Fridays (科学実験室).
// Monday 2026-10-05 09:30 JST is group A's first day.
const NOW = '2026-10-05T00:30:00.000Z';
const lcu = <K extends 'courseOffering' | 'person' | 'enrollment'>(kind: K, key: string) =>
  stableId(kind, 'lcu', key);
const self = lcu('person', 'self');
const expB = lcu('courseOffering', 'expB');
const expC = lcu('courseOffering', 'expC');
const teamsB = stableId('courseOffering', 'teams', 'expB');
const scheduleDoc = stableId('document', 'teams', 'schedule');

const TABLE_B = `2026年度情報科学実験B実施スケジュール
日付 グループ 教室 回数
10/02(金) B 科学実験室 #01
10/05(月) A C&C #01
10/09(金) B 科学実験室 #02
10/12(月) スポーツの日
10/16(金) A 科学実験室 #02
10/19(月) B C&C #03
11/06(金) 休講（学際準備）
11/25(水) A #07（月曜授業）`;

function lcuEntities(): CanonicalEntityInput[] {
  const out: CanonicalEntityInput[] = [
    { id: self, kind: 'person', name: '本人', roles: ['student'], isSelf: true },
  ];
  const add = (id: string, key: string, title: string, day: number) => {
    out.push({
      id: id as never,
      kind: 'courseOffering',
      title,
      academicYear: 2026,
      term: '後期',
      instructorNames: ['教員 一郎'],
      schedule: [3, 4, 5].map((period) => ({
        dayOfWeek: day,
        period,
        room: '情報科学科実習室1 他',
      })),
      scheduleType: 'regular',
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
  add(expB, 'expB', '情報科学実験B', 1);
  add(expC, 'expC', '情報科学実験C', 5);
  out.push({
    id: stableId('announcement', 'lcu', 'expB-teams'),
    kind: 'announcement',
    courseOfferingId: expB as never,
    title: '情報科学実験B teams 登録について',
    body: '登録は，10/9(金) 12:00 までに終わらせておくようにお願いします (A班の皆様もよろしくお願いします)．',
    publishedAt: '2026-10-01T04:06:00.000Z',
  } as CanonicalEntityInput);
  out.push({
    id: stableId('announcement', 'lcu', 'expB-survey'),
    kind: 'announcement',
    courseOfferingId: expB as never,
    title: 'アンケートのお願い',
    body: 'A班はアンケートを10/9(金) 17:00までに回答してください。',
    publishedAt: '2026-10-01T04:06:00.000Z',
  } as CanonicalEntityInput);
  out.push({
    id: stableId('announcement', 'lcu', 'deadline-widget'),
    kind: 'announcement',
    title: '履修登録期限',
    body: '履修登録期限(一般): 10月7日まで(済)',
    scope: 'university',
    importance: 'high',
    category: '期限',
    publishedAt: '2026-10-01T00:00:00.000Z',
  } as CanonicalEntityInput);
  return out;
}

function teamsEntities(): CanonicalEntityInput[] {
  return [
    {
      id: teamsB as never,
      kind: 'courseOffering',
      title: '情報科学実験B',
      academicYear: 2026,
      term: '後期',
      instructorNames: [],
      schedule: [],
    } as CanonicalEntityInput,
    {
      id: scheduleDoc,
      kind: 'document',
      title: '2026実験Bスケジュール_配布.pdf',
      mimeType: 'application/pdf',
      courseOfferingId: teamsB as never,
      modifiedAt: '2026-10-02T01:48:19.000Z',
    } as CanonicalEntityInput,
    {
      id: stableId('documentChunk', 'teams', 'schedule', '0'),
      kind: 'documentChunk',
      documentId: scheduleDoc,
      ordinal: 0,
      text: TABLE_B,
      page: 1,
    } as CanonicalEntityInput,
  ];
}

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

const normalizer: Normalizer = {
  id: 'test-entities',
  version: '1',
  sourceTypes: ['test.entities'],
  normalize: (item): NormalizeOutput => ({
    entities: (item.payload as { entities: CanonicalEntityInput[] }).entities.map((entity) => ({
      entity,
      ref: { url: 'https://example.ac.jp/' },
    })),
    facts: [],
  }),
};

let uc: UniContext;
let clock: ManualClock;
const chat = { id: 'local:chatgpt', name: 'ChatGPT' };

async function setup(withTable: boolean): Promise<void> {
  clock = new ManualClock(NOW);
  uc = createUniContext({
    profile: 'shizuoka-university',
    clock,
    student: { campus: '浜松', faculty: '情報学部' },
  });
  uc.sync.register({
    sourceId: 'livecampusu',
    adapter: staticAdapter('livecampusu', lcuEntities),
    normalizer,
    metadata: meta('livecampusu', '学務情報システム', 'academic-system', [
      'courses',
      'timetable',
      'enrollments',
      'announcements',
    ]),
  });
  if (withTable)
    uc.sync.register({
      sourceId: 'teams-web',
      adapter: staticAdapter('teams-web', teamsEntities),
      normalizer,
      metadata: meta('teams-web', 'Teams', 'collaboration', ['courses', 'materials']),
    });
  expect((await uc.sync.sync('livecampusu')).ok).toBe(true);
  if (withTable) expect((await uc.sync.sync('teams-web')).ok).toBe(true);
  // The Teams team is the same course as the academic system's offering.
  if (withTable) uc.identity.confirm(expB, teamsB);
  await uc.runPipeline();
}

const expBOn = (date: string) =>
  uc.context.classesOn(date).filter((c) => c.course.title === '情報科学実験B');

afterEach(async () => {
  await uc.close();
});

describe('effective schedule from a distributed group table', () => {
  beforeEach(async () => {
    await setup(true);
  });

  it('marks the timetable meeting unknown (group-dependent) while the group is not known', () => {
    const today = uc.context.today();
    const b = today.classes.filter((c) => c.course.title === '情報科学実験B');
    expect(b.map((c) => c.period)).toEqual([3, 4, 5]);
    for (const c of b) {
      expect(c.effectiveSchedule.status).toBe('unknown');
      expect(c.effectiveSchedule.reason).toContain('Aグループ');
      expect(c.rawSchedule?.room).toBe('情報科学科実習室1 他');
      expect(c.effectiveSchedule.rule?.provenance).toBe('document');
      expect(c.effectiveSchedule.rule?.evidence).toBe('10/05(月) A C&C #01');
    }
    // Friday: group B's meeting is not in the timetable, still listed as unknown (never dropped).
    expect(expBOn('2026-10-09').map((c) => c.effectiveSchedule.status)).toEqual([
      'unknown',
      'unknown',
      'unknown',
    ]);
    const att = attentionRequired(uc, 'watcher', { dryRun: true });
    const ask = att.items.find((i) => i.kind === 'group_unknown');
    expect(ask?.recommendedAction).toContain('set_course_condition');
    expect(ask?.severity).toBe('warning');
  });

  it('group B: Monday is group A’s day (not attending), Friday is the student’s meeting', async () => {
    const r = await uc.additions.setCourseCondition(chat, {
      courseOfferingId: expB,
      value: 'Bグループ',
      evidence: '俺Bグループだよ',
    });
    expect(r.status).toBe('created');
    expect(r.addition.kind).toBe('condition');

    const today = uc.context.today();
    expect(today.classes.some((c) => c.course.title === '情報科学実験B')).toBe(false);
    const not = today.notAttending ?? [];
    expect(not.map((c) => c.period)).toEqual([3, 4, 5]);
    expect(not[0]?.effectiveSchedule).toMatchObject({
      status: 'not_attending',
      reason: 'Aグループの実施日（本人はBグループ）（配布資料）',
      group: { value: 'B', provenance: 'chat', confirmed: false },
    });
    expect(not[0]?.rawSchedule?.date).toBe('2026-10-05');
    expect(not[0]?.summary).toContain('本人は出席なし');
    expect(today.noClassesReason).toContain('出席なし');

    const fri = expBOn('2026-10-09');
    expect(
      fri.map((c) => [c.period, c.effectiveSchedule.status, c.effectiveSchedule.room]),
    ).toEqual([
      [3, 'attending', '科学実験室'],
      [4, 'attending', '科学実験室'],
      [5, 'attending', '科学実験室'],
    ]);
    expect(fri[0]?.rawSchedule).toBeUndefined();
    expect(fri[0]?.startsAt).toBe('2026-10-09T03:45:00.000Z'); // 12:45, the timetable's 3限
    expect(fri[0]?.effectiveSchedule.number).toBe(2);

    // 10/19 (Mon) is group B's day in C&C: the timetable meeting with the table's room.
    const mon = expBOn('2026-10-19');
    expect(mon.map((c) => c.effectiveSchedule.status)).toEqual([
      'attending',
      'attending',
      'attending',
    ]);
    expect(mon[0]?.room.value).toBe('C&C');
    expect(mon[0]?.rawSchedule?.room).toBe('情報科学科実習室1 他');

    // 11/06 (Fri) is a 休講 for everybody; 10/12 is a holiday (no timetable meeting either).
    expect(expBOn('2026-11-06')).toEqual([]);

    // The student-state snapshot and the week follow the effective schedule.
    const state = studentState(uc);
    expect(state.today.classes.some((c) => c.course === '情報科学実験B')).toBe(false);
    expect(state.today.notAttending?.[0]?.reason).toContain('Aグループの実施日');
    const week = uc.context.week();
    const friday = week.days.find((d) => d.date === '2026-10-09');
    expect(friday?.classes.filter((c) => c.course.title === '情報科学実験B')).toHaveLength(3);
    const monday = week.days.find((d) => d.date === '2026-10-05');
    expect(monday?.notAttending).toHaveLength(3);
  });

  it('group A: Monday is the student’s meeting in C&C, Friday is not', async () => {
    await uc.additions.setCourseCondition(chat, {
      courseOfferingId: expB,
      value: 'A',
      evidence: '実験はA班',
    });
    const b = uc.context.today().classes.filter((c) => c.course.title === '情報科学実験B');
    expect(b.map((c) => [c.effectiveSchedule.status, c.effectiveSchedule.room])).toEqual([
      ['attending', 'C&C'],
      ['attending', 'C&C'],
      ['attending', 'C&C'],
    ]);
    expect(b[0]?.effectiveSchedule.reason).toBe('Aグループの実施日（第1回）（配布資料）');
    expect(expBOn('2026-10-09')).toEqual([]);
  });

  it('a chat-registered rule never overrides the document; the disagreement is shown', async () => {
    await uc.additions.setCourseCondition(chat, {
      courseOfferingId: expB,
      value: 'B',
      evidence: 'Bグループ',
    });
    const r = await uc.additions.addSessionRule(chat, {
      courseOfferingId: expB,
      sessions: [{ date: '2026-10-05', group: 'B', room: 'C&C' }],
      evidence: '10/5はBグループ',
    });
    expect(r.addition.kind).toBe('session_rule');
    const not = uc.context.today().notAttending ?? [];
    expect(not).toHaveLength(3);
    expect(not[0]?.effectiveSchedule.conflicts?.[0]).toMatchObject({ about: 'session_rule' });
    expect(not[0]?.effectiveSchedule.conflicts?.[0]?.values.map((v) => v.value)).toEqual([
      'A C&C',
      'B C&C',
    ]);
  });

  it('keeps a deadline addressed only to another group out, and reads 「(済)」 as done', async () => {
    await uc.additions.setCourseCondition(chat, {
      courseOfferingId: expB,
      value: 'B',
      evidence: 'Bグループ',
    });
    const tasks = uc.tasks.list({});
    const extracted = tasks.filter((t) => t.taskKind === 'extracted');
    // 「A班はアンケートを…」: group A only → not the student's task.
    const survey = extracted.find((t) => t.evidence?.includes('アンケート'));
    expect(survey?.status ?? 'cancelled').toBe('cancelled');
    expect(uc.context.nextActions().next.some((a) => a.title.includes('アンケート'))).toBe(false);
    // 「(A班の皆様も…)」: everyone, group A as well → still the student's, with a short title.
    const reg = extracted.find((t) => t.evidence?.includes('登録は'));
    expect(reg?.title).toBe('teams 登録');
    expect(reg?.status).toBe('pending');
    // 「10月7日まで(済)」: already done, with the sentence as evidence.
    const done = extracted.find((t) => t.evidence?.includes('(済)'));
    expect(done?.status).toBe('completed');
    expect(done?.title).toBe('履修登録期限(一般)');
    expect(done?.statusEvidenceFactId).toBeDefined();
  });
});

describe('effective schedule from rules registered in a chat', () => {
  beforeEach(async () => {
    await setup(false);
  });

  it('applies an unconfirmed add_session_rule, labelled, and keeps the raw timetable', async () => {
    await uc.additions.setCourseCondition(chat, {
      courseOfferingId: expB,
      value: 'B',
      evidence: '俺B',
    });
    // No group schedule yet: the condition alone changes nothing.
    expect(
      uc.context.today().classes.filter((c) => c.course.title === '情報科学実験B'),
    ).toHaveLength(3);
    const r = await uc.additions.addSessionRule(chat, {
      courseOfferingId: expB,
      sessions: [
        { date: '2026-10-02', group: 'B', room: '科学実験室', number: 1 },
        { date: '2026-10-05', group: 'A', room: 'C&C', number: 1 },
        { date: '2026-10-09', group: 'B', room: '科学実験室', number: 2 },
      ],
      evidence: '10/02(金) B 科学実験室 #01 / 10/05(月) A C&C #01 / 10/09(金) B 科学実験室 #02',
      sourceDocument: '2026実験Bスケジュール_配布.pdf',
    });
    expect(r.status).toBe('created');
    const not = uc.context.today().notAttending ?? [];
    expect(not[0]?.effectiveSchedule.reason).toBe(
      'Aグループの実施日（本人はBグループ）（チャットで登録（未確認））',
    );
    expect(not[0]?.effectiveSchedule.rule).toMatchObject({
      provenance: 'chat',
      confirmed: false,
      documentTitle: '2026実験Bスケジュール_配布.pdf',
    });
    expect(expBOn('2026-10-09').map((c) => c.effectiveSchedule.status)).toEqual([
      'attending',
      'attending',
      'attending',
    ]);

    // The owner confirms: the rows become the student's own (no 未確認 label).
    await uc.additions.confirm(r.addition.id);
    const after = uc.context.today().notAttending ?? [];
    expect(after[0]?.effectiveSchedule.rule?.provenance).toBe('student');
    expect(after[0]?.effectiveSchedule.reason).toBe('Aグループの実施日（本人はBグループ）');
  });

  it('rejects a group label that is not one and rows without a group', async () => {
    await expect(
      uc.additions.setCourseCondition(chat, {
        courseOfferingId: expB,
        value: '前半',
        evidence: 'x',
      }),
    ).rejects.toThrow(/group label/);
    await expect(
      uc.additions.addSessionRule(chat, {
        courseOfferingId: expB,
        sessions: [{ date: '2026-10-05' }],
        evidence: 'x',
      }),
    ).rejects.toThrow(/needs a group/);
  });
});
