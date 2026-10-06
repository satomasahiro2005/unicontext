import type { Fact } from '@unicontext/canonical-model';
import { describe, expect, it } from 'vitest';
import {
  HOME_KEY,
  isOnlineLocation,
  locationEntity,
  locationIdFor,
  normalizeRoom,
  placeKey,
  placeLabel,
  placeOf,
  TravelBook,
  travelKeyOf,
  travelSubject,
  travelValue,
} from '../src/places.js';

describe('normalizeRoom', () => {
  it('splits the rooms of the academic system into building, room and campus', () => {
    expect(normalizeRoom('工５－２２')).toEqual({ building: '工', room: '工5-22', campus: '浜松' });
    expect(normalizeRoom('情１３')).toEqual({ building: '情', room: '情13', campus: '浜松' });
    expect(normalizeRoom('共通講義棟２１')).toEqual({
      building: '共通講義棟',
      room: '共通講義棟21',
    });
    expect(normalizeRoom('共Ｌ１－計算機実習室１')).toEqual({
      building: '共L',
      room: '共L1-計算機実習室1',
    });
  });

  it('takes the first of several rooms and drops 「他」', () => {
    expect(normalizeRoom('情２４、共通講義棟２１、共通講義棟３１').room).toBe('情24');
    expect(normalizeRoom('情報科学科実習室1 他')).toEqual({ room: '情報科学科実習室1' });
  });

  it('knows a building named in words', () => {
    expect(normalizeRoom('工学部')).toEqual({ building: '工', room: '工学部', campus: '浜松' });
  });
});

describe('placeKey', () => {
  it('is the building or area, so every 工 room is one place', () => {
    expect(placeKey('工５－２２')).toBe('工');
    expect(placeKey('工3-31')).toBe('工');
    expect(placeKey('工学部')).toBe('工');
    expect(placeKey('情報学部')).toBe('情');
    expect(placeKey('情１３')).toBe('情');
  });

  it('home, and unknown places by their compacted text', () => {
    for (const t of ['home', 'Home', '自宅', '家', '寮']) expect(placeKey(t)).toBe(HOME_KEY);
    expect(placeKey('体育館')).toBe('体育館');
    expect(placeKey('Ｃ＆Ｃ')).toBe('c&c');
  });

  it('labels', () => {
    expect(placeLabel('home')).toBe('自宅');
    expect(placeLabel('工')).toBe('工学部');
    expect(placeLabel('体育館')).toBe('体育館');
  });
});

describe('placeOf', () => {
  it('derives the Location id from the key: the same place, the same id', () => {
    const a = placeOf('工５－２２');
    const b = placeOf('工3-31');
    expect(a?.locationId).toBe(b?.locationId);
    expect(a?.locationId).toBe(locationIdFor('工'));
    expect(a?.locationId.startsWith('location:')).toBe(true);
    expect(placeOf('情１３')?.locationId).not.toBe(a?.locationId);
  });

  it('online and empty locations are no place', () => {
    expect(placeOf('Zoom')).toBeUndefined();
    expect(placeOf('https://teams.microsoft.com/l/meetup-join/x')).toBeUndefined();
    expect(placeOf('オンライン')).toBeUndefined();
    expect(placeOf('')).toBeUndefined();
    expect(placeOf(undefined)).toBeUndefined();
    expect(travelKeyOf('Zoom')).toBeUndefined();
    expect(isOnlineLocation('Google Meet')).toBe(true);
  });

  it('builds a Location entity from a key, on demand', () => {
    expect(locationEntity('工')).toEqual({
      id: locationIdFor('工'),
      kind: 'location',
      name: '工学部',
      building: '工',
    });
  });
});

describe('TravelBook', () => {
  const fact = (from: string, to: string, minutes: number, at: string, extra = {}): Fact =>
    ({
      id: `fact:${from}-${to}-${at}`,
      subject: travelSubject(from),
      predicate: 'travel:minutes',
      value: travelValue(from, to, minutes, 'walk'),
      origin: 'user',
      confidence: 1,
      observedAt: at,
      sourceReferenceId: 'sourceReference:x',
      producer: { type: 'user', id: 'self' },
      ...extra,
    }) as unknown as Fact;

  it('finds a trip in either direction; the newest statement wins', () => {
    const book = new TravelBook([
      fact('home', '工', 10, '2026-10-01T00:00:00.000Z'),
      fact('home', '工', 15, '2026-10-03T00:00:00.000Z'),
      fact('情', '工', 8, '2026-10-02T00:00:00.000Z'),
    ]);
    expect(book.between('home', '工')?.minutes).toBe(15);
    expect(book.between('工', '情')?.minutes).toBe(8);
    expect(book.between('工', 'home')?.minutes).toBe(15);
    expect(book.between('home', '情')).toBeUndefined();
    expect(book.between('工', '工')).toBeUndefined();
  });

  it('ignores retracted and malformed facts', () => {
    const book = new TravelBook([
      fact('home', '工', 10, '2026-10-01T00:00:00.000Z', {
        retractedAt: '2026-10-02T00:00:00.000Z',
      }),
      { ...fact('home', '情', 5, '2026-10-01T00:00:00.000Z'), value: { to: '情' } } as Fact,
      { ...fact('home', '情', 5, '2026-10-01T00:00:00.000Z'), value: 'x' } as unknown as Fact,
    ]);
    expect(book.size).toBe(0);
  });
});
