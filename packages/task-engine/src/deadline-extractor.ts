import {
  addZonedDays,
  DEFAULT_TIMEZONE,
  startOfZonedWeek,
  zonedParts,
  zonedTime,
} from '@unicontext/core';

/**
 * Rule-based Japanese deadline extraction (§20). No LLM required. Every result keeps the matched
 * phrase and the sentence it came from so it can be stored as an origin=extracted fact with evidence.
 */
export interface ExtractedDeadline {
  /** ISO instant (UTC). */
  dueAt: string;
  /** The matched phrase, e.g. "10月15日23時59分まで". */
  phrase: string;
  /** The whole sentence containing the phrase. */
  evidence: string;
  rule:
    | 'absolute_date'
    | 'weekday'
    | 'relative_day'
    | 'next_week'
    | 'next_class'
    | 'within_days'
    | 'end_of_period';
  confidence: number;
  /** True when no time was given and the end of day was assumed. */
  timeAssumed: boolean;
}

export interface ExtractOptions {
  /** When the text was written/observed (anchor for relative expressions). */
  reference: Date;
  timezone?: string;
  /** Start of the next class meeting after `reference`, for 「次回まで」「来週まで」. */
  nextClassAt?: Date;
  /** Assumed time when only a date is given. Default 23:59. */
  defaultTime?: { hour: number; minute: number };
}

const WEEKDAY: Record<string, number> = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };
const END = '(?:中に|中|までに|まで|迄|が?締め?切り?|〆切|〆|期限)';
const TIME =
  '(?:(午前|午後|夕方|夜)?\\s*(\\d{1,2})\\s*時\\s*(?:(\\d{1,2})\\s*分|(半))?|(\\d{1,2}):(\\d{2})|(正午))';

interface Span {
  start: number;
  end: number;
}

function sentenceAround(text: string, index: number): string {
  const before = text.slice(0, index);
  const start =
    Math.max(
      before.lastIndexOf('。'),
      before.lastIndexOf('\n'),
      before.lastIndexOf('！'),
      before.lastIndexOf('？'),
    ) + 1;
  const rest = text.slice(index);
  const m = /[。\n！？]/.exec(rest);
  const end = m ? index + m.index + 1 : text.length;
  return text.slice(start, end).trim();
}

function parseTime(
  g: (string | undefined)[],
  offset: number,
): { hour: number; minute: number } | undefined {
  const [ampm, h, mi, half, hh, mm, noon] = g.slice(offset, offset + 7);
  if (noon) return { hour: 12, minute: 0 };
  if (hh !== undefined && mm !== undefined) return { hour: Number(hh), minute: Number(mm) };
  if (h === undefined) return undefined;
  let hour = Number(h);
  if ((ampm === '午後' || ampm === '夕方' || ampm === '夜') && hour < 12) hour += 12;
  return { hour, minute: half ? 30 : mi !== undefined ? Number(mi) : 0 };
}

