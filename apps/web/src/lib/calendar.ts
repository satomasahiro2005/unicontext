import { weekdayJa } from './dates.js';
import { sortClasses } from './sort.js';
import { periodLabel } from './text.js';

export interface WeekGrid<C> {
  dates: string[];
  /** One row per period, ascending; `cells[i]` holds the classes of `dates[i]` in that period. */
  rows: { period: number; cells: C[][] }[];
  /** Per-day classes that have no period (or a period outside the shown rows). */
  unscheduled: C[][];
  hasUnscheduled: boolean;
}

/**
 * Lays a week out as a period x day grid (periods 1..max(minPeriods, highest seen)).
 * Pure so the 1-5限 layout can be tested without a DOM.
 */
export function buildWeekGrid<
  C extends { period: number | undefined; startsAt?: string | undefined },
>(days: readonly { date: string; classes: readonly C[] }[], minPeriods = 5): WeekGrid<C> {
  let maxPeriod = minPeriods;
  for (const day of days) {
    for (const c of day.classes) {
      if (c.period !== undefined && Number.isInteger(c.period) && c.period > maxPeriod) {
        maxPeriod = c.period;
      }
    }
  }
  const rows = Array.from({ length: maxPeriod }, (_, i) => ({
    period: i + 1,
    cells: days.map((day) => sortClasses(day.classes.filter((c) => c.period === i + 1))),
  }));
  const unscheduled = days.map((day) =>
    sortClasses(day.classes.filter((c) => c.period === undefined || !(c.period >= 1))),
  );
  return {
    dates: days.map((d) => d.date),
    rows,
    unscheduled,
    hasUnscheduled: unscheduled.some((list) => list.length > 0),
  };
}

/** `木2限・情報学部2号館21教室` (day of week 0 = Sunday); period and room are optional. */
export function scheduleText(slot: {
  dayOfWeek: number;
  period?: number | undefined;
  room?: string | undefined;
}): string {
  const base = `${weekdayJa(slot.dayOfWeek)}${slot.period === undefined ? '' : periodLabel(slot.period)}`;
  return slot.room ? `${base}・${slot.room}` : base;
}
