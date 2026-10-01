import { parseDateTimeText, parseTimestampMs } from './time.js';

export interface TranscriptSegment {
  startMs: number;
  endMs?: number;
  speaker?: string;
  text: string;
}

export interface ParsedTranscript {
  title?: string;
  /** ISO instant, only when the content itself says when it was recorded. */
  recordedAt?: string;
  /** From a `[course: ...]` / `授業: ...` header. */
  courseHint?: string;
  language?: string;
  segments: TranscriptSegment[];
  /** False when the source had no timestamps (every segment then has startMs 0). */
  hasTimestamps: boolean;
}

export interface ParseOptions {
  /** IANA zone used for dates without an offset. */
  timezone: string;
}

export interface TranscriptFormat {
  id: string;
  extensions: readonly string[];
  /** Importer id recorded on the LectureTranscript (default: the connector's importer). */
  importer?: string;
  parse(content: string, options: ParseOptions): ParsedTranscript;
}

// ------------------------------------------------------------------ shared helpers

const CJK = /[\u3000-鿿＀-￯]/;

/** Join two text pieces: no space between CJK characters, one space otherwise. */
export function joinText(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const last = a.slice(-1);
  const first = b.charAt(0);
  return CJK.test(last) || CJK.test(first) ? `${a}${b}` : `${a} ${b}`;
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const HEADER_KEYS: Record<string, 'courseHint' | 'title' | 'recordedAt' | 'language'> = {
  course: 'courseHint',
  授業: 'courseHint',
  授業名: 'courseHint',
  科目: 'courseHint',
  科目名: 'courseHint',
  講義: 'courseHint',
  講義名: 'courseHint',
  title: 'title',
  タイトル: 'title',
  題名: 'title',
  件名: 'title',
  date: 'recordedAt',
  日付: 'recordedAt',
  日時: 'recordedAt',
  recorded: 'recordedAt',
  recordedat: 'recordedAt',
  録音日時: 'recordedAt',
  録画日時: 'recordedAt',
  language: 'language',
  lang: 'language',
  言語: 'language',
};

const HEADER_RE = /^\[?\s*([A-Za-z぀-ヿ一-鿿_ ]{1,12}?)\s*[:：=]\s*(.+?)\s*\]?\s*$/;

interface HeaderMeta {
  title?: string;
  recordedAt?: string;
  courseHint?: string;
  language?: string;
}

/** Try to read a header/metadata line; returns true when it was one. */
function readHeader(line: string, meta: HeaderMeta, timezone: string): boolean {
  const m = HEADER_RE.exec(line.trim());
  if (!m) return false;
  const key = HEADER_KEYS[(m[1] as string).toLowerCase().replace(/\s+/g, '')];
  if (!key) return false;
  const value = clean(m[2] as string);
  if (!value) return false;
  if (key === 'recordedAt') {
    const iso = parseDateTimeText(value, timezone);
    if (iso) meta.recordedAt ??= iso;
    return true;
  }
  meta[key] ??= value;
  return true;
}

// ------------------------------------------------------------------ txt / md

const TS = String.raw`(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)`;
/** Speaker labels: known roles, "Speaker 1", latin names, or Japanese names with a title. */
const LABEL = String.raw`((?:Speaker|SPEAKER|話者|発言者|参加者|ゲスト|Guest|Host|Instructor|Teacher|Student|Professor|講師|先生|教員|教授|学生|受講者|質問者|司会|ホスト|[A-Za-z][A-Za-z.'-]*(?: [A-Za-z][A-Za-z.'-]*){0,2}|[぀-ヿ一-鿿]{1,6}(?:先生|さん|教授|君|氏))[ \t]*[0-9０-９]*)`;

const RE_BRACKET_TS = new RegExp(String.raw`^\[${TS}\]\s*(?:${LABEL}\s*[:：]\s*)?(.*)$`);
const RE_BARE_TS = new RegExp(String.raw`^${TS}\s*(?:[-–—]\s*|\s+)(?:${LABEL}\s*[:：]\s*)?(.+)$`);
const RE_LABEL_TS_PAREN = new RegExp(String.raw`^${LABEL}\s*[(（]${TS}[)）]\s*[:：]?\s*(.*)$`);
const RE_LABEL_TS_LINE = new RegExp(String.raw`^${LABEL}\s+${TS}\s*$`);
const RE_LABEL_ONLY = new RegExp(String.raw`^${LABEL}\s*[:：]\s*(.+)$`);

interface RawEntry {
  ts?: number;
  speaker?: string;
  text: string;
  continuation?: boolean;
}

function matchLine(
  line: string,
): RawEntry | { header: { ts: number; speaker: string } } | undefined {
  let m = RE_BRACKET_TS.exec(line);
  if (m) {
    const ts = parseTimestampMs(m[1] as string);
    if (ts !== undefined)
      return { ts, ...(m[2] ? { speaker: clean(m[2]) } : {}), text: clean(m[3] ?? '') };
  }
  m = RE_LABEL_TS_PAREN.exec(line);
  if (m) {
    const ts = parseTimestampMs(m[2] as string);
    if (ts !== undefined) return { ts, speaker: clean(m[1] as string), text: clean(m[3] ?? '') };
  }
  m = RE_LABEL_TS_LINE.exec(line);
  if (m) {
    const ts = parseTimestampMs(m[2] as string);
    if (ts !== undefined) return { header: { ts, speaker: clean(m[1] as string) } };
  }
  m = RE_BARE_TS.exec(line);
  if (m) {
    const ts = parseTimestampMs(m[1] as string);
    if (ts !== undefined)
      return { ts, ...(m[2] ? { speaker: clean(m[2]) } : {}), text: clean(m[3] ?? '') };
  }
  m = RE_LABEL_ONLY.exec(line);
  if (m) return { speaker: clean(m[1] as string), text: clean(m[2] as string) };
  return undefined;
}

function frontMatter(lines: string[], meta: HeaderMeta, timezone: string): string[] {
  if (lines[0]?.trim() !== '---') return lines;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return lines;
  for (const l of lines.slice(1, end)) readHeader(l, meta, timezone);
  return lines.slice(end + 1);
}

function parseTextLines(
  content: string,
  options: ParseOptions,
  markdown: boolean,
): ParsedTranscript {
  const meta: HeaderMeta = {};
  let lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (markdown) lines = frontMatter(lines, meta, options.timezone);
  const entries: RawEntry[] = [];
  let contentSeen = false;
  let pending: { ts: number; speaker: string; parts: string[] } | undefined;

  const flushPending = (): void => {
    if (pending) {
      entries.push({
        ts: pending.ts,
        speaker: pending.speaker,
        text: clean(pending.parts.reduce((acc, p) => joinText(acc, p), '')),
      });
      pending = undefined;
    }
  };

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (markdown) {
      const h = /^#{1,6}\s+(.*?)\s*#*$/.exec(line);
      if (h) {
        flushPending();
        meta.title ??= clean(h[1] as string);
        continue;
      }
      line = line.replace(/^>\s?/, '');
    }
    line = line
      .replace(/^[-*+]\s+/, '')
      .replace(/\*\*|__/g, '')
      .trim();
    if (!line) {
      flushPending();
      continue;
    }
    if (pending) {
      pending.parts.push(line);
      continue;
    }
    if (!contentSeen && readHeader(line, meta, options.timezone)) continue;
    const hit = matchLine(line);
    if (hit && 'header' in hit) {
      contentSeen = true;
      pending = { ts: hit.header.ts, speaker: hit.header.speaker, parts: [] };
      continue;
    }
    contentSeen = true;
    if (hit) entries.push(hit);
    else entries.push({ text: clean(line), continuation: true });
  }
  flushPending();

  const hasTimestamps = entries.some((e) => e.ts !== undefined);
  const segments: TranscriptSegment[] = [];
  for (const e of entries) {
    const prev = segments[segments.length - 1];
    if (hasTimestamps && e.continuation && prev) {
      prev.text = joinText(prev.text, e.text);
      continue;
    }
    if (!e.text) continue;
    segments.push({
      startMs: e.ts ?? prev?.startMs ?? 0,
      ...(e.speaker ? { speaker: e.speaker } : {}),
      text: e.text,
    });
  }
  return { ...meta, segments, hasTimestamps };
}

