import type { Fact } from '@unicontext/canonical-model';
import type { PaceCourseItem, PaceResponse, PaceSetResponse } from '@unicontext/daemon/api-types';
import { DaemonApiError } from '@unicontext/daemon/lib';
import { resolveCourse } from '@unicontext/mcp/courses';
import { PACE_SLOT_EXAMPLE, setPaceSlots } from '@unicontext/context-engine';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { UsageError } from '../errors.js';
import { TASK_STATUS_LABELS } from '../format/common.js';
import { printTable } from '../format/views.js';
import { action, type Harness } from '../harness.js';

const SCHEDULE_TYPE_LABEL: Record<PaceCourseItem['scheduleType'], string> = {
  regular: '時間割',
  unscheduled: '時間割外',
  intensive: '集中講義',
};

interface PaceSetResult {
  course: PaceSetResponse['course'];
  slots: PaceSetResponse['slots'];
  fact: Fact;
  via: 'daemon' | 'in-process';
}

/** PUT (or DELETE) through a running daemon, else write to the local database. */
async function storeSlots(
  ctx: CliContext,
  courseInput: string,
  slots: string[],
): Promise<PaceSetResult> {
  const daemon = await ctx.daemon();
  if (daemon) {
    const path = `/api/v1/courses/${encodeURIComponent(courseInput)}/pace`;
    try {
      const res =
        slots.length > 0
          ? await daemon.put<PaceSetResponse>(path, { slots })
          : await daemon.delete<PaceSetResponse>(path);
      return { ...res, via: 'daemon' };
    } catch (e) {
      if (e instanceof DaemonApiError) throw e;
      // connection problem: fall back to the local database below
    }
  }
  const { uc } = await ctx.runtime();
  const { ref } = resolveCourse(uc, courseInput);
  const stored = setPaceSlots(uc, ref, slots);
  return {
    course: ref,
    slots: stored.slots.map((s) => uc.context.paceSlotView(s)),
    fact: stored.fact,
    via: 'in-process',
  };
}

async function loadOverview(ctx: CliContext): Promise<PaceResponse> {
  const daemon = await ctx.daemon();
  if (daemon) {
    try {
      return await daemon.get<PaceResponse>('/api/v1/pace');
    } catch (e) {
      if (e instanceof DaemonApiError) throw e;
    }
  }
  const { uc } = await ctx.runtime();
  return uc.context.paceOverview();
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function printStored(ctx: CliContext, r: PaceSetResult, cleared: boolean): void {
  if (ctx.json) {
    ctx.printJson({ course: r.course, slots: r.slots, fact: r.fact, via: r.via });
    return;
  }
  const s = ctx.style;
  ctx.out(
    s.green(cleared ? '自習時間を解除しました' : '自習時間を保存しました（本人入力として記録）'),
  );
  ctx.out(`  科目: ${ctx.text(r.course.title)}`);
  if (!cleared) ctx.out(`  自習時間: ${r.slots.map((x) => x.text).join('、')}`);
}

export function registerPace(program: Command, h: Harness): void {
  const pace = program
    .command('pace')
    .description(
      '時間割外・集中講義の自習時間とペースを管理する / Self-study slots and pacing for courses without a weekly class',
    );

  pace
    .command('set')
    .description(
      '毎週の自習時間を設定する（今の設定を置き換える） / Set the weekly self-study slots',
    )
    .argument('<course>', '科目のID・科目コード・科目名 / course id, code or title')
    .option(
      '--slot <slot>',
      `自習時間 例: "${PACE_SLOT_EXAMPLE}" "土2限"（複数回指定できる） / repeatable`,
      collect,
      [] as string[],
    )
    .addHelpText(
      'after',
      `
例:
  unicontext pace set <科目> --slot "${PACE_SLOT_EXAMPLE}"
  unicontext pace set <科目> --slot "土2限" --slot "水2限"`,
    )
    .action(
      action<{ slot: string[] }>(h, async (ctx, { args, opts }) => {
        const slots = opts.slot;
        if (slots.length === 0)
          throw new UsageError(
            '自習時間を--slotで指定してください',
            `例: unicontext pace set <科目> --slot "${PACE_SLOT_EXAMPLE}"（解除は「unicontext pace clear <科目>」）`,
          );
        printStored(ctx, await storeSlots(ctx, String(args[0]), slots), false);
        return 0;
      }),
    );

  pace
    .command('clear')
    .description('自習時間を解除する / Clear the self-study slots')
    .argument('<course>', '科目のID・科目コード・科目名 / course id, code or title')
    .action(
      action(h, async (ctx, { args }) => {
        printStored(ctx, await storeSlots(ctx, String(args[0]), []), true);
        return 0;
      }),
    );

  pace
    .command('list')
    .description(
      '履修中の科目の自習時間と今週分の状況を表示する / List slots and this week’s status',
    )
    .action(
      action(h, async (ctx) => {
        const overview = await loadOverview(ctx);
        if (ctx.json) {
          ctx.printJson(overview);
          return 0;
        }
        if (overview.courses.length === 0) {
          ctx.out(`  ${ctx.style.dim('なし')}`);
          return 0;
        }
        printTable(
          ctx,
          [
            { header: '科目', value: (c) => ctx.text(c.course.title), max: 30 },
            { header: '種別', value: (c) => SCHEDULE_TYPE_LABEL[c.scheduleType] },
            { header: '自習時間', value: (c) => c.slots.map((x) => x.text).join('、') || '-' },
            {
              header: '今週分',
              value: (c) => (c.thisWeek ? TASK_STATUS_LABELS[c.thisWeek.status] : '-'),
            },
            {
              header: '遅れ',
              value: (c) =>
                [
                  ...(c.behindWeeks > 0 ? [`${c.behindWeeks}週分`] : []),
                  ...(c.unsubmitted > 0 ? [`未提出${c.unsubmitted}件`] : []),
                ].join('、') || '-',
              style: (padded, c) =>
                c.behindWeeks >= 2
                  ? ctx.style.red(padded)
                  : c.behindWeeks > 0 || c.unsubmitted > 0
                    ? ctx.style.yellow(padded)
                    : padded,
            },
          ],
          overview.courses,
        );
        return 0;
      }),
    );
}
