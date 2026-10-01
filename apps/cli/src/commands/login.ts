import { type AuthResult, supportsInteractiveLogin } from '@unicontext/connector-sdk';
import { AuthRequiredError } from '@unicontext/core';
import type { Command } from 'commander';
import { CliError, loginHint } from '../errors.js';
import { shortTime } from '../format/common.js';
import { action, type Harness } from '../harness.js';
import { runSync } from './sync.js';

const AUTH_LABELS: Record<AuthResult['status'], string> = {
  authenticated: '認証できました',
  not_required: 'ログインは不要です',
  auth_required: 'ログインが必要です',
  failed: '認証に失敗しました',
};

export function registerLogin(program: Command, h: Harness): void {
  program
    .command('login')
    .description('ソースにログインする / Authenticate a source (opens the browser when needed)')
    .argument('<source>', 'ソースID（例: microsoft365, livecampusu） / source id')
    .action(
      action(h, async (ctx, { args }) => {
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
            auth = await adapter.login();
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

        // After a successful login, let a running daemon pick the source up right away.
        let synced: Awaited<ReturnType<typeof runSync>> | undefined;
        let syncError: string | undefined;
        if (ok) {
          const daemon = await ctx.daemon();
          if (daemon) {
            try {
              synced = await runSync(ctx, sourceId, daemon);
            } catch (e) {
              syncError = e instanceof Error ? e.message : String(e);
            }
          }
        }

        if (ctx.json) {
          ctx.printJson({
            sourceId,
            auth,
            ...(synced ? { sync: synced.reports } : {}),
            ...(syncError ? { syncError } : {}),
          });
          return ok ? 0 : 1;
        }
        const s = ctx.style;
        ctx.out(
          `${sourceId}: ${ok ? s.green(AUTH_LABELS[auth.status]) : s.red(AUTH_LABELS[auth.status])}`,
        );
        if (auth.account) ctx.out(`  アカウント: ${ctx.text(auth.account)}`);
        if (auth.expiresAt) ctx.out(`  有効期限: ${shortTime(auth.expiresAt, tz)}`);
        if (auth.message) ctx.out(`  ${ctx.text(auth.message)}`);
        if (synced) {
          const r = synced.reports[0];
          if (r)
            ctx.out(
              `  デーモンで同期を実行しました（${r.ok ? '成功' : `失敗: ${ctx.text(r.error)}`}）`,
            );
        }
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
