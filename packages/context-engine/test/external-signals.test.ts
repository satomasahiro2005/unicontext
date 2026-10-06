import { stableId } from '@unicontext/canonical-model';
import { createFakeConnector } from '@unicontext/connector-sdk';
import { ManualClock } from '@unicontext/core';
import { loadDefaultAuthorityRules } from '@unicontext/provenance';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attentionRequired,
  createUniContext,
  externalSignalFingerprint,
  type AdditionClient,
  type IngestExternalSignalInput,
  type UniContext,
} from '../src/index.js';

/*
 * ingest_external_signal: findings in the student's Gmail / Google Calendar, written by an AI
 * client. Monday 2026-10-05 12:56 JST. 情報科学実験C was rejected by email while the academic
 * system still lists it; the DB course's レポート1 is on Ed due 10/6 17:00.
 */

const CHATGPT: AdditionClient = { id: 'https://chatgpt.com/oauth/client.json', name: 'ChatGPT' };
const CLAUDE: AdditionClient = { id: 'local:claude', name: 'Claude' };
const LCU_DB = stableId('courseOffering', 'livecampusu', 'C-DB');
const LCU_EXC = stableId('courseOffering', 'livecampusu', 'C-EXC');
const ED_REPORT1 = stableId('assignment', 'edstem', 'lesson-119755');
const LCU_REPORT = stableId('assignment', 'livecampusu', 'A-EXC');
const SYSTEM_DUE = '2026-10-06T17:00:00+09:00';
const MAIL_DUE = '2026-10-07T17:00:00+09:00';

const open: UniContext[] = [];
afterEach(async () => {
  for (const uc of open.splice(0)) await uc.close();
});

async function setup(): Promise<UniContext> {
  // The university systems were read at 12:00; the student's AI looks at the mail at 12:56.
  const clock = new ManualClock('2026-10-05T03:00:00.000Z');
  const uc = createUniContext({ profile: 'shizuoka-university', clock });
  open.push(uc);
  const lcu = createFakeConnector({
    product: 'livecampusu',
    sourceLabel: '学務情報システム',
    authority: 'academic-system',
    capabilities: ['courses', 'enrollments', 'timetable', 'assignments'],
    dataset: {
      courses: [
        {
          id: 'C-DB',
          code: '77403030',
          title: 'データベースシステム論',
          year: 2026,
          term: '後期',
          enrolled: true,
          schedule: [{ day: 4, period: 2, room: '共通講義棟31' }],
        },
        {
          id: 'C-EXC',
          code: '77403040',
          title: '情報科学実験C',
          year: 2026,
          term: '後期',
          enrolled: true,
          schedule: [3, 4, 5].map((period) => ({ day: 5, period, room: '実習室1' })),
        },
      ],
      assignments: [
        {
          id: 'A-EXC',
          courseId: 'C-EXC',
          title: '実験C 事前レポート',
          due: '2026-10-08T23:59:00+09:00',
        },
      ],
    },
  });
  uc.sync.register({
    sourceId: 'livecampusu',
    adapter: lcu.adapter,
    normalizer: lcu.normalizer,
    metadata: lcu.metadata,
  });
  const ed = createFakeConnector({
    product: 'edstem',
    sourceLabel: 'Ed Discussion',
    authority: 'lms',
    // As the real Ed connector: assignments come from the submission system.
    authorities: { 'fake.assignment': 'submission-system' },
    capabilities: ['courses', 'assignments'],
    dataset: {
      courses: [
        { id: 'db2026', code: 'db2026', title: 'データベースシステム論', year: 2026, term: '後期' },
      ],
      assignments: [
        {
          id: 'lesson-119755',
          courseId: 'db2026',
          title: '当日課題 (小レポート1)',
          due: SYSTEM_DUE,
        },
      ],
    },
  });
  uc.sync.register({
    sourceId: 'edstem',
    adapter: ed.adapter,
    normalizer: ed.normalizer,
    metadata: ed.metadata,
  });
  expect((await uc.sync.sync('livecampusu')).ok).toBe(true);
  expect((await uc.sync.sync('edstem')).ok).toBe(true);
  await uc.runPipeline();
  clock.set('2026-10-05T03:56:00.000Z');
  return uc;
}

