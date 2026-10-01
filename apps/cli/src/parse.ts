import type { JsonValue } from '@unicontext/canonical-model';
import { addZonedDays, parseDuration, startOfZonedDay } from '@unicontext/core';
import { UsageError } from './errors.js';

/**
 * `--since` value: an ISO timestamp, a relative duration (`30m`, `2h`, `1d`, `1w`) or the words
 * `today` / `yesterday` (start of that local day). Returns an ISO instant.
 */
export function parseSince(input: string, now: Date, timezone: string): string {
  const text = input.trim();
  const lower = text.toLowerCase();
  if (lower === 'yesterday' || text === '昨日')
    return startOfZonedDay(addZonedDays(now, -1, timezone), timezone).toISOString();
  if (lower === 'today' || text === '今日') return startOfZonedDay(now, timezone).toISOString();
  const week = /^(\d+(?:\.\d+)?)w$/i.exec(text);
  if (week) return new Date(now.getTime() - Number(week[1]) * 7 * 86_400_000).toISOString();
  if (/^\d+(?:\.\d+)?\s*(ms|s|m|h|d)$/i.test(text)) {
    return new Date(now.getTime() - parseDuration(text.toLowerCase())).toISOString();
  }
  const date = new Date(text);
  if (!text || Number.isNaN(date.getTime()))
    throw new UsageError(
      `--sinceの値「${input}」を解釈できません`,
      '例: --since 2026-10-01T09:00:00+09:00 / --since 1d / --since 2h / --since yesterday',
    );
  return date.toISOString();
}

export function parsePositiveInt(value: string, name: string, max?: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || (max !== undefined && n > max))
    throw new UsageError(
      `${name}には1${max !== undefined ? `から${max}` : '以上'}の整数を指定してください（指定値: ${value}）`,
    );
  return n;
}

/** `correct` value: JSON when it parses (numbers, booleans, quoted strings, objects), else text. */
export function parseValue(text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}
