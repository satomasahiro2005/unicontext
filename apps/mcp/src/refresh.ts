import {
  FRESHNESS_USES,
  type FreshnessUse,
  type SourceFreshness,
  type UniContext,
} from '@unicontext/context-engine';
import { errorMessage } from '@unicontext/core';
import { z } from 'zod';
import { resolveCourse } from './courses.js';
import type { EnvelopeOptions } from './envelope.js';

/**
 * `refresh_sources`: bring the sources behind an answer up to date when a view says its
 * information is older than its use allows (the answer hint names it). Read-only toward the
 * university (each source is read the way its scheduled sync reads it, never written to), and
 * rate-limited by the scheduler: a source is not read again within 10 minutes of its last
 * forced or successful run, one that needs a login or is backing off is skipped, and all
 * forced runs together are capped per hour. The daemon enforces this for its REST endpoint too.
 */

export const REFRESH_MAX_WAIT_MS = 60_000;
export const REFRESH_TOOL = {
  title: '情報源を更新',
  description:
    '回答の根拠になっている情報源を今すぐ読み直す。get_today などの answerHint に「◯◯ は N分前の情報です。refresh_sources で更新できます」とあるとき、学生に確認を頼まず、先にこれを呼ぶ。course（科目）・capabilities（schedule=休講・教室 / deadlines・assignments=課題・締切 / announcements / messages / materials / calendar / grades / attendance）・sources（情報源の id）で対象を絞る（省略すると全部）。10分以内に取得済み・要ログイン・失敗が続いて待機中の情報源は読み直さず skipped に理由を返す。同じ情報源は10分に1回、全体で1時間に6回まで。大学の画面には何も送信しない（読むだけ）。wait=true で最大60秒まで終わるのを待つ（省略時は開始だけ）。freshnessBefore は更新前の古さ。更新後は get_today などを呼び直す。 / Re-read the sources behind an answer now. Call it yourself (never ask the student to check) when an answerHint says a source’s information is N minutes old. Narrow with course, capabilities (schedule = cancellations/rooms, deadlines/assignments, announcements, messages, materials, calendar, grades, attendance) or sources (ids); omit to refresh all. Sources read within 10 minutes, needing a login, or backing off are skipped with a reason; at most one run per source per 10 minutes and 6 per hour overall. Read-only at the university. wait=true waits up to 60 s. Then call the view again.',
} as const;

export const refreshShape = {
  course: z
    .string()
    .min(1)
    .optional()
    .describe(
      '科目の id、または科目名・科目コードの一部。その科目の情報源だけ読み直す / Course id or part of its title or code: only that course’s sources',
    ),
  capabilities: z
    .array(z.enum(FRESHNESS_USES as unknown as [FreshnessUse, ...FreshnessUse[]]))
    .optional()
    .describe(
      '読み直したい情報の種類（schedule, deadlines, assignments, announcements, messages, materials, calendar, grades, attendance） / Kinds of information to refresh',
    ),
  sources: z
    .array(z.string().min(1))
    .max(10)
    .optional()
    .describe('情報源の id（get_today の coverage.sources[].sourceId） / Source ids'),
  wait: z
    .boolean()
    .optional()
    .describe(
      'true: 終わるまで最大60秒待つ。省略・false: 開始だけして返す / true: wait up to 60 s (default: start only)',
    ),
};

export type RefreshArgs = z.infer<z.ZodObject<typeof refreshShape>>;

