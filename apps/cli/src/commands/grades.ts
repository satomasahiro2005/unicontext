import {
  GRADE_OUTCOME_LABELS,
  GRADE_OUTCOMES,
  type GradeOutcome,
} from '@unicontext/canonical-model';
import {
  buildGradeReport,
  type GradeAttempt,
  type GradePeriodTotals,
  type GradeReport,
} from '@unicontext/context-engine';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { UsageError } from '../errors.js';
import { printTable } from '../format/views.js';
import { action, type Harness } from '../harness.js';
import { parsePositiveInt } from '../parse.js';

function outcomeStyle(ctx: CliContext, outcome: GradeOutcome, text: string): string {
  if (outcome === 'passed' || outcome === 'transferred') return ctx.style.green(text);
  if (outcome === 'failed' || outcome === 'withdrawn') return ctx.style.red(text);
  if (outcome === 'unknown' || outcome === 'not_graded') return ctx.style.yellow(text);
  return text;
}

function creditsText(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function totalsLine(t: GradePeriodTotals): string {
  const parts = [`修得 ${creditsText(t.earnedCredits)}単位`];
  if (t.failedCredits) parts.push(`不合格 ${creditsText(t.failedCredits)}単位`);
  for (const o of ['in_progress', 'not_graded', 'withdrawn', 'unknown'] as const)
    if (t.counts[o]) parts.push(`${GRADE_OUTCOME_LABELS[o]} ${t.counts[o]}件`);
  return `${parts.join(' / ')}（${t.attempts}件）`;
}

function attemptNote(a: GradeAttempt, report: GradeReport): string {
  const course = report.courses.find((c) => c.attempts.some((x) => x.id === a.id));
  const notes: string[] = [];
  if (course && course.attempts.length > 1)
    notes.push(`${a.attemptNo}/${course.attempts.length}回目`);
  if (a.pendingReexam) notes.push('再試待ち');
  if (course && !course.earned && a.id === course.latest.id && course.failedAttempts > 0)
    notes.push('未修得');
  if (course?.earned && a.outcome === 'failed') notes.push('後に修得');
  if (a.markers?.length) notes.push(a.markers.map((m) => m.label ?? m.symbol).join('・'));
  return notes.join('、');
}

export function printGrades(ctx: CliContext, report: GradeReport, filtered: boolean): void {
  if (report.totals.attempts === 0) {
    ctx.out('成績はまだありません');
    ctx.out(
      ctx.style.dim(
        '学務情報システムの成績は、config.yamlのsources.livecampusuにgrades: trueを書いて同期すると取り込みます',
      ),
    );
    return;
  }
  const byTerm = new Map<string, GradeAttempt[]>();
  for (const a of report.attempts) {
    const key = `${a.academicYear ?? ''} ${a.term ?? ''}`.trim() || '不明';
    byTerm.set(key, [...(byTerm.get(key) ?? []), a]);
  }
  if (report.attempts.length === 0) ctx.out('条件に合う成績はありません');
  let first = true;
  for (const t of report.terms) {
    const list = byTerm.get(t.key);
    if (!list) continue;
    if (!first) ctx.out('');
    first = false;
    ctx.out(
      `${ctx.style.bold(t.key.replace(/^(\d{4}) /, '$1年度 '))}  ${ctx.style.dim(totalsLine(t))}`,
    );
    printTable(
      ctx,
      [
        { header: 'コード', value: (a: GradeAttempt) => a.subjectCode ?? '-' },
        { header: '科目', value: (a) => ctx.text(a.title), max: 30 },
        {
          header: '単位',
          value: (a) => (a.credits === undefined ? '-' : creditsText(a.credits)),
          align: 'right',
        },
        { header: '評価', value: (a) => a.evaluation || '（なし）' },
        {
          header: '区分',
          value: (a) => GRADE_OUTCOME_LABELS[a.outcome],
          style: (padded, a) => outcomeStyle(ctx, a.outcome, padded),
        },
        { header: '試験', value: (a) => a.examType ?? '' },
        { header: '備考', value: (a) => attemptNote(a, report), max: 30 },
      ],
      list,
    );
  }
  ctx.out('');
  ctx.out(ctx.style.bold('年度ごと'));
  for (const y of report.years) ctx.out(`  ${y.key}年度  ${totalsLine(y)}`);
  ctx.out(`  合計  ${totalsLine(report.totals)}`);
  const notEarned = report.courses.filter((c) => !c.earned && c.failedAttempts > 0);
  if (!filtered && notEarned.length) {
    ctx.out('');
    ctx.out(ctx.style.bold(`まだ修得していない不合格科目（${notEarned.length}件）`));
    for (const c of notEarned)
      ctx.out(
        `  ${c.subjectCode ?? ''} ${c.title}  不合格${c.failedAttempts}回・最新 ${c.latest.evaluation || '（なし）'}（${c.latest.academicYear ?? ''} ${c.latest.term ?? ''}）`,
      );
  }
  if (report.unknownLabels.length)
    ctx.out(
      ctx.style.yellow(
        `区分を判定できない評価: ${report.unknownLabels.map((l) => l || '空欄').join('、')}（修得にも不合格にも数えていません）`,
      ),
    );
}

export function registerGrades(program: Command, h: Harness): void {
  program
    .command('grades')
    .description(
      '成績の一覧（全年度・全学期、学期ごと） / Grade history of every term, grouped by year and term',
    )
    .option('--year <year>', '年度で絞る（例: 2025） / only this academic year', (v) =>
      parsePositiveInt(v, '--year', 2100),
    )
    .option('--failed', '不合格だけ表示 / only failed attempts')
    .option(
      '--status <list>',
      `区分（${GRADE_OUTCOMES.join(', ')}）か評価の表記（不可・再試など）をカンマ区切りで / outcomes or evaluation labels, comma separated`,
    )
    .action(
      action<{ year?: number; failed?: boolean; status?: string }>(h, async (ctx, { opts }) => {
        if (opts.year !== undefined && opts.year < 1900)
          throw new UsageError('--yearには4桁の年度を指定してください');
        const statuses = (opts.status ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const { uc } = await ctx.runtime();
        const report = buildGradeReport(uc, {
          year: opts.year,
          ...(statuses.length ? { statuses } : {}),
          failedOnly: opts.failed === true,
        });
        if (ctx.json) ctx.printJson(report);
        else printGrades(ctx, report, Boolean(opts.failed || statuses.length));
      }),
    );
}
