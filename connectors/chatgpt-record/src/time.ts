import { zonedParts, zonedTime } from '@unicontext/core';

const pad = (n: number): string => String(n).padStart(2, '0');

/** "hh:mm:ss(.mmm)" / "mm:ss(.mmm)" (comma or dot) -> milliseconds. */
export function parseTimestampMs(text: string): number | undefined {
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(text.trim());
  if (!m) return undefined;
  const [h, mi, s] = [Number(m[1] ?? 0), Number(m[2]), Number(m[3])];
  if (mi > 59 || s > 59) return undefined;
  const ms = m[4] ? Number(m[4].padEnd(3, '0')) : 0;
  return ((h * 60 + mi) * 60 + s) * 1000 + ms;
}

/** Milliseconds -> "HH:MM:SS" (hours may exceed two digits). */
export function formatTimestamp(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export interface LocalDateTime {
  date: string;
  /** HH:MM when the text carried a time. */
  time?: string;
}

/**
 * Find a date (and a time right after it) in free text or a file name:
 * `2026-10-01 10-40`, `2026-10-01_10-40`, `20261001_1040`, `2026-10-01T10:40`, `2026/10/01 10:40:05`,
 * `2026年10月1日 10時40分`.
 */
export function findLocalDateTime(text: string): LocalDateTime | undefined {
  const s = text.normalize('NFKC');
  let m = /(?<!\d)((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(s);
  if (!m) m = /(?<!\d)((?:19|20)\d{2})[-_./](\d{1,2})[-_./](\d{1,2})(?!\d)/.exec(s);
  if (!m) m = /(?<!\d)((?:19|20)\d{2})(\d{2})(\d{2})(?!\d)/.exec(s);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number];
  if (!validDate(y, mo, d)) return undefined;
  const rest = s.slice(m.index + m[0].length);
  const date = `${y}-${pad(mo)}-${pad(d)}`;
  const t =
    /^[\sT_-]*(\d{1,2})\s*[:._h時-]\s*(\d{2})(?:\s*[:._-]\s*\d{2})?\s*分?(?!\d)/.exec(rest) ??
    /^[\sT_-]*(\d{2})(\d{2})(?!\d)/.exec(rest);
  if (t) {
    const [h, mi] = [Number(t[1]), Number(t[2])];
    if (h < 24 && mi < 60) return { date, time: `${pad(h)}:${pad(mi)}` };
  }
  return { date };
}

/** Local date/time in `timezone` -> ISO instant (00:00 when there is no time). */
export function localToIso(value: LocalDateTime, timezone: string): string {
  const [y, mo, d] = value.date.split('-').map(Number) as [number, number, number];
  const [h, mi] = value.time ? (value.time.split(':').map(Number) as [number, number]) : [0, 0];
  return zonedTime({ year: y, month: mo, day: d, hour: h, minute: mi }, timezone).toISOString();
}

/** "2026-10-01T01:40:00Z" / "2026-10-01 10:40" / "2026年10月1日" -> ISO instant. */
export function parseDateTimeText(text: string, timezone: string): string | undefined {
  const trimmed = text.trim();
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
    const dt = new Date(trimmed);
    if (!Number.isNaN(dt.getTime())) return dt.toISOString();
  }
  const found = findLocalDateTime(trimmed);
  return found ? localToIso(found, timezone) : undefined;
}

/** Local date (YYYY-MM-DD) of an instant in `timezone`. */
export function localDateOf(iso: string, timezone: string): string {
  const p = zonedParts(new Date(iso), timezone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Local minutes since midnight of an instant in `timezone`. */
export function localMinutesOf(iso: string, timezone: string): number {
  const p = zonedParts(new Date(iso), timezone);
  return p.hour * 60 + p.minute;
}
