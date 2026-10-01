import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import {
  type DaemonClient,
  DaemonAlreadyRunningError,
  isProcessAlive,
  lockFile,
  readLock,
} from '@unicontext/daemon/lib';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError, UsageError } from '../errors.js';
import { shortTime } from '../format/common.js';
import { action, type Harness } from '../harness.js';
import { parsePositiveInt } from '../parse.js';
import { daemonInfo } from './status.js';

/** A fresh discovery (ctx.daemon() is memoized and would hide a daemon that just started). */
async function probe(ctx: CliContext): Promise<DaemonClient | undefined> {
  return ctx.deps.daemonClient({
    paths: ctx.paths(),
    secrets: await ctx.secrets(),
    dev: ctx.dev,
  });
}

/** Poll (every 250 ms) until `done` is true; gives up after roughly `timeoutMs`. */
async function waitFor(
  ctx: CliContext,
  timeoutMs: number,
  done: () => Promise<boolean>,
): Promise<boolean> {
  const attempts = Math.max(1, Math.ceil(timeoutMs / 250));
  for (let i = 0; i < attempts; i++) {
    if (await done()) return true;
    await ctx.deps.sleep(250);
  }
  return done();
}

function daemonFlags(ctx: CliContext, port: number | undefined): string[] {
  const flags: string[] = [];
  if (ctx.opts.dataDir) flags.push('--data-dir', path.resolve(ctx.opts.dataDir));
  if (ctx.opts.config) flags.push('--config', path.resolve(ctx.opts.config));
  if (ctx.opts.keychain === false) flags.push('--no-keychain');
  if (ctx.dev) flags.push('--dev');
  if (port !== undefined) flags.push('--port', String(port));
  return flags;
}

