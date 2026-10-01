import { describe, expect, it } from 'vitest';
import { extractDeadlines } from '../src/index.js';

// 2026-10-01 (Thu) 10:00 JST
const reference = new Date('2026-10-01T01:00:00Z');
const one = (text: string, extra: Partial<Parameters<typeof extractDeadlines>[1]> = {}) => {
  const r = extractDeadlines(text, { reference, ...extra });
  expect(r, text).toHaveLength(1);
  return r[0] as NonNullable<(typeof r)[0]>;
};

describe('Japanese deadline extraction (§20)', () => {
  it('10月15日23時59分まで', () => {
    const d = one('レポートは10月15日23時59分までにLMSへ提出してください。');
    expect(d).toMatchObject({
      dueAt: '2026-10-15T14:59:00.000Z',
      rule: 'absolute_date',
      phrase: '10月15日23時59分までに',
      timeAssumed: false,
    });
    expect(d.evidence).toBe('レポートは10月15日23時59分までにLMSへ提出してください。');
  });

  it('金曜日中 → this Friday 23:59', () => {
    expect(one('感想を金曜日中に送ってください')).toMatchObject({
      dueAt: '2026-10-02T14:59:00.000Z',
      rule: 'weekday',
      timeAssumed: true,
    });
  });

  it('来週まで → next class next week, else +7 days', () => {
    const next = new Date('2026-10-08T01:20:00Z');
    expect(one('来週までに読んでおいてください', { nextClassAt: next })).toMatchObject({
      dueAt: next.toISOString(),
      rule: 'next_week',
    });
    expect(one('来週までに読んでおいてください')).toMatchObject({
      dueAt: '2026-10-08T14:59:00.000Z',
      confidence: 0.5,
    });
  });

  it('次回まで → start of the next class', () => {
    const next = new Date('2026-10-08T01:20:00Z');
    expect(one('教科書3章を次回までに読むこと。', { nextClassAt: next })).toMatchObject({
      dueAt: next.toISOString(),
      rule: 'next_class',
      confidence: 0.8,
    });
  });

  it('relative days and clock times', () => {
    expect(one('明日の17時までに返信して')).toMatchObject({
      dueAt: '2026-10-02T08:00:00.000Z',
      rule: 'relative_day',
    });
    expect(one('今日中にお願いします')).toMatchObject({ dueAt: '2026-10-01T14:59:00.000Z' });
    expect(one('明後日の午後3時半まで')).toMatchObject({ dueAt: '2026-10-03T06:30:00.000Z' });
  });

  it('slash dates with weekday and full-width digits', () => {
    expect(one('課題2は10/20(火) 17:00締切です')).toMatchObject({
      dueAt: '2026-10-20T08:00:00.000Z',
    });
    expect(one('１０月２０日（火）正午まで')).toMatchObject({ dueAt: '2026-10-20T03:00:00.000Z' });
  });

  it('来週金曜日まで / 今週中', () => {
    expect(one('来週金曜日までに提出')).toMatchObject({
      dueAt: '2026-10-09T14:59:00.000Z',
      rule: 'weekday',
    });
    expect(one('今週中に登録すること')).toMatchObject({
      dueAt: '2026-10-04T14:59:00.000Z',
      rule: 'end_of_period',
    });
  });

  it('rolls dates without a year into the next year when far in the past', () => {
    expect(one('1月10日までに提出', { reference: new Date('2026-12-20T00:00:00Z') }).dueAt).toBe(
      '2027-01-10T14:59:00.000Z',
    );
  });

  it('ignores dates that are not deadlines and finds several in one text', () => {
    expect(extractDeadlines('10月15日に中間試験があります。', { reference })).toEqual([]);
    const many = extractDeadlines('課題1は10月8日まで。課題2は金曜日中。', { reference });
    expect(many.map((m) => m.rule)).toEqual(['absolute_date', 'weekday']);
  });
});
