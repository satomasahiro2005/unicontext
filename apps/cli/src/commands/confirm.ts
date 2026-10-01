import type { IdentityLink } from '@unicontext/canonical-model';
import { entityLabel } from '@unicontext/canonical-model';
import { NotFoundError } from '@unicontext/core';
import type { Runtime } from '@unicontext/daemon/lib';
import { applyProposal, type Proposal } from '@unicontext/mcp/proposals';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError, UsageError } from '../errors.js';
import { predicateLabel, shortTime, valueText } from '../format/common.js';
import { printSection, printTable } from '../format/views.js';
import { action, type Harness } from '../harness.js';
import { subjectLabel } from './correct.js';

const PROPOSAL_STATUS_LABELS: Record<Proposal['status'], string> = {
  pending: '確認待ち',
  confirmed: '適用済み',
  rejected: '却下済み',
  expired: '期限切れ',
};

function printProposal(ctx: CliContext, rt: Runtime, p: Proposal): void {
  const s = ctx.style;
  ctx.out(s.bold(`提案「${p.id}」`) + s.dim(`（${PROPOSAL_STATUS_LABELS[p.status]}）`));
  ctx.out(`  内容: ${ctx.text(p.preview)}`);
  ctx.out(`  対象: ${ctx.text(subjectLabel(rt, p.subject))}の${predicateLabel(p.predicate)}`);
  ctx.out(`  新しい値: ${ctx.text(valueText(p.value))}`);
  if (p.note) ctx.out(`  理由: ${ctx.text(p.note)}`);
  ctx.out(`  提案元: ${ctx.text(p.createdBy)}`);
  ctx.out(`  有効期限: ${shortTime(p.expiresAt, rt.uc.timezone)}`);
}

function linkLabel(rt: Runtime, id: string): string {
  const entity = rt.uc.sync.stores.entities.get(id);
  const source = rt.uc.sync.stores.entities.meta(id)?.sourceId;
  const label = entity ? entityLabel(entity) : id;
  return source ? `${label}（${source}）` : label;
}

function requireEntity(rt: Runtime, id: string): void {
  if (!rt.uc.sync.stores.entities.get(id)) throw new NotFoundError(`entity ${id}`);
}

function printLink(ctx: CliContext, rt: Runtime, link: IdentityLink, headline: string): void {
  ctx.out(ctx.style.green(headline));
  ctx.out(`  ${ctx.text(linkLabel(rt, link.leftId))}`);
  ctx.out(`  ${ctx.text(linkLabel(rt, link.rightId))}`);
  ctx.out(`  状態: ${link.status}（決定者: ${link.decidedBy}）`);
}

async function listPending(ctx: CliContext): Promise<void> {
  const rt = await ctx.runtime();
  const proposals = rt.proposals.list({ status: 'pending' });
  const links = rt.uc.identity.listLinks({ status: 'suggested' });
  if (ctx.json) {
    ctx.printJson({ proposals, suggestedLinks: links });
    return;
  }
  const tz = rt.uc.timezone;
  printSection(ctx, 'AIの提案', proposals.length);
  if (proposals.length === 0) ctx.out(`  ${ctx.style.dim('なし')}`);
  else {
    printTable(
      ctx,
      [
        { header: 'ID', value: (p) => p.id },
        { header: '内容', value: (p) => ctx.text(p.preview), max: 60 },
        { header: '期限', value: (p) => shortTime(p.expiresAt, tz) },
      ],
      proposals,
    );
    ctx.out(
      ctx.style.dim('  適用: unicontext confirm <ID> / 却下: unicontext confirm reject <ID>'),
    );
  }
  printSection(ctx, '紐付けの候補', links.length);
  if (links.length === 0) ctx.out(`  ${ctx.style.dim('なし')}`);
  else {
    printTable(
      ctx,
      [
        { header: '科目A', value: (l) => ctx.text(linkLabel(rt, l.leftId)), max: 34 },
        { header: '科目B', value: (l) => ctx.text(linkLabel(rt, l.rightId)), max: 34 },
        { header: '一致度', value: (l) => l.score.toFixed(2), align: 'right' },
        { header: '根拠', value: (l) => ctx.text(l.evidence.join(' / ')), max: 50 },
      ],
      links,
    );
    for (const l of links)
      ctx.out(ctx.style.dim(`  同じ科目なら: unicontext confirm link ${l.leftId} ${l.rightId}`));
    ctx.out(ctx.style.dim('  別の科目なら: unicontext confirm unlink <科目AのID> <科目BのID>'));
  }
}

