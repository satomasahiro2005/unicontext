import { loadConfig } from '@unicontext/core';
import { UniContextAi } from '@unicontext/daemon/lib';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError, UsageError } from '../errors.js';
import { action, type Harness } from '../harness.js';

async function ai(ctx: CliContext): Promise<UniContextAi> {
  return new UniContextAi(await ctx.secrets(), loadConfig(ctx.configFile()).ai);
}

export function registerAi(program: Command, h: Harness): void {
  const cmd = program
    .command('ai')
    .description(
      'UniContext自身が使うClaude APIの設定（ゲストの質問への回答など） / Claude API used by UniContext itself',
    );

  cmd
    .command('set-key')
    .description(
      'Anthropic APIキーを保存する（Claude MaxのAPIクレジットが使える） / Store the Anthropic API key',
    )
    .option('--from-env <name>', '環境変数から読む / read it from an environment variable')
    .option('--stdin', '標準入力から読む（例: Get-Clipboard | …） / read it from stdin')
    .action(
      action<{ fromEnv?: string; stdin?: boolean }>(h, async (ctx, { opts }) => {
        let key: string;
        if (opts.fromEnv) {
          key = ctx.deps.env[opts.fromEnv] ?? '';
          if (!key) throw new UsageError(`環境変数${opts.fromEnv}が空です`);
        } else {
          if (!opts.stdin && !ctx.canPrompt())
            throw new UsageError(
              '対話できない環境ではキーを入力できません',
              '端末から実行するか --stdin / --from-env <環境変数名> を使ってください',
            );
          key = await (ctx.deps.promptSecret ?? ctx.deps.prompt)('Anthropic APIキー（sk-ant-…）: ');
        }
        key = key.trim();
        if (!key.startsWith('sk-ant-'))
          throw new CliError('Anthropic APIキー（sk-ant-で始まる値）ではありません', 1);
        const secrets = await ctx.secrets();
        await secrets.set((await ai(ctx)).keyRef, key);
        ctx.out(
          ctx.style.green(`APIキーを保存しました（${secrets.backend}）。確認: unicontext ai test`),
        );
      }),
    );

  cmd
    .command('remove-key')
    .description('保存したAPIキーを消す（AIの機能が止まる） / Delete the stored API key')
    .action(
      action(h, async (ctx) => {
        const removed = await (await ctx.secrets()).delete((await ai(ctx)).keyRef);
        ctx.out(removed ? 'APIキーを消しました' : 'APIキーは保存されていません');
      }),
    );

  cmd
    .command('status')
    .description('AIの設定を表示する / Show AI settings')
    .action(
      action(h, async (ctx) => {
        const cfg = loadConfig(ctx.configFile()).ai;
        const a = await ai(ctx);
        const out = { ...cfg, available: await a.available(), model: a.model };
        if (ctx.json) ctx.printJson(out, { local: true });
        else {
          ctx.out(
            `  Claude:        ${out.available ? '使えます（APIキーあり・値は表示しません）' : `使えません（unicontext ai set-key${cfg.provider !== 'none' && cfg.provider !== 'anthropic' ? `・ai.providerが${cfg.provider}` : ''}）`}`,
          );
          ctx.out(`  モデル:        ${a.model}`);
          ctx.out(
            `  ゲストの質問:  ${cfg.guestQuestions ? `受け付ける（1人${cfg.guestQuestionsPerDay}回/日・全体${cfg.totalQuestionsPerDay}回/日）` : '受け付けない'}`,
          );
        }
      }),
    );

  cmd
    .command('test')
    .description('APIキーとモデルで1回呼んでみる / Make one call with the key and model')
    .action(
      action(h, async (ctx) => {
        const a = await ai(ctx);
        if (!(await a.available()))
          throw new CliError('Claudeを使えません（確認: unicontext ai status）', 1);
        const text = await a.ping();
        ctx.out(ctx.style.green(`${a.model}: ${text}`));
      }),
    );
}