export const txtFormat: TranscriptFormat = {
  id: 'txt',
  extensions: ['txt', 'text'],
  parse: (content, options) => parseTextLines(content, options, false),
};

export const mdFormat: TranscriptFormat = {
  id: 'md',
  extensions: ['md', 'markdown'],
  parse: (content, options) => parseTextLines(content, options, true),
};

// ------------------------------------------------------------------ WebVTT / SRT

const CUE_RE =
  /^((?:\d{1,3}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d{1,3}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)(?:\s.*)?$/;

interface Cue {
  startMs: number;
  endMs: number;
  lines: string[];
}

function readCues(content: string): { cues: Cue[]; headerLines: string[] } {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const cues: Cue[] = [];
  const headerLines: string[] = [];
  let current: Cue | undefined;
  let seenCue = false;
  let inNote = false;
  for (const raw of lines) {
    const line = raw.trim();
    const m = CUE_RE.exec(line);
    if (m) {
      const startMs = parseTimestampMs(m[1] as string);
      const endMs = parseTimestampMs(m[2] as string);
      if (startMs !== undefined && endMs !== undefined) {
        current = { startMs, endMs, lines: [] };
        cues.push(current);
        seenCue = true;
        inNote = false;
        continue;
      }
    }
    if (!line) {
      current = undefined;
      inNote = false;
      continue;
    }
    if (!seenCue) {
      headerLines.push(line);
      continue;
    }
    if (/^(NOTE|STYLE|REGION)\b/.test(line) && !current) {
      inNote = true;
      continue;
    }
    if (inNote) continue;
    if (current) current.lines.push(line);
    // else: a cue identifier line (number or id) before the timing line - ignored
  }
  return { cues, headerLines };
}

function stripCueMarkup(text: string): { text: string; speaker?: string } {
  let speaker: string | undefined;
  const v = /<v(?:\.[^\s>]+)*\s+([^>]+)>/.exec(text);
  if (v) speaker = clean(v[1] as string);
  const stripped = text
    .replace(/<v(?:\.[^\s>]+)*\s+[^>]*>/g, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/<\d{1,2}:\d{2}[:.\d]*>/g, '')
    .replace(/\{\\an?\d\}/g, '');
  return { text: clean(stripped), ...(speaker ? { speaker } : {}) };
}

/** Zoom-style "Name: text" cues: when most cues have a short name prefix, split it off. */
function inferSpeakerPrefix(segments: TranscriptSegment[]): void {
  const withoutSpeaker = segments.filter((s) => !s.speaker);
  if (withoutSpeaker.length < 3) return;
  const re = /^([^\s:：][^:：]{0,28}?)\s*[:：]\s+(.+)$/;
  const hits = withoutSpeaker.filter((s) => {
    const m = re.exec(s.text);
    return m !== null && !/\d{1,2}:\d{2}/.test(m[1] as string) && !/^https?$/i.test(m[1] as string);
  });
  if (hits.length < withoutSpeaker.length * 0.7) return;
  for (const s of hits) {
    const m = re.exec(s.text);
    if (!m) continue;
    s.speaker = clean(m[1] as string);
    s.text = clean(m[2] as string);
  }
}

function cuesToTranscript(
  cues: Cue[],
  headerLines: string[],
  options: ParseOptions,
  inferSpeakers: boolean,
): ParsedTranscript {
  const meta: HeaderMeta = {};
  for (const h of headerLines) {
    const m = /^language\s*[:：]\s*(\S+)/i.exec(h);
    if (m) meta.language = m[1] as string;
    else readHeader(h, meta, options.timezone);
  }
  const segments: TranscriptSegment[] = [];
  for (const cue of [...cues].sort((a, b) => a.startMs - b.startMs)) {
    const pieces = cue.lines.map(stripCueMarkup);
    const speaker = pieces.find((p) => p.speaker)?.speaker;
    const text = clean(pieces.map((p) => p.text).reduce((acc, p) => joinText(acc, p), ''));
    if (!text) continue;
    segments.push({
      startMs: cue.startMs,
      endMs: cue.endMs,
      ...(speaker ? { speaker } : {}),
      text,
    });
  }
  if (inferSpeakers) inferSpeakerPrefix(segments);
  return { ...meta, segments, hasTimestamps: true };
}

export const vttFormat: TranscriptFormat = {
  id: 'vtt',
  extensions: ['vtt'],
  parse(content, options) {
    const { cues, headerLines } = readCues(content.replace(/^\uFEFF/, ''));
    // The first header line is "WEBVTT [title]"; metadata lines such as "Language: ja" follow.
    const first = headerLines[0]?.replace(/^WEBVTT\s*[-:]?\s*/i, '').trim();
    const parsed = cuesToTranscript(cues, headerLines.slice(1), options, true);
    if (first && !parsed.title) parsed.title = first;
    return parsed;
  },
};

export const srtFormat: TranscriptFormat = {
  id: 'srt',
  extensions: ['srt'],
  parse(content, options) {
    const { cues } = readCues(content.replace(/^\uFEFF/, ''));
    // SRT cue lines may start with a dash ("- text"); the index lines are skipped by readCues.
    for (const c of cues) c.lines = c.lines.map((l) => l.replace(/^-\s+/, ''));
    return cuesToTranscript(cues, [], options, false);
  },
};

// ------------------------------------------------------------------ JSON

type Json = unknown;
const isObject = (v: Json): v is Record<string, Json> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const ARRAY_KEYS = [
  'segments',
  'transcript',
  'utterances',
  'results',
  'items',
  'captions',
  'entries',
  'cues',
  'lines',
  'sentences',
  'paragraphs',
  'monologues',
  'data',
];
const TEXT_KEYS = [
  'text',
  'content',
  'transcript',
  'body',
  'caption',
  'sentence',
  'utterance',
  'message',
  'value',
];
const SPEAKER_KEYS = [
  'speaker',
  'speaker_name',
  'speakerName',
  'speaker_label',
  'spk',
  'name',
  'role',
  'user',
  'author',
];
const START_MS_KEYS = ['startMs', 'start_ms', 'start_time_ms', 'startTimeMs'];
const START_KEYS = [
  'start',
  'start_time',
  'startTime',
  'begin',
  'offset',
  'from',
  'timestamp',
  'time',
  'ts',
];
const END_MS_KEYS = ['endMs', 'end_ms', 'end_time_ms', 'endTimeMs'];
const END_KEYS = ['end', 'end_time', 'endTime', 'stop', 'to'];

function looksLikeSegmentArray(v: Json): v is Json[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => typeof x === 'string' || (isObject(x) && textOf(x) !== undefined))
  );
}

