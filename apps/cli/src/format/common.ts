import type { FactOrigin, HealthState, JsonValue, TaskStatus } from '@unicontext/canonical-model';
import type { Citation, ResolvedValue, ValueCandidate } from '@unicontext/context-engine';
import { formatShortJa, zonedParts } from '@unicontext/core';
import type { Style } from './style.js';

export const STATE_LABELS: Record<HealthState | 'unknown', string> = {
  healthy: '正常',
  degraded: '一部異常',
  auth_required: '要ログイン',
  rate_limited: '制限中',
  offline: 'オフライン',
  failed: '失敗',
  unknown: '不明',
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  pending: '未着手',
  in_progress: '進行中',
  submitted: '提出済み',
  completed: '完了',
  cancelled: '取消',
  unknown: '不明',
  expired_past_term: '終了した学期',
};

export const ORIGIN_LABELS: Record<FactOrigin, string> = {
  authoritative: '公式',
  user: '本人入力',
  extracted: '抽出',
  inferred: '推論',
};

export const CLASS_STATUS_LABELS: Record<string, string> = {
  scheduled: '通常',
  cancelled: '休講',
  makeup: '補講',
  online: 'オンライン',
  changed: '変更あり',
};

export const PREDICATE_LABELS: Record<string, string> = {
  room: '教室',
  class_status: '授業の状態',
  starts_at: '開始時刻',
  assignment_due: '課題の締切',
  exam_at: '試験日時',
  submission_status: '提出状況',
  grade: '成績',
  grade_letter: '成績評価',
  deadline: '締切',
  pace_slots: '自習時間',
};

export const KIND_LABELS: Record<string, string> = {
  course: '科目',
  courseOffering: '科目',
  assignment: '課題',
  submission: '提出',
  exam: '試験',
  announcement: 'お知らせ',
  message: 'メッセージ',
  thread: 'スレッド',
  material: '資料',
  document: '資料',
  documentChunk: '資料',
  lecture: '講義',
  lectureTranscript: '講義録',
  lectureSegment: '講義録',
  calendarEvent: '予定',
  classSession: '授業',
  grade: '成績',
  location: '場所',
};

export function predicateLabel(predicate: string): string {
  return PREDICATE_LABELS[predicate] ?? predicate;
}

export function stateLabel(state: string): string {
  return STATE_LABELS[state as HealthState] ?? state;
}

export function colorState(style: Style, state: string, text: string): string {
  switch (state) {
    case 'healthy':
      return style.green(text);
    case 'degraded':
    case 'rate_limited':
    case 'auth_required':
    case 'offline':
      return style.yellow(text);
    case 'failed':
      return style.red(text);
    default:
      return text;
  }
}

/** "10/1 09:42" in the profile timezone; empty for undefined. */
export function shortTime(iso: string | undefined, tz: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : formatShortJa(d, tz);
}

const two = (n: number): string => String(n).padStart(2, '0');

/** "09:30" in the profile timezone. */
export function clockTime(iso: string | undefined, tz: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = zonedParts(d, tz);
  return `${two(p.hour)}:${two(p.minute)}`;
}

/** Compact remaining time for deadlines. */
export function remaining(hoursLeft: number | undefined): string {
  if (hoursLeft === undefined) return '';
  const abs = Math.abs(hoursLeft);
  const amount =
    abs < 1
      ? `${Math.max(1, Math.round(abs * 60))}分`
      : abs < 48
        ? `${Math.round(abs)}時間`
        : `${Math.round(abs / 24)}日`;
  return hoursLeft < 0 ? `${amount}超過` : `あと${amount}`;
}

export function valueText(v: JsonValue | undefined): string {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Distinct citation labels, e.g. "学務情報システム 9/30 09:00取得 / Microsoft Teams 10/1 09:00取得". */
export function citationText(citations: readonly Citation[] | undefined, max = 2): string {
  if (!citations || citations.length === 0) return '';
  const labels = [...new Set(citations.map((c) => c.label))];
  const shown = labels.slice(0, max).join(' / ');
  return labels.length > max ? `${shown} ほか${labels.length - max}件` : shown;
}

/** One line per distinct (value, source) pair of a conflict or resolved value. */
export function distinctCandidates(candidates: readonly ValueCandidate[]): ValueCandidate[] {
  const seen = new Set<string>();
  const out: ValueCandidate[] = [];
  for (const c of candidates) {
    const key = `${valueText(c.value)}|${c.citation?.label ?? c.source}|${c.origin}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export function distinctValues(candidates: readonly ValueCandidate[]): string[] {
  return [...new Set(candidates.map((c) => valueText(c.value)))];
}

/** A resolved value for a table cell; a conflict shows every candidate, never just one. */
export function resolvedText(rv: ResolvedValue<string>, labels?: Record<string, string>): string {
  if (rv.status === 'conflict') return `競合: ${distinctValues(rv.candidates).join(' / ')}`;
  if (rv.value === undefined) return '-';
  return labels?.[rv.value] ?? rv.value;
}