/** Find deadline expressions in Japanese text. Results are sorted by position. */
export function extractDeadlines(input: string, options: ExtractOptions): ExtractedDeadline[] {
  const tz = options.timezone ?? DEFAULT_TIMEZONE;
  const text = input.normalize('NFKC');
  const ref = options.reference;
  const now = zonedParts(ref, tz);
  const defTime = options.defaultTime ?? { hour: 23, minute: 59 };
  const out: (ExtractedDeadline & Span)[] = [];
  const taken: Span[] = [];
  const free = (s: Span): boolean => !taken.some((t) => s.start < t.end && t.start < s.end);

  const at = (
    y: number,
    mo: number,
    d: number,
    time: { hour: number; minute: number } | undefined,
  ): { date: Date; timeAssumed: boolean } => {
    const t = time ?? defTime;
    // "24時" style deadlines roll over naturally through Date normalization.
    return {
      date: zonedTime({ year: y, month: mo, day: d, hour: t.hour, minute: t.minute }, tz),
      timeAssumed: !time,
    };
  };

  const push = (
    m: RegExpExecArray,
    rule: ExtractedDeadline['rule'],
    date: Date,
    confidence: number,
    timeAssumed: boolean,
  ): void => {
    const span = { start: m.index, end: m.index + m[0].length };
    if (!free(span)) return;
    taken.push(span);
    out.push({
      ...span,
      dueAt: date.toISOString(),
      phrase: m[0].trim(),
      evidence: sentenceAround(text, m.index),
      rule,
      confidence,
      timeAssumed,
    });
  };

  const each = (re: RegExp, fn: (m: RegExpExecArray) => void): void => {
    for (const m of text.matchAll(re)) fn(m as RegExpExecArray);
  };

  // 1. 10月15日(木)23時59分まで / 2026年10月15日まで / 10/15 17:00締切
  const abs = new RegExp(
    `(?:(\\d{4})\\s*年\\s*)?(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*日\\s*(?:[(（][月火水木金土日][)）])?\\s*(?:の\\s*)?${TIME}?\\s*${END}`,
    'g',
  );
  const slash = new RegExp(
    `(?:(\\d{4})/)?(\\d{1,2})/(\\d{1,2})\\s*(?:[(（][月火水木金土日][)）])?\\s*${TIME}?\\s*${END}`,
    'g',
  );
  for (const re of [abs, slash]) {
    each(re, (m) => {
      const g = [...m] as (string | undefined)[];
      const month = Number(g[2]);
      const day = Number(g[3]);
      if (month < 1 || month > 12 || day < 1 || day > 31) return;
      let year = g[1] ? Number(g[1]) : now.year;
      const time = parseTime(g, 4);
      let r = at(year, month, day, time);
      if (!g[1] && r.date.getTime() < ref.getTime() - 60 * 86_400_000) {
        year += 1;
        r = at(year, month, day, time);
      }
      push(m, 'absolute_date', r.date, time ? 0.95 : 0.85, r.timeAssumed);
    });
  }

  // 2. (今週|来週|再来週)?金曜日(17時)?まで / 金曜日中
  const weekday = new RegExp(
    `(今週|来週|再来週)?\\s*(?:の\\s*)?([月火水木金土日])曜日?\\s*(?:の\\s*)?${TIME}?\\s*${END}`,
    'g',
  );
  each(weekday, (m) => {
    const g = [...m] as (string | undefined)[];
    const target = WEEKDAY[g[2] ?? ''] ?? 0;
    let base: Date;
    if (g[1]) {
      const weeks = g[1] === '今週' ? 0 : g[1] === '来週' ? 1 : 2;
      const monday = addZonedDays(startOfZonedWeek(ref, tz), 7 * weeks, tz);
      base = addZonedDays(monday, (target + 6) % 7, tz); // Monday-based week
    } else {
      base = addZonedDays(ref, (target - now.weekday + 7) % 7, tz);
    }
    const p = zonedParts(base, tz);
    const time = parseTime(g, 3);
    const r = at(p.year, p.month, p.day, time);
    push(m, 'weekday', r.date, g[1] ? 0.85 : 0.8, r.timeAssumed);
  });

  // 3. 今日中 / 本日17時まで / 明日まで / 明後日まで
  const relDay = new RegExp(
    `(今日|本日|明日|あした|明後日|あさって)\\s*(?:の\\s*)?${TIME}?\\s*${END}`,
    'g',
  );
  each(relDay, (m) => {
    const g = [...m] as (string | undefined)[];
    const offset =
      g[1] === '今日' || g[1] === '本日' ? 0 : g[1] === '明日' || g[1] === 'あした' ? 1 : 2;
    const p = zonedParts(addZonedDays(ref, offset, tz), tz);
    const time = parseTime(g, 2);
    const r = at(p.year, p.month, p.day, time);
    push(m, 'relative_day', r.date, 0.85, r.timeAssumed);
  });

  // 4. 今週中 / 今月中
  each(/(今週|今月)\s*(?:中に?|末まで(?:に)?|いっぱい)/g, (m) => {
    if (m[1] === '今週') {
      const sunday = addZonedDays(startOfZonedWeek(ref, tz), 6, tz);
      const p = zonedParts(sunday, tz);
      push(m, 'end_of_period', at(p.year, p.month, p.day, undefined).date, 0.7, true);
    } else {
      const last = zonedTime({ year: now.year, month: now.month + 1, day: 0 }, tz);
      const p = zonedParts(last, tz);
      push(m, 'end_of_period', at(p.year, p.month, p.day, undefined).date, 0.7, true);
    }
  });

  // 5. 次回(の授業)まで: the start of the next class if known.
  each(
    /次回(?:の\s*(?:授業|講義|ゼミ|演習))?\s*(?:まで(?:に)?|の?(?:授業|講義)?開始(?:時|前)?まで)/g,
    (m) => {
      if (options.nextClassAt) push(m, 'next_class', options.nextClassAt, 0.8, false);
      else {
        const p = zonedParts(addZonedDays(ref, 7, tz), tz);
        push(m, 'next_class', at(p.year, p.month, p.day, undefined).date, 0.4, true);
      }
    },
  );

  // 6. 来週まで: next class if it falls next week, else one week from the reference.
  each(/来週\s*(?:の\s*(?:授業|講義))?\s*まで(?:に)?/g, (m) => {
    const weekStart = addZonedDays(startOfZonedWeek(ref, tz), 7, tz);
    const weekEnd = addZonedDays(weekStart, 7, tz);
    const next = options.nextClassAt;
    if (next && next >= weekStart && next < weekEnd) push(m, 'next_week', next, 0.65, false);
    else {
      const p = zonedParts(addZonedDays(ref, 7, tz), tz);
      push(m, 'next_week', at(p.year, p.month, p.day, undefined).date, 0.5, true);
    }
  });

  // 7. 3日以内
  each(/(\d{1,2})\s*日以内/g, (m) => {
    const p = zonedParts(addZonedDays(ref, Number(m[1]), tz), tz);
    push(m, 'within_days', at(p.year, p.month, p.day, undefined).date, 0.6, true);
  });

  return out.sort((a, b) => a.start - b.start).map(({ start: _s, end: _e, ...d }) => d);
}