/** A started sync run. */
export interface SyncStart {
  jobId: string;
  /** Resolves when the run has finished (never rejects). */
  finished: () => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Starts a forced (on-demand, rate-limited) sync of one source. Throws when the limits refuse it
 * (a RateLimitedError, or the daemon's HTTP 429). The daemon runs it in-process; `unicontext mcp`
 * routes it to the running daemon (POST /api/v1/sources/:id/sync?wait=0&reason=on-demand).
 */
export type SyncStarter = (sourceId: string) => Promise<SyncStart>;

/** In-process: the scheduler of this process (used when no daemon is running). */
export function inProcessSyncStarter(uc: UniContext): SyncStarter {
  return async (sourceId) => {
    uc.scheduler.assertOnDemand(sourceId);
    const jobId = `${sourceId}-${uc.clock.now().getTime().toString(36)}`;
    const run = uc.scheduler.trigger(sourceId, { reason: 'on-demand' }).then(
      (r) => ({ ok: r.ok, ...(r.error ? { error: r.error } : {}) }),
      (e: unknown) => ({ ok: false, error: errorMessage(e) }),
    );
    return { jobId, finished: () => run };
  };
}

export type RefreshSkipReason =
  | 'unknown_source'
  | 'not_loaded'
  | 'auth_required'
  | 'backoff'
  | 'recently_forced'
  | 'recently_synced'
  | 'hourly_cap'
  | 'rate_limited'
  | 'failed_to_start';

export interface RefreshSourceView {
  sourceId: string;
  label: string;
  health: SourceFreshness['health'];
  lastSuccessAt?: string | undefined;
  ageMinutes?: number | undefined;
  intervalMinutes?: number | undefined;
  freshness: SourceFreshness['freshness'];
  uses: FreshnessUse[];
  budgetMinutes: number;
}

export interface RefreshResult {
  started: { sourceId: string; jobId: string }[];
  skipped: {
    sourceId: string;
    reason: RefreshSkipReason;
    detail?: string;
    retryAfterMinutes?: number;
  }[];
  /** The targeted sources' age before this call, stalest first. */
  freshnessBefore: RefreshSourceView[];
  /** wait=true: how the started runs ended. */
  finished?: { sourceId: string; ok: boolean; error?: string }[];
  /** wait=true: started runs that had not finished when the wait ended. */
  stillRunning?: string[];
  /** wait=true: the started sources' age after the wait. */
  freshnessAfter?: RefreshSourceView[];
}

function view(s: SourceFreshness): RefreshSourceView {
  return {
    sourceId: s.sourceId,
    label: s.label,
    health: s.health,
    ...(s.lastSuccessAt ? { lastSuccessAt: s.lastSuccessAt } : {}),
    ...(s.ageMinutes !== undefined ? { ageMinutes: s.ageMinutes } : {}),
    ...(s.intervalMinutes !== undefined ? { intervalMinutes: s.intervalMinutes } : {}),
    freshness: s.freshness,
    uses: s.uses,
    budgetMinutes: s.budgetMinutes,
  };
}

const REFUSALS = new Set<RefreshSkipReason>([
  'auth_required',
  'backoff',
  'recently_forced',
  'recently_synced',
  'hourly_cap',
]);

/** The scheduler's refusal (in-process, or the daemon's 429 carrying its message) as a skip. */
function refusalOf(e: unknown): RefreshResult['skipped'][number] | undefined {
  const code = (e as { code?: unknown }).code;
  if (code !== 'rate_limited') return undefined;
  const message = errorMessage(e);
  const m = /\((\w+)\):\s*(.*)$/s.exec(message);
  const reason = m?.[1] as RefreshSkipReason | undefined;
  const retry = (e as { retryAfterMs?: unknown }).retryAfterMs;
  return {
    sourceId: '',
    reason: reason && REFUSALS.has(reason) ? reason : 'rate_limited',
    detail: m?.[2] ?? message,
    ...(typeof retry === 'number' ? { retryAfterMinutes: Math.ceil(retry / 60_000) } : {}),
  };
}

export async function refreshSources(
  uc: UniContext,
  args: RefreshArgs,
  startSync: SyncStarter = inProcessSyncStarter(uc),
): Promise<RefreshResult> {
  const courseOfferingId = args.course ? resolveCourse(uc, args.course).ref.id : undefined;
  const registered = new Set(uc.sync.sources().map((s) => s.sourceId));
  const targets = uc.context.sourceFreshness({
    ...(courseOfferingId ? { courseOfferingId } : {}),
    ...(args.capabilities?.length ? { uses: args.capabilities } : {}),
    ...(args.sources?.length ? { sourceIds: args.sources } : {}),
  });
  const result: RefreshResult = {
    started: [],
    skipped: [],
    freshnessBefore: targets.map(view),
  };
  for (const id of args.sources ?? [])
    if (!targets.some((t) => t.sourceId === id))
      result.skipped.push({
        sourceId: id,
        reason: 'unknown_source',
        detail: courseOfferingId
          ? 'この科目で使っている情報源にありません'
          : '登録されていない情報源です',
      });

  const running: { sourceId: string; start: SyncStart }[] = [];
  for (const t of targets) {
    if (!registered.has(t.sourceId)) {
      result.skipped.push({
        sourceId: t.sourceId,
        reason: 'not_loaded',
        detail: '情報源のコネクタを読み込めていないため更新できません',
      });
      continue;
    }
    const verdict = uc.scheduler.checkOnDemand(t.sourceId);
    if (!verdict.ok && verdict.reason) {
      result.skipped.push({
        sourceId: t.sourceId,
        reason: verdict.reason,
        ...(verdict.detail ? { detail: verdict.detail } : {}),
        ...(verdict.retryAfterMs !== undefined
          ? { retryAfterMinutes: Math.ceil(verdict.retryAfterMs / 60_000) }
          : {}),
      });
      continue;
    }
    try {
      const start = await startSync(t.sourceId);
      running.push({ sourceId: t.sourceId, start });
      result.started.push({ sourceId: t.sourceId, jobId: start.jobId });
    } catch (e) {
      const refused = refusalOf(e);
      result.skipped.push(
        refused
          ? { ...refused, sourceId: t.sourceId }
          : { sourceId: t.sourceId, reason: 'failed_to_start', detail: errorMessage(e) },
      );
    }
  }

  if (args.wait && running.length > 0) {
    const waitMs = REFRESH_MAX_WAIT_MS;
    const timer: { id?: NodeJS.Timeout } = {};
    const timeout = new Promise<'timeout'>((resolve) => {
      timer.id = setTimeout(() => resolve('timeout'), waitMs);
    });
    const outcomes = new Map<string, { ok: boolean; error?: string }>();
    await Promise.race([
      Promise.all(
        running.map(async (r) => {
          outcomes.set(r.sourceId, await r.start.finished());
        }),
      ),
      timeout,
    ]);
    clearTimeout(timer.id);
    result.finished = running.flatMap((r) => {
      const o = outcomes.get(r.sourceId);
      return o ? [{ sourceId: r.sourceId, ...o }] : [];
    });
    result.stillRunning = running.map((r) => r.sourceId).filter((id) => !outcomes.has(id));
    result.freshnessAfter = uc.context
      .sourceFreshness({ sourceIds: running.map((r) => r.sourceId) })
      .map(view);
  }
  return result;
}

function hintFor(r: RefreshResult, wait: boolean): string {
  const parts: string[] = [];
  if (r.started.length > 0) {
    parts.push(
      wait
        ? r.stillRunning?.length
          ? `更新を開始しました（${r.stillRunning.join('、')}はまだ実行中）。少し後に get_today などを呼び直してください。`
          : '更新が終わりました。get_today などを呼び直して、新しい内容で答えてください。'
        : '更新を開始しました（数十秒〜数分かかります）。終わったあとに get_today などを呼び直すと新しい内容になります。wait=true なら終わるまで待てます。',
    );
  }
  const login = r.skipped.filter((s) => s.reason === 'auth_required');
  if (login.length > 0)
    parts.push(
      `${login.map((s) => s.sourceId).join('、')}は要ログインのため更新できませんでした。そこの情報は古い可能性があると伝えてください（ログインし直せるのは本人だけです）。`,
    );
  const recent = r.skipped.filter(
    (s) => s.reason === 'recently_synced' || s.reason === 'recently_forced',
  );
  if (recent.length > 0)
    parts.push('直近に取得済みの情報源は読み直していません（その内容が最新です）。');
  if (r.started.length === 0 && r.skipped.length === 0)
    parts.push(
      '対象の情報源がありませんでした。course・capabilities・sources を確認してください。',
    );
  return parts.join(' ');
}

interface RegisterDeps {
  uc: UniContext;
  /** How to start a forced run; default in-process (see SyncStarter). */
  startSync?: SyncStarter | undefined;
}

/** The registration function of the MCP server's `tool` helper (server.ts). */
export type ToolRegistrar = <S extends z.ZodRawShape>(
  name: string,
  meta: { title: string; description: string; remoteDescription?: string; readOnly?: boolean },
  shape: S,
  run: (
    args: z.infer<z.ZodObject<S>>,
  ) =>
    | { data: unknown; options?: EnvelopeOptions }
    | Promise<{ data: unknown; options?: EnvelopeOptions }>,
) => void;

export function registerRefreshTools(tool: ToolRegistrar, deps: RegisterDeps): void {
  tool('refresh_sources', REFRESH_TOOL, refreshShape, async (a) => {
    const data = await refreshSources(deps.uc, a, deps.startSync);
    return { data, options: { hint: hintFor(data, a.wait === true) } };
  });
}
