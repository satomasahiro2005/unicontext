import { readLock, type LockInfo } from '@unicontext/daemon/lib';
import type { HealthResponse, SourceInfo } from '@unicontext/daemon/api-types';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { shortTime } from '../format/common.js';
import { printSection, printSources } from '../format/views.js';
import { action, type Harness } from '../harness.js';
import { VERSION } from '../version.js';

export interface DaemonInfo {
  running: boolean;
  url: string | undefined;
  port: number | undefined;
  pid: number | undefined;
  version: string | undefined;
  startedAt: string | undefined;
  dev: boolean | undefined;
  /** Contents of unicontextd.lock when the file exists (possibly stale). */
  lock: LockInfo | undefined;
}

/** Ask the daemon (lock file + /api/v1/health) whether it is up. */
export async function daemonInfo(ctx: CliContext): Promise<DaemonInfo> {
  const lock = ctx.dev ? undefined : readLock(ctx.paths());
  const client = await ctx.daemon();
  let health: HealthResponse | undefined;
  if (client) {
    try {
      health = await client.health();
    } catch {
      health = undefined;
    }
  }
  if (!client || !health) {
    return {
      running: false,
      url: undefined,
      port: lock?.port,
      pid: lock?.pid,
      version: undefined,
      startedAt: lock?.startedAt,
      dev: undefined,
      lock,
    };
  }
  const port = Number(new URL(client.baseUrl).port) || undefined;
  return {
    running: true,
    url: client.baseUrl,
    port,
    pid: health.pid,
    version: health.version,
    startedAt: health.startedAt,
    dev: health.dev,
    lock,
  };
}

export interface StatusReport {
  version: string;
  dev: boolean;
  dataDir: string;
  configFile: string;
  daemon: DaemonInfo;
  sources: SourceInfo[];
  openConflicts: number;
  pendingProposals: number;
  suggestedLinks: number;
}

export function registerStatus(program: Command, h: Harness): void {
  program
    .command('status')
    .description('デーモン・ソース・確認待ちの状態 / Daemon, sources and items awaiting you')
    .action(
      action(h, async (ctx) => {
        const rt = await ctx.runtime();
        const daemon = await daemonInfo(ctx);
        const report: StatusReport = {
          version: VERSION,
          dev: rt.dev,
          dataDir: rt.paths.root,
          configFile: rt.paths.configFile,
          daemon,
          sources: rt.describeSources(),
          openConflicts: rt.uc.context.admin().conflicts.length,
          pendingProposals: rt.proposals.list({ status: 'pending' }).length,
          suggestedLinks: rt.uc.identity.listLinks({ status: 'suggested' }).length,
        };
        if (ctx.json) {
          ctx.printJson(report);
          return;
        }
        const s = ctx.style;
        const tz = rt.uc.timezone;
        ctx.out(
          s.bold(`UniContext ${VERSION}`) + (report.dev ? s.dim('（開発用の見本データ）') : ''),
        );
        ctx.out(`データ: ${report.dataDir}`);
        if (daemon.running)
          ctx.out(
            `デーモン: ${s.green('稼働中')} ${daemon.url}（pid ${daemon.pid}、v${daemon.version}、${shortTime(daemon.startedAt, tz)}起動）`,
          );
        else
          ctx.out(`デーモン: ${s.yellow('停止中')}（「unicontext daemon start」で起動できます）`);
        printSection(ctx, 'ソース', report.sources.length);
        printSources(ctx, report.sources, tz);
        printSection(ctx, '確認が必要なもの');
        ctx.out(
          `  競合: ${report.openConflicts > 0 ? s.red(`${report.openConflicts}件`) : '0件'}${report.openConflicts > 0 ? s.dim('（「unicontext conflicts」で確認）') : ''}`,
        );
        ctx.out(
          `  AIの提案: ${report.pendingProposals}件、紐付けの候補: ${report.suggestedLinks}件${report.pendingProposals + report.suggestedLinks > 0 ? s.dim('（「unicontext confirm --list」で確認）') : ''}`,
        );
      }),
    );
}
