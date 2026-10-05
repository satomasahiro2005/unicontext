/**
 * Deadline coverage: which sources feed the student's deadlines, whether each is healthy, and what
 * is known to be missing. An empty deadline list only means "none found in these sources"; the AI
 * must not read it as "there is no deadline" (the student's words: 期限がわからない時にAIが楽観視して
 * しまうのも問題). Views carry this so an answer can say what was checked and what was not. Work
 * whose due date is unknown carries its estimate (estimate.ts: earliest plausible, 「推定」).
 */
import { formatShortJa } from '@unicontext/core';
import type { EstimatedDue } from './estimate.js';

/** What a source contributes to deadlines, by connector capability. */
const COVERS: Record<string, string> = {
  assignments: '課題',
  exams: '試験',
  calendar: '予定',
  announcements: 'お知らせ（文中の締切）',
  messages: '投稿（文中の締切）',
};
const DEADLINE_CAPABILITIES = new Set(Object.keys(COVERS));
/** Where a course can live without its deadlines being synced (posts, materials). */
const PRESENCE_CAPABILITIES = new Set(['announcements', 'messages', 'materials']);
/** Authorities that are not a place an instructor sets work (the student's own files, recordings). */
const NOT_A_PLATFORM = new Set(['local-file', 'transcript', 'student-statement', 'syllabus']);
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export type CoverageHealth = 'ok' | 'auth_required' | 'stale' | 'failing' | 'never_synced';

export interface CoverageSource {
  sourceId: string;
  label: string;
  health: CoverageHealth;
  lastSuccessAt?: string | undefined;
  /** What it feeds: 課題, お知らせ（文中の締切）, ... */
  covers: string[];
}

export type CoverageGap =
  | {
      kind: 'source_unhealthy';
      sourceId: string;
      label: string;
      health: Exclude<CoverageHealth, 'ok'>;
      lastSuccessAt?: string | undefined;
      detail: string;
    }
  | {
      kind: 'deadlines_not_synced';
      course: { id: string; title: string };
      sourceId: string;
      label: string;
      detail: string;
    }
  | {
      kind: 'unknown_due';
      course: { id: string; title: string } | undefined;
      /** Earliest estimate first; each with its 「推定」 (never a stated deadline). */
      items: { title: string; url?: string | undefined; estimatedDue?: EstimatedDue | undefined }[];
      detail: string;
    };

export interface DeadlineCoverage {
  /** No known gap: every deadline source is healthy and no open assignment lacks a due date. */
  complete: boolean;
  sources: CoverageSource[];
  gaps: CoverageGap[];
  /** How to read the deadlines next to this (for the AI). */
  note: string;
}

/** A source as the coverage needs it (from the connector metadata and the health store). */
export interface CoverageSourceInput {
  sourceId: string;
  label: string;
  /** Undefined: the connector is not loaded (configured but failing), so its coverage is unknown. */
  capabilities: readonly string[] | undefined;
  authority: string | undefined;
  referenceOnly: boolean;
  state: string | undefined;
  lastSuccessAt: string | undefined;
  staleAfterMs: number | undefined;
}

export interface CoverageCourse {
  id: string;
  title: string;
  /** Sources of the course's linked offerings. */
  sourceIds: string[];
}

export interface CoverageUndated {
  course: { id: string; title: string } | undefined;
  title: string;
  url: string | undefined;
  /** The earliest plausible deadline (estimate.ts). */
  estimatedDue?: EstimatedDue | undefined;
}

const HEALTH_TEXT: Record<Exclude<CoverageHealth, 'ok'>, string> = {
  auth_required: '要ログイン（取得できていません）',
  stale: 'しばらく取得できていません',
  failing: '取得に失敗しています',
  never_synced: 'まだ一度も取得できていません',
};

export function coverageHealth(s: CoverageSourceInput, now: Date): CoverageHealth {
  if (s.state === 'auth_required') return 'auth_required';
  if (s.state === 'failed' || s.state === 'offline' || s.state === 'rate_limited') return 'failing';
  if (!s.lastSuccessAt) return 'never_synced';
  const age = now.getTime() - new Date(s.lastSuccessAt).getTime();
  return age > (s.staleAfterMs ?? DEFAULT_STALE_AFTER_MS) ? 'stale' : 'ok';
}

function feedsDeadlines(s: CoverageSourceInput): boolean {
  if (s.referenceOnly) return false;
  // Not loaded: it may well carry deadlines; its state decides whether it shows up.
  if (!s.capabilities) return s.state !== undefined && s.state !== 'healthy';
  return s.capabilities.some((c) => DEADLINE_CAPABILITIES.has(c));
}

