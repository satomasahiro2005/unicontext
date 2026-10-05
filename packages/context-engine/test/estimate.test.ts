import { describe, expect, it } from 'vitest';
import { type EstimateHost, estimateDue, type EstimateSubject, seriesOf } from '../src/index.js';

// Weekly class: Thursdays 10:20 JST (01:20Z) from 2026-10-01; 10/22 is a holiday (no class).
const THURSDAYS = ['2026-10-01', '2026-10-08', '2026-10-15', '2026-10-29', '2026-11-05'];
const meeting = (date: string): number => Date.parse(`${date}T01:20:00.000Z`);

function host(
  now: string,
  dated: { id: string; title: string; dueAt: string }[] = [],
  dates: string[] = THURSDAYS,
): EstimateHost {
  return {
    now: new Date(now),
    timezone: 'Asia/Tokyo',
    meetings: (_course, from, to) => dates.filter((d) => d >= from && d <= to).map(meeting),
    datedItems: () => dated,
  };
}

const subject = (over: Partial<EstimateSubject>): EstimateSubject => ({
  id: 'task:x',
  title: '課題',
  courseId: 'courseOffering:db',
  appearedAt: '2026-10-08T03:00:00.000Z', // 10/8 12:00, after the Thursday class
  texts: [],
  checkWhere: 'EdStemの課題ページ',
  ...over,
});

describe('estimateDue', () => {
  it('reads a series from the title', () => {
    expect(seriesOf('当日課題 (小レポート2)')).toMatchObject({
      n: 2,
      prefix: '当日課題小レポート',
    });
    expect(seriesOf('第３回 小テスト')).toMatchObject({ n: 3, full: '第#回小テスト' });
    expect(seriesOf('期末レポート')).toBeUndefined();
  });

  it('follows the course pattern: the same offset from the class, the typical interval', () => {
    // 小レポート1 given 10/1, due Tue 10/6 23:59; 小レポート2 given 10/8, due Tue 10/13 23:59.
    const dated = [
      { id: 'a1', title: '小レポート1', dueAt: '2026-10-06T14:59:00.000Z' },
      { id: 'a2', title: '小レポート2', dueAt: '2026-10-13T14:59:00.000Z' },
      { id: 'other', title: '期末レポート', dueAt: '2026-10-09T14:59:00.000Z' },
    ];
    const e = estimateDue(
      subject({ title: '小レポート3', appearedAt: '2026-10-15T03:00:00.000Z' }),
      host('2026-10-15T04:00:00.000Z', dated),
    );
    expect(e.method).toBe('series');
    expect(e.confidence).toBe('medium');
    expect(e.label).toBe('推定');
    // Given in the 10/15 class: Tue 10/20 23:59, same as the 7-day interval from 小レポート2.
    expect(e.at).toBe('2026-10-20T14:59:00.000Z');
    expect(e.earliest).toBe(e.at);
    expect(e.basis).toContain('小レポート');
    expect(e.text).toMatch(/^推定 10\/20 23:59/);
    expect(e.text).toContain('要確認: EdStemの課題ページ');
    expect(e.passed).toBe(false);
  });

  it('with one known item, steps one class per number and keeps the earliest plausible', () => {
    // 小レポート1 was due 5 days 13:39 after the 10/1 class.
    const dated = [{ id: 'a1', title: '小レポート1', dueAt: '2026-10-06T14:59:00.000Z' }];
    // 小レポート4, one per class: given in the 4th class, 10/29 (10/22 is a holiday) → 11/3 23:59.
    // It was already seen on 10/16, so it may have come in the 10/15 class: 10/20 23:59 first.
    const e = estimateDue(
      subject({ title: '小レポート4', appearedAt: '2026-10-16T03:00:00.000Z' }),
      host('2026-10-16T04:00:00.000Z', dated),
    );
    expect(e.at).toBe('2026-10-20T14:59:00.000Z');
    expect(e.latest).toBe('2026-11-03T14:59:00.000Z');
  });

  it('uses a relative rule in the item text: 次回授業まで, N週間以内', () => {
    const next = estimateDue(
      subject({ texts: ['ER図を描いて次回の授業までに提出すること'] }),
      host('2026-10-08T04:00:00.000Z'),
    );
    expect(next.method).toBe('relative_rule');
    expect(next.at).toBe('2026-10-15T01:20:00.000Z'); // next Thursday class start
    expect(next.basis).toContain('次回の授業まで');

    const week = estimateDue(
      subject({ texts: ['1週間以内に提出'] }),
      host('2026-10-08T04:00:00.000Z'),
    );
    expect(week.method).toBe('relative_rule');
    expect(week.at).toBe('2026-10-15T03:00:00.000Z');
    // Both rules: the earliest wins, the later one is the end of the range.
    const both = estimateDue(
      subject({ texts: ['2週間以内、遅くとも次回の授業まで'] }),
      host('2026-10-08T04:00:00.000Z'),
    );
    expect(both.at).toBe('2026-10-15T01:20:00.000Z');
    expect(both.latest).toBe('2026-10-22T03:00:00.000Z');
  });

  it('falls back to the next class of the course (skipping holidays), as the earliest', () => {
    const e = estimateDue(
      subject({ appearedAt: '2026-10-16T03:00:00.000Z' }),
      host('2026-10-16T04:00:00.000Z'),
    );
    expect(e.method).toBe('next_class');
    expect(e.confidence).toBe('low');
    expect(e.at).toBe('2026-10-29T01:20:00.000Z'); // 10/22 is a holiday
    expect(e.latest).toBe('2026-11-05T01:20:00.000Z');
    expect(e.basis).toContain('10/29(木)');
  });

  it('defaults to a week after it appeared, 23:59, without a timetable', () => {
    const e = estimateDue(
      subject({ courseId: undefined }),
      host('2026-10-08T04:00:00.000Z', [], []),
    );
    expect(e.method).toBe('default');
    expect(e.at).toBe('2026-10-15T14:59:00.000Z');
    expect(e.latest).toBe('2026-10-22T14:59:00.000Z');
  });

  it('never estimates before the item appeared, and flags a past estimate', () => {
    // An old item: the next class after it appeared is long gone.
    const e = estimateDue(
      subject({ appearedAt: '2026-10-01T03:00:00.000Z' }),
      host('2026-10-20T00:00:00.000Z'),
    );
    expect(Date.parse(e.at)).toBeGreaterThanOrEqual(Date.parse('2026-10-01T03:00:00.000Z'));
    expect(e.at).toBe('2026-10-08T01:20:00.000Z');
    expect(e.passed).toBe(true);
    expect(e.text).toContain('もう過ぎている可能性');
  });
});
