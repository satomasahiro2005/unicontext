import { ConfigError } from './errors.js';

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse "15m", "1h", "1d", "30s", "500ms" or a number of milliseconds. */
export function parseDuration(input: string | number): number {
  if (typeof input === 'number') return input;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/.exec(input);
  if (!m) throw new ConfigError(`Invalid duration: ${input}`);
  return Math.round(Number(m[1]) * (UNITS[m[2] ?? 'ms'] ?? 1));
}
