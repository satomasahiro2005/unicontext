/**
 * Which day does a post mean? 「本日の授業は21教室で行います」 posted on 10/6 means 10/6 only; 「次回」
 * means the course's next session after the post. Pure and deterministic: everything is computed
 * from the post's own time, never from the clock.
 *
 * Used by the Teams and Microsoft 365 normalizers to scope a room-change hint to one session
 * (LiveCampusU does the same with the 対象日 of its 講義室変更 notices).
 */
import { DEFAULT_TIMEZONE, zonedDateString, zonedTime } from './dates.js';

const DAY_MS = 86_400_000;
const WEEKDAY_CHARS = '日月火水木金土';
const DOW = '[日月火水木金土]';

/** A session of the course, by local date (YYYY-MM-DD), for 次回 / 来週. */
export type SessionDate = string | { date: string };

export interface ResolvedSessionDate {
  /** Local date, YYYY-MM-DD. */
  date: string;
  /** How the date was found: explicit-date, today, tomorrow, day-after-tomorrow, weekday, … */
  basis:
    | 'explicit-date'
    | 'today'
    | 'tomorrow'
    | 'day-after-tomorrow'
    | 'next-session'
    | 'next-week-session'
    | 'next-week-weekday'
    | 'this-week-weekday'
    | 'weekday';
}

interface Hit {
  /** The text that carries the date. */
  phrase: string;
  /** Position in the (NFKC-normalized) text. */
  index: number;
  kind: ResolvedSessionDate['basis'];
  groups: RegExpExecArray;
}

// Each rule: [kind, regex]. Higher in the list = more specific. Text is NFKC-normalized first.
const RULES: readonly [ResolvedSessionDate['basis'], RegExp][] = [
  [
    'explicit-date',
    new RegExp(
      `(?<![\\d/])(?:(\\d{4})\\s*[/年]\\s*)?(\\d{1,2})\\s*[/月]\\s*(\\d{1,2})\\s*日?(?:\\s*[（(]\\s*(${DOW})\\s*(?:曜日?)?\\s*[）)]|\\s*(${DOW})曜日?)?(?![\\d:：])`,
    ),
  ],
  ['next-week-weekday', new RegExp(`来週\\s*(?:の)?\\s*(${DOW})\\s*(?:曜日?|[）)])?`)],
  ['this-week-weekday', new RegExp(`今週\\s*(?:の)?\\s*(${DOW})\\s*曜日?`)],
  ['next-session', /次回|次の授業|次の講義|次の回/],
  ['next-week-session', /来週/],
  ['day-after-tomorrow', /明後日|あさって/],
  ['tomorrow', /明日|あした/],
  ['today', /本日|今日|きょう/],
  ['weekday', new RegExp(`(${DOW})曜日?`)],
];

function scan(text: string): Hit | undefined {
  const t = text.normalize('NFKC');
  for (const [kind, re] of RULES) {
    const m = re.exec(t);
    if (m) return { phrase: m[0].trim(), index: m.index, kind, groups: m };
  }
  return undefined;
}

/** The part of the text that names a day (「本日」「10/6(月)」「来週の火曜日」 …), if any. */
export function findDatePhrase(text: string): string | undefined {
  return scan(text)?.phrase;
}

/**
 * The text says the change is not for one day: 以降 / 今後 / これから / from now on.
 * 「今後ともよろしくお願いします」 is a greeting, not a change.
 */
export function isPermanentChange(text: string): boolean {
  const t = text.normalize('NFKC');
  return /以降|以後|今後(?!とも|ご|の連絡)|これから|from now on|henceforth/i.test(t);
}

function parts(date: string): { year: number; month: number; day: number } | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : undefined;
}

function toUtc(date: string): number {
  const p = parts(date);
  if (!p) return Number.NaN;
  return Date.UTC(p.year, p.month - 1, p.day);
}

function fromUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Add days to a local date string (YYYY-MM-DD). */
export function addLocalDate(date: string, days: number): string {
  return fromUtc(toUtc(date) + days * DAY_MS);
}

/** 0 = Sunday … 6 = Saturday */
function weekdayOf(date: string): number {
  return new Date(toUtc(date)).getUTCDay();
}

function validDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

function sessionDates(sessions: readonly SessionDate[] | undefined): string[] {
  return [...new Set((sessions ?? []).map((s) => (typeof s === 'string' ? s : s.date)))]
    .filter((d) => parts(d))
    .sort();
}

/** Monday of the week of a local date. */
function mondayOf(date: string): string {
  const dow = weekdayOf(date);
  return addLocalDate(date, -((dow + 6) % 7));
}

function explicit(hit: Hit, posted: string): string | undefined {
  const g = hit.groups;
  const month = Number(g[2]);
  const day = Number(g[3]);
  const named = g[4] ?? g[5];
  const dow = named ? WEEKDAY_CHARS.indexOf(named) : undefined;
  const postedYear = Number(posted.slice(0, 4));
  // A year in the text is taken as is; without one the post's year, then the next and the previous
  // (posted 12/20 saying 「1/10」 means next January).
  const years = g[1] ? [Number(g[1])] : [postedYear, postedYear + 1, postedYear - 1];
  const dates = years
    .filter((y) => validDate(y, month, day))
    .map((y) => `${y}-${pad2(month)}-${pad2(day)}`)
    // A weekday that does not match the date means the text is not what we think it is.
    .filter((d) => dow === undefined || weekdayOf(d) === dow);
  if (g[1]) return dates[0];
  const near = dates.find((d) => Math.abs(toUtc(d) - toUtc(posted)) <= 180 * DAY_MS);
  // Far from the post with a weekday that fits only by luck (another year) is not a match.
  return near ?? (dow === undefined ? dates[0] : undefined);
}

