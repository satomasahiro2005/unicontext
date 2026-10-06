import type { Addition } from '@unicontext/canonical-model';
import { sha256, ValidationError } from '@unicontext/core';
import { SourceReferenceStore } from '@unicontext/database';
import { toCitation } from '@unicontext/provenance';
import type { AttentionItem } from './attention.js';
import type { UniContext } from './runtime.js';

/*
 * External signals: things about the student's university life that an AI client found in the
 * student's own Gmail or Google Calendar (a registration result, a cancellation, a room change, a
 * deadline). UniContext never reads Gmail or the calendar itself; the AI client reads them and
 * writes the finding through `ingest_external_signal`. A signal is stored like any other chat
 * addition (unconfirmed, cited, retractable) but at the lowest authority, `external-signal`:
 * below every university source, so it never overrides one — a disagreement is shown as a
 * conflict (or, for enrollment, as a note showing both) with both values and their sources.
 */

export const EXTERNAL_SIGNAL_SOURCES = ['gmail', 'calendar'] as const;
export type ExternalSignalSource = (typeof EXTERNAL_SIGNAL_SOURCES)[number];

export const EXTERNAL_SIGNAL_KINDS = [
  'registration_result',
  'cancellation',
  'room_change',
  'deadline',
  'schedule_change',
  'other',
] as const;
export type ExternalSignalKind = (typeof EXTERNAL_SIGNAL_KINDS)[number];

/** SourceReference authority of every external signal (the last entry of the authority rules). */
export const EXTERNAL_SIGNAL_AUTHORITY = 'external-signal';

/** How a signal is cited. */
export const EXTERNAL_SIGNAL_LABELS = {
  gmail: 'Gmail（本人のメール）',
  calendar: 'Googleカレンダー',
} as const satisfies Record<ExternalSignalSource, string>;

export const EXTERNAL_SIGNAL_KIND_LABELS: Record<ExternalSignalKind, string> = {
  registration_result: '履修登録の結果',
  cancellation: '休講・中止',
  room_change: '教室変更',
  deadline: '締切',
  schedule_change: '日程変更',
  other: 'その他の連絡',
};

/** Size limits of one ingest_external_signal call (also the MCP input schema). */
export const EXTERNAL_SIGNAL_LIMITS = {
  nativeId: 300,
  from: 200,
  subject: 300,
  summary: 2000,
  quote: 1000,
  location: 200,
  task: 200,
  url: 1000,
  dueAt: 100,
} as const;

export interface IngestExternalSignalInput {
  source: ExternalSignalSource;
  /** The mail's message id / the event's id: the same one is stored once. */
  nativeId: string;
  /** When the mail arrived / the event was seen (ISO-8601). */
  observedAt: string;
  from?: string | undefined;
  subject?: string | undefined;
  eventStart?: string | undefined;
  eventEnd?: string | undefined;
  location?: string | undefined;
  /** What matters in one or two sentences — not the whole mail. */
  summary: string;
  kind: ExternalSignalKind;
  /** Course offering id (the tool resolves a name or code first). */
  courseOfferingId?: string | undefined;
  /** The work item a deadline is about (「レポート1」): matched against the course's assignments. */
  task?: string | undefined;
  /** A deadline's due date: ISO-8601 or Japanese. Default for kind=deadline: eventStart. */
  dueAt?: string | undefined;
  /** The verbatim sentence the finding rests on. */
  quote: string;
  /** Link to the mail / the event. */
  url?: string | undefined;
  /**
   * For kind=registration_result: what the result says about taking the course (the student was
   * rejected, withdrawn, lost the lottery = not_taking; admitted = taking).
   */
  enrollment?: string | undefined;
  idempotencyKey?: string | undefined;
}

/** sha256(source + nativeId): the same mail or event is one signal. */
export function externalSignalFingerprint(source: ExternalSignalSource, nativeId: string): string {
  return sha256(`${source}${nativeId}`);
}

/** The dedupe key of the addition (the fingerprint, whoever sends it). */
export function externalSignalDedupeKey(fingerprint: string): string {
  return `external_signal|${fingerprint}`;
}

export function isExternalSignalAddition(a: Pick<Addition, 'tool'>): boolean {
  return a.tool === 'ingest_external_signal';
}

/** A valid ISO-8601 instant (with offset) → its canonical ISO string. */
export function parseSignalInstant(value: string, field: string): string {
  const s = value.trim();
  const t = Date.parse(s);
  if (!s || Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}T/.test(s))
    throw new ValidationError(`${field} must be an ISO-8601 date-time (2026-10-05T09:30:00+09:00)`);
  return new Date(t).toISOString();
}

