import { CanonicalEntitySchema, type CanonicalEntity } from '@unicontext/canonical-model';
import {
  createNormalizeContext,
  type NormalizeOutput,
  type RawItem,
  type RawItemView,
} from '@unicontext/connector-sdk';
import { contentHash } from '@unicontext/core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createLiveCampusUNormalizer,
  examDate,
  LiveCampusUAdapter,
  type NoticePayload,
} from '../src/index.js';
import {
  FakeLcuServer,
  FakeStrategy,
  newClock,
  TEST_DEPLOYMENT,
  TEST_PROFILE,
  testContext,
} from './helpers.js';

const normalizer = createLiveCampusUNormalizer({ deployment: TEST_DEPLOYMENT });
const ctx = createNormalizeContext({
  sourceId: 'livecampusu',
  sourceSystem: 'livecampusu',
  sourceLabel: '学務情報システム',
  defaultAuthority: 'academic-system',
  profile: TEST_PROFILE,
  now: new Date('2026-10-01T03:00:00.000Z'),
});

function view(item: RawItem): RawItemView {
  return {
    id: `raw:${item.sourceType}:${item.externalId}`,
    sourceId: 'livecampusu',
    sourceType: item.sourceType,
    externalId: item.externalId,
    payload: JSON.parse(JSON.stringify(item.payload)) as unknown,
    fetchedAt: '2026-10-01T03:00:00.000Z',
    sourceUpdatedAt: undefined,
    contentHash: contentHash(item.payload),
  };
}

async function norm(item: RawItem): Promise<NormalizeOutput> {
  return normalizer.normalize(view(item), ctx);
}

function entityOf<K extends CanonicalEntity['kind']>(
  out: NormalizeOutput,
  kind: K,
): Extract<CanonicalEntity, { kind: K }> | undefined {
  const e = out.entities.find((x) => x.entity.kind === kind)?.entity;
  return e ? (CanonicalEntitySchema.parse(e) as Extract<CanonicalEntity, { kind: K }>) : undefined;
}

let items: RawItem[] = [];
beforeAll(async () => {
  const clock = newClock();
  const server = new FakeLcuServer({ clock, readRows: [46] });
  const adapter = new LiveCampusUAdapter(testContext(clock, server.fetch), {
    strategy: new FakeStrategy(server),
  });
  items = (await adapter.sync({ mode: 'initial' })).items;
});

function find(type: string, pred: (p: Record<string, unknown>) => boolean): RawItem {
  const it = items.find((i) => i.sourceType === type && pred(i.payload as Record<string, unknown>));
  if (!it) throw new Error(`no ${type}`);
  return it;
}

function notice(
  overrides: Partial<NoticePayload> & { important: NonNullable<NoticePayload['important']> },
): RawItem {
  const payload: NoticePayload = {
    key: `n-test-${overrides.important.contactSeq}`,
    kind: 'notice',
    context: { offeringKey: '2026-77401100-61' },
    source: { screen: 'SC_01002B00_00', selector: 'importantNotice' },
    ...overrides,
  };
  return { sourceType: 'lcu.notice', externalId: payload.key, payload };
}

const baseImportant = {
  contactDate: '2026/10/05',
  contactSeq: '300001',
  contactTime: '09:00',
  contactTypeCode: 'U01',
  contactTypeTitle: '休講',
  importanceCategory: '1',
  subjectClassSemesterWeekHour: '情報理論\r\n後期/木3・4',
  targetDate: '2026/10/08',
  title: '10/8(木) 情報理論は休講です',
};

