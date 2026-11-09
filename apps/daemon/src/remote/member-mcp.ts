import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ACCESS_LABELS, ACCESS_CATEGORIES, type AccessCategory } from '@unicontext/mcp';
import { z } from 'zod';
import type { GuestCourse, GuestView } from './guest-view.js';

/**
 * Tools for someone the student shares with, next to the student's own single-category tools
 * their categories unlock (@unicontext/mcp access.ts). These three are projections that hold only
 * what their category says: the week's classes, the registered courses, the deadlines.
 */

export interface MemberToolDeps {
  access: ReadonlySet<AccessCategory>;
  /** The calendar week: 0 this week, 1 the next; `upcoming` adds the 14-day deadlines. */
  view(offsetWeeks: number, upcoming: boolean): GuestView;
  /** Every registered course with its weekly slots (guest-view.ts guestCourses). */
  courses(): GuestCourse[];
}

export function memberInstructions(name: string, access: ReadonlySet<AccessCategory>): string {
  const shared = ACCESS_CATEGORIES.filter((c) => access.has(c)).map((c) => ACCESS_LABELS[c]);
  return [
    `この接続は、学生本人が${name}さんに共有したものです。見られるのは ${shared.join('・') || '（なし）'} だけで、読むことしかできません。`,
    '共有されていないことは推測で断定せず、「共有されていないので分かりません」と答えてください。',
    '締切が載っていないことは締切が無いことを意味しません。日時は timezone（Asia/Tokyo）で読んでください。',
    '出典（citations）があれば、その label を添えて答えてください。',
  ].join('\n');
}

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

export function registerMemberTools(server: McpServer, deps: MemberToolDeps): void {
  if (deps.access.has('schedule'))
    server.registerTool(
      'get_schedule',
      {
        title: '時間割',
        description:
          '今週か来週の時間割（日ごとの授業・時限・教室・休講）。today が今日。 / The timetable for this or next week',
        inputSchema: {
          week: z.enum(['this', 'next']).optional().describe('this（今週・既定）か next（来週）'),
        },
        annotations: readOnly,
      },
      ({ week }) => {
        const { deadlines: _d, exams: _e, ...view } = deps.view(week === 'next' ? 1 : 0, false);
        return json(view);
      },
    );

  if (deps.access.has('courses'))
    server.registerTool(
      'get_courses',
      {
        title: '履修科目',
        description:
          '履修登録した科目の一覧（年度・学期・前半/後半・曜日と時限・教室）。週ごとでなく全体の時間割を一度に返す。 / Every registered course with its weekly slots',
        inputSchema: {},
        annotations: readOnly,
      },
      () => json({ courses: deps.courses() }),
    );

  if (deps.access.has('deadlines'))
    server.registerTool(
      'get_deadlines',
      {
        title: '締切・試験',
        description:
          '直近の課題の締切と試験。提出状況が共有されていれば done（提出済み）と overdue（期限を過ぎて提出を確認できていない）も。 / Upcoming deadlines and exams',
        inputSchema: {},
        annotations: readOnly,
      },
      () => {
        const v = deps.view(0, true);
        return json({
          generatedAt: v.generatedAt,
          timezone: v.timezone,
          today: v.today,
          deadlines: v.deadlines ?? [],
          exams: v.exams ?? [],
        });
      },
    );
}
