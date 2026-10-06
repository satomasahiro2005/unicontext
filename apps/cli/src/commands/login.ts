import { type AuthResult, supportsInteractiveLogin } from '@unicontext/connector-sdk';
import { AuthRequiredError } from '@unicontext/core';
import type { DaemonClient } from '@unicontext/daemon/lib';
import type {
  SyncJob,
  SyncJobResponse,
  SyncResponse,
  SyncRunReport,
} from '@unicontext/daemon/api-types';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError, loginHint } from '../errors.js';
import { shortTime } from '../format/common.js';
import { action, type Harness } from '../harness.js';
import { promptMissingSecrets } from './secrets.js';

const AUTH_LABELS: Record<AuthResult['status'], string> = {
  authenticated: '認証できました',
  not_required: 'ログインは不要です',
  auth_required: 'ログインが必要です',
  failed: '認証に失敗しました',
};

/** After a login the daemon is only asked once: a busy or absent one must not hold the student. */
const DAEMON_DISCOVERY_MS = 10_000;
/** `--wait-sync`: a progress line this often, and give up waiting after the cap. */
const PROGRESS_EVERY_MS = 10_000;
const WAIT_SYNC_CAP_MS = 10 * 60_000;
const POLL_MS = 1_000;

interface DaemonDiscovery {
  daemon: DaemonClient | undefined;
  /** pid of a daemon process that is alive but did not answer in time. */
  unresponsivePid: number | undefined;
}

async function discoverDaemon(ctx: CliContext): Promise<DaemonDiscovery> {
  let waitedFor: number | undefined;
  const daemon = await ctx.deps.daemonClient({
    paths: ctx.paths(),
    secrets: await ctx.secrets(),
    dev: ctx.dev,
    waitMs: DAEMON_DISCOVERY_MS,
    onWait: (pid) => {
      waitedFor = pid;
    },
  });
  return { daemon, unresponsivePid: daemon ? undefined : waitedFor };
}

interface StartedSync {
  /** The background job (current daemons). */
  job?: SyncJob;
  /** The finished report (an older daemon that ran the sync before answering). */
  report?: SyncRunReport;
}

async function startSync(daemon: DaemonClient, sourceId: string): Promise<StartedSync> {
  const started = await daemon.post<SyncJobResponse | SyncResponse>(
    `/api/v1/sources/${encodeURIComponent(sourceId)}/sync?wait=0`,
  );
  return 'report' in started ? { report: started.report } : { job: started.job };
}

/** `--wait-sync`: poll the job; a progress line every 10 s; stop waiting after 10 min. */
async function waitForJob(
  ctx: CliContext,
  daemon: DaemonClient,
  first: SyncJob,
): Promise<{ job: SyncJob; timedOut: boolean }> {
  const startedAt = ctx.deps.now().getTime();
  let job = first;
  let polls = 0;
  let nextProgress = PROGRESS_EVERY_MS;
  while (job.state === 'running') {
    // The larger of the counted and the real time: instant fake sleeps cannot spin forever.
    const elapsed = Math.max(polls * POLL_MS, ctx.deps.now().getTime() - startedAt);
    if (elapsed >= WAIT_SYNC_CAP_MS) return { job, timedOut: true };
    if (elapsed >= nextProgress) {
      if (!ctx.json) ctx.err(`同期の完了を待っています…（${Math.round(elapsed / 1000)}秒経過）`);
      nextProgress = elapsed + PROGRESS_EVERY_MS;
    }
    await ctx.deps.sleep(POLL_MS);
    polls++;
    job = (await daemon.get<SyncJobResponse>(`/api/v1/sync-jobs/${encodeURIComponent(job.id)}`)).job;
  }
  return { job, timedOut: false };
}

