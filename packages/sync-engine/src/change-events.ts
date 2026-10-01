import {
  type CanonicalEntity,
  type ChangeEvent,
  type ChangeEventType,
  entityLabel,
  type EntityKind,
  type JsonValue,
  makeId,
} from '@unicontext/canonical-model';
import { DEFAULT_TIMEZONE, formatShortJa } from '@unicontext/core';

export const KIND_LABELS_JA: Record<EntityKind, string> = {
  university: '大学',
  campus: 'キャンパス',
  academicTerm: '学期',
  person: '人物',
  course: '科目',
  courseOffering: '授業',
  enrollment: '履修',
  assignment: '課題',
  submission: '提出',
  exam: '試験',
  announcement: 'お知らせ',
  message: 'メッセージ',
  thread: 'スレッド',
  material: '資料',
  document: 'ファイル',
  documentChunk: 'ファイルの一部',
  lecture: '講義',
  lectureTranscript: '講義録',
  lectureSegment: '講義録の一部',
  calendarEvent: '予定',
  classSession: '授業回',
  location: '場所',
  grade: '成績',
};

const FIELD_LABELS_JA: Record<string, string> = {
  dueAt: '締切',
  room: '教室',
  status: '状態',
  startsAt: '開始',
  endsAt: '終了',
  title: '題名',
  body: '本文',
  score: '点数',
  period: '時限',
  date: '日付',
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function fmt(v: unknown, tz: string): string {
  if (v === undefined || v === null) return '(なし)';
  if (typeof v === 'string' && ISO.test(v)) return formatShortJa(new Date(v), tz);
  if (typeof v === 'string') return v.length > 30 ? `${v.slice(0, 30)}…` : v;
  return JSON.stringify(v);
}

/** Human summary such as "課題「課題1」の締切: 10/8 23:59 → 10/10 23:59". */
export function summarizeChange(
  type: ChangeEventType,
  entity: CanonicalEntity,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  fields: string[],
  tz: string = DEFAULT_TIMEZONE,
): string {
  const kind = KIND_LABELS_JA[entity.kind];
  const label = `${kind}「${entityLabel(entity)}」`;
  switch (type) {
    case 'created':
      return `${label}が追加されました`;
    case 'deleted':
      return `${label}が削除されました`;
    case 'restored':
      return `${label}が復活しました`;
    case 'updated': {
      const parts = fields
        .slice(0, 3)
        .map((f) => `${FIELD_LABELS_JA[f] ?? f}: ${fmt(before?.[f], tz)} → ${fmt(after?.[f], tz)}`);
      return `${label}の${parts.join('、')}${fields.length > 3 ? ` ほか${fields.length - 3}件` : ''}`;
    }
    default:
      return label;
  }
}

function pick(
  obj: CanonicalEntity | undefined,
  fields: string[] | 'all',
): Record<string, JsonValue> | null {
  if (!obj) return null;
  const r = obj as unknown as Record<string, JsonValue>;
  if (fields === 'all') return { ...r };
  const out: Record<string, JsonValue> = {};
  for (const f of fields) if (r[f] !== undefined) out[f] = r[f] as JsonValue;
  return out;
}

export function courseOfferingOf(e: CanonicalEntity): string | undefined {
  if (e.kind === 'courseOffering') return e.id;
  const v = (e as unknown as Record<string, unknown>).courseOfferingId;
  return typeof v === 'string' ? v : undefined;
}

/** Build a ChangeEvent from an entity diff (§13). before/after carry only changed fields for updates. */
export function buildChangeEvent(input: {
  type: ChangeEventType;
  entity: CanonicalEntity;
  previous: CanonicalEntity | undefined;
  changedFields: string[];
  source: ChangeEvent['source'];
  occurredAt: string;
  observedAt: string;
  timezone?: string;
}): ChangeEvent {
  const { type, entity, previous } = input;
  const fields = input.changedFields;
  const before =
    type === 'created'
      ? null
      : type === 'updated'
        ? pick(previous, fields)
        : pick(previous ?? entity, 'all');
  const after =
    type === 'deleted' ? null : type === 'updated' ? pick(entity, fields) : pick(entity, 'all');
  const course = courseOfferingOf(entity);
  return {
    id: makeId('changeEvent'),
    entityId: entity.id,
    entityKind: entity.kind,
    type,
    changedFields: fields,
    before,
    after,
    source: input.source,
    occurredAt: input.occurredAt,
    observedAt: input.observedAt,
    ...(course ? { courseOfferingId: course as ChangeEvent['courseOfferingId'] } : {}),
    summary: summarizeChange(type, entity, before, after, fields, input.timezone),
  };
}
