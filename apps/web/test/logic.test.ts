import { describe, expect, it } from 'vitest';
import { buildWeekGrid, scheduleText } from '../src/lib/calendar.js';
import { describeNotification } from '../src/lib/notifications.js';
import { sortByDue, sortClasses } from '../src/lib/sort.js';
import { formatValue, looksLikeInstants, parseCorrectionValue } from '../src/lib/values.js';

describe('sorting', () => {
  it('sorts by due date with undated items last and keeps ties stable', () => {
    const rows = [
      { id: 'a', dueAt: undefined as string | undefined },
      { id: 'b', dueAt: '2026-10-10T14:59:00.000Z' },
      { id: 'c', dueAt: '2026-10-08T14:59:00.000Z' },
      { id: 'd', dueAt: '2026-10-08T14:59:00.000Z' },
    ];
    expect(sortByDue(rows).map((r) => r.id)).toEqual(['c', 'd', 'b', 'a']);
    expect(rows[0]?.id).toBe('a');
  });

  it('sorts classes by period then start time with unknown periods last', () => {
    const rows = [
      {
        id: 'x',
        period: undefined as number | undefined,
        startsAt: undefined as string | undefined,
      },
      { id: 'y', period: 2, startsAt: '2026-10-01T02:00:00.000Z' },
      { id: 'z', period: 1, startsAt: '2026-10-01T00:00:00.000Z' },
    ];
    expect(sortClasses(rows).map((r) => r.id)).toEqual(['z', 'y', 'x']);
  });
});

describe('buildWeekGrid', () => {
  const day = (date: string, periods: (number | undefined)[]) => ({
    date,
    classes: periods.map((period, i) => ({ id: `${date}-${i}`, period })),
  });

  it('builds periods 1-5 by default with one cell list per day', () => {
    const grid = buildWeekGrid([day('2026-10-01', [1, 2]), day('2026-10-02', [2])]);
    expect(grid.rows.map((r) => r.period)).toEqual([1, 2, 3, 4, 5]);
    expect(grid.rows[0]?.cells.map((c) => c.length)).toEqual([1, 0]);
    expect(grid.rows[1]?.cells.map((c) => c.length)).toEqual([1, 1]);
    expect(grid.hasUnscheduled).toBe(false);
  });

  it('grows beyond 5 when a later period exists and collects unscheduled classes', () => {
    const grid = buildWeekGrid([day('2026-10-01', [6, undefined])]);
    expect(grid.rows).toHaveLength(6);
    expect(grid.rows[5]?.cells[0]?.[0]?.id).toBe('2026-10-01-0');
    expect(grid.unscheduled[0]?.map((c) => c.id)).toEqual(['2026-10-01-1']);
    expect(grid.hasUnscheduled).toBe(true);
  });
});

describe('formatValue', () => {
  it('formats instants, dates and primitives', () => {
    expect(formatValue('2026-10-08T14:59:00.000Z', 'Asia/Tokyo')).toBe('10/8 23:59');
    expect(formatValue('2026-10-08')).toBe('10/8');
    expect(formatValue('21教室')).toBe('21教室');
    expect(formatValue(null)).toBe('なし');
    expect(formatValue(undefined)).toBe('なし');
    expect(formatValue(true)).toBe('はい');
    expect(formatValue(3)).toBe('3');
    expect(formatValue([])).toBe('なし');
  });
});

describe('correction input', () => {
  it('keeps typed text as a string by default', () => {
    expect(parseCorrectionValue('  11教室 ')).toBe('11教室');
    expect(parseCorrectionValue('21')).toBe('21');
  });
  it('keeps numeric type when the candidates are numbers', () => {
    expect(parseCorrectionValue('3', [2])).toBe(3);
    expect(parseCorrectionValue('abc', [2])).toBe('abc');
  });
  it('parses explicit JSON and rejects empty input', () => {
    expect(parseCorrectionValue('["a","b"]')).toEqual(['a', 'b']);
    expect(parseCorrectionValue('{broken')).toBe('{broken');
    expect(parseCorrectionValue('   ')).toBeUndefined();
  });
  it('detects instant candidates', () => {
    expect(looksLikeInstants(['2026-10-08T14:59:00.000Z', '2026-10-10T14:59:00.000Z'])).toBe(true);
    expect(looksLikeInstants(['21教室'])).toBe(false);
    expect(looksLikeInstants([])).toBe(false);
  });
});

describe('describeNotification', () => {
  it('reads known fields and tolerates anything else', () => {
    const v = describeNotification(
      {
        id: 'n1',
        title: '教室変更',
        body: '21教室から11教室へ',
        priority: 'high',
        createdAt: '2026-10-01T00:42:00.000Z',
      },
      0,
      'Asia/Tokyo',
    );
    expect(v.key).toBe('n1');
    expect(v.title).toBe('教室変更');
    expect(v.detail).toBe('21教室から11教室へ');
    expect(v.priority).toBe('high');
    expect(v.at).toBe('10/1 09:42');
    expect(describeNotification(null, 3).title).toBe('通知');
    expect(describeNotification(42, 3).key).toBe('n3');
  });
});

describe('scheduleText', () => {
  it('writes weekday and period without spaces', () => {
    expect(scheduleText({ dayOfWeek: 4, period: 2, room: '情報学部2号館21教室' })).toBe(
      '木2限・情報学部2号館21教室',
    );
    expect(scheduleText({ dayOfWeek: 1, period: 5 })).toBe('月5限');
    expect(scheduleText({ dayOfWeek: 0, period: undefined, room: 'A301' })).toBe('日・A301');
  });
});
