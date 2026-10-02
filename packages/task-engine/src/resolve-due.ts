import { DEFAULT_TIMEZONE, zonedTime } from '@unicontext/core';
import { type ExtractedDeadline, extractDeadlines } from './deadline-extractor.js';

/**
 * A due date given by an AI client: either an absolute ISO-8601 value or a Japanese expression
 * heard in a lecture (「来週の金曜」「次回」「10月15日17時」). Relative expressions are resolved
 * against `reference` (when it was said) and, for 「次回」「来週」, the next class of the course
 * from the timetable and the academic calendar.
 */
export interface ResolvedDue {
  /** ISO instant (UTC). */
  dueAt: string;
  rule: 'iso_datetime' | 'iso_local' | 'iso_date' | ExtractedDeadline['rule'];
  /** The expression that was resolved. */
  phrase: string;
  /** No time of day was given; `defaultTime` (23:59) was assumed. */
  timeAssumed: boolean;
  confidence: number;
}

export interface ResolveDueOptions {
  reference: Date;
  timezone?: string;
  /** Start of the course's next class after `reference` (「次回まで」「来週まで」). */
  nextClassAt?: Date;
  defaultTime?: { hour: number; minute: number };
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const ISO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Resolve a due-date expression; undefined when nothing date-like is in it. */
export function resolveDueExpression(
  input: string,
  options: ResolveDueOptions,
): ResolvedDue | undefined {
  const tz = options.timezone ?? DEFAULT_TIMEZONE;
  const text = input.normalize('NFKC').trim();
  if (!text) return undefined;
  const def = options.defaultTime ?? { hour: 23, minute: 59 };

  if (ISO_INSTANT.test(text)) {
    const t = Date.parse(text);
    if (Number.isNaN(t)) return undefined;
    return {
      dueAt: new Date(t).toISOString(),
      rule: 'iso_datetime',
      phrase: input.trim(),
      timeAssumed: false,
      confidence: 1,
    };
  }
  const local = ISO_LOCAL.exec(text);
  if (local) {
    const [y, mo, d, h, mi] = local.slice(1, 6).map(Number) as [
      number,
      number,
      number,
      number,
      number,
    ];
    if (!validDate(y, mo, d) || h > 24 || mi > 59) return undefined;
    return {
      dueAt: zonedTime({ year: y, month: mo, day: d, hour: h, minute: mi }, tz).toISOString(),
      rule: 'iso_local',
      phrase: input.trim(),
      timeAssumed: false,
      confidence: 1,
    };
  }
  const date = ISO_DATE.exec(text);
  if (date) {
    const [y, mo, d] = date.slice(1, 4).map(Number) as [number, number, number];
    if (!validDate(y, mo, d)) return undefined;
    return {
      dueAt: zonedTime(
        { year: y, month: mo, day: d, hour: def.hour, minute: def.minute },
        tz,
      ).toISOString(),
      rule: 'iso_date',
      phrase: input.trim(),
      timeAssumed: true,
      confidence: 0.9,
    };
  }

  // Japanese expressions: the extractor wants a deadline marker (まで/締切/中), which a bare
  // 「来週の金曜」「次回」 lacks, so try the text as given and then with 「まで」.
  const extract = (t: string): ExtractedDeadline | undefined =>
    extractDeadlines(t, {
      reference: options.reference,
      timezone: tz,
      ...(options.nextClassAt ? { nextClassAt: options.nextClassAt } : {}),
      defaultTime: def,
    })[0];
  const found = extract(text) ?? extract(`${text}まで`);
  if (!found) return undefined;
  return {
    dueAt: found.dueAt,
    rule: found.rule,
    phrase: input.trim(),
    timeAssumed: found.timeAssumed,
    confidence: found.confidence,
  };
}