export function registerDaemon(program: Command, h: Harness): void {
  const daemon = program
    .command('daemon')
    .description(
      'バックグラウンドのデーモンを操作する / Control the background daemon (unicontextd)',
    );

  daemon
    .command('start')
    .description('デーモンを起動する / Start the daemon')
    .option('--foreground', 'この端末で実行し続ける / run in this terminal until stopped')
    .option('--port <n>', '待ち受けポート（127.0.0.1のみ） / listen port', (v) =>
      parsePositiveInt(v, '--port', 65535),
    )
    .action(
      action<{ foreground?: boolean; port?: number }>(h, async (ctx, { opts }) => {
        const info = await daemonInfo(ctx);
        if (info.running) {
          if (ctx.json) ctx.printJson({ started: false, ...info });
          else ctx.out(`既に起動しています: ${info.url}（pid ${info.pid}）`);
          return 0;
        }
        if (opts.foreground) {
          try {
            const running = await ctx.deps.startDaemon({
              handleSignals: true,
              ...(opts.port !== undefined ? { port: opts.port } : {}),
              ...(ctx.opts.dataDir ? { dataDir: path.resolve(ctx.opts.dataDir) } : {}),
              ...(ctx.opts.config ? { configFile: path.resolve(ctx.opts.config) } : {}),
              ...(ctx.dev ? { dev: true } : {}),
              ...(ctx.opts.keychain === false ? { noKeychain: true } : {}),
            });
            ctx.out(`unicontextd listening on ${running.url}${ctx.dev ? ' (dev seed data)' : ''}`);
            await running.stopped;
            return 0;
          } catch (e) {
            if (e instanceof DaemonAlreadyRunningError) {
              ctx.out(e.message);
              return 0;
            }
            throw e;
          }
        }
        if (ctx.dev)
          throw new UsageError(
            '見本データのデーモンはバックグラウンドで起動できません',
            '「unicontext --dev daemon start --foreground」で端末に表示したまま起動してください',
          );
        const script = ctx.deps.daemonScript();
        if (!existsSync(script))
          throw new CliError(
            `デーモン本体が見つかりません: ${script}`,
            1,
            'リポジトリのルートで「pnpm build」を実行してください',
          );
        ctx.deps.spawnDaemon(script, daemonFlags(ctx, opts.port));
        let client: DaemonClient | undefined;
        const up = await waitFor(ctx, ctx.deps.daemonStartTimeoutMs ?? 10_000, async () => {
          client = await probe(ctx);
          return client !== undefined;
        });
        if (!up || !client)
          throw new CliError(
            'デーモンの起動を確認できませんでした',
            1,
            `ログ（${path.join(ctx.paths().logs, 'unicontextd.log')}）を確認するか、「unicontext daemon start --foreground」で原因を表示してください`,
          );
        const health = await client.health();
        if (ctx.json) ctx.printJson({ started: true, url: client.baseUrl, pid: health.pid });
        else
          ctx.out(
            ctx.style.green(`デーモンを起動しました: ${client.baseUrl}（pid ${health.pid}）`),
          );
        return 0;
      }),
    );

  daemon
    .command('stop')
    .description('デーモンを停止する / Stop the daemon')
    .option(
      '--force',
      'APIが応答しなくてもロックファイルのpidを終了する / kill the lock file pid even when the API does not answer',
    )
    .action(
      action<{ force?: boolean }>(h, async (ctx, { opts }) => {
        const paths = ctx.paths();
        const client = await probe(ctx);
        const lock = readLock(paths);
        let stopped = false;
        let how: 'api' | 'signal' | undefined;
        if (client) {
          try {
            await client.post('/api/v1/daemon/stop');
            how = 'api';
            stopped = await waitFor(ctx, 5_000, async () => (await probe(ctx)) === undefined);
          } catch {
            // no token or an old daemon: fall back to the pid in the lock file
          }
        }
        if (!stopped) {
          const pid = lock?.pid;
          if (pid && isProcessAlive(pid)) {
            // Only a pid that answered as the daemon (discover checks health.pid against the lock)
            // is killed without --force: after a crash or reboot the pid may belong to any process.
            if (!client && !opts.force)
              throw new CliError(
                `デーモンが応答しません（ロックファイルのpid ${pid}）`,
                1,
                'このpidは別のプロセスに再利用されている可能性があるため停止しませんでした。デーモンであることを確認してから「unicontext daemon stop --force」を実行してください',
              );
            try {
              ctx.deps.killProcess(pid);
              how = 'signal';
              stopped = await waitFor(ctx, 5_000, async () => !isProcessAlive(pid));
            } catch (e) {
              throw new CliError(
                `デーモン（pid ${pid}）を停止できませんでした: ${e instanceof Error ? e.message : String(e)}`,
                1,
                'タスクマネージャーなどで該当のプロセスを終了してください',
              );
            }
            if (stopped) {
              try {
                unlinkSync(lockFile(paths)); // a killed daemon cannot remove its own lock
              } catch {
                // already gone
              }
            }
          } else if (!client) {
            if (ctx.json) ctx.printJson({ running: false, stopped: false });
            else ctx.out('デーモンは起動していません');
            return 0;
          }
        }
        if (!stopped)
          throw new CliError(
            'デーモンが停止しませんでした',
            1,
            '「unicontext daemon status」で状態を確認してください',
          );
        if (ctx.json) ctx.printJson({ running: false, stopped: true, via: how });
        else ctx.out(ctx.style.green('デーモンを停止しました'));
        return 0;
      }),
    );

  daemon
    .command('status')
    .description('デーモンの状態を表示する / Show whether the daemon is running')
    .action(
      action(h, async (ctx) => {
        const info = await daemonInfo(ctx);
        if (ctx.json) {
          ctx.printJson(info);
          return;
        }
        const s = ctx.style;
        if (info.running) {
          ctx.out(`デーモン: ${s.green('稼働中')}`);
          ctx.out(`  URL: ${info.url}`);
          ctx.out(`  pid: ${info.pid}`);
          ctx.out(`  バージョン: ${info.version}`);
          ctx.out(`  起動: ${shortTime(info.startedAt, 'Asia/Tokyo')}`);
          if (info.dev) ctx.out('  見本データで動作中です');
        } else {
          ctx.out(`デーモン: ${s.yellow('停止中')}`);
          if (info.lock)
            ctx.out(
              `  ロックファイルは残っていますが応答がありません（pid ${info.lock.pid}${info.lock.port ? `、ポート${info.lock.port}` : ''}）`,
            );
          ctx.out('  「unicontext daemon start」で起動できます');
        }
      }),
    );
}
