/**
 * Timezone-aware date helpers. All instants are plain Date (UTC); "zoned" helpers interpret them
 * in an IANA timezone (default Asia/Tokyo) using Intl, so no tz database dependency is needed.
 */
export const DEFAULT_TIMEZONE = 'Asia/Tokyo';

export const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'] as const;

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAY_EN: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function zonedParts(date: Date, tz: string = DEFAULT_TIMEZONE): ZonedParts {
  const parts = formatter(tz).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAY_EN[get('weekday')] ?? 0,
  };
}

/** Offset of tz from UTC at the given instant, in minutes (Asia/Tokyo = +540). */
export function tzOffsetMinutes(date: Date, tz: string = DEFAULT_TIMEZONE): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - truncated) / 60000);
}

export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  millisecond?: number;
}

/** Convert a wall-clock time in tz to an instant. Day/month overflow is normalized (e.g. day 32). */
export function zonedTime(local: LocalDateTime, tz: string = DEFAULT_TIMEZONE): Date {
  const utcGuess = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour ?? 0,
    local.minute ?? 0,
    local.second ?? 0,
    local.millisecond ?? 0,
  );
  let offset = tzOffsetMinutes(new Date(utcGuess), tz);
  let result = utcGuess - offset * 60000;
  const offset2 = tzOffsetMinutes(new Date(result), tz);
  if (offset2 !== offset) {
    offset = offset2;
    result = utcGuess - offset * 60000;
  }
  return new Date(result);
}

export function startOfZonedDay(date: Date, tz: string = DEFAULT_TIMEZONE): Date {
  const p = zonedParts(date, tz);
  return zonedTime({ year: p.year, month: p.month, day: p.day }, tz);
}

/** 23:59:59.999 local time of the same day. */
export function endOfZonedDay(date: Date, tz: string = DEFAULT_TIMEZONE): Date {
  const p = zonedParts(date, tz);
  return zonedTime(
    {
      year: p.year,
      month: p.month,
      day: p.day,
      hour: 23,
      minute: 59,
      second: 59,
      millisecond: 999,
    },
    tz,
  );
}

/** Add calendar days keeping the local wall-clock time. */
export function addZonedDays(date: Date, days: number, tz: string = DEFAULT_TIMEZONE): Date {
  const p = zonedParts(date, tz);
  const ms = date.getTime() % 1000;
  return zonedTime(
    {
      year: p.year,
      month: p.month,
      day: p.day + days,
      hour: p.hour,
      minute: p.minute,
      second: p.second,
      millisecond: ms < 0 ? 0 : ms,
    },
    tz,
  );
}

/** Start of the local week (default Monday). */
export function startOfZonedWeek(
  date: Date,
  tz: string = DEFAULT_TIMEZONE,
  weekStartsOn = 1,
): Date {
  const p = zonedParts(date, tz);
  const diff = (p.weekday - weekStartsOn + 7) % 7;
  return zonedTime({ year: p.year, month: p.month, day: p.day - diff }, tz);
}

const pad = (n: number, w = 2): string => String(Math.abs(n)).padStart(w, '0');

/** 'YYYY-MM-DD' in tz. */
export function zonedDateString(date: Date, tz: string = DEFAULT_TIMEZONE): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Parse 'YYYY-MM-DD' as the start of that local day. */
export function parseZonedDate(value: string, tz: string = DEFAULT_TIMEZONE): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new RangeError(`Invalid local date: ${value}`);
  return zonedTime({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }, tz);
}

/** ISO 8601 with the local offset, e.g. 2026-10-01T09:42:00+09:00. */
export function toZonedIso(date: Date, tz: string = DEFAULT_TIMEZONE): string {
  const p = zonedParts(date, tz);
  const off = tzOffsetMinutes(date, tz);
  const sign = off >= 0 ? '+' : '-';
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

/** Compact Japanese display, e.g. "10/1 09:42". */
export function formatShortJa(date: Date, tz: string = DEFAULT_TIMEZONE): string {
  const p = zonedParts(date, tz);
  return `${p.month}/${p.day} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** e.g. "10月1日(木)". */
export function formatDateJa(date: Date, tz: string = DEFAULT_TIMEZONE): string {
  const p = zonedParts(date, tz);
  return `${p.month}月${p.day}日(${WEEKDAYS_JA[p.weekday]})`;
}

export interface DateRange {
  from: Date;
  to: Date;
}

export function isWithin(date: Date, range: DateRange): boolean {
  const t = date.getTime();
  return t >= range.from.getTime() && t < range.to.getTime();
}

/** Local day range [start, next start) that contains date. */
export function zonedDayRange(date: Date, tz: string = DEFAULT_TIMEZONE): DateRange {
  const from = startOfZonedDay(date, tz);
  return { from, to: addZonedDays(from, 1, tz) };
}
