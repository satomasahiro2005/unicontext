import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  classDay,
  classifyNoticeImportance,
  dayOfWeekOfDate,
  expandWeeklySlots,
  findTerm,
  loadProfile,
  parseProfile,
  termForDate,
} from '../src/index.js';

// Synthetic calendar (not a real university's dates).
const profile = parseProfile(`
id: sample
academicCalendar:
  timezone: Asia/Tokyo
  periods:
    - { period: 1, start: '09:00', end: '10:30' }
    - { period: 4, start: '14:40', end: '16:10' }
  terms:
    - id: '2030-1'
      name: '2030年度 前期'
      termCode: 前期
      year: 2030
      start: '2030-04-01'
      end: '2030-09-30'
      classes: { start: '2030-04-10', end: '2030-07-26' }
      exams: { start: '2030-07-29', end: '2030-08-02' }
    - id: '2030-2'
      name: '2030年度 後期'
      termCode: 後期
      year: 2030
      start: '2030-10-01'
      end: '2031-03-31'
      classes: { start: '2030-10-01', end: '2031-01-31' }
  noClassDays:
    - { date: '2030-10-14', note: 祝日 }
    - { date: '2030-10-25', note: 学園祭（A地区休講）, campus: A }
    - { date: '2030-11-15', note: 午後休講, faculty: 工学部, fromPeriod: 3 }
  substituteDays:
    - { date: '2030-10-16', dayOfWeek: 1, note: 月曜授業 }
`);
const cal = profile.academicCalendar;

describe('academic calendar arithmetic', () => {
  it('local date helpers', () => {
    expect(dayOfWeekOfDate('2030-10-01')).toBe(2); // Tuesday
    expect(addLocalDays('2030-12-31', 1)).toBe('2031-01-01');
  });

  it('finds the term of a date and of an offering label', () => {
    expect(termForDate(cal, '2030-10-01')?.id).toBe('2030-2');
    expect(termForDate(cal, '2030-09-30')?.id).toBe('2030-1');
    expect(termForDate(cal, '2031-04-01')).toBeUndefined();
    expect(findTerm(cal, 2030, '後期')?.id).toBe('2030-2');
    expect(findTerm(cal, 2030, '前学期')?.id).toBe('2030-1');
    expect(findTerm(cal, 2030, '2030年度 前期')?.id).toBe('2030-1');
    expect(findTerm(cal, 2031, '前期')).toBeUndefined();
  });

  it('substitute days follow another weekday; no-class days and holidays have none', () => {
    expect(classDay(cal, '2030-10-16')).toMatchObject({ dayOfWeek: 1, note: '月曜授業' });
    expect(classDay(cal, '2030-10-14').noClasses).toBe('祝日');
    expect(
      classDay(cal, '2030-10-21', { holidays: new Map([['2030-10-21', '臨時休業']]) }),
    ).toMatchObject({ noClasses: '臨時休業' });
  });

  it('campus/faculty exceptions apply only to matching students, else become notes', () => {
    expect(classDay(cal, '2030-10-25', { student: { campus: 'A地区' } }).noClasses).toBe(
      '学園祭（A地区休講）',
    );
    expect(classDay(cal, '2030-10-25', { student: { campus: 'B' } })).toMatchObject({
      scopedNotes: [],
    });
    expect(classDay(cal, '2030-10-25').scopedNotes).toEqual(['学園祭（A地区休講）（A）']);
    expect(classDay(cal, '2030-11-15', { student: { faculty: '工学部' } }).cancelledFrom).toEqual({
      period: 3,
      note: '午後休講',
    });
  });

  it('expands weekly slots inside the class weeks only', () => {
    const term = findTerm(cal, 2030, '前期');
    if (!term?.classes) throw new Error('term');
    const occ = expandWeeklySlots(
      [{ dayOfWeek: 1, period: 1 }],
      term.classes,
      { from: '2030-07-01', to: '2030-08-10' },
      cal,
      { exams: term.exams },
    );
    expect(occ.map((o) => o.date)).toEqual([
      '2030-07-01',
      '2030-07-08',
      '2030-07-15',
      '2030-07-22',
    ]);
  });

  it('marks classes from a partial closure period as cancelled', () => {
    const occ = expandWeeklySlots(
      [
        { dayOfWeek: 5, period: 1 },
        { dayOfWeek: 5, period: 4 },
      ],
      { start: '2030-11-15', end: '2030-11-15' },
      { from: '2030-11-15', to: '2030-11-16' },
      cal,
      { student: { faculty: '工学部' } },
    );
    expect(occ.map((o) => [o.slot.period, o.cancelled])).toEqual([
      [1, undefined],
      [4, '午後休講'],
    ]);
  });

  it('the shipped Shizuoka profile has the 2026 terms with class weeks', () => {
    const shizuoka = loadProfile('shizuoka-university').academicCalendar;
    const late = findTerm(shizuoka, 2026, '後期');
    expect(late).toMatchObject({ start: '2026-10-01', classes: { start: '2026-10-01' } });
    expect(termForDate(shizuoka, '2026-10-01')?.termCode).toBe('後期');
    // 11/25(水) follows the Monday timetable.
    expect(classDay(shizuoka, '2026-11-25').dayOfWeek).toBe(1);
  });
});

describe('rule-based notice importance', () => {
  const imp = (
    title: string,
    extra: Partial<Parameters<typeof classifyNoticeImportance>[0]> = {},
  ) => classifyNoticeImportance({ title, ...extra }).importance;

  it('class changes and personal procedures are high', () => {
    expect(imp('後期 休講のお知らせ')).toBe('high');
    expect(imp('前期期末試験時間割について')).toBe('high');
    expect(imp('履修登録期間のご案内（10月7日まで）')).toBe('high');
    expect(imp('学生カードの提出期限について')).toBe('high');
    expect(imp('何かの連絡', { kind: 'roomChange' })).toBe('high');
    expect(imp('何かの連絡', { courseLinked: true })).toBe('high');
    expect(imp('レポート催促', { kind: 'reminder' })).toBe('high');
  });

  it('campaigns are low, even when they mention 試験', () => {
    expect(imp('就活本選考対策講座のご案内')).toBe('low');
    expect(imp('メルマガ vol.7')).toBe('low');
    expect(imp('学生生活実態調査の実施について')).toBe('low');
    expect(imp('企業説明会を開催します')).toBe('low');
    expect(imp('県教員採用試験ガイダンス')).toBe('low');
  });

  it('optional applications and general information are normal; 【重要】 is high', () => {
    expect(imp('授業料免除申請・奨学金の申込みについて')).toBe('normal');
    expect(imp('単位互換科目の履修申請について')).toBe('normal');
    expect(imp('図書館の開館時間について')).toBe('normal');
    expect(imp('【重要】システム停止のお知らせ')).toBe('high');
  });
});
