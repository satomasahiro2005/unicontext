import { ADDITION_STATUSES, type AdditionStatus } from '@unicontext/canonical-model';
import {
  ADDITION_LIMITS,
  type AdditionClient,
  type AdditionResult,
  type AdditionView,
  type UniContext,
} from '@unicontext/context-engine';
import { z } from 'zod';
import { resolveCourse } from './courses.js';

/*
 * MCP write tools (record_lecture, add_deadline, add_note, add_task, list_my_additions,
 * retract_addition): what an AI client heard in a lecture recording goes into UniContext's own
 * database only — never to a university system — as unconfirmed, origin=extracted data that the
 * owner confirms or rejects (`unicontext additions`, Web UI). See AdditionsService.
 */

const L = ADDITION_LIMITS;

const course = z
  .string()
  .min(1)
  .max(200)
  .describe(
    '科目名（「データベース」など一部でよい）・科目コード・courseOffering:… の id / Course name, code or id',
  );
const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('YYYY-MM-DD');
const recordingTimestamp = z
  .string()
  .max(16)
  .optional()
  .describe('録音の中の位置 "HH:MM:SS" / Position in the recording');
const lectureDate = localDate
  .optional()
  .describe(
    'その話があった講義の日付（相対的な締切の基準。省略時は今日） / Date of the lecture it was said in (anchor for relative dates; default today)',
  );
const source = z
  .string()
  .max(L.source)
  .optional()
  .describe('録音の出どころ。省略時は「ChatGPT Record」 / Recording source name');
const idempotencyKey = z
  .string()
  .min(1)
  .max(L.idempotencyKey)
  .optional()
  .describe(
    '同じ呼び出しをやり直すときに同じ値を送ると二重登録されない / Same key = same call, never stored twice',
  );
const evidence = z
  .string()
  .min(1)
  .max(L.evidence)
  .describe('根拠になった発言をそのまま引用 / Verbatim quote of what was said');

const AdditionOutput = z.looseObject({
  id: z.string(),
  tool: z.string(),
  kind: z.string(),
  status: z.enum(ADDITION_STATUSES),
  title: z.string(),
});

export const WRITE_RESULT_SHAPE = {
  status: z.enum(['created', 'updated', 'duplicate', 'replayed', 'retracted']),
  addition: AdditionOutput,
  answerHint: z.string(),
};

export const LIST_RESULT_SHAPE = {
  additions: z.array(AdditionOutput),
  answerHint: z.string(),
};

export const recordLectureShape = {
  course,
  date: localDate.describe('講義の日付 YYYY-MM-DD / Lecture date'),
  period: z.number().int().min(1).max(10).optional().describe('時限 / Period'),
  title: z
    .string()
    .max(L.title)
    .optional()
    .describe('講義の題（第3回 正規化 など） / Lecture title'),
  summary: z.string().min(1).max(L.summary).describe('講義の要約 / Summary of the lecture'),
  keyPoints: z
    .array(z.string().min(1).max(L.keyPoint))
    .max(L.keyPoints)
    .optional()
    .describe('要点（箇条書き） / Key points'),
  transcriptExcerpt: z
    .string()
    .max(L.segmentText * 5)
    .optional()
    .describe('文字起こしの抜粋（recordingTimestamp の位置のもの） / Transcript excerpt'),
  segments: z
    .array(
      z.object({
        at: recordingTimestamp,
        text: z.string().min(1).max(L.segmentText),
        speaker: z.string().max(60).optional(),
      }),
    )
    .max(L.segments)
    .optional()
    .describe('タイムスタンプつきの文字起こし / Timestamped transcript segments'),
  recordingTimestamp,
  source,
  idempotencyKey,
};