const rejection = (over: Partial<IngestExternalSignalInput> = {}): IngestExternalSignalInput => ({
  source: 'gmail',
  nativeId: '19a0c1d2e3f40001',
  observedAt: '2026-10-04T09:00:00+09:00',
  from: '教務係 <kyomu@example.ac.jp>',
  subject: '【履修登録】抽選結果のお知らせ',
  summary: '情報科学実験Cは抽選の結果、履修不許可になりました。',
  kind: 'registration_result',
  courseOfferingId: LCU_EXC,
  enrollment: 'not_taking',
  quote: '情報科学実験Cは抽選の結果、履修を許可できませんでした。',
  url: 'https://mail.google.com/mail/u/0/#inbox/19a0c1d2e3f40001',
  ...over,
});

const deadlineMail = (
  over: Partial<IngestExternalSignalInput> = {},
): IngestExternalSignalInput => ({
  source: 'gmail',
  nativeId: '19a0c1d2e3f40002',
  observedAt: '2026-10-05T10:00:00+09:00',
  from: '山本 泰生',
  subject: 'データベース 小レポート1 について',
  summary: '小レポート1の提出期限が10月7日17時に延びた。',
  kind: 'deadline',
  courseOfferingId: LCU_DB,
  task: 'レポート1',
  dueAt: MAIL_DUE,
  quote: '小レポート1の提出期限を10月7日(水)17:00まで延長します。',
  url: 'https://mail.google.com/mail/u/0/#inbox/19a0c1d2e3f40002',
  ...over,
});

describe('idempotence: the same mail or event is stored once', () => {
  it('sending the same nativeId twice answers duplicate and stores nothing more', async () => {
    const uc = await setup();
    const first = await uc.additions.ingestExternalSignal(CHATGPT, rejection());
    expect(first.status).toBe('created');
    expect(first.addition).toMatchObject({
      tool: 'ingest_external_signal',
      kind: 'external_signal',
      status: 'unconfirmed',
      label: 'Gmail（本人のメール）',
      source: 'Gmail（本人のメール）',
    });
    const again = await uc.additions.ingestExternalSignal(CHATGPT, rejection());
    expect(again.status).toBe('duplicate');
    expect(again.addition.id).toBe(first.addition.id);
    // Even with other words, from another client: it is the same mail.
    const other = await uc.additions.ingestExternalSignal(
      CLAUDE,
      rejection({ summary: '別の言い方', observedAt: '2026-10-05T11:00:00+09:00' }),
    );
    expect(other.status).toBe('duplicate');
    expect(uc.additions.list().filter((a) => a.tool === 'ingest_external_signal')).toHaveLength(1);
  });

  it('is keyed by source + nativeId: a calendar event with the same id is another signal', async () => {
    const uc = await setup();
    expect(externalSignalFingerprint('gmail', 'abc')).not.toBe(
      externalSignalFingerprint('calendar', 'abc'),
    );
    const mail = await uc.additions.ingestExternalSignal(
      CHATGPT,
      rejection({ kind: 'other', enrollment: undefined, nativeId: 'abc' }),
    );
    const event = await uc.additions.ingestExternalSignal(
      CHATGPT,
      rejection({
        source: 'calendar',
        kind: 'other',
        enrollment: undefined,
        nativeId: 'abc',
        eventStart: '2026-10-09T13:00:00+09:00',
      }),
    );
    expect(mail.status).toBe('created');
    expect(event.status).toBe('created');
    expect(event.addition.label).toBe('Googleカレンダー');
  });

  it('a retracted signal can be stored again', async () => {
    const uc = await setup();
    const first = await uc.additions.ingestExternalSignal(CHATGPT, rejection());
    await uc.additions.retract(CHATGPT, first.addition.id);
    expect(uc.context.enrollmentOf(LCU_EXC).enrolled).toBe(true);
    const again = await uc.additions.ingestExternalSignal(CHATGPT, rejection());
    expect(again.status).toBe('created');
    expect(uc.context.enrollmentOf(LCU_EXC).enrolled).toBe(false);
  });
});

