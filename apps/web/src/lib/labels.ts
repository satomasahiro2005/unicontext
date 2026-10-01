/** Japanese labels for enums that arrive from the API. All pure lookups. */

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted';

const HEALTH_LABELS: Record<string, string> = {
  healthy: '正常',
  degraded: '一部に問題',
  auth_required: '要ログイン',
  rate_limited: 'アクセス制限中',
  offline: 'オフライン',
  failed: '失敗',
  unknown: '未確認',
};

const HEALTH_TONES: Record<string, Tone> = {
  healthy: 'ok',
  degraded: 'warn',
  rate_limited: 'warn',
  auth_required: 'bad',
  offline: 'bad',
  failed: 'bad',
  unknown: 'muted',
};

/** Higher = needs attention sooner. Used to sort sources. */
const HEALTH_SEVERITY: Record<string, number> = {
  failed: 5,
  auth_required: 4,
  offline: 3,
  rate_limited: 2,
  degraded: 1,
  unknown: 0,
  healthy: 0,
};

export function healthLabel(state: string): string {
  return HEALTH_LABELS[state] ?? state;
}

export function healthTone(state: string): Tone {
  return HEALTH_TONES[state] ?? 'muted';
}

export function healthSeverity(state: string): number {
  return HEALTH_SEVERITY[state] ?? 0;
}

/** True when the source needs the user's attention (unknown = not synced yet, not unhealthy). */
export function isUnhealthy(state: string): boolean {
  return healthSeverity(state) > 0;
}

/** auth_required and failed sources show the login command. */
export function needsLoginCommand(state: string): boolean {
  return state === 'auth_required' || state === 'failed';
}

export function countUnhealthy(sources: readonly { state: string }[]): number {
  return sources.filter((s) => isUnhealthy(s.state)).length;
}

const ENTITY_KIND_LABELS: Record<string, string> = {
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
  task: 'タスク',
  changeEvent: '変更',
  conflict: '競合',
};

export function entityKindLabel(kind: string): string {
  return ENTITY_KIND_LABELS[kind] ?? kind;
}

const CHANGE_TYPE_LABELS: Record<string, string> = {
  created: '追加',
  updated: '変更',
  deleted: '削除',
  restored: '復活',
  conflict_detected: '競合を検出',
  conflict_resolved: '競合を解消',
};

export function changeTypeLabel(type: string): string {
  return CHANGE_TYPE_LABELS[type] ?? type;
}

const FIELD_LABELS: Record<string, string> = {
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
  instructors: '担当',
  description: '説明',
  url: 'URL',
  publishedAt: '公開日時',
  importance: '重要度',
  cancelled: '休講',
  scope: '範囲',
  weight: '配点',
  note: '備考',
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

const ORIGIN_LABELS: Record<string, string> = {
  authoritative: '公式',
  user: '手入力',
  extracted: '抽出',
  inferred: '推定',
};

export function originLabel(origin: string): string {
  return ORIGIN_LABELS[origin] ?? origin;
}

const TASK_STATUS_LABELS: Record<string, string> = {
  pending: '未提出',
  in_progress: '作業中',
  submitted: '提出済み',
  completed: '完了',
  cancelled: '取消',
  unknown: '不明',
};

export function taskStatusLabel(status: string): string {
  return TASK_STATUS_LABELS[status] ?? status;
}

export function taskStatusTone(status: string): Tone {
  if (status === 'submitted' || status === 'completed') return 'ok';
  if (status === 'pending' || status === 'in_progress') return 'info';
  return 'muted';
}

const IMPORTANCE_LABELS: Record<string, string> = {
  critical: '緊急',
  high: '重要',
  normal: '通常',
  low: '低',
};

export function importanceLabel(importance: string): string {
  return IMPORTANCE_LABELS[importance] ?? importance;
}

export function importanceTone(importance: string): Tone {
  if (importance === 'critical') return 'bad';
  if (importance === 'high') return 'warn';
  return 'muted';
}

const SCOPE_LABELS: Record<string, string> = {
  university: '大学',
  faculty: '学部',
  department: '学科',
  course: '授業',
  personal: '個人',
};

export function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}

const MATERIAL_KIND_LABELS: Record<string, string> = {
  slide: 'スライド',
  slides: 'スライド',
  pdf: 'PDF',
  document: '文書',
  recording: '録画',
  video: '動画',
  link: 'リンク',
  other: 'その他',
};

export function materialKindLabel(kind: string): string {
  return MATERIAL_KIND_LABELS[kind] ?? kind;
}

const SEARCH_VIA_LABELS: Record<string, string> = {
  lexical: '全文',
  semantic: '意味',
  structured: '構造',
};

export function searchViaLabel(via: string): string {
  return SEARCH_VIA_LABELS[via] ?? via;
}

const NOTIFICATION_KIND_LABELS: Record<string, string> = {
  room_change: '教室変更',
  class_cancelled: '休講',
  new_assignment: '新しい課題',
  deadline_changed: '締切の変更',
  deadline_approaching: '締切が近い',
  exam_announced: '試験の告知',
  important_announcement: '重要なお知らせ',
  auth_expired: 'ログイン切れ',
  sync_failure: '同期の失敗',
  conflict: '競合',
  schema_drift: '形式の変化',
};

export function notificationKindLabel(kind: string): string {
  return NOTIFICATION_KIND_LABELS[kind] ?? kind;
}
