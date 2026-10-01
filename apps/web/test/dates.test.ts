import { describe, expect, it } from 'vitest';
import {
  dayKey,
  formatDateJa,
  formatMonthDay,
  formatRemaining,
  formatShort,
  formatTime,
  formatTimeRange,
  isoToZonedLocal,
  relativeDayLabel,
  weekdayJa,
  zonedLocalToIso,
} from '../src/lib/dates.js';

describe('date formatting in Asia/Tokyo', () => {
  it('formats an instant as M/D HH:mm', () => {
    expect(formatShort('2026-10-01T00:42:00.000Z', 'Asia/Tokyo')).toBe('10/1 09:42');
  });

  it('rolls over to the next day in JST', () => {
    expect(formatShort('2026-10-08T14:59:00.000Z', 'Asia/Tokyo')).toBe('10/8 23:59');
    expect(formatShort('2026-10-08T15:00:00.000Z', 'Asia/Tokyo')).toBe('10/9 00:00');
  });

  it('uses the timezone it is given', () => {
    expect(formatShort('2026-10-01T00:42:00.000Z', 'UTC')).toBe('10/1 00:42');
    expect(formatTime('2026-10-01T00:42:00.000Z', 'America/Los_Angeles')).toBe('17:42');
  });

  it('formats a Japanese date with weekday', () => {
    expect(formatDateJa('2026-10-01T00:00:00.000Z', 'Asia/Tokyo')).toBe('10月1日(木)');
    expect(formatDateJa('2026-10-01')).toBe('10月1日(木)');
    expect(formatDateJa('2026-10-04')).toBe('10月4日(日)');
  });

  it('formats plain dates without an hour', () => {
    expect(formatShort('2026-10-08')).toBe('10/8');
    expect(formatMonthDay('2026-10-10T14:59:00.000Z')).toBe('10/10');
  });

  it('returns an empty string for invalid input instead of throwing', () => {
    expect(formatShort('not a date')).toBe('');
    expect(formatTime(undefined)).toBe('');
    expect(formatDateJa('')).toBe('');
  });

  it('falls back to Asia/Tokyo for an unknown timezone', () => {
    expect(formatShort('2026-10-01T00:42:00.000Z', 'Mars/Olympus')).toBe('10/1 09:42');
  });

  it('formats time ranges', () => {
    expect(formatTimeRange('2026-10-01T00:45:00.000Z', '2026-10-01T02:15:00.000Z')).toBe(
      '09:45–11:15',
    );
    expect(formatTimeRange('2026-10-01T00:45:00.000Z', undefined)).toBe('09:45–');
    expect(formatTimeRange(undefined, undefined)).toBe('');
  });

  it('names weekdays from 0 = Sunday', () => {
    expect(weekdayJa(0)).toBe('日');
    expect(weekdayJa(4)).toBe('木');
    expect(weekdayJa(7)).toBe('日');
  });

  it('computes the display day key', () => {
    expect(dayKey('2026-09-30T15:30:00.000Z', 'Asia/Tokyo')).toBe('2026-10-01');
    expect(dayKey('2026-09-30T15:30:00.000Z', 'UTC')).toBe('2026-09-30');
  });

  it('labels today, yesterday and tomorrow', () => {
    expect(relativeDayLabel('2026-10-01', '2026-10-01')).toBe('今日');
    expect(relativeDayLabel('2026-09-30', '2026-10-01')).toBe('昨日');
    expect(relativeDayLabel('2026-10-02', '2026-10-01')).toBe('明日');
    expect(relativeDayLabel('2026-10-05', '2026-10-01')).toBeUndefined();
  });

  it('describes remaining and overdue time', () => {
    expect(formatRemaining(3, false)).toBe('あと3時間');
    expect(formatRemaining(0.2, false)).toBe('あと1時間未満');
    expect(formatRemaining(96, false)).toBe('あと4日');
    expect(formatRemaining(-5, true)).toBe('5時間超過');
    expect(formatRemaining(-72, true)).toBe('3日超過');
  });

  it('round-trips datetime-local values through the timezone', () => {
    expect(zonedLocalToIso('2026-10-10T23:59', 'Asia/Tokyo')).toBe('2026-10-10T14:59:00.000Z');
    expect(isoToZonedLocal('2026-10-10T14:59:00.000Z', 'Asia/Tokyo')).toBe('2026-10-10T23:59');
    expect(zonedLocalToIso('2026-10-10T23:59', 'UTC')).toBe('2026-10-10T23:59:00.000Z');
    expect(zonedLocalToIso('garbage')).toBeUndefined();
  });
});
