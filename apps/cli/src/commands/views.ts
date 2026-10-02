import { TASK_STATUSES, type TaskStatus } from '@unicontext/canonical-model';
import { getView } from '@unicontext/context-engine';
import type {
  AssignmentsResponse,
  ConflictsResponse,
  CoursesResponse,
  SourcesResponse,
} from '@unicontext/daemon/api-types';
import { buildAssignments } from '@unicontext/mcp/assignments';
import { resolveCourse } from '@unicontext/mcp/courses';
import { listCourses } from '@unicontext/daemon/lib';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { UsageError } from '../errors.js';
import {
  printAssignments,
  printChangesContext,
  printConflicts,
  printCourses,
  printDay,
  printDeadlineContext,
  printSearch,
  printSources,
  printWeek,
} from '../format/views.js';
import { action, type Harness } from '../harness.js';
import { parsePositiveInt, parseSince } from '../parse.js';

/** `--course` accepts an id, a course code or (part of) a title. */
async function courseId(ctx: CliContext, input: string | undefined): Promise<string | undefined> {
  if (input === undefined) return undefined;
  const rt = await ctx.runtime();
  return resolveCourse(rt.uc, input).ref.id;
}

export function registerViewCommands(program: Command, h: Harness): void {
  program
    .command('today')
    .description('今日の授業・締切・変更 / Today: classes, deadlines and changes')
    .action(
      action(h, async (ctx) => {
        const { uc } = await ctx.runtime();
        const bundle = getView(uc.context, 'today', {});
        if (ctx.json) ctx.printJson(bundle);
        else printDay(ctx, '今日', bundle);
      }),
    );

  program
    .command('tomorrow')
    .description('明日の授業・準備・締切 / Tomorrow: classes, preparation and deadlines')
    .action(
      action(h, async (ctx) => {
        const { uc } = await ctx.runtime();
        const bundle = getView(uc.context, 'tomorrow', {});
        if (ctx.json) ctx.printJson(bundle);
        else printDay(ctx, '明日', bundle);
      }),
    );

  program
    .command('week')
    .description('今週の時間割・締切・試験 / This week: timetable, deadlines and exams')
    .action(
      action(h, async (ctx) => {
        const { uc } = await ctx.runtime();
        const bundle = getView(uc.context, 'week', {});
        if (ctx.json) ctx.printJson(bundle);
        else printWeek(ctx, bundle);
      }),
    );

  program
    .command('courses')
    .description(
      '科目の一覧（既定は今の学期に登録した科目） / Courses of the current term (identity-resolved)',
    )
    .option('--term <term>', '学期（2026-1・前期・後期など） / term id or label, e.g. 2026-1, 前期')
    .option(
      '--all',
      'すべての学期と未登録の科目（シラバスのみ）も表示 / every term and unregistered offerings',
    )
    .action(
      action<{ term?: string; all?: boolean }>(h, async (ctx, { opts }) => {
        const { uc } = await ctx.runtime();
        if (opts.all && opts.term) throw new UsageError('--termと--allは同時に指定できません');
        const body: CoursesResponse = listCourses(uc, {
          term: opts.all ? 'all' : opts.term,
        });
        if (ctx.json) ctx.printJson(body);
        else printCourses(ctx, body);
      }),
    );

  for (const [name, description] of [
    ['assignments', '課題の一覧（既定は未完了） / Assignments (open ones by default)'],
    ['tasks', 'やることの一覧（既定は未完了） / Tasks (open ones by default)'],
  ] as const) {
    program
      .command(name)
      .description(description)
      .option('--course <id>', '科目で絞り込む（ID・コード・科目名） / filter by course')
      .option(
        '--all',
        '提出済み・完了・取消・終了した学期も含める / include finished, cancelled and ended-term tasks',
      )
      .option(
        '--include-past',
        '終了した学期の未提出課題も含める / include unfinished work of terms that have ended',
      )
      .action(
        action<{ course?: string; all?: boolean; includePast?: boolean }>(
          h,
          async (ctx, { opts }) => {
            const { uc } = await ctx.runtime();
            const course = await courseId(ctx, opts.course);
            const statuses: TaskStatus[] | undefined = opts.all ? [...TASK_STATUSES] : undefined;
            const body: AssignmentsResponse = {
              assignments: buildAssignments(uc, {
                ...(statuses ? { statuses } : {}),
                ...(course ? { courseOfferingId: course } : {}),
                ...(opts.includePast ? { includePast: true } : {}),
              }),
            };
            if (ctx.json) ctx.printJson(body);
            else printAssignments(ctx, body.assignments, uc.timezone);
          },
        ),
      );
  }

  program
    .command('deadlines')
    .description('これからの締切と期限切れ / Upcoming and overdue deadlines')
    .option('--days <n>', '何日先まで見るか（既定15） / look-ahead in days', (v) =>
      parsePositiveInt(v, '--days', 365),
    )
    .option('--course <id>', '科目で絞り込む / filter by course')
    .action(
      action<{ days?: number; course?: string }>(h, async (ctx, { opts }) => {
        const { uc } = await ctx.runtime();
        const course = await courseId(ctx, opts.course);
        const bundle = getView(uc.context, 'deadline', {
          ...(opts.days ? { days: opts.days } : {}),
          ...(course ? { courseOfferingId: course } : {}),
        });
        if (ctx.json) ctx.printJson(bundle);
        else printDeadlineContext(ctx, bundle);
      }),
    );

  program
    .command('changes')
    .description('昨日からの変更（または指定時点以降） / What changed since yesterday or --since')
    .option('--since <when>', '起点: ISO日時・1d・2h・yesterday / ISO time, 1d, 2h or yesterday')
    .action(
      action<{ since?: string }>(h, async (ctx, { opts }) => {
        const { uc } = await ctx.runtime();
        const since = opts.since ? parseSince(opts.since, ctx.now(), uc.timezone) : undefined;
        const bundle = getView(uc.context, 'changes', since ? { since } : {});
        if (ctx.json) ctx.printJson(bundle);
        else printChangesContext(ctx, bundle);
      }),
    );

  program
    .command('search')
    .description(
      '授業資料・お知らせ・講義録を検索 / Search materials, announcements and transcripts',
    )
    .argument('<query>', '検索語 / query text')
    .option('--limit <n>', '最大件数（既定20） / max results', (v) =>
      parsePositiveInt(v, '--limit', 100),
    )
    .option('--course <id>', '科目で絞り込む / filter by course')
    .action(
      action<{ limit?: number; course?: string }>(h, async (ctx, { args, opts }) => {
        const { uc } = await ctx.runtime();
        const query = String(args[0] ?? '').trim();
        if (!query) throw new UsageError('検索語が空です');
        const course = await courseId(ctx, opts.course);
        const result = await uc.search.search(query, {
          limit: opts.limit ?? 20,
          ...(course ? { courseOfferingId: course } : {}),
        });
        if (ctx.json) ctx.printJson(result);
        else printSearch(ctx, result, uc.timezone);
      }),
    );

  program
    .command('conflicts')
    .description('情報源の間で食い違っている項目 / Open conflicts between sources')
    .action(
      action(h, async (ctx) => {
        const { uc } = await ctx.runtime();
        const body: ConflictsResponse = { conflicts: uc.context.admin().conflicts };
        if (ctx.json) ctx.printJson(body);
        else printConflicts(ctx, body.conflicts);
      }),
    );

  program
    .command('sources')
    .description('接続しているソースと状態 / Sources and their health')
    .action(
      action(h, async (ctx) => {
        const rt = await ctx.runtime();
        const body: SourcesResponse = { sources: rt.describeSources() };
        if (ctx.json) ctx.printJson(body);
        else printSources(ctx, body.sources, rt.uc.timezone);
      }),
    );
}