describe('registration result: not_taking feeds condition:enrollment (unconfirmed, never over the university)', () => {
  it('shows the course as not taken, with both sides visible, and leaves LiveCampusU alone', async () => {
    const uc = await setup();
    const r = await uc.additions.ingestExternalSignal(CHATGPT, rejection());
    expect(r.addition.stored).toMatchObject({
      predicate: 'condition:enrollment',
      value: 'not_taking',
    });

    // The student's views follow the mail …
    expect(uc.context.enrollmentOf(LCU_EXC).enrolled).toBe(false);
    const course = uc.context.course(LCU_EXC);
    expect(course.enrolled).toBe(false);
    expect(course.enrollment).toMatchObject({
      academic: 'active',
      declaration: {
        value: 'not_taking',
        confirmed: false,
        provenance: 'external',
        source: 'Gmail（本人のメール）',
        evidence: '情報科学実験Cは抽選の結果、履修を許可できませんでした。',
      },
      taken: false,
    });
    const fridayClasses = uc.context.classesOn('2026-10-09').map((c) => c.course.title);
    expect(fridayClasses).not.toContain('情報科学実験C');
    expect(uc.context.today().deadlines.map((d) => d.title)).not.toContain('実験C 事前レポート');

    // … and says so: the academic system still lists it, the mail says otherwise. Both shown.
    const note = uc.context.today().enrollmentNotes?.[0];
    expect(note).toMatchObject({ academic: 'active', declared: 'not_taking', confirmed: false });
    expect(note?.note).toContain('学務では履修中');
    expect(note?.note).toContain('Gmail（本人のメール）');
    expect(note?.citations[0]).toMatchObject({
      authority: 'external-signal',
      sourceLabel: 'Gmail（本人のメール）',
    });

    // … but the university's own record is untouched, and nothing was deleted.
    const enrollments = uc.sync.stores.entities
      .list('enrollment')
      .filter((e) => e.courseOfferingId === LCU_EXC);
    expect(enrollments).toHaveLength(1);
    expect(enrollments[0]?.status).toBe('active');
    expect(
      uc.context.deadline({ courseOfferingId: LCU_EXC }).upcoming.map((d) => d.title),
    ).toContain('実験C 事前レポート');
  });

  it('is cited as Gmail with when the mail arrived and a link, at the lowest authority', async () => {
    const uc = await setup();
    const r = await uc.additions.ingestExternalSignal(CHATGPT, rejection());
    const fact = uc.resolver.facts
      .withSources(
        uc.resolver.facts.active({ subjects: [LCU_EXC], predicate: 'condition:enrollment' }),
      )
      .find((f) => f.fact.producer.type === 'ai');
    expect(fact?.fact).toMatchObject({ origin: 'extracted', value: 'not_taking' });
    expect(fact?.source).toMatchObject({
      sourceSystem: 'Gmail（本人のメール）',
      sourceLabel: 'Gmail（本人のメール）',
      authority: 'external-signal',
      url: 'https://mail.google.com/mail/u/0/#inbox/19a0c1d2e3f40001',
      retrievedAt: '2026-10-04T00:00:00.000Z',
    });
    const citation = uc.context.course(LCU_EXC).enrollment?.declaration;
    expect(citation?.source).toBe('Gmail（本人のメール）');
    const a = uc.additions.get(r.addition.id);
    expect(a?.evidence).toBe('情報科学実験Cは抽選の結果、履修を許可できませんでした。');
  });

  it('the owner confirms: the course stays hidden and the note goes away; rejecting brings it back', async () => {
    const uc = await setup();
    const r = await uc.additions.ingestExternalSignal(CHATGPT, rejection());
    await uc.additions.confirm(r.addition.id);
    expect(uc.context.today().enrollmentNotes).toBeUndefined();
    expect(uc.context.course(LCU_EXC).enrollment?.declaration).toMatchObject({
      value: 'not_taking',
      confirmed: true,
      provenance: 'student',
    });
    expect(uc.context.enrollmentOf(LCU_EXC).enrolled).toBe(false);

    const uc2 = await setup();
    const r2 = await uc2.additions.ingestExternalSignal(CHATGPT, rejection());
    await uc2.additions.reject(r2.addition.id);
    expect(uc2.context.enrollmentOf(LCU_EXC).enrolled).toBe(true);
    expect(uc2.context.today().enrollmentNotes).toBeUndefined();
  });

  it('taking brings back a course the academic system dropped', async () => {
    const uc = await setup();
    const r = await uc.additions.ingestExternalSignal(
      CHATGPT,
      rejection({
        nativeId: 'ok-1',
        enrollment: 'taking',
        summary: '履修が許可されました。',
        quote: '履修を許可しました。',
      }),
    );
    expect(r.status).toBe('created');
    expect(uc.context.course(LCU_EXC).enrollment?.declaration).toMatchObject({
      value: 'taking',
      provenance: 'external',
    });
    // The system says active and the mail says taking: they agree, no note.
    expect(uc.context.today().enrollmentNotes).toBeUndefined();
  });

  it('needs the course, and a value it understands', async () => {
    const uc = await setup();
    await expect(
      uc.additions.ingestExternalSignal(CHATGPT, rejection({ courseOfferingId: undefined })),
    ).rejects.toThrow(/course is required/);
    await expect(
      uc.additions.ingestExternalSignal(CHATGPT, rejection({ enrollment: 'maybe' })),
    ).rejects.toThrow(/not_taking or taking/);
  });
});

