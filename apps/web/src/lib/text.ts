const JA = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff';
const AFTER_JA = new RegExp(`([${JA}])[ \\t\\u00a0]+([A-Za-z0-9])`, 'g');
const BEFORE_JA = new RegExp(`([A-Za-z0-9])[ \\t\\u00a0]+([${JA}])`, 'g');

/** Removes spaces between Japanese characters and ASCII letters/digits (UI copy rule). */
export function tightenJa(text: string): string {
  return text.replace(AFTER_JA, '$1$2').replace(BEFORE_JA, '$1$2');
}

/** `2限` etc.: period number to label; unknown periods get a neutral label. */
export function periodLabel(period: number | undefined): string {
  return period === undefined || !Number.isFinite(period) ? '時限未定' : `${period}限`;
}

/** Only absolute http(s) URLs may become links; everything else (javascript:, data:, ...) is dropped. */
export function safeHttpUrl(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  try {
    const u = new URL(trimmed);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}