describe('normalizer: courses (timetable + getClassSubjectList)', () => {
  it('maps a timetable course to course + courseOffering + enrollment', async () => {
    const out = await norm(find('lcu.course', (p) => p.key === '2026-77401100-61'));
    const course = entityOf(out, 'course');
    const offering = entityOf(out, 'courseOffering');
    expect(course).toMatchObject({ courseCode: '77401100', title: '情報理論', credits: 2 });
    expect(course?.id).toBe(ctx.id('course', '77401100'));
    expect(offering).toMatchObject({
      id: ctx.id('courseOffering', '2026-77401100-61'),
      courseId: course?.id,
      academicYear: 2026,
      term: '前期',
      title: '情報理論',
      courseCode: '77401100',
      instructorNames: ['教員 花子'],
      room: '情１３',
      schedule: [{ dayOfWeek: 4, period: 2, startTime: '10:20', endTime: '11:50', room: '情１３' }],
      extra: { classCode: '61', numbering: 'IN002160010', credits: 2, campus: '（共通）' },
    });
    expect(offering?.url).toBe('https://lcu.example.ac.jp/lcu-web/SC_18001B00_13');
    const ref = out.entities.find((e) => e.entity.kind === 'courseOffering')?.ref;
    expect(ref?.location?.selector).toBe(
      'SC_18001B00_13 li.select-btn[week=4][period=2][subject=77401100]',
    );
    const enrollment = entityOf(out, 'enrollment');
    expect(enrollment).toMatchObject({
      personId: ctx.id('person', 'self'),
      courseOfferingId: offering?.id,
    });
    const self = entityOf(out, 'person');
    expect(self).toMatchObject({ name: '本人', isSelf: true, roles: ['student'] });
  });

  it('subject-list-only courses get a term but no schedule', async () => {
    const out = await norm(find('lcu.course', (p) => p.key === '2026-77301090-61'));
    expect(entityOf(out, 'courseOffering')).toMatchObject({
      title: '情報学方法論',
      schedule: [],
      extra: { classCode: '61', className: '1クラス' },
    });
    expect(out.drift).toEqual([]);
  });
});