describe('deadline signal: an unconfirmed add_deadline, linked by number, never over the system', () => {
  it('attaches to the assignment of the same number and opens a conflict instead of overriding it', async () => {
    const uc = await setup();
    const r = await uc.additions.ingestExternalSignal(CHATGPT, deadlineMail());
    expect(r.status).toBe('created');
    expect(r.addition.attachedTo).toMatchObject({
      id: ED_REPORT1,
      title: '当日課題 (小レポート1)',
    });
    expect(r.addition.dueAt).toBe(new Date(MAIL_DUE).toISOString());
    expect(r.addition.stored).toMatchObject({ assignmentId: ED_REPORT1, attached: true });
    // No assignment of its own was made for it.
    expect(
      uc.sync.stores.entities
        .list('assignment')
        .filter(
          (a) =>
            a.courseOfferingId === LCU_DB ||
            a.courseOfferingId === stableId('courseOffering', 'edstem', 'db2026'),
        ),
    ).toHaveLength(1);

    const conflicts = uc.resolver
      .listConflicts({ status: 'open' })
      .filter((c) => c.subject === ED_REPORT1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.predicate).toBe('assignment_due');
    expect(conflicts[0]?.candidates.map((c) => c.authority).sort()).toEqual(
      ['external-signal', 'submission-system'].sort(),
    );
    expect(r.addition.conflicts.map((c) => c.values.map((v) => v.source))).toEqual([
      expect.arrayContaining(['Gmail（本人のメール）']),
    ]);

    // The deadline the student is shown is the system's, with both in the course's conflicts.
    const item = uc.context
      .deadline({ days: 30, courseOfferingId: LCU_DB })
      .upcoming.find((d) => d.title.includes('小レポート1'));
    expect(item).toBeDefined();
    expect(item?.dueAt).toBe(SYSTEM_DUE);
    expect(JSON.stringify(uc.context.course(LCU_DB).conflicts)).toContain('Gmail（本人のメール）');
  });

  it('the same deadline from a second mail is a duplicate', async () => {
    const uc = await setup();
    await uc.additions.ingestExternalSignal(CHATGPT, deadlineMail());
    const second = await uc.additions.ingestExternalSignal(
      CHATGPT,
      deadlineMail({ nativeId: 'reminder-mail', observedAt: '2026-10-06T08:00:00+09:00' }),
    );
    expect(second.status).toBe('duplicate');
  });

  it('with no assignment of that number, it is a deadline of its own, labelled Gmail', async () => {
    const uc = await setup();
    const r = await uc.additions.ingestExternalSignal(
      CHATGPT,
      deadlineMail({
        nativeId: 'new-work',
        task: '追加レポート',
        subject: '追加レポートのお知らせ',
        dueAt: '2026-10-20T17:00:00+09:00',
        quote: '追加レポートは10月20日17時までです。',
      }),
    );
    expect(r.addition.attachedTo).toBeUndefined();
    const item = uc.context
      .deadline({ days: 30, courseOfferingId: LCU_DB })
      .upcoming.find((d) => d.title === '追加レポート');
    expect(item).toMatchObject({ dueAt: new Date('2026-10-20T17:00:00+09:00').toISOString() });
    expect(item?.recorded).toMatchObject({ label: 'Gmail（本人のメール）', confirmed: false });
    expect(item?.summary).toContain('Gmail（本人のメール）');
  });

  it('a calendar event can be the deadline (eventStart), and a deadline needs a date', async () => {
    const uc = await setup();
    const r = await uc.additions.ingestExternalSignal(
      CHATGPT,
      deadlineMail({
        source: 'calendar',
        nativeId: 'evt-1',
        dueAt: undefined,
        eventStart: '2026-10-22T09:00:00+09:00',
        task: '中間発表',
      }),
    );
    expect(r.addition.dueAt).toBe(new Date('2026-10-22T09:00:00+09:00').toISOString());
    expect(r.addition.label).toBe('Googleカレンダー');
    await expect(
      uc.additions.ingestExternalSignal(CHATGPT, deadlineMail({ nativeId: 'x', dueAt: undefined })),
    ).rejects.toThrow(/dueAt/);
  });

  it('a system value that agrees opens nothing', async () => {
    const uc = await setup();
    const r = await uc.additions.ingestExternalSignal(
      CHATGPT,
      deadlineMail({ nativeId: 'same', dueAt: SYSTEM_DUE }),
    );
    expect(r.addition.attachedTo?.id).toBe(ED_REPORT1);
    expect(
      uc.resolver.listConflicts({ status: 'open' }).filter((c) => c.subject === ED_REPORT1),
    ).toEqual([]);
  });

  it('keeps the experiment report of another course apart (title match is per course)', async () => {
    const uc = await setup();
    const r = await uc.additions.ingestExternalSignal(
      CHATGPT,
      deadlineMail({
        nativeId: 'exc-1',
        courseOfferingId: LCU_EXC,
        task: '事前レポート',
        dueAt: '2026-10-08T23:59:00+09:00',
      }),
    );
    expect(r.addition.attachedTo?.id).toBe(LCU_REPORT);
  });
});

