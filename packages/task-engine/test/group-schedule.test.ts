import { describe, expect, it } from 'vitest';
import {
  courseOfTable,
  doneMarker,
  groupAddress,
  parseGroupScheduleTable,
  shortDeadlineTitle,
} from '../src/index.js';

const LAYOUT_DATE_GROUP_ROOM = `2026年度情報科学実験B実施スケジュール
日付 グループ 教室 回数
10/02(金) B 科学実験室 #01
10/05(月) A C&C #01
10/09(金) B 科学実験室 #02
10/12(月) スポーツの日
10/16(金) A 科学実験室 #02
11/02(月) B #05
11/06(金) 休講（学際準備）
11/25(水) A #07（月曜授業）
01/04(月) B 科学実験室 #12`;

// Number first, the month only when it changes, the group in the last column.
const LAYOUT_NUMBER_TOPIC_GROUP = `2026/09/24 時点
回 日付 備考
実習内容 実施班
1 10/2（金） H1 FPGAと論理合成ツールと論理回路(1) A
1 5（月） H1 FPGAと論理合成ツールと論理回路(1) B
2 9（金） H1 (2)，H2 カウンタの特性 (1) A
12（月 祝） スポーツの日
2 16（金） H1 (2)，H2 カウンタの特性 (1) B
5 11/2（月） H4 ALUの設計 A
6（金） テクノフェスタ準備のため休講
7 25（水） H6 加減乗算器の作成(1) B ＃1
2026年度 後期 情報科学実験C
#1 11月25日(水)は月曜授業．`;

describe('parseGroupScheduleTable', () => {
  it('reads date, group, room and meeting number rows (year from the academic year)', () => {
    const t = parseGroupScheduleTable(LAYOUT_DATE_GROUP_ROOM, { academicYear: 2026 });
    expect(t?.heading).toBe('2026年度情報科学実験B実施スケジュール');
    expect(t?.groups).toEqual(['A', 'B']);
    const rows = t?.rows.map(({ line: _l, ...r }) => r);
    expect(rows).toEqual([
      { date: '2026-10-02', group: 'B', status: 'held', number: 1, room: '科学実験室' },
      { date: '2026-10-05', group: 'A', status: 'held', number: 1, room: 'C&C' },
      { date: '2026-10-09', group: 'B', status: 'held', number: 2, room: '科学実験室' },
      { date: '2026-10-12', status: 'no_class', note: 'スポーツの日' },
      { date: '2026-10-16', group: 'A', status: 'held', number: 2, room: '科学実験室' },
      { date: '2026-11-02', group: 'B', status: 'held', number: 5 },
      { date: '2026-11-06', status: 'no_class', note: '休講(学際準備)' },
      { date: '2026-11-25', group: 'A', status: 'held', number: 7, note: '月曜授業' },
      { date: '2027-01-04', group: 'B', status: 'held', number: 12, room: '科学実験室' },
    ]);
    expect(t?.rows[0]?.line).toBe('10/02(金) B 科学実験室 #01');
  });

  it('carries the month over and takes the leading number as the meeting number', () => {
    const t = parseGroupScheduleTable(LAYOUT_NUMBER_TOPIC_GROUP, { academicYear: 2026 });
    const rows = t?.rows.map(({ line: _l, ...r }) => r);
    expect(rows?.slice(0, 3)).toEqual([
      {
        date: '2026-10-02',
        group: 'A',
        status: 'held',
        number: 1,
        topic: 'H1 FPGAと論理合成ツールと論理回路(1)',
      },
      {
        date: '2026-10-05',
        group: 'B',
        status: 'held',
        number: 1,
        topic: 'H1 FPGAと論理合成ツールと論理回路(1)',
      },
      {
        date: '2026-10-09',
        group: 'A',
        status: 'held',
        number: 2,
        topic: 'H1 (2),H2 カウンタの特性 (1)',
      },
    ]);
    expect(rows?.find((r) => r.date === '2026-10-12')?.status).toBe('no_class');
    expect(rows?.find((r) => r.date === '2026-11-06')?.status).toBe('no_class');
    // 「＃1」 after the group is a footnote mark, not the meeting number.
    expect(rows?.find((r) => r.date === '2026-11-25')).toMatchObject({ group: 'B', number: 7 });
    expect(t?.context).toContain('情報科学実験C');
  });

  it('is not a table: prose with dates, one group only, or weekdays that do not match', () => {
    expect(
      parseGroupScheduleTable(
        '明日，10/02(金) B班は，科学実験室にて開講します．\n＃A班は，10/05(月) C&C で実施されます．',
        { academicYear: 2026 },
      ),
    ).toBeUndefined();
    expect(
      parseGroupScheduleTable('10/02(金) B x\n10/09(金) B x\n10/16(金) B x\n10/23(金) B x', {
        academicYear: 2026,
      }),
    ).toBeUndefined();
    // 10/02 is a Friday, not a Monday: the rows are not taken.
    expect(
      parseGroupScheduleTable('10/02(月) A x\n10/05(金) B x\n10/09(月) A x\n10/12(金) B x', {
        academicYear: 2026,
      }),
    ).toBeUndefined();
  });
});

