import { parseExternalTermLabel } from '@unicontext/core';

/**
 * Text normalization for matching course titles across systems (§14), e.g.
 * LCU「データベースシステム論」/ Teams「2026 DB Systems」/ EdStem「DBSys」→ "dbsys".
 * Deterministic and dictionary based; no LLM.
 */

/** NFKC (full/half width), lowercase, collapse whitespace. */
export function normalizeText(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

const TERM_WORDS =
  /(前学期|後学期|前期|後期|春学期|秋学期|夏学期|冬学期|通年|集中|第[1-4一二三四]クォーター|[1-4]q|spring|summer|fall|autumn|winter|semester|term)/g;
const SCHEDULE_HINT =
  /(\d{4}|年度|前期|後期|学期|クォーター|[月火水木金土日]曜?\s*\d|\d\s*限|spring|fall|autumn|q\d)/;

/** Glossary applied after NFKC+lowercase. Japanese terms match anywhere, English on word boundaries. */
export const DEFAULT_GLOSSARY: [RegExp, string][] = [
  [/データベース/g, 'db'],
  [/\bdatabases?\b/g, 'db'],
  [/システム/g, 'sys'],
  [/\bsystems?\b/g, 'sys'],
  [/プログラミング/g, 'prog'],
  [/\bprogramming\b/g, 'prog'],
  [/ネットワーク/g, 'net'],
  [/\bnetworks?\b/g, 'net'],
  [/アルゴリズム/g, 'algo'],
  [/\balgorithms?\b/g, 'algo'],
  [/データ構造/g, 'ds'],
  [/\bdata structures?\b/g, 'ds'],
  [/オペレーティング\s?システム|\boperating sys\b/g, 'os'],
  [/人工知能|\bartificial intelligence\b/g, 'ai'],
  [/機械学習|\bmachine learning\b/g, 'ml'],
  [/情報/g, 'info'],
  [/\binformation\b/g, 'info'],
  [/演習/g, 'ex'],
  [/\bexercises?\b|\bpractice\b/g, 'ex'],
  [/入門/g, 'intro'],
  [/\bintroduction to\b|\bintroduction\b|\bintro to\b/g, 'intro'],
  [/基礎/g, 'basic'],
  [/\bfundamentals? of\b|\bfundamentals?\b|\bbasics?\b/g, 'basic'],
  [/特論/g, 'adv'],
  [/\badvanced\b/g, 'adv'],
  [/\btheory of\b|\btheory\b/g, ''],
  [/\b(and|of|the|for|in)\b|&/g, ''],
];

/** Drop bracketed parts that only carry year/term/timetable info, keep other bracket contents. */
function stripBrackets(s: string): string {
  return s.replace(/[[【(（〔「『]([^\]】)）〕」』]*)[\]】)）〕」』]/g, (_m, inner: string) =>
    SCHEDULE_HINT.test(inner) ? ' ' : ` ${inner} `,
  );
}

export interface TitleNormalizeOptions {
  glossary?: [RegExp, string][];
}

/** Canonical comparison key for a course title. */
export function normalizeCourseTitle(title: string, options: TitleNormalizeOptions = {}): string {
  let s = normalizeText(title);
  s = stripBrackets(s);
  s = s.replace(/(^|\s)(20\d{2}|19\d{2})\s*(年度|年|ay|fy)?(?=\s|$|[^\d])/g, ' ');
  s = s.replace(/\b(ay|fy)\s*20\d{2}\b/g, ' ');
  s = s.replace(TERM_WORDS, ' ');
  s = s.replace(/[月火水木金土日]曜?\s*\d\s*限?/g, ' ');
  for (const [re, rep] of options.glossary ?? DEFAULT_GLOSSARY) s = s.replace(re, rep);
  s = s.replace(/(論|学)$/u, '').replace(/(論|学)\s/gu, ' ');
  s = s.replace(/[\s\p{P}\p{S}]+/gu, '');
  return s;
}

/** First 4-digit academic year in a title ("2026 DB Systems" → 2026). */
export function extractYear(title: string): number | undefined {
  const m = /(?:^|[^\d])(20\d{2})(?:[^\d]|$)/.exec(normalizeText(title));
  return m ? Number(m[1]) : undefined;
}

/**
 * Term marker in a title or term field, normalized to "first" | "second" | "full-year" |
 * "intensive", or the compacted label when it is none of those (see isKnownTerm).
 */
export function normalizeTerm(term: string | undefined): string | undefined {
  if (!term) return undefined;
  const t = normalizeText(term);
  // "Semester 2", "S1", "2nd semester", 第2学期 (an LMS / Ed session) = the n-th half of the year
  const external = parseExternalTermLabel(t);
  if (external?.kind === 'ordinal' && external.n <= 2) return external.n === 1 ? 'first' : 'second';
  if (/前期|前学期|春|spring|第1|1q|2q/.test(t)) return 'first';
  if (/後期|後学期|秋|fall|autumn|第2|3q|4q/.test(t)) return 'second';
  if (/通年|full/.test(t)) return 'full-year';
  if (/集中|intensive/.test(t)) return 'intensive';
  return t.replace(/\s/g, '');
}

const KNOWN_TERMS = new Set(['first', 'second', 'full-year', 'intensive']);

/**
 * A normalized term that names a real term. Free-text session names (Ed's placeholder "X") are
 * unknown: they neither veto nor support a match.
 */
export function isKnownTerm(normalized: string | undefined): normalized is string {
  return normalized !== undefined && KNOWN_TERMS.has(normalized);
}

function bigrams(s: string): string[] {
  const chars = [...s];
  if (chars.length < 2) return chars.length ? [chars[0] as string] : [];
  const out: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) out.push(`${chars[i]}${chars[i + 1]}`);
  return out;
}

/** Dice coefficient on character bigrams of normalized titles, with containment boost. 0..1. */
export function titleSimilarity(a: string, b: string, options: TitleNormalizeOptions = {}): number {
  const x = normalizeCourseTitle(a, options);
  const y = normalizeCourseTitle(b, options);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 4 && long.includes(short)) return 0.9;
  const ba = bigrams(x);
  const bb = bigrams(y);
  const counts = new Map<string, number>();
  for (const g of bb) counts.set(g, (counts.get(g) ?? 0) + 1);
  let overlap = 0;
  for (const g of ba) {
    const c = counts.get(g) ?? 0;
    if (c > 0) {
      overlap++;
      counts.set(g, c - 1);
    }
  }
  return (2 * overlap) / (ba.length + bb.length);
}

const HONORIFICS =
  /(先生|教授|准教授|助教|講師|特任|名誉|客員|博士|氏|様|さん|prof\.?|professor|dr\.?|lecturer)/g;

export function normalizePersonName(name: string): string {
  return normalizeText(name)
    .replace(HONORIFICS, '')
    .replace(/[\s\p{P}]+/gu, '');
}

/** Same person if normalized names match or one is a prefix (surname only). */
export function personNamesMatch(a: string, b: string): boolean {
  const x = normalizePersonName(a);
  const y = normalizePersonName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return s.length >= 2 && l.startsWith(s);
}

export function normalizeCourseCode(code: string): string {
  return normalizeText(code).replace(/[\s\-_.]/g, '');
}