describe('authority', () => {
  it('external-signal is below every university source wherever the rules rank them', () => {
    const rules = loadDefaultAuthorityRules();
    const university = [
      'academic-system',
      'submission-system',
      'instructor-announcement',
      'syllabus',
    ];
    for (const predicate of ['assignment_due', 'exam_at', 'deadline', 'condition:enrollment']) {
      const order = rules.predicates[predicate] ?? [];
      expect(order.at(-1), predicate).toBe('external-signal');
      for (const u of university)
        if (order.includes(u))
          expect(order.indexOf(u), `${predicate}/${u}`).toBeLessThan(order.length - 1);
    }
    expect(rules.default.at(-1)).toBe('external-signal');
  });
});

describe('other signals: a note on the course and attention news', () => {
  const roomChange = (
    over: Partial<IngestExternalSignalInput> = {},
  ): IngestExternalSignalInput => ({
    source: 'gmail',
    nativeId: 'room-1',
    observedAt: '2026-10-05T11:30:00+09:00',
    subject: '10/8 データベース 教室変更',
    summary: '10/8のデータベースシステム論は21教室に変更。',
    kind: 'room_change',
    courseOfferingId: LCU_DB,
    location: '21教室',
    quote: '10月8日の授業は21教室で行います。',
    ...over,
  });

  it('is stored as a note on the course (get_notes), cited, and never changes the room', async () => {
    const uc = await setup();
    const r = await uc.additions.ingestExternalSignal(CHATGPT, roomChange());
    expect(r.status).toBe('created');
    expect(r.addition.course).toMatchObject({ id: LCU_DB });
    const notes = uc.additions.notes({ courseOfferingId: LCU_DB });
    expect(notes.notes).toHaveLength(1);
    expect(notes.notes[0]).toMatchObject({
      kind: 'external_signal',
      label: 'Gmail（本人のメール）',
      status: 'unconfirmed',
    });
    expect(notes.notes[0]?.text).toContain('21教室');
    expect(notes.notes[0]?.text).toContain('10月8日の授業は21教室で行います。');
    expect(notes.notes[0]?.citations[0]).toMatchObject({ authority: 'external-signal' });
    // The university's room is as it was.
    expect(uc.context.course(LCU_DB).room.value).toBe('共通講義棟31');
  });

  it('is news for the attention view once per client', async () => {
    const uc = await setup();
    await uc.additions.ingestExternalSignal(CHATGPT, roomChange());
    await uc.additions.ingestExternalSignal(CHATGPT, deadlineMail());
    const first = attentionRequired(uc, 'watcher');
    const signal = first.items.find((i) => i.line.includes('21教室'));
    expect(signal).toMatchObject({
      kind: 'announcement',
      severity: 'warning',
      course: 'データベースシステム論',
    });
    expect(signal?.line).toContain('【Gmail（本人のメール）】');
    expect(signal?.citations[0]?.label).toContain('Gmail（本人のメール）');
    // A deadline is not news here (the deadline alerts carry it).
    expect(first.items.map((i) => i.line).join('\n')).not.toContain('小レポート1の提出期限');
    expect(attentionRequired(uc, 'watcher').items.some((i) => i.line.includes('21教室'))).toBe(
      false,
    );
  });

  it('retracting removes the note', async () => {
    const uc = await setup();
    const r = await uc.additions.ingestExternalSignal(CHATGPT, roomChange());
    await uc.additions.retract(CHATGPT, r.addition.id);
    expect(uc.additions.notes({ courseOfferingId: LCU_DB }).notes).toEqual([]);
  });

  it('a registration result that does not say taking or not is only a note', async () => {
    const uc = await setup();
    const r = await uc.additions.ingestExternalSignal(
      CHATGPT,
      roomChange({
        nativeId: 'reg-note',
        kind: 'registration_result',
        courseOfferingId: undefined,
        summary: '履修登録の最終確認期間は10/9まで。',
        quote: '履修登録の最終確認は10月9日までです。',
      }),
    );
    expect(r.addition.stored).toHaveProperty('documentId');
    expect(uc.context.enrollmentOf(LCU_EXC).enrolled).toBe(true);
  });
});

