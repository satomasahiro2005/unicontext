import { load } from 'cheerio';

/**
 * スケジュール (SC_18001B00_01) renders FullCalendar with an inline `events: [ … ]` literal (no XHR).
 * The literal is JavaScript, not JSON, so it is extracted by bracket matching and converted with a
 * small tokenizer (single quotes, unquoted keys, trailing commas, comments). Nothing is evaluated;
 * anything that is not a plain literal (function calls, identifiers) makes the parse fail safely.
 */

export interface CalendarEventRecord {
  title: string;
  start: string;
  end?: string;
  allDay?: boolean;
  /** LCU `listType`: Holiday / teachingevent / … */
  listType?: string;
  [key: string]: unknown;
}

/** Every array literal following `events:` in the given script text. */
export function findEventsLiterals(script: string): string[] {
  const out: string[] = [];
  const re = /\bevents\s*:\s*\[/g;
  for (let m = re.exec(script); m; m = re.exec(script)) {
    const start = m.index + m[0].length - 1;
    const end = matchBracket(script, start);
    if (end !== undefined) out.push(script.slice(start, end + 1));
  }
  return out;
}

/** Text of the <script> elements that mention `events` (HTML comments/markup are ignored). */
function scriptTexts(html: string): string[] {
  const $ = load(html);
  return $('script')
    .map((_, el) => $(el).text())
    .get()
    .filter((t) => t.includes('events'));
}

/** Source text of the first `events: [...]` literal inside a <script> element, if any. */
export function findEventsLiteral(html: string): string | undefined {
  return scriptTexts(html).flatMap(findEventsLiterals)[0];
}

function matchBracket(s: string, open: number): number | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '/' && s[i + 1] === '/') {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl;
    } else if (ch === '/' && s[i + 1] === '*') {
      const close = s.indexOf('*/', i + 2);
      i = close < 0 ? s.length : close + 1;
    } else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

/** Convert a JS object/array literal to JSON text; throws on anything that is not a literal. */
export function jsLiteralToJson(src: string): string {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  const isIdStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
  const isId = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
  while (i < n) {
    const ch = src[i] as string;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0) throw new SyntaxError('unterminated comment');
      i = close + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let value = '';
      for (; j < n && src[j] !== ch; j++) {
        const c = src[j] as string;
        if (c === '\\') {
          const next = src[j + 1] ?? '';
          j++;
          if (next === 'n') value += '\n';
          else if (next === 't') value += '\t';
          else if (next === 'r') value += '\r';
          else if (next === 'u') {
            value += String.fromCharCode(parseInt(src.slice(j + 1, j + 5), 16));
            j += 4;
          } else value += next;
        } else value += c;
      }
      if (j >= n) throw new SyntaxError('unterminated string');
      out.push(JSON.stringify(value));
      i = j + 1;
      continue;
    }
    if (/[-0-9.]/.test(ch)) {
      const m = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new SyntaxError(`bad number at ${i}`);
      out.push(String(Number(m[0])));
      i += m[0].length;
      continue;
    }
    if (isIdStart(ch)) {
      let j = i;
      while (j < n && isId(src[j] as string)) j++;
      const word = src.slice(i, j);
      let k = j;
      while (k < n && /\s/.test(src[k] as string)) k++;
      if (src[k] === ':') out.push(JSON.stringify(word));
      else if (word === 'true' || word === 'false' || word === 'null') out.push(word);
      else if (word === 'undefined') out.push('null');
      else throw new SyntaxError(`non-literal value "${word}"`);
      i = j;
      continue;
    }
    if (ch === ',') {
      // Drop trailing commas.
      let k = i + 1;
      while (k < n && /\s/.test(src[k] as string)) k++;
      if (src[k] === ']' || src[k] === '}') {
        i++;
        continue;
      }
      out.push(',');
      i++;
      continue;
    }
    if ('[]{}:'.includes(ch)) {
      out.push(ch);
      i++;
      continue;
    }
    throw new SyntaxError(`unexpected "${ch}" at ${i}`);
  }
  return out.join('');
}

export interface CalendarParseResult {
  events: CalendarEventRecord[];
  /** Set when an `events:` literal was found but could not be read as plain data. */
  error?: string;
}

export function parseCalendarEvents(html: string): CalendarParseResult {
  const literals = scriptTexts(html).flatMap(findEventsLiterals);
  if (literals.length === 0) return { events: [] };
  let data: unknown;
  let error: string | undefined;
  for (const literal of literals) {
    try {
      data = JSON.parse(jsLiteralToJson(literal));
      error = undefined;
      break;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  if (error !== undefined) return { events: [], error };
  if (!Array.isArray(data)) return { events: [], error: 'events is not an array' };
  const events: CalendarEventRecord[] = [];
  for (const ev of data) {
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) continue;
    const rec = ev as Record<string, unknown>;
    if (typeof rec.title !== 'string' || typeof rec.start !== 'string') continue;
    events.push(rec as CalendarEventRecord);
  }
  return { events };
}
