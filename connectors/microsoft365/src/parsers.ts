import { toZonedIso, zonedTime } from '@unicontext/core';

/* Pure helpers used by the normalizer (and exported for tests / other connectors). */

// ---------------------------------------------------------------------------------------------
// Date/time

const WINDOWS_TIME_ZONES: Record<string, string> = {
  UTC: 'UTC',
  'Coordinated Universal Time': 'UTC',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'India Standard Time': 'Asia/Kolkata',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'AUS Eastern Standard Time': 'Australia/Sydney',
};

/** Windows or IANA time zone name → IANA name (or undefined when unknown). */
export function resolveTimeZone(name: string | null | undefined): string | undefined {
  if (!name) return undefined;
  const mapped = WINDOWS_TIME_ZONES[name];
  if (mapped) return mapped;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return name;
  } catch {
    return undefined;
  }
}

const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?$/;

export interface GraphDateTime {
  dateTime: string;
  timeZone?: string | null | undefined;
}

/**
 * Graph `{dateTime, timeZone}` → ISO 8601 with offset. With `Prefer: outlook.timezone="UTC"` (what
 * the connector sends) the result is always `...Z`. Other zones (Windows or IANA names) are
 * converted with Intl; a missing zone is treated as UTC (Graph's default).
 */
export function graphDateTimeToIso(value: GraphDateTime): string | undefined {
  const m = DATE_TIME.exec(value.dateTime.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, frac, off] = m;
  const parts = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: Number(s ?? 0),
    millisecond: frac ? Math.round(Number(`0.${frac}`) * 1000) : 0,
  };
  const utcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
  if (off && off !== 'Z') {
    const sign = off.startsWith('-') ? -1 : 1;
    const digits = off.replace(/[^0-9]/g, '');
    const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
    return new Date(utcMs - sign * minutes * 60_000).toISOString();
  }
  const zone = off === 'Z' ? 'UTC' : value.timeZone ? resolveTimeZone(value.timeZone) : 'UTC';
  if (!zone) return undefined;
  if (zone === 'UTC') return new Date(utcMs).toISOString();
  return toZonedIso(zonedTime(parts, zone), zone);
}

/** `YYYY-MM-DD` of a Graph dateTime string, as written (no zone conversion). */
export function graphDatePart(value: GraphDateTime): string | undefined {
  return /^(\d{4}-\d{2}-\d{2})T/.exec(value.dateTime)?.[1];
}

/** Midnight of a `YYYY-MM-DD` date in `timezone`, as ISO with offset. */
export function localMidnightIso(date: string, timezone: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return toZonedIso(zonedTime({ year: y ?? 1970, month: m ?? 1, day: d ?? 1 }, timezone), timezone);
}

// ---------------------------------------------------------------------------------------------
// Text