/**
 * The local day a post means, or undefined when it cannot be told.
 *
 * 本日/今日 (the day of the post), 明日, 明後日, 次回 (first session after the post's day; needs
 * `sessionsOfCourse`), 来週 alone (the course's first session next week; needs sessions), 来週の火曜
 * (that day of next week), M/D, M月D日 and either with (曜日) (the weekday has to match), a bare
 * 月曜日 (next one after the post's day). `postedAt` is when the post was written.
 */
export function resolveSessionDate(
  text: string,
  postedAt: Date | string,
  tz: string = DEFAULT_TIMEZONE,
  sessionsOfCourse?: readonly SessionDate[],
): ResolvedSessionDate | undefined {
  const at = typeof postedAt === 'string' ? new Date(postedAt) : postedAt;
  if (Number.isNaN(at.getTime())) return undefined;
  const hit = scan(text);
  if (!hit) return undefined;
  const posted = zonedDateString(at, tz);
  const sessions = sessionDates(sessionsOfCourse);
  const done = (date: string | undefined): ResolvedSessionDate | undefined =>
    date ? { date, basis: hit.kind } : undefined;
  switch (hit.kind) {
    case 'explicit-date':
      return done(explicit(hit, posted));
    case 'today':
      return done(posted);
    case 'tomorrow':
      return done(addLocalDate(posted, 1));
    case 'day-after-tomorrow':
      return done(addLocalDate(posted, 2));
    case 'next-week-weekday': {
      const dow = WEEKDAY_CHARS.indexOf(hit.groups[1] ?? '');
      return done(addLocalDate(mondayOf(posted), 7 + ((dow + 6) % 7)));
    }
    case 'this-week-weekday': {
      const dow = WEEKDAY_CHARS.indexOf(hit.groups[1] ?? '');
      return done(addLocalDate(mondayOf(posted), (dow + 6) % 7));
    }
    case 'next-session':
      return done(sessions.find((d) => d > posted));
    case 'next-week-session': {
      const from = addLocalDate(mondayOf(posted), 7);
      const to = addLocalDate(from, 6);
      return done(sessions.find((d) => d >= from && d <= to));
    }
    case 'weekday': {
      const dow = WEEKDAY_CHARS.indexOf(hit.groups[1] ?? '');
      let date = addLocalDate(posted, 1);
      while (weekdayOf(date) !== dow) date = addLocalDate(date, 1);
      return done(date);
    }
  }
}

export interface RoomChangeScopeInput {
  /** The room-change hint: where the date phrase was found, and whether the text says 以降/今後. */
  datePhrase?: string | undefined;
  permanent?: boolean | undefined;
}

export type RoomChangeScope =
  /** Valid for one local day: [validFrom, validUntil). */
  | { kind: 'dated'; date: string; validFrom: string; validUntil: string; basis: string }
  /** 以降/今後: the course's room from now on (validFrom when a start day is named). */
  | { kind: 'permanent'; validFrom?: string; date?: string }
  /** No day could be told and the text does not say it is permanent. */
  | { kind: 'unresolved' };

/** The instant a local day starts / the next local day starts, as ISO strings in UTC. */
export function localDayBounds(date: string, tz: string): { start: string; end: string } {
  const p = parts(date) ?? { year: 1970, month: 1, day: 1 };
  return {
    start: zonedTime({ ...p }, tz).toISOString(),
    end: zonedTime({ ...p, day: p.day + 1 }, tz).toISOString(),
  };
}

/**
 * What a room-change hint applies to: one session day (本日 … = the day of the post, 10/6 …),
 * the course from now on (以降 / 今後), or nothing certain (no day, not permanent: the change
 * is news, not a fact about the course's room).
 */
export function resolveRoomChangeScope(
  hint: RoomChangeScopeInput,
  postedAt: Date | string | undefined,
  tz: string = DEFAULT_TIMEZONE,
  sessionsOfCourse?: readonly SessionDate[],
): RoomChangeScope {
  const resolved =
    hint.datePhrase && postedAt !== undefined
      ? resolveSessionDate(hint.datePhrase, postedAt, tz, sessionsOfCourse)
      : undefined;
  if (hint.permanent) {
    if (resolved)
      return {
        kind: 'permanent',
        validFrom: localDayBounds(resolved.date, tz).start,
        date: resolved.date,
      };
    return { kind: 'permanent' };
  }
  if (resolved) {
    const b = localDayBounds(resolved.date, tz);
    return {
      kind: 'dated',
      date: resolved.date,
      validFrom: b.start,
      validUntil: b.end,
      basis: resolved.basis,
    };
  }
  return { kind: 'unresolved' };
}
