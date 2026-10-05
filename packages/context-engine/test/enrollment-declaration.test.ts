import { type CanonicalEntityInput, stableId } from '@unicontext/canonical-model';
import { ManualClock } from '@unicontext/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defineMetadata,
  type NormalizeOutput,
  type Normalizer,
  type SourceAdapter,
} from '../../connector-sdk/src/index.js';
import { attentionRequired, createUniContext, type UniContext } from '../src/index.js';

// 情報科学実験C (Fri 3–5) is still listed as 履修中 by the academic system, but the registration
// was rejected by email: the student says so in a chat. Monday 2026-10-05 09:30 JST.
const NOW = '2026-10-05T00:30:00.000Z';
const FRIDAY = '2026-10-09';
const lcu = <K extends 'courseOffering' | 'person' | 'enrollment' | 'assignment'>(
  kind: K,
  key: string,
) => stableId(kind, 'lcu', key);
const self = lcu('person', 'self');
const expB = lcu('courseOffering', 'expB');
const expC = lcu('courseOffering', 'expC');
const net = lcu('courseOffering', 'net');

function lcuEntities(dropNet = false): CanonicalEntityInput[] {
  const out: CanonicalEntityInput[] = [
    { id: self, kind: 'person', name: '本人', roles: ['student'], isSelf: true },
  ];
  const add = (id: string, key: string, title: string, day: number, status = 'active') => {
    out.push({
      id: id as never,
      kind: 'courseOffering',
      title,
      academicYear: 2026,
      term: '後期',
      instructorNames: ['教員 一郎'],
      schedule: [3, 4, 5].map((period) => ({ dayOfWeek: day, period, room: '実習室1' })),
      scheduleType: 'regular',
    });
    out.push({
      id: lcu('enrollment', key),
      kind: 'enrollment',
      personId: self,
      courseOfferingId: id as never,
      role: 'student',
      status: status as never,
    });
  };
  add(expB, 'expB', '情報科学実験B', 1);
  add(expC, 'expC', '情報科学実験C', 5);
  add(net, 'net', 'ネットワーク論', 3, dropNet ? 'dropped' : 'active');
  out.push({
    id: lcu('assignment', 'expC-report'),
    kind: 'assignment',
    courseOfferingId: expC as never,
    title: '実験C 事前レポート',
    dueAt: '2026-10-08T14:59:00.000Z',
  } as CanonicalEntityInput);
  const notice = (key: string, title: string, body: string, publishedAt: string) =>
    out.push({
      id: stableId('announcement', 'lcu', key),
      kind: 'announcement',
      title,
      body,
      scope: 'university',
      importance: 'high',
      publishedAt,
    } as CanonicalEntityInput);
  notice(
    'same-due',
    '抽選履修登録期間のご案内',
    '登録は10月20日(火)12:00まで。10月20日(火)12:00が締め切りです。',
    '2026-10-01T00:00:00.000Z',
  );
  notice(
    'restated-day',
    '授業料免除について',
    '申請は10月15日の17時00分までに提出してください。書類は10月15日まで受け付けます。',
    '2026-10-01T00:00:00.000Z',
  );
  notice(
    'two-dates',
    'ラウンジスタッフ募集',
    '応募は10/23(金)16:30まで。面接の希望は10/30(金)まで。',
    '2026-10-01T00:00:00.000Z',
  );
  notice(
    'old-two-dates',
    '国際交流ラウンジスタッフ募集',
    '応募は4/24(金)16:30まで。面接の希望は5/1(金)まで。',
    '2026-04-19T07:54:00.000Z',
  );
  return out;
}

const metadata = defineMetadata({
  name: '@unicontext/livecampusu',
  product: 'livecampusu',
  version: '1.0.0',
  license: 'MIT',
  capabilities: ['courses', 'timetable', 'enrollments', 'assignments'] as never,
  adapter: 'native',
  apiStability: 'unofficial',
  risk: 'unsupported',
  testedVersion: 'test',
  defaultAuthority: 'academic-system' as never,
  sourceLabel: '学務情報システム',
  rawTypes: ['test.entities'],
});

