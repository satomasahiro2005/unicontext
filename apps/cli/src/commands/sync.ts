import type { DaemonClient } from '@unicontext/daemon/lib';
import { requireSource } from '@unicontext/daemon/lib';
import type {
  SourceInfo,
  SourcesResponse,
  SyncJobResponse,
  SyncResponse,
  SyncRunReport,
} from '@unicontext/daemon/api-types';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { colorState, stateLabel } from '../format/common.js';
import { printTable } from '../format/views.js';
import { action, type Harness } from '../harness.js';

const MODE_LABELS: Record<string, string> = {
  initial: '初回',
  incremental: '差分',
  full: '全件',
};

export interface SyncOutcome {
  via: 'daemon' | 'in-process';
  reports: SyncRunReport[];
  /** Sources that were skipped because their connector could not be loaded or is disabled. */
  skipped: { sourceId: string; reason: string }[];
}

function pickSources(
  all: readonly SourceInfo[],
  requested: string | undefined,
): { ids: string[]; skipped: { sourceId: string; reason: string }[] } {
  if (requested) return { ids: [requested], skipped: [] };
  const ids: string[] = [];
  const skipped: { sourceId: string; reason: string }[] = [];
  for (const s of all) {
    if (!s.enabled) continue;
    if (!s.loaded) skipped.push({ sourceId: s.sourceId, reason: s.loadError ?? '読み込めません' });
    else ids.push(s.sourceId);
  }
  return { ids, skipped };
}

const POLL_MS = 1_000;

/**
 * Start a sync in the daemon and wait for its report. The daemon answers right away with a job
 * (202) and the job is polled, so a sync that runs for minutes (LiveCampusU) never hits the HTTP
 * timeout. A daemon without background jobs answers with the report itself.
 */
export async function syncViaDaemon(
  daemon: DaemonClient,
  sourceId: string,
  options: { pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<SyncRunReport> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = await daemon.post<SyncJobResponse | SyncResponse>(
    `/api/v1/sources/${encodeURIComponent(sourceId)}/sync?wait=0`,
  );
  if ('report' in started) return started.report;
  let job = started.job;
  while (job.state === 'running') {
    await sleep(options.pollMs ?? POLL_MS);
    job = (await daemon.get<SyncJobResponse>(`/api/v1/sync-jobs/${encodeURIComponent(job.id)}`))
      .job;
  }
  if (job.report) return job.report;
  throw new Error(job.error ?? `sync of ${sourceId} failed`);
}

/** Sequentially sync the given source (or every enabled one), through the daemon when it runs. */
export async function runSync(
  ctx: CliContext,
  requested: string | undefined,
  daemon: DaemonClient | undefined,
): Promise<SyncOutcome> {
  const reports: SyncRunReport[] = [];
  if (daemon) {
    const { sources } = await daemon.get<SourcesResponse>('/api/v1/sources');
    const { ids, skipped } = pickSources(sources, requested);
    for (const id of ids) reports.push(await syncViaDaemon(daemon, id));
    return { via: 'daemon', reports, skipped };
  }
  const rt = await ctx.runtime();
  if (requested) requireSource(rt, requested);
  const { ids, skipped } = pickSources(rt.describeSources(), requested);
  for (const id of ids) reports.push(await rt.uc.sync.sync(id));
  return { via: 'in-process', reports, skipped };
}

export function registerSync(program: Command, h: Harness): void {
  program
    .command('sync')
    .description(
      'ソースを同期する（省略時は有効な全ソース） / Sync one source or all enabled sources',
    )
    .argument('[source]', 'ソースID / source id')
    .action(
      action(h, async (ctx, { args }) => {
        const requested = typeof args[0] === 'string' ? args[0] : undefined;
        const daemon = await ctx.daemon();
        const outcome = await runSync(ctx, requested, daemon);
        const failed = outcome.reports.filter((r) => !r.ok);
        if (ctx.json) {
          ctx.printJson(outcome);
          return failed.length > 0 ? 1 : 0;
        }
        if (outcome.reports.length === 0) {
          ctx.out('同期できるソースがありません');
          ctx.out(
            ctx.style.dim(
              'config.yamlのsourcesを確認してください（「unicontext sources」で一覧できます）',
            ),
          );
        } else {
          ctx.out(
            ctx.style.dim(
              outcome.via === 'daemon'
                ? 'デーモン経由で同期しました'
                : 'デーモンが起動していないため、この場で同期しました',
            ),
          );
          printTable(
            ctx,
            [
              { header: 'ソース', value: (r) => r.sourceId },
              { header: 'モード', value: (r) => MODE_LABELS[r.mode] ?? r.mode },
              { header: '追加', value: (r) => String(r.raw.inserted), align: 'right' },
              { header: '更新', value: (r) => String(r.raw.updated), align: 'right' },
              { header: '削除', value: (r) => String(r.raw.deleted), align: 'right' },
              { header: '変更', value: (r) => String(r.normalized.changeEvents), align: 'right' },
              {
                header: '状態',
                value: (r) => stateLabel(r.health),
                style: (padded, r) => colorState(ctx.style, r.health, padded),
              },
              { header: 'エラー', value: (r) => ctx.text(r.error), max: 60 },
            ],
            outcome.reports,
          );
        }
        for (const s of outcome.skipped)
          ctx.err(`ソース「${s.sourceId}」はスキップしました: ${ctx.text(s.reason)}`);
        for (const r of failed) {
          if (r.health === 'auth_required')
            ctx.err(
              `ソース「${r.sourceId}」: 「unicontext login ${r.sourceId}」でログインしてください`,
            );
        }
        return failed.length > 0 ? 1 : 0;
      }),
    );
}
