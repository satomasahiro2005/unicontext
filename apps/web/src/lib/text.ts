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

export type TextSegment =
  { type: 'text'; text: string } | { type: 'link'; text: string; href: string };

const URL_PATTERN = /https?:\/\/[^\s\u0080-\uffff<>"'`]+/g;

/** Trailing sentence punctuation (and an unmatched closing bracket) is not part of the URL. */
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url.at(-1);
    if (last === undefined) return url;
    const unmatched =
      (last === ')' && !url.includes('(')) ||
      (last === ']' && !url.includes('[')) ||
      (last === '}' && !url.includes('{'));
    if (/[.,;:!?]/.test(last) || unmatched) url = url.slice(0, -1);
    else return url;
  }
}

/**
 * Splits plain text into text and http(s) link segments so it can be rendered without
 * dangerouslySetInnerHTML. Anything that is not a safe http(s) URL stays text.
 */
export function linkifyText(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  let last = 0;
  const push = (segment: TextSegment): void => {
    const prev = out.at(-1);
    if (segment.type === 'text' && prev?.type === 'text') prev.text += segment.text;
    else if (segment.text !== '') out.push(segment);
  };
  for (const m of text.matchAll(URL_PATTERN)) {
    const start = m.index;
    const url = trimUrl(m[0]);
    const href = safeHttpUrl(url);
    push({ type: 'text', text: text.slice(last, start) });
    if (href) push({ type: 'link', text: url, href });
    else push({ type: 'text', text: url });
    last = start + url.length;
  }
  push({ type: 'text', text: text.slice(last) });
  return out;
}

/** 1536 -> 1.5KB (no space before the unit, per the UI copy rule). */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)}KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)}MB`;
}
