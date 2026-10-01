import { DEFAULT_TIMEZONE, dayKey } from './dates.js';

function cmpOptionalString(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a < b ? -1 : 1;
}

/** Earliest due date first; items without a due date last. Stable, does not mutate. */
export function sortByDue<T extends { dueAt?: string | undefined }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((x, y) => cmpOptionalString(x.item.dueAt, y.item.dueAt) || x.index - y.index)
    .map((x) => x.item);
}

/** Period order (unknown periods last), then start time. */
export function sortClasses<
  T extends { period?: number | undefined; startsAt?: string | undefined },
>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((x, y) => {
      const px = x.item.period ?? Number.POSITIVE_INFINITY;
      const py = y.item.period ?? Number.POSITIVE_INFINITY;
      if (px !== py) return px < py ? -1 : 1;
      return cmpOptionalString(x.item.startsAt, y.item.startsAt) || x.index - y.index;
    })
    .map((x) => x.item);
}

export interface DayGroup<T> {
  /** `YYYY-MM-DD` in the display timezone */
  key: string;
  items: T[];
}

/**
 * Buckets items by the calendar day of `getAt(item)` in `timeZone`. Days are ordered newest first
 * (or oldest first with `order: 'asc'`); items inside a day follow the same order. Items without a
 * valid time go into a trailing group with an empty key.
 */
export function groupByDay<T>(
  items: readonly T[],
  getAt: (item: T) => string | undefined,
  timeZone: string = DEFAULT_TIMEZONE,
  order: 'asc' | 'desc' = 'desc',
): DayGroup<T>[] {
  const dated = new Map<string, { item: T; at: string }[]>();
  const undated: T[] = [];
  for (const item of items) {
    const at = getAt(item);
    const key = at ? dayKey(at, timeZone) : '';
    if (!at || !key) {
      undated.push(item);
      continue;
    }
    const bucket = dated.get(key);
    if (bucket) bucket.push({ item, at });
    else dated.set(key, [{ item, at }]);
  }
  const sign = order === 'desc' ? -1 : 1;
  const groups: DayGroup<T>[] = [...dated.entries()]
    .sort(([a], [b]) => (a < b ? -sign : a > b ? sign : 0))
    .map(([key, bucket]) => ({
      key,
      items: bucket
        .sort((x, y) => (x.at < y.at ? -sign : x.at > y.at ? sign : 0))
        .map((x) => x.item),
    }));
  if (undated.length > 0) groups.push({ key: '', items: undated });
  return groups;
}
