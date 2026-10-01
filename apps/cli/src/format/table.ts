/*
 * Terminal table rendering that is aware of East Asian width: wide characters (kanji, kana,
 * full-width forms) take two columns, combining marks and zero-width characters take none.
 * No external dependency (§ task: table renderer).
 */

export const ELLIPSIS = '…';

/** Wide and fullwidth ranges of East Asian Width (W and F), plus common emoji blocks. */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation (「」、。)
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul compat, CJK compat
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6],
  [0x1b000, 0x1b2ff], // Kana supplement / extended
  [0x1f200, 0x1f2ff],
  [0x1f300, 0x1f64f], // pictographs and emoticons
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd], // CJK extensions B..
];

function isZeroWidth(cp: number): boolean {
  return (
    cp === 0 ||
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritics
    (cp >= 0x200b && cp <= 0x200f) || // zero-width space/joiners, direction marks
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    cp === 0xfeff ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

/** Display columns of one code point: 0, 1 or 2. */
export function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0; // control characters
  if (isZeroWidth(cp)) return 0;
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return 2;
    if (cp < lo) break; // ranges are sorted
  }
  return 1;
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, '');
}

/** Number of terminal columns the string occupies (ANSI colour codes are ignored). */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/** Pad on the right with spaces up to `width` columns (never truncates). */
export function padEnd(s: string, width: number): string {
  const missing = width - displayWidth(s);
  return missing > 0 ? s + ' '.repeat(missing) : s;
}

/** Pad on the left with spaces up to `width` columns. */
export function padStart(s: string, width: number): string {
  const missing = width - displayWidth(s);
  return missing > 0 ? ' '.repeat(missing) + s : s;
}

/**
 * Cut the string so it fits in `width` columns; when something was cut the last column is the
 * ellipsis. A wide character is never split.
 */
export function truncate(s: string, width: number, ellipsis: string = ELLIPSIS): string {
  if (width <= 0) return '';
  if (displayWidth(s) <= width) return s;
  const room = width - displayWidth(ellipsis);
  if (room < 0) return '';
  let out = '';
  let used = 0;
  for (const ch of s) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (used + w > room) break;
    out += ch;
    used += w;
  }
  return out + ellipsis;
}

/**
 * Make source-derived text safe for a terminal: control characters (including ESC, so injected
 * ANSI sequences cannot reach the screen) and line breaks become single spaces.
 */
export function sanitizeText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
}

export interface TableColumn<Row> {
  header: string;
  /** Plain text of the cell. */
  value: (row: Row) => string;
  /** Maximum display width; longer values are truncated with an ellipsis. */
  max?: number;
  align?: 'left' | 'right';
  /** Applied after padding so colour codes never disturb the layout. */
  style?: (padded: string, row: Row) => string;
}

export interface TableOptions {
  /** Colour/emphasis for the header row. */
  headerStyle?: (s: string) => string;
  /** Text printed between columns. */
  gap?: string;
  /** Prefix for every line (indent). */
  indent?: string;
}

/** Render rows as an aligned text table with a header and a rule. Returns the lines. */
export function renderTable<Row>(
  columns: readonly TableColumn<Row>[],
  rows: readonly Row[],
  options: TableOptions = {},
): string[] {
  const gap = options.gap ?? '  ';
  const indent = options.indent ?? '';
  const headerStyle = options.headerStyle ?? ((s: string) => s);
  const cells = rows.map((row) =>
    columns.map((c) => {
      const text = sanitizeText(c.value(row));
      return c.max ? truncate(text, c.max) : text;
    }),
  );
  const widths = columns.map((c, i) =>
    Math.max(displayWidth(c.header), ...cells.map((r) => displayWidth(r[i] ?? ''))),
  );
  const fit = (text: string, i: number, align: 'left' | 'right' | undefined): string =>
    align === 'right' ? padStart(text, widths[i] ?? 0) : padEnd(text, widths[i] ?? 0);
  const lines: string[] = [];
  lines.push(
    indent +
      headerStyle(
        columns
          .map((c, i) => fit(c.header, i, c.align))
          .join(gap)
          .trimEnd(),
      ),
  );
  lines.push(indent + widths.map((w) => '-'.repeat(w)).join(gap));
  rows.forEach((row, r) => {
    const parts = columns.map((c, i) => {
      const padded = fit(cells[r]?.[i] ?? '', i, c.align);
      return c.style ? c.style(padded, row) : padded;
    });
    lines.push(indent + parts.join(gap).trimEnd());
  });
  return lines;
}