const NBSP = new RegExp(String.fromCharCode(0xa0), 'g');

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  hellip: '…',
  ndash: '–',
  mdash: '—',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const cp = parseInt(body.slice(2), 16);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    if (body.startsWith('#')) {
      const cp = parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Teams/Outlook HTML body → plain text (line breaks kept, mentions reduced to the name). */
export function stripHtml(html: string): string {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<attachment\b[^>]*>\s*<\/attachment>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '・')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .replace(NBSP, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Body of a Graph itemBody as plain text. */
export function bodyToText(
  body:
    | { contentType?: string | null | undefined; content?: string | null | undefined }
    | null
    | undefined,
): string {
  const content = body?.content ?? '';
  return /html/i.test(body?.contentType ?? '') || /<\/?[a-z][^>]*>/i.test(content)
    ? stripHtml(content)
    : content.trim();
}

export function looksLikeQuestion(text: string): boolean {
  return /[?？]\s*$/.test(text.trim());
}

/** Mail subject without leading Re:/Fwd: markers (stable thread title). */
export function threadSubject(subject: string | null | undefined): string {
  const stripped = (subject ?? '')
    .replace(/^(\s*(re|fw|fwd|返信|転送|回答)\s*[:：]\s*)+/i, '')
    .trim();
  return stripped.length > 0 ? stripped : '(件名なし)';
}

// ---------------------------------------------------------------------------------------------
// Teams naming (Shizuoka: 「yyyy年度（科目・クラス名等）」)

export interface ParsedTeamName {
  title: string;
  academicYear?: number;
  className?: string;
  /** True when the name followed the 「yyyy年度（…）」 convention. */
  structured: boolean;
}

const toHalfDigits = (s: string): string =>
  s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

const CLASS_SEGMENT =
  /^(?:第?[0-9０-９A-Za-zＡ-Ｚａ-ｚ]{1,3}\s*(?:クラス|組|班|グループ|class|group)|(?:クラス|組|class)\s*[0-9０-９A-Za-zＡ-Ｚａ-ｚ]{1,3}|[0-9０-９A-Za-zＡ-Ｚａ-ｚ]{1,2})$/i;

export function parseTeamName(displayName: string): ParsedTeamName {
  const name = displayName.trim();
  const m =
    /^([0-9０-９]{4})\s*年度\s*[（(]\s*(.+?)\s*[）)]\s*$/.exec(name) ??
    /^([0-9０-９]{4})\s*年度\s+(.+)$/.exec(name);
  if (!m) return { title: name, structured: false };
  const academicYear = Number(toHalfDigits(m[1] ?? ''));
  const inner = (m[2] ?? '').trim();
  const segments = inner
    .split(/[・･]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (segments.length >= 2 && last && CLASS_SEGMENT.test(last)) {
    return {
      title: segments.slice(0, -1).join('・'),
      academicYear,
      className: last,
      structured: true,
    };
  }
  return { title: inner.length > 0 ? inner : name, academicYear, structured: true };
}

// ---------------------------------------------------------------------------------------------
// Room-change hint in instructor posts

const ROOM_CHARS = '[0-9A-Za-z０-９Ａ-Ｚａ-ｚ\\-－ー棟館号階]';
const ROOM_SUFFIX = '(?:教室|講義室|演習室|実習室|室)';
const ROOM_WITH_SUFFIX = `${ROOM_CHARS}{1,12}${ROOM_SUFFIX}`;
const ROOM_PATTERNS: RegExp[] = [
  // 教室を11教室に変更します / 教室を201に変更
  new RegExp(`教室を\\s*(${ROOM_CHARS}{1,12}${ROOM_SUFFIX}?)\\s*(?:に|へ)\\s*(?:変更|移動)`),
  // 11教室に変更になりました
  new RegExp(`(${ROOM_WITH_SUFFIX})\\s*(?:に|へ)\\s*(?:変更|移動)`),
  // 本日の授業は11教室で行います
  new RegExp(`(${ROOM_WITH_SUFFIX})\\s*(?:で|にて)\\s*(?:行い|行う|実施|開催|おこな)`),
];

export interface RoomChangeHint {
  room: string;
  /** The sentence the room was read from. */
  sentence: string;
}

export function extractRoomChange(text: string): RoomChangeHint | undefined {
  for (const re of ROOM_PATTERNS) {
    const m = re.exec(text);
    if (!m?.[1]) continue;
    const room = m[1].normalize('NFKC').replace(/\s+/g, '');
    const sentence =
      text
        .split(/(?<=[。！？!?\n])/)
        .map((s) => s.trim())
        .find((s) => s.includes(m[0])) ?? m[0];
    return { room, sentence: sentence.slice(0, 200) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// OneDrive

export type MaterialKind = 'slides' | 'handout' | 'other';

export function materialKindFor(name: string, mimeType?: string | null): MaterialKind {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  if (['ppt', 'pptx', 'pps', 'ppsx', 'pptm', 'key', 'odp'].includes(ext)) return 'slides';
  if (ext === 'pdf') return 'handout';
  if (/presentationml|powerpoint/i.test(mimeType ?? '')) return 'slides';
  if (mimeType === 'application/pdf') return 'handout';
  return 'other';
}

/** `parentReference.path` ("/drive/root:/授業") + name → "/授業/name". */
export function drivePath(parentPath: string | null | undefined, name: string): string {
  const dir = (parentPath ?? '').replace(/^\/drives?\/[^:]*:/, '').replace(/\/+$/, '');
  return `${dir === '' || dir.startsWith('/') ? dir : `/${dir}`}/${name}`;
}
