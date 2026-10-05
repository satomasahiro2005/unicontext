/** Helpers that turn the appliance's human-formatted list fields into typed metadata. */

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
  PB: 1024 ** 5,
};

/** "14.00 KB" / "0" / 1234 → bytes. Undefined when it cannot be read. */
export function sizeToBytes(size: string | number | undefined): number | undefined {
  if (size === undefined) return undefined;
  if (typeof size === 'number') return Number.isFinite(size) ? Math.max(0, Math.round(size)) : undefined;
  const s = size.trim();
  if (s === '' || s === '-') return undefined;
  const m = /^([\d.,]+)\s*([A-Za-z]+)?$/.exec(s);
  if (!m) return undefined;
  const n = Number(m[1]!.replace(/,/g, ''));
  if (!Number.isFinite(n)) return undefined;
  const unit = (m[2] ?? 'B').toUpperCase();
  const mult = SIZE_UNITS[unit] ?? 1;
  return Math.max(0, Math.round(n * mult));
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * "Mon Oct  5 09:13:03 2026" → "2026-10-05T09:13:03+09:00". The appliance prints the file server's
 * local (JST) time with no zone, so JST is assumed. Undefined when it cannot be parsed. The raw
 * string is kept separately as the authoritative version component (tz-independent).
 */
export function parseTimestamp(ts: string | undefined, tzOffset = '+09:00'): string | undefined {
  if (!ts) return undefined;
  const parts = ts.trim().split(/\s+/);
  // [Weekday] Mon DD HH:MM:SS YYYY  — the weekday may be absent.
  const toks = parts.length >= 5 ? parts.slice(-4) : parts;
  if (toks.length < 4) return undefined;
  const [mon, day, time, year] = toks as [string, string, string, string];
  const month = MONTHS[mon.slice(0, 3).toLowerCase()];
  const d = Number(day);
  const y = Number(year);
  if (!month || !Number.isFinite(d) || !Number.isFinite(y) || !/^\d{1,2}:\d{2}:\d{2}$/.test(time))
    return undefined;
  const pad = (n: number): string => String(n).padStart(2, '0');
  const [hh, mm, ss] = time.split(':');
  return `${y}-${pad(month)}-${pad(d)}T${hh!.padStart(2, '0')}:${mm}:${ss}${tzOffset}`;
}

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
};

export function mimeFromName(name: string): string | undefined {
  return MIME[extensionOf(name)];
}

/** Join path parts with '/', dropping '' and normalizing — no leading/trailing slash. */
export function joinPath(...parts: (string | undefined)[]): string {
  return parts
    .filter((p): p is string => !!p)
    .flatMap((p) => p.split('/'))
    .filter((p) => p !== '' && p !== '.')
    .join('/');
}

/** Parent folder path of a '/'-separated path ('' for a top-level entry). */
export function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** `<year prefix>`, e.g. "2024コンピュータ入門" → { year: 2024, rest: "コンピュータ入門" }. */
export function splitYearPrefix(name: string): { year: number | undefined; rest: string } {
  const m = /^\s*(20\d{2})\s*(?:年度)?\s*(.*)$/.exec(name);
  if (m && m[2]) return { year: Number(m[1]), rest: m[2].trim() };
  return { year: undefined, rest: name.trim() };
}

/** Drop a trailing "（教員名）" / "(teacher)" bracket from a course-folder name. */
export function stripTeacherBracket(name: string): { title: string; teacher: string | undefined } {
  const m = /^(.*?)[\s\u3000]*[（(]([^（）()]+)[）)]\s*$/.exec(name);
  if (m && m[1]) return { title: m[1].trim(), teacher: m[2]!.trim() };
  return { title: name.trim(), teacher: undefined };
}
