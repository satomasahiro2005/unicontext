import { describe, expect, it } from 'vitest';
import { changeSubject, describeChange, type ChangeLike } from '../src/lib/changes.js';
import { groupByDay } from '../src/lib/sort.js';

function change(over: Partial<ChangeLike>): ChangeLike {
  return {
    id: 'changeEvent:1',
    entityKind: 'assignment',
    type: 'updated',
    summary: '課題「課題1」の締切: 10/8 23:59 → 10/10 23:59',
    changedFields: ['dueAt'],
    before: { dueAt: '2026-10-08T14:59:00.000Z' },
    after: { dueAt: '2026-10-10T14:59:00.000Z' },
    occurredAt: '2026-10-01T00:10:00.000Z',
    ...over,
  };
}

describe('describeChange', () => {
  it('renders a deadline move as 締切: 10/8 23:59 → 10/10 23:59', () => {
    const view = describeChange(change({}), 'Asia/Tokyo');
    expect(view.kindLabel).toBe('課題');
    expect(view.typeLabel).toBe('変更');
    expect(view.headline).toBe('課題「課題1」');
    expect(view.diffs).toHaveLength(1);
    expect(view.diffs[0]?.text).toBe('締切: 10/8 23:59 → 10/10 23:59');
    expect(view.diffs[0]?.before).toBe('10/8 23:59');
    expect(view.diffs[0]?.after).toBe('10/10 23:59');
  });

  it('renders several fields and treats missing values as なし', () => {
    const view = describeChange(
      change({
        entityKind: 'courseOffering',
        summary: '授業「データベースシステム論」の教室: 21教室 → 11教室',
        changedFields: ['room', 'period'],
        before: { room: '21教室' },
        after: { room: '11教室', period: 3 },
      }),
    );
    expect(view.diffs.map((d) => d.text)).toEqual(['教室: 21教室 → 11教室', '時限: なし → 3']);
  });

  it('shows booleans and lists in a readable way', () => {
    const view = describeChange(
      change({
        changedFields: ['cancelled', 'instructors'],
        before: { cancelled: false, instructors: ['山田 太郎'] },
        after: { cancelled: true, instructors: ['山田 太郎', '佐藤 花子'] },
      }),
    );
    expect(view.diffs[0]?.text).toBe('休講: いいえ → はい');
    expect(view.diffs[1]?.text).toBe('担当: 山田 太郎 → 山田 太郎、佐藤 花子');
  });

  it('keeps the server summary for created events and has no diffs', () => {
    const view = describeChange(
      change({
        entityKind: 'material',
        type: 'created',
        summary: '資料「Lecture 3.pdf」が追加されました',
        changedFields: ['title', 'url'],
        before: null,
        after: { title: 'Lecture 3.pdf' },
      }),
    );
    expect(view.typeLabel).toBe('追加');
    expect(view.kindLabel).toBe('資料');
    expect(view.headline).toBe('資料「Lecture 3.pdf」が追加されました');
    expect(view.diffs).toEqual([]);
  });

  it('caps the number of diffs and reports how many were hidden', () => {
    const fields = Array.from({ length: 11 }, (_, i) => `f${i}`);
    const view = describeChange(
      change({
        changedFields: fields,
        before: Object.fromEntries(fields.map((f) => [f, 1])),
        after: Object.fromEntries(fields.map((f) => [f, 2])),
      }),
    );
    expect(view.diffs).toHaveLength(8);
    expect(view.hiddenDiffs).toBe(3);
  });

  it('extracts the quoted subject from a summary', () => {
    expect(changeSubject('課題「課題1」の締切: x')).toBe('課題「課題1」');
    expect(changeSubject('no quotes here')).toBeUndefined();
  });
});

describe('groupByDay for the changes screen', () => {
  const items = [
    { id: 'a', at: '2026-09-30T20:00:00.000Z' }, // 10/1 05:00 JST
    { id: 'b', at: '2026-09-30T10:00:00.000Z' }, // 9/30 19:00 JST
    { id: 'c', at: '2026-10-01T01:00:00.000Z' }, // 10/1 10:00 JST
    { id: 'd', at: undefined as string | undefined },
  ];

  it('groups newest day first with newest items first', () => {
    const groups = groupByDay(items, (i) => i.at, 'Asia/Tokyo');
    expect(groups.map((g) => g.key)).toEqual(['2026-10-01', '2026-09-30', '']);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['c', 'a']);
    expect(groups[2]?.items.map((i) => i.id)).toEqual(['d']);
  });

  it('can group oldest first', () => {
    const groups = groupByDay(items, (i) => i.at, 'Asia/Tokyo', 'asc');
    expect(groups.map((g) => g.key)).toEqual(['2026-09-30', '2026-10-01', '']);
    expect(groups[1]?.items.map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('respects the display timezone when bucketing', () => {
    const groups = groupByDay(items.slice(0, 3), (i) => i.at, 'UTC');
    expect(groups.map((g) => g.key)).toEqual(['2026-10-01', '2026-09-30']);
    expect(groups[1]?.items.map((i) => i.id)).toEqual(['a', 'b']);
  });
});