function findSegmentArray(root: Json, depth = 0): Json[] | undefined {
  if (looksLikeSegmentArray(root)) return root;
  if (!isObject(root) || depth > 3) return undefined;
  for (const key of ARRAY_KEYS) {
    const v = root[key];
    const found = looksLikeSegmentArray(v)
      ? v
      : isObject(v)
        ? findSegmentArray(v, depth + 1)
        : undefined;
    if (found) return found;
  }
  for (const v of Object.values(root)) {
    const found = looksLikeSegmentArray(v)
      ? v
      : isObject(v)
        ? findSegmentArray(v, depth + 1)
        : undefined;
    if (found) return found;
  }
  return undefined;
}

function textOf(o: Record<string, Json>): string | undefined {
  for (const k of TEXT_KEYS) {
    const v = o[k];
    if (typeof v === 'string' && clean(v)) return clean(v);
  }
  const words = o.words;
  if (Array.isArray(words)) {
    const parts = words
      .map((w) => (typeof w === 'string' ? w : isObject(w) ? (w.word ?? w.text) : undefined))
      .filter((w): w is string => typeof w === 'string');
    if (parts.length > 0) return clean(parts.reduce((acc, p) => joinText(acc, p.trim()), ''));
  }
  return undefined;
}

interface RawTime {
  /** Exact milliseconds when the key said so or the value was a "hh:mm:ss" string. */
  ms?: number;
  /** A bare number whose unit (seconds or ms) is decided per document. */
  auto?: number;
}