function adapter(entities: () => CanonicalEntityInput[]): SourceAdapter {
  return {
    id: 'livecampusu',
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
const chat = { id: 'local:claude', name: 'Claude' };

async function setup(dropNet = false): Promise<void> {
  uc = createUniContext({
    profile: 'shizuoka-university',
    clock: new ManualClock(NOW),
    student: { campus: '浜松', faculty: '情報学部' },
  });
  uc.sync.register({
    sourceId: 'livecampusu',
    adapter: adapter(() => lcuEntities(dropNet)),
    normalizer,
    metadata,
  });
  expect((await uc.sync.sync('livecampusu')).ok).toBe(true);
  await uc.runPipeline();
}

const titlesOn = (date: string) => uc.context.classesOn(date).map((c) => c.course.title);
const declare = (course: string, value: string) =>
  uc.additions.setCourseCondition(chat, {
    courseOfferingId: course,
    condition: 'enrollment',
    value,
    evidence: '本人: 実験Cは結局履修拒否された',
  });

afterEach(async () => {
  await uc.close();
});

describe('the student says they do not take a course the system still lists', () => {
  beforeEach(async () => {
    await setup();
  });

  it('shows the course everywhere before the declaration', () => {
    expect(titlesOn(FRIDAY)).toContain('情報科学実験C');
    expect(uc.context.today().deadlines.map((d) => d.title)).toContain('実験C 事前レポート');
    expect(uc.context.enrollmentOf(expC).enrolled).toBe(true);
  });

  it('hides it at once while unconfirmed, with a one-line note, and deletes nothing', async () => {
    const r = await declare(expC, 'not_taking');
    expect(r.status).toBe('created');
    expect(r.addition.title).toBe('情報科学実験C: 履修していない（本人）');
    expect(r.addition.status).toBe('unconfirmed');

    expect(titlesOn(FRIDAY)).toEqual([]);
    const week = uc.context.week();
    expect(week.days.flatMap((d) => d.classes.map((c) => c.course.title))).not.toContain(
      '情報科学実験C',
    );
    const today = uc.context.today();
    expect(today.deadlines.map((d) => d.title)).not.toContain('実験C 事前レポート');
    expect(today.tasks.map((t) => t.title)).not.toContain('実験C 事前レポート');
    expect(JSON.stringify(uc.context.nextActions())).not.toContain('実験C');
    expect(JSON.stringify(attentionRequired(uc, 'watcher', { dryRun: true }))).not.toContain(
      '実験C 事前レポート',
    );
    expect(JSON.stringify(today.coverage)).not.toContain('情報科学実験C');
    // Notifications stay silent about it.
    expect(uc.context.enrollmentOf(expC).enrolled).toBe(false);

    expect(today.enrollmentNotes).toHaveLength(1);
    expect(today.enrollmentNotes?.[0]).toMatchObject({
      course: { title: '情報科学実験C' },
      academic: 'active',
      declared: 'not_taking',
      confirmed: false,
      evidence: '本人: 実験Cは結局履修拒否された',
    });
    expect(today.enrollmentNotes?.[0]?.note).toContain(
      '学務では履修中、本人は履修していないと登録',
    );
    expect(week.enrollmentNotes).toHaveLength(1);

    // Nothing is deleted: the course view keeps it with both statuses, and the deadline is there.
    const course = uc.context.course(expC);
    expect(course.enrolled).toBe(false);
    expect(course.enrollment).toMatchObject({
      academic: 'active',
      declaration: { value: 'not_taking', confirmed: false, provenance: 'chat' },
      taken: false,
    });
    expect(uc.context.deadline({ courseOfferingId: expC }).upcoming.map((d) => d.title)).toContain(
      '実験C 事前レポート',
    );
    // Other courses are untouched.
    expect(titlesOn('2026-10-05')).toEqual(['情報科学実験B', '情報科学実験B', '情報科学実験B']);
  });

  it('confirmed by the student: still hidden, and no note any more', async () => {
    const r = await declare(expC, 'not_taking');
    await uc.additions.confirm(r.addition.id);
    expect(titlesOn(FRIDAY)).toEqual([]);
    expect(uc.context.today().enrollmentNotes).toBeUndefined();
    expect(uc.context.course(expC).enrollment?.declaration).toMatchObject({
      value: 'not_taking',
      confirmed: true,
      provenance: 'student',
    });
  });

  it('a newer taking declaration brings the course back; retracting does too', async () => {
    const r = await declare(expC, 'not_taking');
    expect(titlesOn(FRIDAY)).toEqual([]);
    await uc.additions.retract(chat, r.addition.id);
    expect(titlesOn(FRIDAY)).toContain('情報科学実験C');
    await declare(expC, '履修拒否された');
    expect(titlesOn(FRIDAY)).toEqual([]);
  });

  it('accepts plain words and rejects values that are neither', async () => {
    await expect(declare(expC, 'maybe')).rejects.toThrow(/not_taking or taking/);
  });
});

describe('the student says they take a course the system marks dropped', () => {
  beforeEach(async () => {
    await setup(true);
  });

  it('brings it back with a note while unconfirmed', async () => {
    expect(titlesOn('2026-10-07')).toEqual([]);
    await declare(net, 'taking');
    expect(titlesOn('2026-10-07')).toEqual(['ネットワーク論', 'ネットワーク論', 'ネットワーク論']);
    const notes = uc.context.today().enrollmentNotes ?? [];
    expect(notes.map((n) => n.note)).toEqual([
      expect.stringContaining('学務では履修していない、本人は履修中と登録'),
    ]);
  });
});

describe('deadline conflicts in today', () => {
  beforeEach(async () => {
    await setup();
  });

  it('lists only real, current disagreements', () => {
    const titles = uc.context.today().conflicts.map((c) => c.subjectLabel);
    // Same due date in two phrasings, and a date restated without its time: no conflict.
    expect(titles.some((t) => t.includes('抽選履修登録'))).toBe(false);
    expect(titles.some((t) => t.includes('授業料免除'))).toBe(false);
    // Two different dates in one current notice: still shown.
    expect(titles.some((t) => t.includes('ラウンジスタッフ募集') && !t.includes('国際'))).toBe(
      true,
    );
    // The same shape from April (all dates long past): not in today's view.
    expect(titles.some((t) => t.includes('国際交流'))).toBe(false);
    // One task for the restated deadline, at the stated time.
    // One deadline per restated date (the stated time wins), one task per due date.
    const facts = (key: string) =>
      uc.resolver.facts
        .active({ subjects: [stableId('announcement', 'lcu', key)], predicate: 'deadline' })
        .map((f) => (f.value as { dueAt: string }).dueAt);
    expect(facts('restated-day')).toEqual(['2026-10-15T08:00:00.000Z']);
    expect(facts('same-due')).toEqual(['2026-10-20T03:00:00.000Z']);
    expect(uc.tasks.list().filter((t) => t.dueAt === '2026-10-20T03:00:00.000Z')).toHaveLength(1);
  });
});
