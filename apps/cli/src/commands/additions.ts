import { ADDITION_STATUSES, type AdditionStatus } from '@unicontext/canonical-model';
import type { AdditionView } from '@unicontext/context-engine';
import { NotFoundError } from '@unicontext/core';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError, UsageError } from '../errors.js';
import { shortTime } from '../format/common.js';
import { printSection, printTable } from '../format/views.js';
import { action, type Harness } from '../harness.js';

/*
 * `unicontext additions`: what AI clients (ChatGPT through the remote MCP, local MCP clients)
 * wrote from lecture recordings. Stored in UniContext only; the owner confirms them (they become
 * the user's own facts and win over the sources) or rejects them (removed again).
 */

const STATUS_LABELS: Record<AdditionStatus, string> = {
  unconfirmed: '未確認',
  confirmed: '確認済み',
  rejected: '却下',
  retracted: '取り消し',
};

const KIND_LABELS: Record<AdditionView['kind'], string> = {
  lecture: '講義の記録',
  assignment: '課題',
  report: 'レポート',
  quiz: '小テスト',
  exam: '試験',
  prep: '準備',
  note: 'メモ',
  task: 'やること',
  condition: '本人の条件',
  session_rule: 'グループ別の日程',
  external_signal: 'メール・予定表の連絡',
};

function printAddition(ctx: CliContext, a: AdditionView, tz: string): void {
  const s = ctx.style;
  ctx.out(
    s.bold(`${KIND_LABELS[a.kind]}「${ctx.text(a.title)}」`) +
      s.dim(`（${STATUS_LABELS[a.status]}）`),
  );
  ctx.out(`  ID: ${a.id}`);
  if (a.course) ctx.out(`  科目: ${ctx.text(a.course.title)}`);
  if (a.dueText) ctx.out(`  日時: ${a.dueText}`);
  if (a.attachedTo)
    ctx.out(`  大学側の項目: ${ctx.text(a.attachedTo.title)}（${a.attachedTo.source ?? '不明'}）`);
  if (a.evidence) ctx.out(`  根拠: 「${ctx.text(a.evidence)}」`);
  ctx.out(
    `  出典: ${ctx.text(a.source)}${a.recordingTimestamp ? ` ${a.recordingTimestamp}` : ''}（${ctx.text(a.client.name ?? a.client.id)}が${shortTime(a.createdAt, tz)}に追加）`,
  );
  for (const c of a.conflicts)
    ctx.out(
      s.yellow(
        `  食い違い: ${c.values.map((v) => `${typeof v.value === 'string' ? v.value : JSON.stringify(v.value)}（${v.source}）`).join(' / ')}`,
      ),
    );
}

export function registerAdditions(program: Command, h: Harness): void {
  const additions = program
    .command('additions')
    .description(
      'AIが追加した締切・やること・メモ・講義の記録（チャットで登録・録音から）を確認する / Review what AI clients added from chats and lecture recordings',
    )
    .option('--all', 'すべての状態を表示する / every status')
    .option(
      '--status <status>',
      'unconfirmed | confirmed | rejected | retracted（既定: unconfirmed）',
    )
    .action(
      action<{ all?: boolean; status?: string }>(h, async (ctx, { opts }) => {
        if (opts.status && !(ADDITION_STATUSES as readonly string[]).includes(opts.status))
          throw new UsageError(`不明な状態です: ${opts.status}`, ADDITION_STATUSES.join(' / '));
        const rt = await ctx.runtime();
        const list = rt.uc.additions.list(
          opts.all
            ? {}
            : { statuses: [(opts.status as AdditionStatus | undefined) ?? 'unconfirmed'] },
        );
        if (ctx.json) {
          ctx.printJson({ additions: list });
          return 0;
        }
        printSection(ctx, 'AIが追加した内容（チャットで登録・録音から）', list.length);
        if (list.length === 0) {
          ctx.out(`  ${ctx.style.dim('なし')}`);
          return 0;
        }
        printTable(
          ctx,
          [
            { header: 'ID', value: (a) => a.id },
            { header: '種類', value: (a) => KIND_LABELS[a.kind] },
            { header: '由来', value: (a) => a.label },
            { header: '科目', value: (a) => ctx.text(a.course?.title ?? ''), max: 20 },
            { header: '内容', value: (a) => ctx.text(a.title), max: 36 },
            { header: '日時', value: (a) => a.dueText ?? '' },
            { header: '状態', value: (a) => STATUS_LABELS[a.status] },
            {
              header: '注意',
              value: (a) => (a.conflicts.length > 0 ? '大学側と食い違い' : ''),
            },
          ],
          list,
        );
        ctx.out(
          ctx.style.dim(
            '  確認: unicontext additions confirm <ID> / 却下: unicontext additions reject <ID>',
          ),
        );
        return 0;
      }),
    );

  additions
    .command('show')
    .description('1件の詳細を表示する / Show one addition')
    .argument('<id>', 'addition:… のID')
    .action(
      action(h, async (ctx, { args }) => {
        const rt = await ctx.runtime();
        const a = rt.uc.additions.get(String(args[0]));
        if (!a) throw new NotFoundError(`addition ${String(args[0])}`);
        if (ctx.json) ctx.printJson({ addition: a });
        else printAddition(ctx, a, rt.uc.timezone);
      }),
    );

  additions
    .command('confirm')
    .description(
      '内容が正しいと確認する（本人入力として記録し、大学側の値より優先する） / Confirm: store as your own facts',
    )
    .argument('<id>', 'addition:… のID')
    .option('--yes', '確認の質問を省略する / skip the y/N question')
    .action(
      action<{ yes?: boolean }>(h, async (ctx, { args, opts }) => {
        const id = String(args[0]);
        ctx.assertCanConfirm(opts.yes);
        const rt = await ctx.runtime();
        const a = rt.uc.additions.get(id);
        if (!a) throw new NotFoundError(`addition ${id}`);
        if (!ctx.json) printAddition(ctx, a, rt.uc.timezone);
        if (a.status !== 'unconfirmed' && a.status !== 'confirmed')
          throw new CliError(`「${id}」は${STATUS_LABELS[a.status]}のため確認できません`, 1);
        const ok = await ctx.confirmAction(
          a.conflicts.length > 0
            ? `大学側の情報と食い違っています。${a.via === 'chat' ? 'チャットで登録した' : '録音の'}内容を正しいとして本人入力で記録しますか？`
            : 'この内容を本人入力として記録しますか？',
          opts.yes,
        );
        if (!ok) {
          ctx.err('キャンセルしました（何も変更していません）');
          return 1;
        }
        const done = await rt.uc.additions.confirm(id);
        if (ctx.json) ctx.printJson({ addition: done });
        else ctx.out(ctx.style.green('確認しました（本人入力として記録）'));
        return 0;
      }),
    );

  additions
    .command('reject')
    .description('間違いとして却下する（記録・締切・タスクを取り消す） / Reject and remove it')
    .argument('<id>', 'addition:… のID')
    .action(
      action(h, async (ctx, { args }) => {
        const id = String(args[0]);
        const rt = await ctx.runtime();
        if (!rt.uc.additions.get(id)) throw new NotFoundError(`addition ${id}`);
        const done = await rt.uc.additions.reject(id);
        if (ctx.json) ctx.printJson({ addition: done });
        else ctx.out(ctx.style.green(`「${done.title}」を却下しました`));
      }),
    );
}
