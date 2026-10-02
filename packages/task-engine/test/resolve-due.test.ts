import { describe, expect, it } from 'vitest';
import { resolveDueExpression } from '../src/index.js';

// Monday 2026-11-16 12:00 JST
const reference = new Date('2026-11-16T03:00:00.000Z');
const opts = { reference, timezone: 'Asia/Tokyo' };

describe('resolveDueExpression', () => {
  it('passes absolute ISO values through (instant, local time, date only)', () => {
    expect(resolveDueExpression('2026-12-01T17:00:00+09:00', opts)).toMatchObject({
      dueAt: '2026-12-01T08:00:00.000Z',
      rule: 'iso_datetime',
      timeAssumed: false,
    });
    expect(resolveDueExpression('2026-12-01T17:00', opts)?.dueAt).toBe('2026-12-01T08:00:00.000Z');
    expect(resolveDueExpression('2026-12-01', opts)).toMatchObject({
      dueAt: '2026-12-01T14:59:00.000Z',
      rule: 'iso_date',
      timeAssumed: true,
    });
    expect(resolveDueExpression('2026-02-30', opts)).toBeUndefined();
  });

  it('reads Japanese expressions without a deadline marker', () => {
    expect(resolveDueExpression('来週の金曜', opts)?.dueAt).toBe('2026-11-27T14:59:00.000Z');
    expect(resolveDueExpression('金曜日', opts)?.dueAt).toBe('2026-11-20T14:59:00.000Z');
    expect(resolveDueExpression('明日の17時', opts)?.dueAt).toBe('2026-11-17T08:00:00.000Z');
    expect(resolveDueExpression('１２月４日', opts)?.dueAt).toBe('2026-12-04T14:59:00.000Z');
    expect(resolveDueExpression('来週の金曜までに', opts)?.rule).toBe('weekday');
  });

  it('uses the next class for 次回 / 来週', () => {
    const nextClassAt = new Date('2026-11-25T01:20:00.000Z');
    expect(resolveDueExpression('次回', { ...opts, nextClassAt })).toMatchObject({
      dueAt: '2026-11-25T01:20:00.000Z',
      rule: 'next_class',
    });
    expect(resolveDueExpression('来週', { ...opts, nextClassAt })).toMatchObject({
      dueAt: '2026-11-25T01:20:00.000Z',
      rule: 'next_week',
    });
  });

  it('returns undefined for text without a date', () => {
    expect(resolveDueExpression('そのうち', opts)).toBeUndefined();
    expect(resolveDueExpression('  ', opts)).toBeUndefined();
  });
});