describe('normalizer: notices', () => {
  it('U04 講義室変更 → announcement + changed classSession + extracted room fact', async () => {
    const out = await norm(find('lcu.notice', (p) => p.kind === 'roomChange'));
    const offeringId = ctx.id('courseOffering', '2026-77401220-61');
    const a = entityOf(out, 'announcement');
    expect(a).toMatchObject({
      title: '7/24(金) B班の教室を科学実験室から共41に変更します',
      importance: 'high',
      scope: 'course',
      category: '講義室変更',
      courseOfferingId: offeringId,
      publishedAt: '2026-07-23T01:30:00.000Z',
      body: '（本文）\n（本文）\n（本文）\n（本文）',
    });
    const s = entityOf(out, 'classSession');
    expect(s).toMatchObject({
      courseOfferingId: offeringId,
      date: '2026-07-24',
      status: 'changed',
      room: '共41',
    });
    // 金5・6 and 金7・8 → ambiguous period, so none.
    expect(s?.period).toBeUndefined();
    expect(out.entities.find((e) => e.entity.kind === 'classSession')?.origin).toBe('extracted');
    expect(out.facts).toEqual([
      expect.objectContaining({
        subject: offeringId,
        predicate: 'room',
        value: '共41',
        origin: 'extracted',
        confidence: 0.8,
        validFrom: '2026-07-23T15:00:00.000Z',
        validUntil: '2026-07-24T15:00:00.000Z',
        evidence: '7/24(金) B班の教室を科学実験室から共41に変更します',
      }),
    ]);
    expect(out.facts?.[0]?.ref?.location?.messageId).toBe('100003');
  });

  it('university notices have scope university; a survey is low importance', async () => {
    // LCU marks every notice importanceCategory 1, so importance comes from the rules (a 調査).
    const out = await norm(
      find('lcu.notice', (p) => (p as NoticePayload).important?.contactSeq === '100001'),
    );
    expect(entityOf(out, 'announcement')).toMatchObject({
      scope: 'university',
      importance: 'low',
      body: '',
    });
    expect(out.entities).toHaveLength(1);
  });

  it('importance is rule-based: campaigns low, personal procedures high, class notices high', async () => {
    const uni = (contactSeq: string, title: string): RawItem =>
      notice({
        kind: 'notice',
        context: {},
        important: {
          ...baseImportant,
          contactSeq,
          contactTypeCode: 'U05',
          contactTypeTitle: '学内連絡',
          subjectClassSemesterWeekHour: '',
          targetDate: '',
          title,
        },
      });
    const imp = async (item: RawItem) => entityOf(await norm(item), 'announcement')?.importance;
    expect(await imp(uni('400001', '10/8（木）開催！就活対策講座【就職支援室 No.1】'))).toBe('low');
    expect(await imp(uni('400002', '就職支援室発刊メルマガ【vol.1】'))).toBe('low');
    expect(await imp(uni('400003', '県教員採用試験ガイダンスのご案内'))).toBe('low');
    expect(await imp(uni('400004', '後期の履修登録期間について'))).toBe('high');
    expect(await imp(uni('400005', '後期授業料免除申請、奨学金の申込みについて'))).toBe('normal');
    expect(await imp(uni('400006', '【重要】台風接近に伴う授業の取扱いについて'))).toBe('high');
    // Course-linked teacher notices are about the student's own class.
    const course = notice({
      kind: 'notice',
      important: { ...baseImportant, contactSeq: '400007', contactTypeCode: 'U06', title: '連絡' },
    });
    expect(await imp(course)).toBe('high');
  });

  it('時間割外 retake course → offering with scheduleType unscheduled and no slots', async () => {
    const out = await norm(find('lcu.course', (p) => p.key === '2026-77301020-RW'));
    expect(entityOf(out, 'courseOffering')).toMatchObject({
      title: 'コンピュータ入門',
      term: '前期',
      academicYear: 2026,
      scheduleType: 'unscheduled',
      schedule: [],
      room: '共通講義棟２１',
      instructorNames: ['教員 花子'],
      extra: { classCode: 'RW', retake: true },
    });
    const regular = await norm(find('lcu.course', (p) => p.key === '2026-77401100-61'));
    expect(entityOf(regular, 'courseOffering')?.scheduleType).toBe('regular');
  });

  it('U01 休講 → cancelled classSession with the unambiguous period', async () => {
    const out = await norm(notice({ kind: 'cancellation', important: baseImportant }));
    const s = entityOf(out, 'classSession');
    expect(s).toMatchObject({
      courseOfferingId: ctx.id('courseOffering', '2026-77401100-61'),
      date: '2026-10-08',
      period: 2,
      startsAt: '2026-10-08T01:20:00.000Z',
      status: 'cancelled',
    });
    expect(s?.id).toBe(ctx.id('classSession', '2026-77401100-61', '2026-10-08', '2'));
  });

  it('U02 補講 → makeup session; U03 試験 → exam', async () => {
    const makeup = await norm(
      notice({
        kind: 'makeup',
        important: {
          ...baseImportant,
          contactSeq: '300002',
          contactTypeCode: 'U02',
          contactTypeTitle: '補講',
          targetDate: '2026/10/10',
          title: '補講を行います',
        },
      }),
    );
    expect(entityOf(makeup, 'classSession')).toMatchObject({
      status: 'makeup',
      date: '2026-10-10',
    });
    const exam = await norm(
      notice({
        kind: 'exam',
        important: {
          ...baseImportant,
          contactSeq: '300003',
          contactTypeCode: 'U03',
          contactTypeTitle: '試験',
          targetDate: '2026/11/20',
          title: '中間試験(11/20, 共21, 12:45-)',
        },
      }),
    );
    expect(entityOf(exam, 'exam')).toMatchObject({
      title: '中間試験(11/20, 共21, 12:45-)',
      examKind: 'midterm',
      startsAt: '2026-11-20T03:45:00.000Z',
      courseOfferingId: ctx.id('courseOffering', '2026-77401100-61'),
    });
  });

  it('change notices without a matched course only warn', async () => {
    const out = await norm(notice({ kind: 'cancellation', important: baseImportant, context: {} }));
    expect(out.entities.map((e) => e.entity.kind)).toEqual(['announcement']);
    expect(out.warnings?.[0]).toMatch(/not matched/);
  });
});

