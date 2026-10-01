import { DEFAULT_TIMEZONE, formatShort, isIsoDateTime, isPlainDate } from './dates.js';
import type { JsonValue } from './json.js';
import { truncate } from './text.js';

const NONE = 'なし';

/** Human text for a fact/change value: instants as `10/8 23:59`, dates as `10/8`, lists joined. */
export function formatValue(
  value: JsonValue | undefined,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  if (value === undefined || value === null) return NONE;
  if (typeof value === 'string') {
    if (value === '') return NONE;
    if (isIsoDateTime(value) || isPlainDate(value)) {
      const formatted = formatShort(value, timeZone);
      if (formatted) return formatted;
    }
    return truncate(value, 80);
  }
  if (typeof value === 'boolean') return value ? 'はい' : 'いいえ';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return value.length === 0 ? NONE : value.map((v) => formatValue(v, timeZone)).join('、');
  }
  return truncate(JSON.stringify(value), 120);
}

/** True when a candidate list holds instants (so a datetime input is the right editor). */
export function looksLikeInstants(values: readonly (JsonValue | undefined)[]): boolean {
  const present = values.filter((v): v is JsonValue => v !== undefined && v !== null);
  return present.length > 0 && present.every((v) => typeof v === 'string' && isIsoDateTime(v));
}

/**
 * Turns what the user typed into the JSON value to store. Text stays text, except when the
 * existing candidates are numbers/booleans (then a matching literal keeps that type), or when
 * the input is explicitly a JSON object/array/quoted string.
 */
export function parseCorrectionValue(
  text: string,
  hints: readonly JsonValue[] = [],
): JsonValue | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  if (/^[[{"]/.test(trimmed)) {
    try {
      return JSON.parse(trimmed) as JsonValue;
    } catch {
      return trimmed;
    }
  }
  const sample = hints.find((h) => h !== null && h !== undefined);
  if (typeof sample === 'number' && /^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (typeof sample === 'boolean' && (trimmed === 'true' || trimmed === 'false')) {
    return trimmed === 'true';
  }
  return trimmed;
}
