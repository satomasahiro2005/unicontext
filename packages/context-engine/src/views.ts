import { ValidationError } from '@unicontext/core';
import { z } from 'zod';
import type { ContextEngine } from './engine.js';
import type {
  AdminContext,
  ChangesContext,
  ClassPreparationContext,
  ClassReviewContext,
  CourseContext,
  DeadlineContext,
  ExamPreparationContext,
  TodayContext,
  TomorrowContext,
  WeekContext,
} from './types.js';

/** Built-in views (§18). `uri` is the MCP resource name (§40 also exposes unicontext://...). */
export const CONTEXT_VIEWS = [
  {
    name: 'today',
    uri: 'context://today',
    description: '今日の授業・変更・締切・未提出・授業準備・お知らせ・競合',
  },
  { name: 'tomorrow', uri: 'context://tomorrow', description: '明日の授業と準備、締切' },
  { name: 'week', uri: 'context://week', description: '今週の時間割・締切・試験・変更' },
  {
    name: 'course',
    uri: 'context://course/{courseOfferingId}',
    description: '1科目の全体像（全ソース統合）',
  },
  { name: 'deadline', uri: 'context://deadline', description: '期限切れと今後の締切' },
  {
    name: 'changes',
    uri: 'context://changes',
    description: '昨日から変わったこと（または since 以降）',
  },
  {
    name: 'class-preparation',
    uri: 'context://class-preparation',
    description: '次の授業の準備（資料・締切・お知らせ・前回の講義）',
  },
  {
    name: 'class-review',
    uri: 'context://class-review',
    description: '直近の講義の振り返り（スライド・録音・質問）',
  },
  {
    name: 'exam-preparation',
    uri: 'context://exam-preparation',
    description: '試験準備（日時・教室・範囲・授業中の言及）',
  },
  { name: 'admin', uri: 'context://admin', description: '大学からのお知らせ、接続状態、確認待ち' },
] as const;

export type ContextViewName = (typeof CONTEXT_VIEWS)[number]['name'];

export interface ContextViewResultMap {
  today: TodayContext;
  tomorrow: TomorrowContext;
  week: WeekContext;
  course: CourseContext;
  deadline: DeadlineContext;
  changes: ChangesContext;
  'class-preparation': ClassPreparationContext;
  'class-review': ClassReviewContext;
  'exam-preparation': ExamPreparationContext;
  admin: AdminContext;
}

/** Parameters accepted by each view (validated; usable as MCP tool input schemas). */
export const ContextViewParams = {
  today: z.object({}).strict(),
  tomorrow: z.object({}).strict(),
  week: z.object({}).strict(),
  course: z.object({ courseOfferingId: z.string() }).strict(),
  deadline: z
    .object({
      days: z.number().int().positive().max(365).optional(),
      courseOfferingId: z.string().optional(),
    })
    .strict(),
  changes: z
    .object({ since: z.string().optional(), courseOfferingId: z.string().optional() })
    .strict(),
  'class-preparation': z
    .object({ sessionId: z.string().optional(), courseOfferingId: z.string().optional() })
    .strict(),
  'class-review': z
    .object({
      lectureId: z.string().optional(),
      sessionId: z.string().optional(),
      courseOfferingId: z.string().optional(),
      date: z.string().optional(),
    })
    .strict(),
  'exam-preparation': z
    .object({ examId: z.string().optional(), courseOfferingId: z.string().optional() })
    .strict(),
  admin: z.object({}).strict(),
} satisfies Record<ContextViewName, z.ZodType>;

export function isContextViewName(name: string): name is ContextViewName {
  return CONTEXT_VIEWS.some((v) => v.name === name);
}

/** Generic dispatcher used by MCP resources / REST: getView(engine, "today", {}). */
export function getView<N extends ContextViewName>(
  engine: ContextEngine,
  name: N,
  params: unknown = {},
): ContextViewResultMap[N] {
  const parsed = ContextViewParams[name].safeParse(params ?? {});
  if (!parsed.success)
    throw new ValidationError(
      `Invalid params for ${name}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  const p = parsed.data as Record<string, string | number | undefined>;
  const opt = <T extends Record<string, unknown>>(o: T): T =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  const results: { [K in ContextViewName]: () => ContextViewResultMap[K] } = {
    today: () => engine.today(),
    tomorrow: () => engine.tomorrow(),
    week: () => engine.week(),
    course: () => engine.course(String(p.courseOfferingId)),
    deadline: () =>
      engine.deadline(
        opt({
          days: p.days as number | undefined,
          courseOfferingId: p.courseOfferingId as string | undefined,
        }),
      ),
    changes: () =>
      engine.changesSince(
        opt({
          since: p.since as string | undefined,
          courseOfferingId: p.courseOfferingId as string | undefined,
        }),
      ),
    'class-preparation': () =>
      engine.classPreparation(
        opt({
          sessionId: p.sessionId as string | undefined,
          courseOfferingId: p.courseOfferingId as string | undefined,
        }),
      ),
    'class-review': () =>
      engine.classReview(
        opt({
          lectureId: p.lectureId as string | undefined,
          sessionId: p.sessionId as string | undefined,
          courseOfferingId: p.courseOfferingId as string | undefined,
          date: p.date as string | undefined,
        }),
      ),
    'exam-preparation': () =>
      engine.examPreparation(
        opt({
          examId: p.examId as string | undefined,
          courseOfferingId: p.courseOfferingId as string | undefined,
        }),
      ),
    admin: () => engine.admin(),
  };
  return results[name]();
}