/** Trim and bound an optional text field. */
export function boundedText(
  value: string | undefined,
  field: string,
  max: number,
): string | undefined {
  const s = value?.trim();
  if (!s) return undefined;
  if (s.length > max) throw new ValidationError(`${field} is longer than ${max} characters`);
  return s;
}

/** A link the signal points at: http(s) only. */
export function signalUrl(value: string | undefined): string | undefined {
  const s = boundedText(value, 'url', EXTERNAL_SIGNAL_LIMITS.url);
  if (!s) return undefined;
  if (!/^https?:\/\//i.test(s))
    throw new ValidationError('url must start with http:// or https://');
  return s;
}

/** The title of the addition: 「Gmail（本人のメール）: 履修登録の結果」. */
export function externalSignalTitle(input: {
  source: ExternalSignalSource;
  subject?: string | undefined;
  summary: string;
  kind: ExternalSignalKind;
}): string {
  const what =
    input.subject?.trim() ||
    (input.summary.length > 40 ? `${input.summary.slice(0, 40)}…` : input.summary);
  return `${EXTERNAL_SIGNAL_LABELS[input.source]}: ${what}`;
}

/** The note kept on the course for a signal that is neither a deadline nor an enrollment result. */
export function externalSignalNoteText(input: {
  source: ExternalSignalSource;
  kind: ExternalSignalKind;
  from?: string | undefined;
  subject?: string | undefined;
  eventStart?: string | undefined;
  eventEnd?: string | undefined;
  location?: string | undefined;
  summary: string;
  quote: string;
  url?: string | undefined;
  observedAt: string;
}): string {
  const lines = [
    `【${EXTERNAL_SIGNAL_LABELS[input.source]}・${EXTERNAL_SIGNAL_KIND_LABELS[input.kind]}】${input.summary}`,
    `引用: 「${input.quote}」`,
  ];
  if (input.subject) lines.push(`件名・題: ${input.subject}`);
  if (input.from) lines.push(`差出人: ${input.from}`);
  if (input.eventStart)
    lines.push(`日時: ${input.eventStart}${input.eventEnd ? ` 〜 ${input.eventEnd}` : ''}`);
  if (input.location) lines.push(`場所: ${input.location}`);
  if (input.url) lines.push(`リンク: ${input.url}`);
  lines.push(`受信・確認: ${input.observedAt}`);
  return lines.join('\n');
}

type Draft = Omit<
  AttentionItem,
  'attentionId' | 'firstSeenAt' | 'lastChangedAt' | 'sourceHealth'
> & {
  subject: string;
  sourceIds?: string[];
};

/**
 * News for the attention view: the external signals stored since `since` that are not deadlines
 * (a deadline reaches the student through the deadline alerts once it is stored) — a registration
 * result, a cancellation, a room or schedule change, any other university mail. Each is told once
 * per client (its key is the addition).
 */
export function externalSignalAlerts(uc: UniContext, since: string): Draft[] {
  const refs = new SourceReferenceStore(uc.db);
  const out: Draft[] = [];
  for (const a of uc.additions.store.list({ statuses: ['unconfirmed', 'confirmed'] })) {
    if (!isExternalSignalAddition(a) || a.createdAt < since) continue;
    const d = a.data;
    const kind = typeof d.signalKind === 'string' ? d.signalKind : 'other';
    if (kind === 'deadline') continue;
    const label = typeof d.source === 'string' ? d.source : EXTERNAL_SIGNAL_LABELS.gmail;
    const summary = typeof d.summary === 'string' ? d.summary : a.title;
    const course = a.courseOfferingId ? uc.context.courseRef(a.courseOfferingId)?.title : undefined;
    const ref = a.sourceReferenceId ? refs.get(a.sourceReferenceId) : undefined;
    const important =
      kind === 'registration_result' ||
      kind === 'cancellation' ||
      kind === 'room_change' ||
      kind === 'schedule_change';
    out.push({
      subject: `signal:${a.id}`,
      key: `signal:${a.id}`,
      kind: 'announcement',
      severity: important ? 'warning' : 'info',
      line: `【${label}】${course ? `${course}: ` : ''}${summary}`,
      course,
      at: typeof d.observedAt === 'string' ? d.observedAt : a.createdAt,
      link: undefined,
      citations: ref ? [toCitation(ref, uc.timezone)] : [],
      nextEscalationAt: undefined,
      recommendedAction: `${label}の連絡を確かめる${typeof d.evidence === 'string' ? `（「${d.evidence.slice(0, 80)}」）` : ''}`,
    });
  }
  return out;
}