export function registerConfirm(program: Command, h: Harness): void {
  const confirm = program
    .command('confirm')
    .description(
      'AIの提案や紐付けの候補を確認して適用する / Review and apply proposals and identity links',
    )
    .argument('[proposalId]', '適用する提案のID / proposal id to apply')
    .option(
      '--list',
      '確認待ちの提案と紐付け候補を表示する / list pending proposals and link suggestions',
    )
    .option('--yes', '確認の質問を省略する / skip the y/N question')
    .action(
      action<{ list?: boolean; yes?: boolean }>(h, async (ctx, { args, opts }) => {
        if (opts.list) {
          await listPending(ctx);
          return 0;
        }
        const id = typeof args[0] === 'string' ? args[0] : undefined;
        if (!id)
          throw new UsageError(
            '適用する提案のIDを指定してください',
            '「unicontext confirm --list」で確認待ちの提案を表示できます',
          );
        ctx.assertCanConfirm(opts.yes);
        const rt = await ctx.runtime();
        const proposal = rt.proposals.get(id);
        if (!proposal) throw new NotFoundError(`proposal ${id}`);
        if (!ctx.json) printProposal(ctx, rt, proposal);
        if (proposal.status !== 'pending')
          throw new CliError(
            `提案「${id}」は${PROPOSAL_STATUS_LABELS[proposal.status]}のため適用できません`,
            1,
            proposal.status === 'expired' ? 'AIに提案をもう一度出してもらってください' : undefined,
          );
        const ok = await ctx.confirmAction('この修正を本人の入力として適用しますか？', opts.yes);
        if (!ok) {
          ctx.err('キャンセルしました（何も変更していません）');
          return 1;
        }
        const applied = applyProposal(rt.uc, rt.proposals, id);
        rt.uc.identity.invalidate();
        if (ctx.json) ctx.printJson({ proposal: applied.proposal, fact: applied.fact });
        else {
          ctx.out(ctx.style.green('適用しました（本人入力として記録）'));
          ctx.out(`  ファクトID: ${applied.fact.id}`);
        }
        return 0;
      }),
    );

  confirm
    .command('link')
    .description('2つの科目を同じ科目として確定する / Confirm that two course entries are the same')
    .argument('<leftId>', '科目AのID / first entity id')
    .argument('<rightId>', '科目BのID / second entity id')
    .action(
      action(h, async (ctx, { args }) => {
        const [left, right] = [String(args[0]), String(args[1])];
        const rt = await ctx.runtime();
        requireEntity(rt, left);
        requireEntity(rt, right);
        const link = rt.uc.identity.confirm(left, right);
        rt.uc.identity.invalidate();
        if (ctx.json) ctx.printJson({ link });
        else printLink(ctx, rt, link, '同じ科目として確定しました');
      }),
    );

  confirm
    .command('unlink')
    .description('2つの科目は別の科目として確定する / Reject an identity link (they are different)')
    .argument('<leftId>', '科目AのID / first entity id')
    .argument('<rightId>', '科目BのID / second entity id')
    .action(
      action(h, async (ctx, { args }) => {
        const [left, right] = [String(args[0]), String(args[1])];
        const rt = await ctx.runtime();
        requireEntity(rt, left);
        requireEntity(rt, right);
        const link = rt.uc.identity.reject(left, right);
        rt.uc.identity.invalidate();
        if (ctx.json) ctx.printJson({ link });
        else printLink(ctx, rt, link, '別の科目として確定しました');
      }),
    );

  confirm
    .command('reject')
    .description('AIの提案を却下する / Reject an AI proposal')
    .argument('<proposalId>', '提案のID / proposal id')
    .action(
      action(h, async (ctx, { args }) => {
        const id = String(args[0]);
        const rt = await ctx.runtime();
        const rejected = rt.proposals.reject(id);
        if (ctx.json) ctx.printJson({ proposal: rejected });
        else ctx.out(ctx.style.green(`提案「${id}」を却下しました`));
      }),
    );
}