describe('normalizer: assignments, warnings, calendar, exams, attendance', () => {
  it('assignment + submission from the submission system', async () => {
    const out = await norm(find('lcu.assignment', (p) => p.submissionSeq === '96930'));
    const a = entityOf(out, 'assignment');
    expect(a).toMatchObject({
      id: ctx.id('assignment', '96930'),
      title: '第1回 小テスト',
      submissionType: '小テスト',
      availableFrom: '2026-05-08T12:50:00.000Z',
      dueAt: '2026-05-19T14:55:00.000Z',
    });
    // オートマトンと言語理論 is not in the (truncated) timetable fixture: no offering link.
    expect(a).not.toHaveProperty('courseOfferingId');
    expect(entityOf(out, 'submission')).toMatchObject({ assignmentId: a?.id, status: 'submitted' });
    for (const e of out.entities) expect(e.ref?.authority).toBe('submission-system');
    const open = await norm(find('lcu.assignment', (p) => p.submissionSeq === '95133'));
    expect(entityOf(open, 'submission')?.status).toBe('not_submitted');
  });

  it('assignments are matched to offerings by title (+ class)', async () => {
    const item = find('lcu.assignment', (p) => p.submissionSeq === '95133');
    expect((item.payload as { context: { offeringKey?: string } }).context.offeringKey).toBe(
      '2026-77401180-61',
    );
    const out = await norm(item);
    expect(entityOf(out, 'assignment')?.courseOfferingId).toBe(
      ctx.id('courseOffering', '2026-77401180-61'),
    );
  });

  it('warningNoticeInformation → deadline calendarEvent + announcement (no request path stored)', async () => {
    const item = find('lcu.warningNotice', () => true);
    expect(JSON.stringify(item.payload)).not.toContain('warningNoticeRequestPath');
    const out = await norm(item);
    expect(entityOf(out, 'calendarEvent')).toMatchObject({
      title: '履修登録期限（一般）',
      startsAt: '2026-10-06T15:00:00.000Z',
      allDay: true,
      category: '期限',
    });
    expect(entityOf(out, 'announcement')).toMatchObject({
      title: '履修登録期限',
      body: '履修登録期限（一般）: 10月7日まで（未）',
      importance: 'high',
      category: '期限',
    });
    expect(out.drift).toEqual([]);
  });

  it('embedded calendar events → calendarEvent', async () => {
    const out = await norm(find('lcu.calendarEvent', (p) => p.title === 'スポーツの日'));
    expect(entityOf(out, 'calendarEvent')).toMatchObject({
      startsAt: '2026-10-11T15:00:00.000Z',
      endsAt: '2026-10-12T15:00:00.000Z',
      allDay: true,
      category: 'Holiday',
    });
    const timed = await norm(find('lcu.calendarEvent', (p) => String(p.title).includes('説明会')));
    expect(entityOf(timed, 'calendarEvent')).toMatchObject({
      startsAt: '2026-10-02T04:00:00.000Z',
      allDay: false,
    });
  });

  it('exam timetable rows → exam with period times', async () => {
    const out = await norm(find('lcu.exam', (p) => p.subject === '情報理論(1クラス)'));
    expect(entityOf(out, 'exam')).toMatchObject({
      title: '情報理論(1クラス)',
      examKind: 'final',
      startsAt: '2026-07-30T01:20:00.000Z',
      endsAt: '2026-07-30T02:50:00.000Z',
      room: '共通講義棟２１',
      courseOfferingId: ctx.id('courseOffering', '2026-77401100-61'),
    });
    expect(examDate('1/20(水)', 2026)).toBe('2027-01-20');
  });

  it('attendance → authoritative attendance fact on the offering', async () => {
    const out = await norm(find('lcu.attendance', (p) => p.subject === '情報理論'));
    expect(out.entities).toEqual([]);
    expect(out.facts).toEqual([
      expect.objectContaining({
        subject: ctx.id('courseOffering', '2026-77401100-61'),
        predicate: 'attendance',
        origin: 'authoritative',
        value: {
          attended: 12,
          absent: 1,
          late: 0,
          earlyLeave: 0,
          excused: 0,
          invalid: 0,
          published: '公開中',
        },
      }),
    ]);
  });

  it('grades (opt-in) → grade', async () => {
    const out = await norm({
      sourceType: 'lcu.grade',
      externalId: 'g-1',
      payload: {
        subjectCode: '77401100',
        subjectName: '情報理論',
        credits: 2,
        score: 88,
        mark: 'A',
        gradePoint: 3,
        reportTerm: '2026前期',
        reportDate: '2026/08/20',
        context: { offeringKey: '2026-77401100-61' },
        source: { screen: 'SC_10004B00_01', selector: 'tr[subjectCode=77401100]' },
      },
    });
    expect(entityOf(out, 'grade')).toMatchObject({
      score: 88,
      letter: 'A',
      gradePoint: 3,
      finalizedAt: '2026-08-19T15:00:00.000Z',
      courseOfferingId: ctx.id('courseOffering', '2026-77401100-61'),
      extra: { evaluation: 'A', outcome: 'passed', academicYear: 2026, term: '前期' },
    });
  });

  it('keeps every evaluation label verbatim and classifies it (unknown stays unknown)', async () => {
    const grade = async (mark: string | undefined, extra: Record<string, unknown> = {}) =>
      entityOf(
        await norm({
          sourceType: 'lcu.grade',
          externalId: `g-${mark ?? 'none'}`,
          payload: {
            subjectCode: '90000001',
            subjectName: 'サンプル入門',
            credits: 2,
            ...(mark !== undefined ? { mark } : {}),
            reportTerm: '2025年度 後期 後期後半',
            academicYear: 2025,
            term: '後期',
            termPart: '後期後半',
            examType: '本試験',
            ...extra,
            context: {},
            source: { screen: 'SC_10004B00_01', selector: 'tr[subjectCode=90000001]' },
          },
        }),
        'grade',
      );
    const cases: [string | undefined, string][] = [
      ['秀', 'passed'],
      ['合', 'passed'],
      ['不可', 'failed'],
      ['否', 'failed'],
      ['再試', 'not_graded'],
      ['認定', 'transferred'],
      ['放棄', 'withdrawn'],
      ['履修中', 'in_progress'],
      [undefined, 'in_progress'],
      ['ＸＹＺ', 'unknown'],
    ];
    for (const [mark, outcome] of cases) {
      const g = await grade(mark);
      expect(g?.extra).toMatchObject({ evaluation: mark ?? '', outcome });
      expect(g?.courseOfferingId).toBeUndefined();
    }
    expect((await grade('再試'))?.extra).toMatchObject({ pendingReexam: true });
    expect((await grade('良', { interim: true }))?.extra).toMatchObject({
      evaluation: '良',
      outcome: 'in_progress',
      interim: true,
    });
    // A re-exam row never shares the id of the regular exam row of the same term.
    const regular = await grade('不可');
    const reexam = await grade('不可', { examType: '再試験' });
    expect(reexam?.id).not.toBe(regular?.id);
  });

  it('単位修得情報 → one credit_requirements fact on the student', async () => {
    const out = await norm({
      sourceType: 'lcu.creditRequirements',
      externalId: '01',
      payload: {
        requirementType: { code: '01', name: '卒業要件（学士課程）' },
        rows: [
          {
            depth: 0,
            name: '卒業要件（学士課程）',
            required: 124,
            expected: 30,
            status: '不足',
            courses: [],
          },
        ],
        markers: [{ symbol: '+', label: 'オンライン科目', capCredits: 10, totalCredits: 2 }],
        source: { screen: 'SC_10004B00_02' },
      },
    });
    expect(entityOf(out, 'person')).toMatchObject({ isSelf: true });
    expect(out.facts).toHaveLength(1);
    expect(out.facts?.[0]).toMatchObject({
      predicate: 'credit_requirements',
      origin: 'authoritative',
      value: { requirementType: { code: '01' }, rows: [{ name: '卒業要件（学士課程）' }] },
    });
  });
});

describe('normalizer: invariants', () => {
  it('every entity validates, carries a screen-id reference, and ids are deterministic', async () => {
    for (const item of items) {
      const a = await norm(item);
      const b = await norm(item);
      expect(a.entities.map((e) => e.entity.id)).toEqual(b.entities.map((e) => e.entity.id));
      for (const e of a.entities) {
        expect(CanonicalEntitySchema.safeParse(e.entity).success, `${item.sourceType}`).toBe(true);
        if (e.entity.kind !== 'person')
          expect(e.ref?.location?.selector).toMatch(/^SC_[A-Za-z0-9]{8}_\d{2}/);
      }
    }
  });

  it('never puts the student name or id into entities', async () => {
    const all = JSON.stringify(await Promise.all(items.map((i) => norm(i))));
    expect(all).not.toContain('学生 太郎');
    expect(all).not.toContain('S0000000');
    expect(items.some((i) => JSON.stringify(i.payload).includes('userName'))).toBe(false);
  });
});
