import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  installService,
  serviceStatus,
  servicePlatform,
  uninstallService,
  type ServiceSpec,
} from '@unicontext/daemon/lib';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError, UsageError } from '../errors.js';
import { action, type Harness } from '../harness.js';

const PLATFORM_LABELS = {
  darwin: 'macOS（launchd）',
  win32: 'Windows（スタートアップのランチャー）',
  linux: 'Linux（systemdユーザーサービス）',
} as const;

/** Environment the service gets: data and config locations from the flags or the current env. */
export function serviceEnv(ctx: CliContext): Record<string, string> {
  const env: Record<string, string> = {};
  const dataDir = ctx.opts.dataDir
    ? path.resolve(ctx.opts.dataDir)
    : ctx.deps.env.UNICONTEXT_DATA_DIR;
  if (dataDir) env.UNICONTEXT_DATA_DIR = dataDir;
  // --data-dir keeps config.yaml next to the data, exactly like the CLI itself does
  const configDir = ctx.opts.config
    ? path.dirname(path.resolve(ctx.opts.config))
    : ctx.opts.dataDir
      ? path.resolve(ctx.opts.dataDir)
      : ctx.deps.env.UNICONTEXT_CONFIG_DIR;
  if (configDir) env.UNICONTEXT_CONFIG_DIR = configDir;
  return env;
}

function buildSpec(ctx: CliContext): ServiceSpec {
  if (ctx.dev) throw new UsageError('見本データ（--dev）のデーモンはサービスとして登録できません');
  const daemonScript = ctx.deps.daemonScript();
  if (!existsSync(daemonScript))
    throw new CliError(
      `デーモン本体が見つかりません: ${daemonScript}`,
      1,
      'リポジトリのルートで「pnpm build」を実行してください',
    );
  const env = serviceEnv(ctx);
  return {
    nodePath: ctx.deps.execPath,
    daemonScript,
    logDir: ctx.paths().logs,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

export function registerService(program: Command, h: Harness): void {
  const service = program
    .command('service')
    .description('ログイン時にデーモンを自動起動する設定 / Run the daemon automatically at login');

  service
    .command('install')
    .description('自動起動に登録する / Register the daemon to start at login')
    .action(
      action(h, async (ctx) => {
        const spec = buildSpec(ctx);
        const result = await installService(
          spec,
          ctx.deps.service?.deps,
          ctx.deps.service?.platform ?? servicePlatform(),
        );
        if (ctx.json) {
          ctx.printJson(result);
          return;
        }
        ctx.out(ctx.style.green(`自動起動を登録しました（${PLATFORM_LABELS[result.platform]}）`));
        for (const m of result.messages) ctx.out(`  ${ctx.text(m)}`);
      }),
    );

  service
    .command('uninstall')
    .description('自動起動の登録を解除する / Remove the automatic start')
    .action(
      action(h, async (ctx) => {
        const result = await uninstallService(
          ctx.deps.service?.deps,
          ctx.deps.service?.platform ?? servicePlatform(),
        );
        if (ctx.json) {
          ctx.printJson(result);
          return;
        }
        ctx.out(`自動起動の登録を解除しました（${PLATFORM_LABELS[result.platform]}）`);
        for (const m of result.messages) ctx.out(`  ${ctx.text(m)}`);
      }),
    );

  service
    .command('status')
    .description('自動起動の登録状況 / Show whether the automatic start is registered')
    .action(
      action(h, async (ctx) => {
        const status = await serviceStatus(
          ctx.deps.service?.deps,
          ctx.deps.service?.platform ?? servicePlatform(),
        );
        if (ctx.json) {
          ctx.printJson(status);
          return;
        }
        ctx.out(`方式: ${PLATFORM_LABELS[status.platform]}`);
        ctx.out(`登録: ${status.installed ? ctx.style.green('済み') : ctx.style.yellow('未登録')}`);
        ctx.out(`定義ファイル: ${status.file}`);
        if (status.installed) {
          const running =
            status.running === undefined ? '不明' : status.running ? '起動中' : '停止中';
          ctx.out(`状態: ${running}${status.detail ? `（${ctx.text(status.detail)}）` : ''}`);
        } else ctx.out('「unicontext service install」で登録できます');
      }),
    );
}
