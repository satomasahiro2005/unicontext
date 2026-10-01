import type { Task } from '@unicontext/canonical-model';
import { parseProfile, ValidationError } from '@unicontext/core';
import { describe, expect, it } from 'vitest';
import {
  formatPaceSlot,
  paceStatus,
  parsePaceSlot,
  parsePaceSlots,
  weekStartOfDue,
} from '../src/index.js';

const profile = parseProfile(`
id: sample
academicCalendar:
  timezone: Asia/Tokyo
  periods:
    - { period: 1, start: '08:40', end: '10:10' }
    - { period: 2, start: '10:20', end: '11:50' }
  terms: []
`);

describe('parsePaceSlot', () => {
  it('reads weekday + time ranges', () => {
    expect(parsePaceSlot('土 10:00-11:30', profile)).toEqual({
      dayOfWeek: 6,
      startTime: '10:00',
      endTime: '11:30',
    });
    expect(parsePaceSlot('日曜日 9:05〜10:00')).toEqual({
      dayOfWeek: 0,
      startTime: '09:05',
      endTime: '10:00',
    });
  });

  it('accepts 曜, full-width digits, colons and tildes', () => {
    const expected = { dayOfWeek: 6, startTime: '10:00', endTime: '11:30' };
    expect(parsePaceSlot('土曜 10:00〜11:30')).toEqual(expected);
    expect(parsePaceSlot('土曜　１０：００～１１：３０')).toEqual(expected);
    expect(parsePaceSlot('土10:00-11:30')).toEqual(expected);
    expect(parsePaceSlot('土 10:00 - 11:30')).toEqual(expected);
  });

  it('reads periods and takes the times from the profile, keeping the period', () => {
    const expected = { dayOfWeek: 6, period: 2, startTime: '10:20', endTime: '11:50' };
    expect(parsePaceSlot('土2限', profile)).toEqual(expected);
    expect(parsePaceSlot('土曜2限', profile)).toEqual(expected);
    expect(parsePaceSlot('土曜２限', profile)).toEqual(expected);
  });

  it('explains in Japanese what is wrong', () => {
    const bad = (text: string): string => {
      try {
        parsePaceSlot(text, profile);
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        return (e as Error).message;
      }
      throw new Error(`expected ${text} to fail`);
    };
    expect(bad('いつか')).toContain('自習時間「いつか」を読み取れません');
    expect(bad('土')).toContain('読み取れません');
    expect(bad('土 10:00')).toContain('読み取れません');
    expect(bad('土 25:00-26:00')).toContain('時刻が正しくありません');
    expect(bad('土 11:30-10:00')).toContain('終了が開始より後');
    expect(bad('土 10:00-10:00')).toContain('終了が開始より後');
    expect(bad('土9限')).toContain('9限の時刻が分かりません');
    expect(() => parsePaceSlot('土2限')).toThrow('2限の時刻が分かりません');
  });

  it('formats back to the input style', () => {
    expect(formatPaceSlot({ dayOfWeek: 6, startTime: '10:00', endTime: '11:30' })).toBe(
      '土 10:00-11:30',
    );
    expect(formatPaceSlot({ dayOfWeek: 3, period: 2, startTime: '10:20', endTime: '11:50' })).toBe(
      '水2限',
    );
  });

  it('parsePaceSlots drops duplicates and sorts', () => {
    expect(
      parsePaceSlots(['土 10:00-11:30', '水2限', '土曜 10:00〜11:30'], profile).map(formatPaceSlot),
    ).toEqual(['水2限', '土 10:00-11:30']);
  });
});

describe('paceStatus', () => {
  const tz = 'Asia/Tokyo';
  // Monday 2030-05-06 is the current week; weekly tasks are due Sunday 23:59 JST.
  const now = new Date('2030-05-09T00:00:00Z');
  const weekly = (monday: string, status: Task['status']) => {
    const [y, m, d] = monday.split('-').map(Number) as [number, number, number];
    const sunday = new Date(Date.UTC(y, m - 1, d + 6, 14, 59));
    return { taskKind: 'weekly_pace' as const, status, dueAt: sunday.toISOString() };
  };
  const assignment = (dueAt: string, status: Task['status']) => ({
    taskKind: 'assignment' as const,
    status,
    dueAt,
  });

  it('maps a weekly task back to its Monday', () => {
    expect(weekStartOfDue('2030-05-12T14:59:00.000Z', tz)).toBe('2030-05-06');
  });

  it('is on track without weekly tasks or with only the current week open', () => {
    expect(paceStatus([], now, tz)).toEqual({ behindWeeks: 0, unsubmitted: 0 });
    expect(paceStatus([weekly('2030-05-06', 'pending')], now, tz).behindWeeks).toBe(0);
  });

  it('counts consecutive past weeks that are not completed', () => {
    const one = [weekly('2030-04-29', 'pending'), weekly('2030-05-06', 'pending')];
    expect(paceStatus(one, now, tz).behindWeeks).toBe(1);
    const two = [
      weekly('2030-04-22', 'in_progress'),
      weekly('2030-04-29', 'pending'),
      weekly('2030-05-06', 'pending'),
    ];
    expect(paceStatus(two, now, tz).behindWeeks).toBe(2);
    const three = [weekly('2030-04-15', 'pending'), ...two];
    expect(paceStatus(three, now, tz).behindWeeks).toBe(3);
  });

  it('stops at the first completed week and remembers the last completed one', () => {
    const tasks = [
      weekly('2030-04-15', 'pending'),
      weekly('2030-04-22', 'completed'),
      weekly('2030-04-29', 'pending'),
      weekly('2030-05-06', 'pending'),
    ];
    expect(paceStatus(tasks, now, tz)).toEqual({
      behindWeeks: 1,
      unsubmitted: 0,
      lastCompletedWeek: '2030-04-22',
    });
    // the last week done: not behind at all
    const caught = [...tasks.slice(0, 2), weekly('2030-04-29', 'completed')];
    expect(paceStatus(caught, now, tz)).toMatchObject({
      behindWeeks: 0,
      lastCompletedWeek: '2030-04-29',
    });
  });

  it('a gap in the weekly tasks ends the streak; cancelled weeks do not count as late', () => {
    expect(
      paceStatus([weekly('2030-04-22', 'pending'), weekly('2030-05-06', 'pending')], now, tz)
        .behindWeeks,
    ).toBe(0);
    expect(
      paceStatus([weekly('2030-04-29', 'cancelled'), weekly('2030-04-22', 'pending')], now, tz)
        .behindWeeks,
    ).toBe(0);
  });

  it('counts past-due assignments that are still open', () => {
    const tasks = [
      assignment('2030-05-01T00:00:00Z', 'pending'),
      assignment('2030-05-02T00:00:00Z', 'in_progress'),
      assignment('2030-05-03T00:00:00Z', 'submitted'),
      assignment('2030-05-04T00:00:00Z', 'completed'),
      assignment('2030-05-20T00:00:00Z', 'pending'), // not due yet
    ];
    expect(paceStatus(tasks, now, tz)).toEqual({ behindWeeks: 0, unsubmitted: 2 });
  });
});