function readTime(o: Record<string, Json>, msKeys: string[], keys: string[]): RawTime {
  for (const k of msKeys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return { ms: Math.round(v) };
  }
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return { auto: v };
    if (typeof v === 'string') {
      const ts = parseTimestampMs(v);
      if (ts !== undefined) return { ms: ts };
      if (/^\d+(?:\.\d+)?$/.test(v.trim())) return { auto: Number(v) };
    }
  }
  return {};
}

function readMeta(root: Json, timezone: string): HeaderMeta {
  const meta: HeaderMeta = {};
  if (!isObject(root)) return meta;
  const sources = [root, isObject(root.metadata) ? root.metadata : undefined].filter(
    (x): x is Record<string, Json> => x !== undefined,
  );
  const pick = (keys: string[]): string | undefined => {
    for (const s of sources)
      for (const k of keys) {
        const v = s[k];
        if (typeof v === 'string' && clean(v)) return clean(v);
      }
    return undefined;
  };
  const title = pick(['title', 'name', 'topic']);
  if (title) meta.title = title;
  const language = pick(['language', 'lang', 'locale']);
  if (language) meta.language = language;
  const course = pick(['course', 'courseName', 'course_name', 'courseHint', 'lecture']);
  if (course) meta.courseHint = course;
  const when = pick([
    'recordedAt',
    'recorded_at',
    'date',
    'created_at',
    'createdAt',
    'started_at',
    'startedAt',
  ]);
  const iso = when ? parseDateTimeText(when, timezone) : undefined;
  if (iso) meta.recordedAt = iso;
  return meta;
}