export function registerLogin(program: Command, h: Harness): void {
  program
    .command('login')
    .description('ソースにログインする / Authenticate a source (opens the browser when needed)')
    .argument('<source>', 'ソースID（例: microsoft365, livecampusu） / source id')
    .option(
      '--wait-sync',
      'ログイン後にデーモンの同期が終わるまで待つ（最大10分） / wait for the daemon sync to finish',
    )
    .action(
      action(h, async (ctx, { args, opts }) => {
        const sourceId = String(args[0]);
        const rt = await ctx.runtime();
        const info = rt.sourceInfo.get(sourceId);
        if (info && !info.enabled)
          throw new CliError(
            `ソース「${sourceId}」は無効になっています`,
            1,
            `config.yamlのsources.${sourceId}でenabled: trueにしてください`,
          );
        if (info?.loadError)
          throw new CliError(
            `ソース「${sourceId}」のコネクタを読み込めません: ${ctx.text(info.loadError)}`,
            1,
            'コネクタをインストールするか、「unicontext doctor」で原因を確認してください',
          );
        let adapter;
        try {
          adapter = rt.uc.sync.getSource(sourceId).adapter;
        } catch {
          throw new CliError(
            `ソース「${sourceId}」は登録されていません`,
            1,
            `config.yamlのsourcesにsources.${sourceId}を追加してください（「unicontext sources」で一覧できます）`,
          );
        }
        if (ctx.noKeychain && !ctx.json)
          ctx.err(
            '注意: キーチェーンを使わない設定のため、ログイン情報はこのコマンドの終了とともに失われます',
          );
        // Token-based sources (envSecrets / headerSecrets, e.g. an MCP server): ask for the values
        // the keychain does not hold yet, without echo, before the adapter tries to connect.
        const enteredSecrets = await promptMissingSecrets(ctx, sourceId);
        let auth: AuthResult;
        try {
          // authenticate() never prompts (connector-sdk contract); when the stored session is not
          // enough, adapters with an interactive flow (OAuth / SSO + MFA) open the browser here.
          auth = await adapter.authenticate();
          if (
            (auth.status === 'auth_required' || auth.status === 'failed') &&
            supportsInteractiveLogin(adapter)
          ) {
            if (!ctx.json)
              ctx.err('ブラウザを開きます。大学のアカウントでログインを済ませてください…');
            auth = await adapter.login(ctx.json ? {} : { notify: (m) => ctx.err(ctx.text(m)) });
          }
        } catch (e) {
          if (e instanceof AuthRequiredError)
            throw new CliError(
              `ログインできませんでした: ${ctx.text(e.message)}`,
              1,
              loginHint(sourceId),
            );
          throw e;
        }
        const ok = auth.status === 'authenticated' || auth.status === 'not_required';
        const tz = rt.uc.timezone;
        const s = ctx.style;
        const waitSync = opts.waitSync === true;

        // The result comes first: a sign-in that took minutes must be confirmed at once, not after
        // the daemon (which may be busy or slow to answer) has been contacted.
        if (!ctx.json) {
          if (enteredSecrets.length > 0)
            ctx.out(`${sourceId}: 秘密情報を保存しました（${enteredSecrets.join(', ')}）`);
          ctx.out(
            `${sourceId}: ${ok ? s.green(AUTH_LABELS[auth.status]) : s.red(AUTH_LABELS[auth.status])}`,
          );
          if (auth.account) ctx.out(`  アカウント: ${ctx.text(auth.account)}`);
          if (auth.expiresAt) ctx.out(`  有効期限: ${shortTime(auth.expiresAt, tz)}`);
          if (auth.message) ctx.out(`  ${ctx.text(auth.message)}`);
        }

        // After a successful login, let a running daemon pick the source up right away, without
        // waiting for it (a source such as the VPN files can sync for many minutes).
        let syncJob: SyncJob | undefined;
        let report: SyncRunReport | undefined;
        let syncError: string | undefined;
        let daemonNote: string | undefined;
        let timedOut = false;
        if (ok) {
          const { daemon, unresponsivePid } = await discoverDaemon(ctx);
          if (daemon) {
            try {
              const started = await startSync(daemon, sourceId);
              syncJob = started.job;
              report = started.report;
              if (syncJob && !ctx.json)
                ctx.out(`  デーモンで同期を開始しました（ジョブ ${ctx.text(syncJob.id)}）`);
              if (syncJob && waitSync) {
                const done = await waitForJob(ctx, daemon, syncJob);
                syncJob = done.job;
                timedOut = done.timedOut;
                report = done.job.report;
                if (done.job.state === 'failed')
                  syncError = done.job.error ?? `sync of ${sourceId} failed`;
              }
            } catch (e) {
              syncError = e instanceof Error ? e.message : String(e);
            }
          } else if (unresponsivePid !== undefined) {
            daemonNote = `UniContextのデーモン（pid ${unresponsivePid}）が${DAEMON_DISCOVERY_MS / 1000}秒たっても応答しないため、同期は始めていません（ログインは済んでいます）`;
          }
        }

        if (ctx.json) {
          ctx.printJson({
            sourceId,
            auth,
            ...(enteredSecrets.length > 0 ? { stored: enteredSecrets } : {}),
            ...(syncJob ? { syncJob } : {}),
            ...(report ? { sync: [{ ...report }] } : {}),
            ...(timedOut ? { syncWaitTimedOut: true } : {}),
            ...(daemonNote ? { daemonNote } : {}),
            ...(syncError ? { syncError } : {}),
          });
          return ok ? 0 : 1;
        }
        if (report)
          ctx.out(
            `  デーモンで同期を実行しました（${report.ok ? '成功' : `失敗: ${ctx.text(report.error)}`}）`,
          );
        if (timedOut && syncJob)
          ctx.out(
            `  同期は10分たっても終わっていません。デーモンの中で続いています（ジョブ ${ctx.text(syncJob.id)}）`,
          );
        if (daemonNote) ctx.err(ctx.text(daemonNote));
        if (syncError) ctx.err(`警告: デーモンでの同期に失敗しました: ${ctx.text(syncError)}`);
        if (!ok) {
          ctx.err(
            `ヒント: ${loginHint(sourceId)}。ブラウザでの操作が完了していることを確認してください`,
          );
          return 1;
        }
        return 0;
      }),
    );
}