describe('validation', () => {
  it('rejects what cannot be stored', async () => {
    const uc = await setup();
    const bad = (over: Partial<IngestExternalSignalInput>) =>
      uc.additions.ingestExternalSignal(
        CHATGPT,
        rejection({ nativeId: `v-${Math.random()}`, ...over }),
      );
    await expect(bad({ summary: ' ' })).rejects.toThrow(/summary is empty/);
    await expect(bad({ quote: '' })).rejects.toThrow(/quote is empty/);
    await expect(bad({ observedAt: 'yesterday' })).rejects.toThrow(/ISO-8601/);
    await expect(bad({ url: 'javascript:alert(1)' })).rejects.toThrow(/http/);
    await expect(bad({ nativeId: '  ' })).rejects.toThrow(/nativeId/);
    await expect(bad({ kind: 'spam' as never })).rejects.toThrow(/kind/);
    await expect(bad({ source: 'slack' as never })).rejects.toThrow(/source/);
    await expect(bad({ courseOfferingId: 'courseOffering:nope' })).rejects.toThrow(
      /not found|course/i,
    );
  });

  it('a mail from the future is stored as seen now', async () => {
    const uc = await setup();
    const r = await uc.additions.ingestExternalSignal(
      CHATGPT,
      rejection({ observedAt: '2027-01-01T00:00:00+09:00', nativeId: 'future' }),
    );
    expect(r.status).toBe('created');
    const fact = uc.resolver.facts
      .withSources(
        uc.resolver.facts.active({ subjects: [LCU_EXC], predicate: 'condition:enrollment' }),
      )
      .find((f) => f.source?.authority === 'external-signal');
    expect(fact?.source?.retrievedAt).toBe('2026-10-05T03:56:00.000Z');
  });
});
