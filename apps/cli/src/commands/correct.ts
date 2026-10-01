import type { Conflict, Fact, JsonValue } from '@unicontext/canonical-model';
import { entityLabel } from '@unicontext/canonical-model';
import { DaemonApiError, type Runtime } from '@unicontext/daemon/lib';
import { NotFoundError } from '@unicontext/core';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { UsageError } from '../errors.js';
import { predicateLabel, valueText } from '../format/common.js';
import { action, type Harness } from '../harness.js';
import { parseValue } from '../parse.js';

export interface CorrectResult {
  fact: Fact;
  conflict: Conflict | undefined;
  via: 'daemon' | 'in-process';
}

export function subjectLabel(rt: Runtime, subject: string): string {
  const entity = rt.uc.sync.stores.entities.get(subject);
  return entity ? entityLabel(entity) : subject;
}

export function registerCorrect(program: Command, h: Harness): void {
  program
    .command('correct')
    .description('値を本人の修正として保存する / Store your own correction (origin=user, §74)')
    .argument('[args...]', '<ファクトまたは競合のID> <値>（--subject指定時は <値> のみ）')
    .option('--subject <entityId>', '修正する対象のエンティティID / entity the correction is about')
    .option('--predicate <p>', '修正する項目（roomやassignment_dueなど） / predicate, e.g. room')
    .option('--note <text>', '理由のメモ / note stored with the correction')
    .addHelpText(
      'after',
      `
例:
  unicontext correct <競合ID> "情報学部2号館11教室"
  unicontext correct --subject <授業のID> --predicate room "情報学部2号館11教室"
値はJSONとして解釈できればJSON、そうでなければ文字列として保存します。`,
    )
    .action(
      action<{ subject?: string; predicate?: string; note?: string }>(
        h,
        async (ctx, { args, opts }) => {
          const words = (args[0] as string[] | undefined) ?? [];
          let id: string | undefined;
          let valueWords: string[];
          if (opts.subject) {
            if (!opts.predicate)
              throw new UsageError('--subjectを使うときは--predicateも指定してください');
            if (words.length < 1) throw new UsageError('修正後の値を指定してください');
            valueWords = words;
          } else {
            if (opts.predicate)
              throw new UsageError('--predicateは--subjectと一緒に指定してください');
            if (words.length < 2)
              throw new UsageError(
                'ファクトまたは競合のIDと、修正後の値を指定してください',
                '例: unicontext correct <競合ID> "情報学部2号館11教室"（IDは「unicontext conflicts」で確認できます）',
              );
            id = words[0];
            valueWords = words.slice(1);
          }
          const value = parseValue(valueWords.join(' '));
          const result = await applyCorrection(ctx, { id, opts, value });
          printCorrection(ctx, result, await subjectOf(ctx, result));
          return 0;
        },
      ),
    );
}

async function subjectOf(ctx: CliContext, r: CorrectResult): Promise<string> {
  const rt = await ctx.runtime();
  return subjectLabel(rt, r.fact.subject);
}

async function applyCorrection(
  ctx: CliContext,
  input: {
    id: string | undefined;
    opts: { subject?: string; predicate?: string; note?: string };
    value: JsonValue;
  },
): Promise<CorrectResult> {
  const { id, opts, value } = input;
  const note = opts.note;
  // The id form can go through a running daemon (POST /api/v1/facts/:id/correct).
  if (id) {
    const daemon = await ctx.daemon();
    if (daemon) {
      try {
        const res = await daemon.post<{ fact: Fact; conflict?: Conflict }>(
          `/api/v1/facts/${encodeURIComponent(id)}/correct`,
          { value, ...(note ? { note } : {}) },
        );
        return { fact: res.fact, conflict: res.conflict, via: 'daemon' };
      } catch (e) {
        if (e instanceof DaemonApiError) throw e;
        // connection problem: fall back to the local database below
      }
    }
  }
  const { uc } = await ctx.runtime();
  let subject = opts.subject;
  let predicate = opts.predicate;
  if (id) {
    const conflict = uc.resolver.getConflict(id);
    if (conflict) {
      subject = conflict.subject;
      predicate = conflict.predicate;
    } else {
      const fact = uc.sync.facts.get(id);
      if (fact) {
        subject = fact.subject;
        predicate = fact.predicate;
      }
    }
    if (!subject || !predicate) throw new NotFoundError(`fact or conflict ${id}`);
  } else if (subject && !uc.sync.stores.entities.get(subject)) {
    throw new NotFoundError(`entity ${subject}`);
  }
  if (!subject || !predicate) throw new UsageError('修正の対象を特定できません');
  const result = uc.resolver.correct({ subject, predicate, value, ...(note ? { note } : {}) });
  uc.identity.invalidate();
  return { fact: result.fact, conflict: result.conflict, via: 'in-process' };
}

function printCorrection(ctx: CliContext, r: CorrectResult, label: string): void {
  if (ctx.json) {
    ctx.printJson({ fact: r.fact, conflict: r.conflict ?? null, via: r.via });
    return;
  }
  const s = ctx.style;
  ctx.out(s.green('修正を保存しました（本人入力として記録）'));
  ctx.out(`  対象: ${ctx.text(label)}の${predicateLabel(r.fact.predicate)}`);
  ctx.out(`  値: ${ctx.text(valueText(r.fact.value))}`);
  ctx.out(`  ファクトID: ${r.fact.id}`);
  ctx.out(`  由来: ${r.fact.origin}（確信度${r.fact.confidence}）`);
  if (r.fact.evidence) ctx.out(`  メモ: ${ctx.text(r.fact.evidence)}`);
  if (r.conflict)
    ctx.out(
      `  競合: ${r.conflict.id}は${r.conflict.status === 'resolved' ? 'この値で解決しました' : `状態が${r.conflict.status}になりました`}`,
    );
  else ctx.out('  競合: この項目に開いている競合はありませんでした');
}