export const addDeadlineShape = {
  course,
  title: z.string().min(1).max(L.title).describe('課題・試験などの名前 / Title'),
  dueAt: z
    .string()
    .min(1)
    .max(100)
    .describe(
      '締切・日時。ISO-8601（2026-10-15T23:59:00+09:00）か、聞いたままの日本語（来週の金曜 / 次回 / 10月15日17時）。相対表現は講義日・時間割・学年暦で解決して返す / Absolute ISO-8601, or the Japanese expression as heard; relative ones are resolved with the lecture date, timetable and academic calendar',
    ),
  kind: z
    .enum(['assignment', 'report', 'quiz', 'exam', 'prep'])
    .describe(
      'assignment=課題, report=レポート, quiz=小テスト, exam=試験, prep=授業までの準備 / What it is',
    ),
  evidence,
  recordingTimestamp,
  lectureDate,
  notes: z.string().max(L.notes).optional().describe('補足（範囲・形式など） / Notes'),
  source,
  idempotencyKey,
};

export const addNoteShape = {
  course,
  title: z.string().max(L.title).optional().describe('メモの題 / Title'),
  text: z.string().min(1).max(L.noteText).describe('メモの本文 / Note text'),
  evidence: evidence.optional(),
  lectureDate,
  recordingTimestamp,
  source,
  idempotencyKey,
};

export const addTaskShape = {
  course,
  title: z.string().min(1).max(L.title).describe('やること / What to do'),
  dueAt: addDeadlineShape.dueAt.optional(),
  notes: z.string().max(L.notes).optional(),
  evidence: evidence.optional(),
  lectureDate,
  recordingTimestamp,
  source,
  idempotencyKey,
};

export const listAdditionsShape = {
  status: z
    .union([z.enum(ADDITION_STATUSES), z.array(z.enum(ADDITION_STATUSES))])
    .optional()
    .describe('unconfirmed | confirmed | rejected | retracted（配列可）'),
  limit: z.number().int().positive().max(200).optional(),
};

export const openAnnouncementShape = {
  ids: z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(10)
    .describe('announcement:… の id（get_announcements の結果。最大10件）'),
};

export const OPEN_ANNOUNCEMENT_RESULT_SHAPE = {
  results: z.array(
    z.looseObject({
      id: z.string(),
      status: z.enum(['opened', 'alreadyFetched', 'notFound', 'unsupported', 'failed']),
      markedReadAtSource: z.boolean(),
    }),
  ),
  opened: z.number().int(),
  markedReadAtSource: z.number().int(),
  answerHint: z.string(),
};

export const retractAdditionShape = {
  additionId: z.string().min(1).max(100).describe('addition:… の id'),
};

const COMMON_DESC =
  'UniContext自身のデータベースにだけ保存し、大学のシステムには何も送らない。保存した内容は「録音から」の未確認情報として扱われ、学務情報システムなどの値を上書きせず、食い違うときは食い違いとして表示される。本人が確認（unicontext additions confirm / Web UI）するまで確定しない。課題の提出状態・成績・履修は変更できない。';
const COMMON_EN =
  'Stored only in UniContext’s local database; nothing is sent to any university system. Stored as unconfirmed extracted data (shown as 「録音から」) that never overrides an authoritative source — disagreements become conflicts — until the owner confirms it. Cannot change submission/completion status, grades or enrolment.';