/**
 * Build the coverage for a set of courses (the student's current courses, or one course).
 * `sources` lists every known source; with `courseScoped`, only the courses' own sources count.
 */
export function buildDeadlineCoverage(input: {
  now: Date;
  sources: CoverageSourceInput[];
  courses: CoverageCourse[];
  undated: CoverageUndated[];
  courseScoped: boolean;
  formatTime: (iso: string) => string;
  /** Time zone of the estimates in the gap text (default Asia/Tokyo). */
  timezone?: string;
}): DeadlineCoverage {
  const courseSources = new Set(input.courses.flatMap((c) => c.sourceIds));
  const relevant = input.sources.filter(
    (s) => feedsDeadlines(s) && (!input.courseScoped || courseSources.has(s.sourceId)),
  );
  const sources: CoverageSource[] = relevant.map((s) => ({
    sourceId: s.sourceId,
    label: s.label,
    health: coverageHealth(s, input.now),
    ...(s.lastSuccessAt ? { lastSuccessAt: s.lastSuccessAt } : {}),
    covers: s.capabilities
      ? s.capabilities.filter((c) => c in COVERS).map((c) => COVERS[c] as string)
      : ['不明（コネクタを読み込めていません）'],
  }));

  const gaps: CoverageGap[] = [];
  for (const s of sources) {
    if (s.health === 'ok') continue;
    const since = s.lastSuccessAt
      ? `最終取得 ${input.formatTime(s.lastSuccessAt)}`
      : '取得実績なし';
    gaps.push({
      kind: 'source_unhealthy',
      sourceId: s.sourceId,
      label: s.label,
      health: s.health,
      ...(s.lastSuccessAt ? { lastSuccessAt: s.lastSuccessAt } : {}),
      detail: `${s.label}: ${HEALTH_TEXT[s.health]}（${since}）。そこにある課題・締切は反映されていない可能性があります。${s.label}を直接確認してください。`,
    });
  }

  const byId = new Map(input.sources.map((s) => [s.sourceId, s]));
  for (const c of input.courses) {
    for (const sourceId of new Set(c.sourceIds)) {
      const s = byId.get(sourceId);
      if (!s?.capabilities || s.referenceOnly) continue;
      if (s.authority && NOT_A_PLATFORM.has(s.authority)) continue;
      if (s.authority === 'academic-system') continue;
      const present = s.capabilities.some((x) => PRESENCE_CAPABILITIES.has(x));
      if (!present || s.capabilities.includes('assignments')) continue;
      gaps.push({
        kind: 'deadlines_not_synced',
        course: { id: c.id, title: c.title },
        sourceId,
        label: s.label,
        detail: `「${c.title}」は${s.label}にもありますが、${s.label}の課題・締切は同期していません（お知らせ・投稿の文中の締切だけ）。${s.label}を直接確認してください。`,
      });
    }
  }

  const undated = new Map<string, CoverageUndated[]>();
  for (const u of input.undated) {
    const key = u.course?.id ?? '';
    undated.set(key, [...(undated.get(key) ?? []), u]);
  }
  const estMs = (u: CoverageUndated): number =>
    u.estimatedDue ? Date.parse(u.estimatedDue.at) : Number.POSITIVE_INFINITY;
  for (const group of undated.values()) {
    const list = [...group].sort((a, b) => estMs(a) - estMs(b));
    const course = list[0]?.course;
    const first = list[0]?.estimatedDue;
    const estimate = first
      ? `最も早い推定は${formatShortJa(new Date(first.at), input.timezone)}（${first.basis}）。推定は確定した締切ではありません。`
      : '';
    gaps.push({
      kind: 'unknown_due',
      course,
      items: list.slice(0, 5).map((u) => ({
        title: u.title,
        ...(u.url ? { url: u.url } : {}),
        ...(u.estimatedDue ? { estimatedDue: u.estimatedDue } : {}),
      })),
      detail: `${course ? `「${course.title}」の` : ''}課題${list.length}件は締切が分かりません（期限不明）。${estimate}すぐ締切が来る可能性があるものとして推定に合わせて扱い、提出先で期限を確認してください。`,
    });
  }

  const complete = gaps.length === 0;
  return {
    complete,
    sources,
    gaps,
    note: complete
      ? '締切は上の情報源から取得したものです。ここに無いことは締切が無いことを意味しません（口頭・紙・同期していない場所の課題もありえます）。'
      : '締切の取得に欠けがあります（gaps）。ここに無い締切や期限不明の課題は、すぐ締切が来る可能性があるものとして扱い、gaps の確認先を学生に伝えてください。期限不明の課題は estimatedDue（早めの推定・根拠つき）に合わせて動き、「推定」と明記して確定した締切のように言わないでください。「締切はない」「余裕がある」とは言わないでください。',
  };
}
