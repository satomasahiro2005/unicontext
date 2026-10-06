import { describe, expect, it } from 'vitest';
import {
  findDatePhrase,
  isPermanentChange,
  resolveRoomChangeScope,
  resolveSessionDate,
} from '../src/index.js';

const TZ = 'Asia/Tokyo';
// Monday 2025-10-06 10:00 JST
const POSTED = '2025-10-06T01:00:00.000Z';
const SESSIONS = ['2025-10-06', '2025-10-13', '2025-10-20'];
const resolve = (text: string, sessions: readonly string[] = SESSIONS) =>
  resolveSessionDate(text, POSTED, TZ, sessions);

describe('resolveSessionDate', () => {
  it('本日 / 今日 is the day of the post, in the post’s timezone', () => {
    expect(resolve('本日の授業は21教室で行います')).toEqual({ date: '2025-10-06', basis: 'today' });
    expect(resolve('今日は21教室')?.date).toBe('2025-10-06');
    // 08:00 JST on the 7th is still the 6th in UTC: the local day wins.
    expect(resolveSessionDate('本日', '2025-10-06T23:30:00.000Z', TZ)?.date).toBe('2025-10-07');
  });

  it('明日 and 明後日 count from the post', () => {
    expect(resolve('明日は教室を21教室に変更します')).toEqual({
      date: '2025-10-07',
      basis: 'tomorrow',
    });
    expect(resolve('明後日の授業')?.date).toBe('2025-10-08');
  });

  it('次回 is the first session after the post’s day and needs the course’s sessions', () => {
    expect(resolve('次回は21教室です')).toEqual({ date: '2025-10-13', basis: 'next-session' });
    expect(resolve('次回は21教室です', [])).toBeUndefined();
  });

  it('来週 alone needs sessions; 来週の火曜 does not', () => {
    expect(resolve('来週は21教室です')).toEqual({ date: '2025-10-13', basis: 'next-week-session' });
    expect(resolve('来週は21教室です', [])).toBeUndefined();
    expect(resolve('来週の火曜日は21教室です', [])).toEqual({
      date: '2025-10-14',
      basis: 'next-week-weekday',
    });
    expect(resolve('来週の月曜は', [])?.date).toBe('2025-10-13');
    expect(resolve('来週の日曜は', [])?.date).toBe('2025-10-19');
  });

  it('reads M/D, M月D日 and a weekday in parentheses', () => {
    expect(resolve('10/6の授業は21教室')).toEqual({ date: '2025-10-06', basis: 'explicit-date' });
    expect(resolve('10月6日(月)の授業は21教室')?.date).toBe('2025-10-06');
    expect(resolve('10月13日（月）')?.date).toBe('2025-10-13');
    expect(resolve('２０２６年１月１０日')?.date).toBe('2026-01-10');
  });

  it('refuses a date whose weekday does not match', () => {
    expect(resolve('10月7日(月)の授業は21教室')).toBeUndefined();
  });

  it('puts a date well before the post into the next year', () => {
    const dec = '2025-12-20T01:00:00.000Z';
    expect(resolveSessionDate('1/10の授業', dec, TZ)?.date).toBe('2026-01-10');
    expect(resolveSessionDate('12/25の授業', dec, TZ)?.date).toBe('2025-12-25');
  });

  it('a bare weekday is the next one after the post', () => {
    expect(resolve('火曜日は21教室')?.date).toBe('2025-10-07');
    expect(resolve('月曜日は21教室')?.date).toBe('2025-10-13');
  });

  it('finds nothing in text without a day', () => {
    expect(resolve('教室を21教室に変更します')).toBeUndefined();
    expect(findDatePhrase('教室を21教室に変更します')).toBeUndefined();
  });

  it('does not take a clock time for a date', () => {
    expect(resolve('10:30からです')).toBeUndefined();
  });
});

describe('findDatePhrase and isPermanentChange', () => {
  it('returns the phrase that names the day', () => {
    expect(findDatePhrase('本日の授業は21教室で行います')).toBe('本日');
    expect(findDatePhrase('10月6日(月)の授業')).toBe('10月6日(月)');
    expect(findDatePhrase('来週の火曜日は')).toContain('来週');
  });

  it('flags 以降 / 今後 / これから, not the closing greeting', () => {
    expect(isPermanentChange('今後は21教室で行います')).toBe(true);
    expect(isPermanentChange('10/13以降は21教室です')).toBe(true);
    expect(isPermanentChange('これから教室が変わります')).toBe(true);
    expect(isPermanentChange('From now on we meet in room 21')).toBe(true);
    expect(isPermanentChange('本日は21教室です。今後ともよろしくお願いします')).toBe(false);
  });
});

describe('resolveRoomChangeScope', () => {
  it('one day: [local midnight, next local midnight)', () => {
    const s = resolveRoomChangeScope({ datePhrase: '本日' }, POSTED, TZ);
    expect(s).toMatchObject({
      kind: 'dated',
      date: '2025-10-06',
      validFrom: '2025-10-05T15:00:00.000Z',
      validUntil: '2025-10-06T15:00:00.000Z',
    });
  });

  it('permanent wins over a date and starts on it', () => {
    expect(resolveRoomChangeScope({ datePhrase: '10/13', permanent: true }, POSTED, TZ)).toEqual({
      kind: 'permanent',
      validFrom: '2025-10-12T15:00:00.000Z',
      date: '2025-10-13',
    });
    expect(resolveRoomChangeScope({ permanent: true }, POSTED, TZ)).toEqual({ kind: 'permanent' });
  });

  it('no day and not permanent is unresolved', () => {
    expect(resolveRoomChangeScope({}, POSTED, TZ)).toEqual({ kind: 'unresolved' });
    expect(resolveRoomChangeScope({ datePhrase: '次回' }, POSTED, TZ)).toEqual({
      kind: 'unresolved',
    });
    expect(resolveRoomChangeScope({ datePhrase: '本日' }, undefined, TZ)).toEqual({
      kind: 'unresolved',
    });
  });
});
