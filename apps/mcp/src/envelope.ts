import { redact } from '@unicontext/core';
import { uniqueCitations, type Citation } from '@unicontext/provenance';

/**
 * The one result shape every tool and resource returns (§75): the data, every citation found in
 * it (de-duplicated), plain-language conflict notices, and a short hint on how to cite.
 */
export interface McpEnvelope<T = unknown> {
  data: T;
  citations: Citation[];
  /** Plain Japanese notices, one per disagreement between sources found anywhere in `data`. */
  conflicts: string[];
  /** Short Japanese instruction for the model on how to answer from this result. */
  answerHint: string;
}

const CONFLICT_SUFFIX = 'どちらが正しいか断定せず両方を伝えてください';

const PREDICATE_LABELS: Record<string, string> = {
  room: '教室',
  class_status: '授業の状況',
  status: '授業の状況',
  starts_at: '開始時刻',
  assignment_due: '締切',
  deadline: '締切',
  exam_at: '試験の日時',
  submission_status: '提出状況',
  grade: '成績',
  grade_letter: '成績評価',
};

export function predicateLabel(predicate: string): string {
  return PREDICATE_LABELS[predicate] ?? predicate;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isCitation(v: unknown): v is Citation {
  return (
    isObj(v) &&
    typeof v.sourceReferenceId === 'string' &&
    typeof v.label === 'string' &&
    typeof v.retrievedAt === 'string'
  );
}

interface CandidateLike {
  value: unknown;
  source: string | undefined;
}

function candidatesOf(v: unknown): CandidateLike[] {
  if (!Array.isArray(v)) return [];
  const out: CandidateLike[] = [];
  const seen = new Set<string>();
  for (const c of v) {
    if (!isObj(c)) continue;
    const cite = isCitation(c.citation) ? c.citation : undefined;
    const source =
      cite?.sourceLabel ??
      cite?.sourceSystem ??
      (typeof c.source === 'string' ? c.source : undefined);
    const key = `${JSON.stringify(c.value)}|${source ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ value: c.value, source });
  }
  return out;
}

function show(v: unknown): string {
  if (typeof v === 'string') return v;
  return JSON.stringify(v) ?? String(v);
}

function conflictNotice(
  label: string,
  context: string | undefined,
  cands: CandidateLike[],
): string {
  const parts = cands.map((c) => `${show(c.value)}${c.source ? `（${c.source}）` : ''}`);
  const joined = parts.length === 2 ? `${parts[0]}と${parts[1]}` : parts.join('、');
  const head = context ? `「${context}」の${label}` : label;
  return `${head}: ${joined}が食い違っています。${CONFLICT_SUFFIX}`;
}

function contextOf(parent: Obj | undefined): string | undefined {
  if (!parent) return undefined;
  const course = parent.course;
  if (isObj(course) && typeof course.title === 'string') return course.title;
  if (typeof parent.title === 'string') return parent.title;
  if (typeof parent.subjectLabel === 'string') return parent.subjectLabel;
  return undefined;
}

export interface Collected {
  citations: Citation[];
  conflicts: string[];
}

/** Walk any JSON value and gather citations and conflict notices (ResolvedValue / ConflictItem). */
export function collect(data: unknown): Collected {
  const citations: Citation[] = [];
  const conflicts = new Map<string, string>();

  const addConflict = (
    label: string,
    context: string | undefined,
    cands: CandidateLike[],
  ): void => {
    if (cands.length === 0) return;
    const key = `${context ?? ''}|${label}|${cands
      .map((c) => show(c.value))
      .sort()
      .join('|')}`;
    if (!conflicts.has(key)) conflicts.set(key, conflictNotice(label, context, cands));
  };

  const walk = (
    v: unknown,
    key: string | undefined,
    parent: Obj | undefined,
    depth: number,
  ): void => {
    if (depth > 60 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, key, parent, depth + 1);
      return;
    }
    const o = v as Obj;
    if (isCitation(o)) citations.push(o);
    // ConflictItem
    if (
      typeof o.predicate === 'string' &&
      typeof o.subjectLabel === 'string' &&
      (o.status === undefined || o.status === 'conflict') &&
      Array.isArray(o.candidates)
    ) {
      addConflict(predicateLabel(o.predicate), o.subjectLabel, candidatesOf(o.candidates));
    }
    // ResolvedValue
    if (o.status === 'conflict' && Array.isArray(o.candidates) && o.predicate === undefined) {
      addConflict(predicateLabel(key ?? 'value'), contextOf(parent), candidatesOf(o.candidates));
    }
    for (const [k, child] of Object.entries(o)) walk(child, k, o, depth + 1);
  };
  walk(data, undefined, undefined, 0);
  return { citations: uniqueCitations(citations), conflicts: [...conflicts.values()] };
}

/** Round-trip through JSON so what we collect from is exactly what the client receives. */
export function toJsonSafe<T>(value: T): T {
  const text = JSON.stringify(value);
  return (text === undefined ? null : JSON.parse(text)) as T;
}

export interface EnvelopeOptions {
  /** Extra citations not discoverable inside `data`. */
  citations?: readonly Citation[];
  /** Extra sentence appended to the answer hint. */
  hint?: string;
}

/** Citation URLs come from sources; never let a token in a query string reach the model. */
function scrubCitationUrls(node: unknown, depth = 0): void {
  if (depth > 60 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node) scrubCitationUrls(x, depth + 1);
    return;
  }
  const o = node as Obj;
  if (isCitation(o) && typeof o.url === 'string') o.url = redact(o.url) as string;
  for (const child of Object.values(o)) scrubCitationUrls(child, depth + 1);
}

export function buildEnvelope<T>(data: T, options: EnvelopeOptions = {}): McpEnvelope<T> {
  const safe = toJsonSafe(data);
  scrubCitationUrls(safe);
  const found = collect(safe);
  const extra = toJsonSafe([...(options.citations ?? [])]);
  scrubCitationUrls(extra);
  const citations = uniqueCitations([...found.citations, ...extra]);
  const conflicts = found.conflicts;
  const sentences: string[] = [];
  const first = citations[0];
  if (first) {
    sentences.push(
      `回答には根拠を添えてください（例: 根拠: ${first.label}）。根拠は citations の label をそのまま使います。`,
    );
  } else {
    sentences.push(
      '根拠となる情報源が見つかりませんでした。推測で補わず、情報が見つからないことを伝えてください。',
    );
  }
  if (conflicts.length > 0)
    sentences.push(
      '情報源の間で食い違いがあります。conflicts の内容を必ず伝え、一方に断定しないでください。',
    );
  if (options.hint) sentences.push(options.hint);
  return { data: safe, citations, conflicts, answerHint: sentences.join(' ') };
}
