import { loadConfig } from '@unicontext/core';
import { AI_BACKENDS, type AiBackend, UniContextAi } from '@unicontext/daemon/lib';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError, UsageError } from '../errors.js';
import { action, type Harness } from '../harness.js';

async function ai(ctx: CliContext): Promise<UniContextAi> {
  return new UniContextAi(await ctx.secrets(), loadConfig(ctx.configFile()).ai);
}

const LABEL: Record<AiBackend, string> = { anthropic: 'Claude', openai: 'ChatGPT（OpenAI）' };

/** `sk-ant-…` is Anthropic's; other `sk-…` keys are OpenAI's. */
function backendOfKey(key: string): AiBackend | undefined {
  if (key.startsWith('sk-ant-')) return 'anthropic';
  if (key.startsWith('sk-')) return 'openai';
  return undefined;
}

function parseBackend(value: string | undefined): AiBackend | undefined {
  if (value === undefined) return undefined;
  const v = value === 'claude' ? 'anthropic' : value === 'chatgpt' ? 'openai' : value;
  if (!(AI_BACKENDS as readonly string[]).includes(v))
    throw new UsageError(`「${value}」は使えません（claude / openaiのどちらか）`);
  return v as AiBackend;
}

export function registerAi(program: Command, h: Harness): void {
  const cmd = program
    .command('ai')
    .description(
      'UniContext自身が使うAPIキーの設定（ゲストの質問への回答など） / API keys used by UniContext itself',
    );

  cmd
    .command('set-key [provider]')
    .description('APIキーを保存する（claude / openai。省略するとキーから判断） / Store an API key')
    .option('--from-env <name>', '環境変数から読む / read it from an environment variable')
    .option('--stdin', '標準入力から読む（例: Get-Clipboard | …） / read it from stdin')
    .action(
      action<{ fromEnv?: string; stdin?: boolean }>(h, async (ctx, { args, opts }) => {
        const named = parseBackend(args[0] === undefined ? undefined : String(args[0]));
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
          key = await (ctx.deps.promptSecret ?? ctx.deps.prompt)(
            `${named ? LABEL[named] : 'Claude（sk-ant-…）かOpenAI（sk-…）'}のAPIキー: `,
          );
        }
        key = key.trim();
        const backend = backendOfKey(key);
        if (!backend || (named && named !== backend))
          throw new CliError(
            named === 'anthropic'
              ? 'Anthropic APIキー（sk-ant-で始まる値）ではありません'
              : named === 'openai'
                ? 'OpenAI APIキー（sk-で始まる値）ではありません'
                : 'APIキー（sk-ant-かsk-で始まる値）ではありません',
            1,
          );
        const secrets = await ctx.secrets();
        await secrets.set((await ai(ctx)).keyRefOf(backend), key);
        ctx.out(
          ctx.style.green(
            `${LABEL[backend]}のAPIキーを保存しました（${secrets.backend}）。確認: unicontext ai test`,
          ),
        );
      }),
    );

  cmd
    .command('remove-key [provider]')
    .description(
      '保存したAPIキーを消す（claude / openai、省略するとClaude） / Delete a stored API key',
    )
    .action(
      action(h, async (ctx, { args }) => {
        const backend =
          parseBackend(args[0] === undefined ? undefined : String(args[0])) ?? 'anthropic';
        const removed = await (await ctx.secrets()).delete((await ai(ctx)).keyRefOf(backend));
        ctx.out(
          removed
            ? `${LABEL[backend]}のAPIキーを消しました`
            : `${LABEL[backend]}のAPIキーは保存されていません`,
        );
      }),
    );

  cmd
    .command('status')
    .description('AIの設定を表示する / Show AI settings')
    .action(
      action(h, async (ctx) => {
        const cfg = loadConfig(ctx.configFile()).ai;
        const a = await ai(ctx);
        const ready = await a.backends();
        const out = {
          ...cfg,
          available: ready.length > 0,
          order: ready,
          model: a.model,
          openaiModel: a.openaiModel,
        };
        if (ctx.json) {
          ctx.printJson(out, { local: true });
          return;
        }
        const off =
          cfg.provider !== 'none' && cfg.provider !== 'anthropic' && cfg.provider !== 'openai';
        for (const b of AI_BACKENDS)
          ctx.out(
            `  ${b === 'anthropic' ? 'Claude:        ' : 'ChatGPT:       '}${
              ready.includes(b)
                ? `使えます（${a.modelOf(b)}・キーの値は表示しません）`
                : `使えません（unicontext ai set-key ${b === 'anthropic' ? 'claude' : 'openai'}${off ? `・ai.providerが${cfg.provider}` : ''}）`
            }`,
          );
        if (ready.length > 1)
          ctx.out(`  使う順:        ${ready.map((b) => LABEL[b]).join(' → ')}（失敗したら次）`);
        ctx.out(
          `  ゲストの質問:  ${cfg.guestQuestions ? `受け付ける（1人${cfg.guestQuestionsPerDay}回/日・全体${cfg.totalQuestionsPerDay}回/日）` : '受け付けない'}`,
        );
      }),
    );

  cmd
    .command('test')
    .description('保存したキーとモデルで1回ずつ呼んでみる / Make one call with each stored key')
    .action(
      action(h, async (ctx) => {
        const a = await ai(ctx);
        const ready = await a.backends();
        if (ready.length === 0)
          throw new CliError('AIを使えません（確認: unicontext ai status）', 1);
        let failed = false;
        for (const b of ready) {
          try {
            ctx.out(ctx.style.green(`${a.modelOf(b)}: ${await a.ping(b)}`));
          } catch (e) {
            failed = true;
            ctx.err(
              `${a.modelOf(b)}: 失敗しました（${ctx.text(e instanceof Error ? e.message : String(e))}）`,
            );
          }
        }
        return failed ? 1 : 0;
      }),
    );
}