export const WRITE_TOOLS = {
  record_lecture: {
    title: '講義の記録を保存',
    description: `録音で聞いた講義の要約・要点（任意でタイムスタンプつきの文字起こし）を、その日の授業に結びつけて保存する。同じ科目・日付・時限なら更新。${COMMON_DESC} / Save a lecture summary, key points and optional timestamped transcript for that day's class. ${COMMON_EN}`,
  },
  add_deadline: {
    title: '締切・試験・準備を追加',
    description: `録音で聞いた課題の締切・レポート・小テスト・試験・授業までの準備を追加する。dueAt は ISO-8601 か聞いたままの日本語（来週の金曜・次回など）で、解決した日時を返すので必ずユーザーに伝える。evidence に発言の引用、recordingTimestamp に録音の位置を入れる。同じ科目・題名・近い締切なら二重にせず更新する。${COMMON_DESC} / Add a deadline, exam or preparation item heard in a lecture; returns the resolved date. ${COMMON_EN}`,
  },
  add_note: {
    title: '講義メモを追加',
    description: `講義で聞いたその他のメモ（連絡事項・ヒントなど）を科目に追加する。検索で見つかるようになる。${COMMON_DESC} / Add a note heard in a lecture. ${COMMON_EN}`,
  },
  add_task: {
    title: 'やることを追加',
    description: `講義で言われたやること（期限なしも可）をタスクとして追加する。${COMMON_DESC} / Add a to-do heard in a lecture. ${COMMON_EN}`,
  },
  list_my_additions: {
    title: '自分が追加した内容',
    description:
      'この接続（クライアント）が追加した内容と、その状態（unconfirmed=未確認 / confirmed=本人が確認済み / rejected=本人が却下 / retracted=取り消し済み）を新しい順に返す。他のクライアントの追加は見えない。 / This client’s own additions and their status.',
  },
  open_announcement: {
    title: 'お知らせの本文を取得（LiveCampusUで既読になる）',
    description:
      '【LiveCampusUのお知らせが既読になる・元に戻せない】本文を取得していない（bodyStatus が notOpened）LiveCampusUのお知らせを、指定したものだけ開いて本文を取得する。LiveCampusUは開いたお知らせを既読にし、未読に戻す方法がないため、必ず事前にユーザー本人の了承を得てから呼ぶこと。UniContextの中では本人が読むまで未読のまま表示される。本文以外は何も変更・送信しない。 / Opens the given unread LiveCampusU notices to fetch their bodies. THIS MARKS THEM READ IN LIVECAMPUSU AND CANNOT BE UNDONE: ask the user first. UniContext keeps them unread until the user reads them there. Nothing else is changed or sent.',
  },
  retract_addition: {
    title: '追加を取り消す',
    description:
      'この接続が追加した、まだ本人が確認していない内容を取り消す（記録・締切・タスクが消える）。他のクライアントの追加や、本人が確認済みのものは取り消せない。 / Withdraw one of this client’s own unconfirmed additions.',
  },
} as const;

/** Drop undefined/empty fields so structuredContent stays small. */
export function compactAddition(v: AdditionView): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (val === undefined || val === null) continue;
    if (Array.isArray(val) && val.length === 0) continue;
    if (typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length === 0) continue;
    out[k] = val;
  }
  return out;
}

const STATUS_HINT: Record<AdditionResult['status'], string> = {
  created: '保存しました。',
  updated: '同じ項目が既にあったので更新しました（二重には登録していません）。',
  duplicate: '同じ項目が既に登録されているため、何も変更していません。',
  replayed: 'この呼び出しは既に処理済みです（同じ idempotencyKey）。',
  retracted: '取り消しました。',
  confirmed: '本人が確認済みです。',
  rejected: '本人が却下しました。',
};

export function writeHint(r: AdditionResult): string {
  const a = r.addition;
  const parts = [STATUS_HINT[r.status]];
  if (a.dueText)
    parts.push(`日時は${a.dueText}として登録されています。この日時をユーザーに伝えてください。`);
  if (a.attachedTo)
    parts.push(
      `大学側の既存の項目「${a.attachedTo.title}」に、録音からの日時として添えました（大学側の値は変わりません）。`,
    );
  if (a.conflicts.length > 0)
    parts.push(
      '大学側の情報と食い違っています。どちらが正しいか断定せず、両方をユーザーに伝えてください。',
    );
  if (r.status === 'created' || r.status === 'updated')
    parts.push(
      '本人が確認するまでは「録音から」の未確認情報です。大学のシステムには何も送っていません。',
    );
  return parts.join('');
}

export function writeOutput(r: AdditionResult): Record<string, unknown> {
  return {
    status: r.status === 'confirmed' || r.status === 'rejected' ? 'duplicate' : r.status,
    addition: compactAddition(r.addition),
    answerHint: writeHint(r),
  };
}

export function courseIdForWrite(uc: UniContext, input: string): string {
  return resolveCourse(uc, input, { preferEnrolled: true }).ref.id;
}

export function toStatuses(
  s: AdditionStatus | AdditionStatus[] | undefined,
): AdditionStatus[] | undefined {
  return s === undefined ? undefined : Array.isArray(s) ? s : [s];
}

export type { AdditionClient };