describe('courseOfTable', () => {
  const courses = [
    { id: 'b', title: '情報科学実験B' },
    { id: 'c', title: '情報科学実験C' },
    { id: 'logic', title: '論理回路' },
  ];
  it('takes the course named in the heading', () => {
    const t = parseGroupScheduleTable(LAYOUT_DATE_GROUP_ROOM, { academicYear: 2026 });
    expect(courseOfTable(LAYOUT_DATE_GROUP_ROOM, t?.heading, courses[2], courses)?.id).toBe('b');
  });
  it('a table in another course’s team named in its title lines belongs to that course', () => {
    const t = parseGroupScheduleTable(LAYOUT_NUMBER_TOPIC_GROUP, { academicYear: 2026 });
    // 「論理回路」 only appears in a row's topic; 「情報科学実験C」 in the title lines.
    expect(
      courseOfTable(
        LAYOUT_NUMBER_TOPIC_GROUP,
        '20260924_実験スケジュール.pdf',
        courses[0],
        courses,
        t?.context,
      )?.id,
    ).toBe('c');
  });
});

describe('deadline sentence context', () => {
  it('reads done markers', () => {
    expect(doneMarker('履修登録期限(一般): 10月7日まで(済)')).toBe('(済)');
    expect(doneMarker('提出期限 10/9 【提出済み】')).toBe('【提出済み】');
    expect(doneMarker('履修登録期限（一般）: 9月30日まで（未）')).toBeUndefined();
    expect(doneMarker('登録完了後に確認メールが届きます。10/9まで')).toBeUndefined();
  });
  it('tells a group-only sentence from one that names a group as well', () => {
    expect(groupAddress('A班はアンケートを10/9までに回答')).toEqual({
      groups: ['A'],
      exclusive: true,
    });
    expect(
      groupAddress(
        '登録は,10/2(金) 12:00 までに終わらせておくようにお願いします (A班の皆様もよろしくお願いします).',
      ),
    ).toEqual({ groups: ['A'], exclusive: false });
    expect(groupAddress('Bグループのみ 10/9 までに提出')).toEqual({
      groups: ['B'],
      exclusive: true,
    });
    expect(groupAddress('レポートは10/9まで')).toBeUndefined();
  });
  it('makes a short title and keeps the sentence for evidence', () => {
    expect(
      shortDeadlineTitle(
        '登録は,10/2(金) 12:00 までに終わらせておくようにお願いします',
        '情報科学実験B teams 登録について',
        '情報科学実験B',
      ),
    ).toBe('teams 登録');
    expect(shortDeadlineTitle('レポートは10/9までに提出すること', undefined, undefined)).toBe(
      'レポート',
    );
    expect(
      shortDeadlineTitle('履修登録期限(一般): 10月7日まで(済)', '履修登録期限', undefined),
    ).toBe('履修登録期限(一般)');
    expect(
      shortDeadlineTitle('A班は10/5までにレポートを提出', undefined, undefined),
    ).toBeUndefined();
  });
});