export const jsonFormat: TranscriptFormat = {
  id: 'json',
  extensions: ['json'],
  parse(content, options) {
    const root = JSON.parse(content.replace(/^\uFEFF/, '')) as Json;
    const meta = readMeta(root, options.timezone);
    const arr = findSegmentArray(root);
    if (!arr) {
      const text = isObject(root) ? textOf(root) : undefined;
      return {
        ...meta,
        segments: text ? [{ startMs: 0, text }] : [],
        hasTimestamps: false,
      };
    }
    interface Item {
      text: string;
      speaker?: string;
      start: RawTime;
      end: RawTime;
      duration: RawTime;
    }
    const items: Item[] = [];
    for (const el of arr) {
      if (typeof el === 'string') {
        if (clean(el)) items.push({ text: clean(el), start: {}, end: {}, duration: {} });
        continue;
      }
      if (!isObject(el)) continue;
      const text = textOf(el);
      if (!text) continue;
      let speaker: string | undefined;
      for (const k of SPEAKER_KEYS) {
        const v = el[k];
        if (typeof v === 'string' && clean(v)) {
          speaker = clean(v);
          break;
        }
        if (typeof v === 'number') {
          speaker = `Speaker ${v}`;
          break;
        }
      }
      items.push({
        text,
        ...(speaker ? { speaker } : {}),
        start: readTime(el, START_MS_KEYS, START_KEYS),
        end: readTime(el, END_MS_KEYS, END_KEYS),
        duration: readTime(el, ['durationMs', 'duration_ms'], ['duration', 'dur']),
      });
    }
    // Bare numbers are seconds (Whisper) unless they only make sense as milliseconds.
    const autos = items
      .flatMap((i) => [i.start.auto, i.end.auto])
      .filter((x): x is number => x !== undefined);
    const autoIsMs =
      autos.length > 0 && autos.every(Number.isInteger) && Math.max(...autos) > 86_400;
    const toMs = (t: RawTime): number | undefined =>
      t.ms ?? (t.auto === undefined ? undefined : Math.round(autoIsMs ? t.auto : t.auto * 1000));
    const hasTimestamps = items.some((i) => toMs(i.start) !== undefined);
    const segments: TranscriptSegment[] = [];
    for (const it of items) {
      const prev = segments[segments.length - 1];
      const start = toMs(it.start) ?? prev?.endMs ?? prev?.startMs ?? 0;
      let end = toMs(it.end);
      const dur = toMs(it.duration);
      if (end === undefined && dur !== undefined) end = start + dur;
      segments.push({
        startMs: Math.max(0, start),
        ...(end !== undefined && end >= start ? { endMs: end } : {}),
        ...(it.speaker ? { speaker: it.speaker } : {}),
        text: it.text,
      });
    }
    if (hasTimestamps) segments.sort((a, b) => a.startMs - b.startMs);
    return { ...meta, segments, hasTimestamps };
  },
};

export const DEFAULT_FORMATS: readonly TranscriptFormat[] = [
  txtFormat,
  mdFormat,
  vttFormat,
  srtFormat,
  jsonFormat,
];
