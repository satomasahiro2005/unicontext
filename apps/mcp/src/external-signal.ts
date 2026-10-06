import {
  type AdditionClient,
  type AdditionResult,
  EXTERNAL_SIGNAL_KINDS,
  EXTERNAL_SIGNAL_LIMITS,
  EXTERNAL_SIGNAL_SOURCES,
  type UniContext,
} from '@unicontext/context-engine';
import { z } from 'zod';
import type { WRITE_TOOLS } from './additions.js';
import { compactAddition, courseIdForWrite } from './additions.js';
import { getAttendance, GET_ATTENDANCE_TOOL, getAttendanceShape } from './attendance.js';
import type { EnvelopeOptions } from './envelope.js';
import type { ToolCallEvent } from './server.js';

/*
 * ingest_external_signal: what an AI client found in the student's own Gmail or Google Calendar
 * about university life (a registration result, a cancellation, a room change, a deadline), saved
 * into UniContext so the student never has to repeat it. UniContext does not read Gmail or the
 * calendar; the client reads them and writes the finding. It is stored like a chat addition
 * (unconfirmed, cited to the message or event, retractable) at the lowest authority, so it never
 * overrides a university value: a disagreement is shown with both values and their sources.
 */

const L = EXTERNAL_SIGNAL_LIMITS;

const iso = z
  .string()
  .min(10)
  .max(40)
  .describe('ISO-8601 日時（2026-10-05T09:30:00+09:00） / ISO-8601 date-time');

export const ingestExternalSignalShape = {
  source: z
    .enum(EXTERNAL_SIGNAL_SOURCES)
    .describe('gmail = 本人のメール、calendar = Googleカレンダー / gmail or calendar'),
  nativeId: z
    .string()
    .min(1)
    .max(L.nativeId)
    .describe(
      'メールのメッセージid・予定のid。同じものを2回送っても二重に保存されない / The message or event id; the same one is stored once',
    ),
  observedAt: iso.describe(
    'メールが届いた日時・予定を見た日時 ISO-8601 / When the mail arrived or the event was seen',
  ),
  from: z.string().max(L.from).optional().describe('差出人（メール） / Sender'),
  subject: z.string().max(L.subject).optional().describe('件名・予定の題 / Subject or event title'),
  eventStart: iso.optional().describe('予定の開始（カレンダー） / Event start'),
  eventEnd: iso.optional().describe('予定の終了（カレンダー） / Event end'),
  location: z.string().max(L.location).optional().describe('場所・教室 / Location'),
  summary: z
    .string()
    .min(1)
    .max(L.summary)
    .describe(
      '大学に関して大事なことを1〜2文で（メール全文を入れない） / What matters, in a sentence or two — not the whole mail',
    ),
  kind: z
    .enum(EXTERNAL_SIGNAL_KINDS)
    .describe(
      'registration_result=履修登録の結果（許可・不許可・抽選・取消）, cancellation=休講・中止, room_change=教室変更, deadline=締切, schedule_change=日程変更, other=その他の大学の連絡',
    ),
  course: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      '科目名（一部でよい）・科目コード・id。分かれば付ける。履修の結果（enrollment）には必須 / Course name, code or id; required with enrollment',
    ),
  task: z
    .string()
    .min(1)
    .max(L.task)
    .optional()
    .describe(
      '締切の対象（「レポート1」など）。その科目に同じ番号の課題があれば、その課題に紐づく / The work item a deadline is about; linked to the course’s assignment of the same number',
    ),
  dueAt: z
    .string()
    .min(1)
    .max(L.dueAt)
    .optional()
    .describe(
      'kind=deadline の締切。ISO-8601 か日本語の表現（10月20日17時）。省略時は eventStart / Deadline; ISO-8601 or Japanese; default eventStart',
    ),
  quote: z
    .string()
    .min(1)
    .max(L.quote)
    .describe('根拠になった文をそのまま引用 / The verbatim sentence the finding rests on'),
  url: z
    .string()
    .max(L.url)
    .optional()
    .describe('メール・予定へのリンク / Link to the mail or event'),
  enrollment: z
    .enum(['not_taking', 'taking'])
    .optional()
    .describe(
      'kind=registration_result のとき、その科目を履修するか: not_taking（不許可・抽選に落ちた・取消）/ taking（許可） / For a registration result: not_taking or taking',
    ),
};

const SIGNAL_STATUSES = ['created', 'updated', 'duplicate', 'replayed', 'retracted'] as const;

