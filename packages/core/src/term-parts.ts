/**
 * Half-terms (前半 / 後半). Japanese universities such as Shizuoka split each semester (前期 / 後期)
 * into two halves of about 8 class weeks; a course meets in one half or in both. The academic
 * system writes the half together with the term: 「後期前半」, 「前期前半/金5・6」, and syllabi
 * state the span: 「後期前半 ～ 後期後半」. Pure text helpers, no I/O.
 */

export const TERM_HALVES = ['前半', '後半'] as const;
export type TermHalf = (typeof TERM_HALVES)[number];

function nfkc(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, '');
}

/** Sorted, distinct halves (前半 before 後半). */
export function normalizeHalves(halves: Iterable<TermHalf>): TermHalf[] {
  const set = new Set(halves);
  return TERM_HALVES.filter((h) => set.has(h));
}

/** 「後期前半」 → { term: 後期, half: 前半 }; 「前半」 → { half: 前半 }; anything else → undefined. */
export function parseTermPartLabel(
  text: string | undefined,
): { term?: string; half: TermHalf } | undefined {
  if (!text) return undefined;
  const m = /^(.*?)(前半|後半)$/.exec(nfkc(text));
  if (!m) return undefined;
  const term = m[1]?.replace(/学期$/, '期');
  return { ...(term ? { term } : {}), half: m[2] as TermHalf };
}

/**
 * Halves a span covers: 「後期前半 ～ 後期後半」 → [前半, 後半], 「後期後半」 → [後半],
 * 「前期前半、前期後半」 → [前半, 後半]. A span without a half (「前期」, 「通年」) → undefined: the
 * text does not say, and callers treat it as the whole term.
 */
export function parseTermSpan(text: string | undefined): TermHalf[] | undefined {
  if (!text) return undefined;
  const parts = nfkc(text)
    .split(/[～〜~\-－,、，/]/)
    .map((p) => parseTermPartLabel(p)?.half)
    .filter((h): h is TermHalf => h !== undefined);
  if (parts.length === 0) return undefined;
  // A range 「前半～後半」 covers both ends (and anything between them).
  return normalizeHalves(parts);
}

/** True when the halves cover the whole term (both halves). */
export function isWholeTerm(halves: readonly TermHalf[] | undefined): boolean {
  return !halves || halves.length === 0 || TERM_HALVES.every((h) => halves.includes(h));
}

/**
 * Display label: (後期, [後半]) → 「後期後半」; (後期, [前半, 後半]) → 「後期（前半・後半）」;
 * no term → 「後半」 / 「前半・後半」; no halves → undefined (unknown).
 */
export function termPartLabel(
  term: string | undefined,
  halves: readonly TermHalf[] | undefined,
): string | undefined {
  if (!halves || halves.length === 0) return undefined;
  const t = term ? term.normalize('NFKC').trim() : '';
  const hs = normalizeHalves(halves);
  if (hs.length === 1) return `${t}${hs[0]}`;
  return t ? `${t}（前半・後半）` : '前半・後半';
}
