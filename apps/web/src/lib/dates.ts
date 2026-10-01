export const DEFAULT_TIMEZONE = 'Asia/Tokyo';

const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'] as const;
const PLAIN_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
  } catch {
    return formatterFor(DEFAULT_TIMEZONE);
  }
  formatters.set(timeZone, fmt);
  return fmt;
}

export function isIsoDateTime(value: string): boolean {
  return ISO_DATETIME.test(value);
}

export function isPlainDate(value: string): boolean {
  return PLAIN_DATE.test(value);
}

function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Parses an instant (ISO string, Date, epoch ms). Returns undefined for anything invalid. */
export function toDate(input: string | number | Date | undefined | null): Date | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function zonedParts(date: Date, timeZone: string = DEFAULT_TIMEZONE): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  return {
    year,
    month,
    day,
    hour: get('hour') % 24,
    minute: get('minute'),
    weekday: weekdayOf(year, month, day),
  };
}

/** Year/month/day of a plain `YYYY-MM-DD` date or of an instant seen in `timeZone`. */
function dayParts(
  input: string | number | Date,
  timeZone: string,
): { year: number; month: number; day: number; weekday: number } | undefined {
  if (typeof input === 'string') {
    const m = PLAIN_DATE.exec(input);
    if (m) {
      const year = Number(m[1]);
      const month = Number(m[2]);
      const day = Number(m[3]);
      return { year, month, day, weekday: weekdayOf(year, month, day) };
    }
  }
  const d = toDate(input);
  if (!d) return undefined;
  const p = zonedParts(d, timeZone);
  return { year: p.year, month: p.month, day: p.day, weekday: p.weekday };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** `10/8` */
export function formatMonthDay(
  input: string | number | Date | undefined,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  if (input === undefined) return '';
  const p = dayParts(input, timeZone);
  return p ? `${p.month}/${p.day}` : '';
}

/** `09:42` */
export function formatTime(
  input: string | number | Date | undefined,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  const d = toDate(input);
  if (!d) return '';
  const p = zonedParts(d, timeZone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** `10/1 09:42` (instants) or `10/1` (plain dates). */
export function formatShort(
  input: string | number | Date | undefined,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  if (input === undefined) return '';
  if (typeof input === 'string' && isPlainDate(input)) return formatMonthDay(input, timeZone);
  const d = toDate(input);
  if (!d) return '';
  const p = zonedParts(d, timeZone);
  return `${p.month}/${p.day} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** `10月1日(木)`; accepts a plain `YYYY-MM-DD` date or an instant. */
export function formatDateJa(
  input: string | number | Date | undefined,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  if (input === undefined) return '';
  const p = dayParts(input, timeZone);
  if (!p) return '';
  return `${p.month}月${p.day}日(${WEEKDAYS_JA[p.weekday]})`;
}

/** `月` for 1 (0 = Sunday). */
export function weekdayJa(dayOfWeek: number): string {
  return WEEKDAYS_JA[((dayOfWeek % 7) + 7) % 7] ?? '';
}

/** `09:00–10:30`, `09:00–` or empty. */
export function formatTimeRange(
  start: string | undefined,
  end: string | undefined,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  const s = formatTime(start, timeZone);
  const e = formatTime(end, timeZone);
  if (s && e) return `${s}–${e}`;
  if (s) return `${s}–`;
  return '';
}

/** `YYYY-MM-DD` of the day an instant falls on in `timeZone` (plain dates pass through). */
export function dayKey(input: string | number | Date, timeZone: string = DEFAULT_TIMEZONE): string {
  const p = dayParts(input, timeZone);
  if (!p) return '';
  return `${String(p.year).padStart(4, '0')}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** 今日 / 昨日 / 明日 relative to `todayKey` (a `YYYY-MM-DD`), otherwise undefined. */
export function relativeDayLabel(dateKey: string, todayKey: string): string | undefined {
  const a = PLAIN_DATE.exec(dateKey);
  const b = PLAIN_DATE.exec(todayKey);
  if (!a || !b) return undefined;
  const da = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const db = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  const diff = Math.round((da - db) / 86_400_000);
  if (diff === 0) return '今日';
  if (diff === -1) return '昨日';
  if (diff === 1) return '明日';
  return undefined;
}

/** `あと3時間`, `あと2日`, `5時間超過`, `3日超過`. */
export function formatRemaining(hoursLeft: number, overdue: boolean): string {
  const abs = Math.abs(hoursLeft);
  if (overdue || hoursLeft < 0) {
    return abs < 48 ? `${Math.max(1, Math.round(abs))}時間超過` : `${Math.round(abs / 24)}日超過`;
  }
  if (abs < 1) return 'あと1時間未満';
  return abs < 48 ? `あと${Math.round(abs)}時間` : `あと${Math.round(abs / 24)}日`;
}

function offsetMinutes(utcMs: number, timeZone: string): number {
  const p = zonedParts(new Date(utcMs), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(utcMs / 60_000) * 60_000) / 60_000);
}

/** Converts a `datetime-local` value (`2026-10-10T23:59`) in `timeZone` to a UTC ISO string. */
export function zonedLocalToIso(
  local: string,
  timeZone: string = DEFAULT_TIMEZONE,
): string | undefined {
  const m = LOCAL_DATETIME.exec(local);
  if (!m) return undefined;
  const wall = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? 0),
  );
  let guess = wall - offsetMinutes(wall, timeZone) * 60_000;
  guess = wall - offsetMinutes(guess, timeZone) * 60_000;
  const d = new Date(guess);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Inverse of zonedLocalToIso: `2026-10-10T14:59:00.000Z` -> `2026-10-10T23:59`. */
export function isoToZonedLocal(
  iso: string,
  timeZone: string = DEFAULT_TIMEZONE,
): string | undefined {
  const d = toDate(iso);
  if (!d) return undefined;
  const p = zonedParts(d, timeZone);
  return `${String(p.year).padStart(4, '0')}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`;
}