const AdditionOutput = z.looseObject({
  id: z.string(),
  tool: z.string(),
  kind: z.string(),
  status: z.string(),
  title: z.string(),
});

export const INGEST_EXTERNAL_SIGNAL_RESULT_SHAPE = {
  status: z.enum(SIGNAL_STATUSES),
  addition: AdditionOutput,
  answerHint: z.string(),
};

/** What to tell the student about one stored (or already stored) signal. */
export function externalSignalHint(r: AdditionResult): string {
  const a = r.addition;
  if (r.status === 'duplicate' || r.status === 'replayed')
    return '同じメール・予定（または同じ締切）は既に保存済みなので、何も変更していません。もう一度呼ぶ必要はありません。';
  if (r.status === 'retracted') return '取り消しました。';
  const parts = [
    '保存しました（未確認）。UniContextにつながる他の会話・クライアントからも見えます。',
  ];
  const stored = a.stored;
  if (stored.predicate === 'condition:enrollment')
    parts.push(
      stored.value === 'not_taking'
        ? 'この科目は今日の予定・次にやること・通知から外れます。学務情報システムではまだ履修中と出ている場合は、その食い違いが enrollmentNotes に1行出ます（履修登録そのものは何も変わりません）。'
        : 'この科目を本人の授業として表示します。',
    );
  if (a.dueText)
    parts.push(`締切は${a.dueText}として登録されています。この日時をユーザーに伝えてください。`);
  if (a.attachedTo)
    parts.push(
      `大学側の既存の項目「${a.attachedTo.title}」に、この連絡の日時として添えました（大学側の値は変わりません）。`,
    );
  if (a.conflicts.length > 0)
    parts.push(
      '大学側の情報と食い違っています。どちらが正しいか断定せず、両方をユーザーに伝えてください。',
    );
  parts.push(
    `${a.label}の連絡として表示されます。大学のシステム・メール・予定表には何も送っていません。`,
  );
  return parts.join('');
}

export function externalSignalOutput(r: AdditionResult): Record<string, unknown> {
  return {
    status: r.status === 'confirmed' || r.status === 'rejected' ? 'duplicate' : r.status,
    addition: compactAddition(r.addition),
    answerHint: externalSignalHint(r),
  };
}

interface ToolOutput {
  data: unknown;
  options?: EnvelopeOptions;
}

/** The registration helpers of the MCP server (server.ts) that the record tools need. */
export interface RecordToolHost {
  uc: UniContext;
  caller: () => AdditionClient;
  /** A course id from an id, a title or a code (read tools). */
  courseId: (input: string | undefined) => string | undefined;
  tool: <S extends z.ZodRawShape>(
    name: string,
    meta: { title: string; description: string; remoteDescription?: string; readOnly?: boolean },
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>) => ToolOutput | Promise<ToolOutput>,
  ) => void;
  writeTool: <S extends z.ZodRawShape>(
    name: keyof typeof WRITE_TOOLS,
    meta: { outputShape: z.ZodRawShape; destructive?: boolean; openWorld?: boolean },
    shape: S,
    run: (
      args: z.infer<z.ZodObject<S>>,
    ) => Promise<{ structured: Record<string, unknown>; write?: ToolCallEvent['write'] }>,
  ) => void;
}

/**
 * The tools of the student's records outside the university systems' own feeds: get_attendance
 * (the academic system's attendance counts) and ingest_external_signal (findings in the
 * student's Gmail / Google Calendar). The second needs the write scope on the remote surface.
 */
export function registerRecordTools(host: RecordToolHost): void {
  const { uc } = host;
  host.tool('get_attendance', GET_ATTENDANCE_TOOL, getAttendanceShape, (a) =>
    getAttendance(uc, a, host.courseId),
  );

  host.writeTool(
    'ingest_external_signal',
    { outputShape: INGEST_EXTERNAL_SIGNAL_RESULT_SHAPE },
    ingestExternalSignalShape,
    async (a) => {
      const r = await uc.additions.ingestExternalSignal(host.caller(), {
        source: a.source,
        nativeId: a.nativeId,
        observedAt: a.observedAt,
        from: a.from,
        subject: a.subject,
        eventStart: a.eventStart,
        eventEnd: a.eventEnd,
        location: a.location,
        summary: a.summary,
        kind: a.kind,
        courseOfferingId: courseIdForWrite(uc, a.course),
        task: a.task,
        dueAt: a.dueAt,
        quote: a.quote,
        url: a.url,
        enrollment: a.enrollment,
      });
      return { structured: externalSignalOutput(r), write: { status: r.status, ...r.audit } };
    },
  );
}
