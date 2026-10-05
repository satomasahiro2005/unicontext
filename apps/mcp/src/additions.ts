import { ADDITION_STATUSES, type AdditionStatus } from '@unicontext/canonical-model';
import {
  ADDITION_LIMITS,
  ADDITION_VIAS,
  type AdditionClient,
  type AdditionResult,
  type AdditionView,
  INGEST_LIMITS,
  type IngestItemResult,
  type IngestLectureResult,
  type UniContext,
} from '@unicontext/context-engine';
import { z } from 'zod';
import { resolveCourse } from './courses.js';

/*
 * MCP write tools (record_lecture, add_deadline, add_note, add_task, list_my_additions,
 * retract_addition): deadlines, to-dos, notes and lecture summaries that the student states or
 * plans in any chat (via chat) or that an AI client heard in a lecture recording (via recording)
 * go into UniContext's own database only — never to a university system — so every other session
 * and client sees them. They are origin=extracted data that never override a system and that the
 * owner can confirm or reject (`unicontext additions`, Web UI). See AdditionsService.
 */

const L = ADDITION_LIMITS;

const course = z
  .string()
  .min(1)
  .max(200)
  .describe(
    '科目名（「データベース」など一部でよい）・科目コード・courseOffering:… の id / Course name, code or id',
  );
const optionalCourse = course
  .optional()
  .describe(
    '科目名（一部でよい）・科目コード・id。科目に関係ない個人の締切・やること・メモなら省略 / Course name, code or id; omit for personal items',
  );
const via = z
  .enum(ADDITION_VIAS)
  .optional()
  .describe(
    'chat=この会話でユーザーが言った・ユーザーと一緒に決めた（既定）／recording=講義の録音で聞いた（recordingTimestamp を付けると既定でこちら） / chat = the student said or planned it in this conversation (default); recording = heard in a lecture recording',
  );
const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('YYYY-MM-DD');
const recordingTimestamp = z
  .string()
  .max(16)
  .optional()
  .describe('録音の中の位置 "HH:MM:SS"（録音のときだけ） / Position in the recording');
const lectureDate = localDate
  .optional()
  .describe(
    'その話があった日（講義の日・会話の日。相対的な締切の基準。省略時は今日） / Date of the lecture or conversation it was said in (anchor for relative dates; default today)',
  );
const source = z
  .string()
  .max(L.source)
  .optional()
  .describe(
    '出どころの名前。省略時は録音なら「ChatGPT Record」、会話なら「ChatGPTとの会話」など / Source name (default: ChatGPT Record / ChatGPTとの会話)',
  );
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
  .describe(
    '根拠をそのまま引用：会話ならユーザーの言葉（「レポートの締切10/20」など）、録音なら先生の発言 / Verbatim quote: the student’s own words in the chat, or what was said in the lecture',
  );

const AdditionOutput = z.looseObject({
  id: z.string(),
  tool: z.string(),
  kind: z.string(),
  status: z.enum(ADDITION_STATUSES),
  via: z.enum(ADDITION_VIAS),
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
  via: via.describe(
    'recording=講義の録音から（既定）／chat=ユーザーが会話で講義の内容を話した / recording (default) or chat',
  ),
  source,
  idempotencyKey,
};

export const addDeadlineShape = {
  course: optionalCourse,
  title: z.string().min(1).max(L.title).describe('課題・試験などの名前 / Title'),
  dueAt: z
    .string()
    .min(1)
    .max(100)
    .describe(
      '締切・日時。ISO-8601（2026-10-15T23:59:00+09:00）か、言われたままの日本語（10月20日17時 / 来週の金曜 / 次回）。相対表現は会話・講義の日、時間割、学年暦で解決して返す（「次回」は科目が必要） / Absolute ISO-8601, or the Japanese expression as said; relative ones are resolved with the date, timetable and academic calendar (次回 needs a course)',
    ),
  kind: z
    .enum(['assignment', 'report', 'quiz', 'exam', 'prep'])
    .describe(
      'assignment=課題, report=レポート, quiz=小テスト, exam=試験, prep=授業までの準備 / What it is',
    ),
  evidence,
  via,
  recordingTimestamp,
  lectureDate,
  notes: z.string().max(L.notes).optional().describe('補足（範囲・形式など） / Notes'),
  source,
  idempotencyKey,
};

export const addNoteShape = {
  course: optionalCourse,
  title: z.string().max(L.title).optional().describe('メモの題 / Title'),
  text: z.string().min(1).max(L.noteText).describe('メモの本文 / Note text'),
  evidence: evidence.optional(),
  via,
  lectureDate,
  recordingTimestamp,
  source,
  idempotencyKey,
};

export const addTaskShape = {
  course: optionalCourse,
  title: z.string().min(1).max(L.title).describe('やること / What to do'),
  dueAt: addDeadlineShape.dueAt.optional().describe('期限（なければ省略） / Due date, if any'),
  notes: z.string().max(L.notes).optional(),
  evidence: evidence.optional(),
  via,
  lectureDate,
  recordingTimestamp,
  source,
  idempotencyKey,
};

export const getNotesShape = {
  course: optionalCourse.describe('科目で絞る / Only this course'),
  personal: z
    .boolean()
    .optional()
    .describe('true で科目に関係ない個人メモだけ / Only notes without a course'),
  query: z.string().min(1).max(200).optional().describe('この文字列を含むメモ / Text filter'),
  id: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('1件を全文で（document:… か addition:… の id） / One note, full text'),
  limit: z.number().int().positive().max(100).optional().describe('既定20 / Default 20'),
};

export const listAdditionsShape = {
  status: z
    .union([z.enum(ADDITION_STATUSES), z.array(z.enum(ADDITION_STATUSES))])
    .optional()
    .describe('unconfirmed | confirmed | rejected | retracted（配列可）'),
  limit: z.number().int().positive().max(200).optional(),
  ingestionId: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'ingest_lecture の結果の ingestionId。その録音から保存したものだけ / Only what one ingest_lecture call stored',
    ),
};

// ---------- ingest_lecture ----------

const IL = INGEST_LIMITS;

const itemKey = z
  .string()
  .min(1)
  .max(IL.itemKey)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u)
  .optional()
  .describe(
    'この録音の中での項目の固定名（report-2・quiz-uml など）。取り込み直しで同じ項目を指すのに使う。省略時は題名から作る / Stable name of the item in this recording; default: from the title',
  );
const itemEvidence = evidence.describe(
  '先生の発言をそのまま引用（「次回までにクラス図を描いてきてください」など） / Verbatim quote from the recording',
);
const itemTimestamp = recordingTimestamp.describe(
  'その発言の録音の中の位置 "HH:MM:SS" / Position of the quote in the recording',
);

export const ingestLectureShape = {
  course: optionalCourse.describe(
    '科目名（一部でよい）・科目コード・id。省略すると lectureDate と period から時間割で決める / Course; omitted: the class of the timetable at lectureDate (+ period)',
  ),
  lectureDate: localDate
    .optional()
    .describe(
      '講義の日 YYYY-MM-DD（省略時は今日）。相対的な締切の基準 / Lecture date (default today); anchor for relative due dates',
    ),
  period: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe(
      '時限。その日にその科目の授業が1コマ（または続きのコマ）だけなら省略してよい / Period; may be omitted when the course has one class (block) that day',
    ),
  title: z
    .string()
    .max(L.title)
    .optional()
    .describe('講義の題（第3回 正規化 など） / Lecture title'),
  summary: z
    .string()
    .min(1)
    .max(L.summary)
    .describe(
      '後で検索・復習するための要約（文字起こしを貼らない） / Summary for later search and review, not the transcript',
    ),
  keyPoints: z
    .array(z.string().min(1).max(L.keyPoint))
    .max(L.keyPoints)
    .optional()
    .describe('要点（短い箇条書き） / Key points, short'),
  segments: recordLectureShape.segments.describe(
    '大事な発言（課題・試験・連絡・説明の山場）だけをタイムスタンプつきで / Only the important timestamped segments',
  ),
  recordingRef: z
    .string()
    .min(1)
    .max(IL.recordingRef)
    .optional()
    .describe(
      'この録音・会話の id が分かれば（chatgpt-record:<会話id> など）。同じ録音を取り込み直しても二重にならない。分からなければ省略 / Id of the recording or conversation, if known; omit otherwise',
    ),
  source,
  deadlines: z
    .array(
      z.object({
        key: itemKey,
        title: addDeadlineShape.title,
        dueAt: addDeadlineShape.dueAt,
        kind: addDeadlineShape.kind,
        evidence: itemEvidence,
        recordingTimestamp: itemTimestamp,
        notes: addDeadlineShape.notes,
      }),
    )
    .max(IL.deadlines)
    .optional()
    .describe(
      '録音の中で実際に言われた締切・試験・小テスト・授業までの準備だけ / Deadlines, exams and preparation actually stated',
    ),
  tasks: z
    .array(
      z.object({
        key: itemKey,
        title: addTaskShape.title,
        dueAt: addTaskShape.dueAt,
        evidence: itemEvidence,
        recordingTimestamp: itemTimestamp,
        notes: addTaskShape.notes,
      }),
    )
    .max(IL.tasks)
    .optional()
    .describe('学生がやらなければならないこと / Things the student has to do'),
  notes: z
    .array(
      z.object({
        key: itemKey,
        title: addNoteShape.title,
        text: z.string().min(1).max(IL.noteText).describe('メモの本文 / Note text'),
        evidence: itemEvidence,
        recordingTimestamp: itemTimestamp,
      }),
    )
    .max(IL.notes)
    .optional()
    .describe(
      '締切ではないが後で要る情報（教室・出席・提出の方法、グループ分け、特別な手順、先生の大事な注意） / Non-deadline information needed later',
    ),
};

const INGEST_ITEM_STATUSES = [
  'created',
  'updated',
  'duplicate',
  'replayed',
  'skipped',
  'failed',
] as const;

const IngestItemOutput = z.looseObject({
  type: z.enum(['lecture', 'deadline', 'task', 'note']),
  title: z.string(),
  status: z.enum(INGEST_ITEM_STATUSES),
});

export const INGEST_RESULT_SHAPE = {
  outcome: z.enum(['stored', 'unchanged', 'partial', 'failed']),
  ingestionId: z.string(),
  course: z.looseObject({ id: z.string(), title: z.string() }),
  lectureDate: z.string(),
  counts: z.looseObject({
    created: z.number().int(),
    updated: z.number().int(),
    unchanged: z.number().int(),
    failed: z.number().int(),
  }),
  lecture: IngestItemOutput,
  items: z.array(IngestItemOutput),
  answerHint: z.string(),
};

const TYPE_JA: Record<IngestItemResult['type'], string> = {
  lecture: '講義',
  deadline: '締切',
  task: 'やること',
  note: 'メモ',
};

function ingestItem(
  x: IngestItemResult,
  redactText: (s: string) => string,
): Record<string, unknown> & { status: (typeof INGEST_ITEM_STATUSES)[number] } {
  const base = {
    type: x.type,
    ...(x.type !== 'lecture' ? { index: x.index } : {}),
    title: x.title,
    ...(x.key ? { key: x.key } : {}),
  };
  if (!x.result)
    return {
      ...base,
      status: 'failed',
      error: {
        code: x.error?.code ?? 'internal',
        message: redactText(x.error?.message ?? 'failed'),
      },
    };
  const r = x.result;
  const a = r.addition;
  const status: (typeof INGEST_ITEM_STATUSES)[number] =
    a.status === 'rejected' || a.status === 'retracted'
      ? 'skipped'
      : r.status === 'confirmed' || (r.status === 'replayed' && a.status === 'confirmed')
        ? 'duplicate'
        : r.status === 'created' || r.status === 'updated' || r.status === 'duplicate'
          ? r.status
          : 'replayed';
  return {
    ...base,
    title: a.title,
    status,
    additionId: a.id,
    ...(status === 'skipped'
      ? {
          reason:
            a.status === 'rejected'
              ? '本人が却下済みのため登録し直していません'
              : '取り消し済みのため登録し直していません',
        }
      : {}),
    ...(a.dueText ? { dueAt: a.dueAt, dueText: a.dueText } : {}),
    ...(a.dueResolution &&
    typeof a.dueResolution === 'object' &&
    !Array.isArray(a.dueResolution) &&
    typeof a.dueResolution.input === 'string'
      ? { dueInput: a.dueResolution.input }
      : {}),
    ...(a.attachedTo ? { attachedTo: { id: a.attachedTo.id, title: a.attachedTo.title } } : {}),
    ...(a.conflicts.length > 0 ? { conflicts: a.conflicts } : {}),
  };
}

/** structuredContent of ingest_lecture: a compact per-part report plus what to tell the user. */
export function ingestOutput(
  r: IngestLectureResult,
  redactText: (s: string) => string = (s) => s,
): Record<string, unknown> {
  const lecture = ingestItem(r.lecture, redactText);
  const items = r.items.map((x) => ingestItem(x, redactText));
  const all = [lecture, ...items];
  const n = (s: string): number => all.filter((x) => x.status === s).length;
  const counts = {
    created: n('created'),
    updated: n('updated'),
    unchanged: n('duplicate') + n('replayed') + n('skipped'),
    failed: n('failed'),
  };
  const outcome =
    counts.failed === all.length
      ? 'failed'
      : counts.failed > 0
        ? 'partial'
        : counts.created + counts.updated > 0
          ? 'stored'
          : 'unchanged';

  const [, month, day] = r.lectureDate.split('-').map(Number);
  const when = `${r.course.title} ${month}/${day}${r.period !== undefined ? ` ${r.period}限` : ''}`;
  const hint: string[] = [];
  const stored = (s: string): boolean => s === 'created' || s === 'updated';
  if (stored(lecture.status)) hint.push(`講義「${when}」の記録を保存しました。`);
  else if (lecture.status === 'failed') hint.push(`講義「${when}」の記録は保存できませんでした。`);
  else hint.push(`講義「${when}」の記録は保存済みでした。`);
  const byType = (['deadline', 'task', 'note'] as const)
    .map((t) => [t, items.filter((x) => x.type === t && stored(x.status)).length] as const)
    .filter(([, c]) => c > 0)
    .map(([t, c]) => `${TYPE_JA[t]}${c}件`);
  if (byType.length > 0) hint.push(`${byType.join('・')}を保存しました。`);
  const dated = items.filter((x) => stored(x.status) && typeof x.dueText === 'string');
  if (dated.length > 0)
    hint.push(
      `日時は ${dated.map((x) => `「${x.title}」${String(x.dueText)}`).join('、')} として登録しました。この日時をユーザーに伝えてください。`,
    );
  if (all.some((x) => Array.isArray(x.conflicts)))
    hint.push(
      '大学側の情報と食い違う項目があります（conflicts）。どちらが正しいか断定せず、両方をユーザーに伝えてください。大学側の値は変えていません。',
    );
  if (counts.unchanged > 0 && counts.created + counts.updated === 0 && counts.failed === 0)
    hint.push('同じ内容が既に保存されていたので、何も変えていません（二重には登録していません）。');
  const failed = all.filter((x) => x.status === 'failed');
  if (failed.length > 0)
    hint.push(
      `保存できなかった項目: ${failed
        .map((x) => `${TYPE_JA[x.type as IngestItemResult['type']]}「${x.title}」`)
        .join(
          '、',
        )}（items の error を参照）。他の項目は保存済みです。直せるなら同じ呼び出しをもう一度送れば、保存済みのものは二重にならず、足りないものだけ保存されます。`,
    );
  if (counts.created + counts.updated > 0)
    hint.push(
      '本人が確認するまでは「録音から」の未確認情報として、他の会話・クライアントの get_today・get_week・get_deadlines・get_tasks・get_notes にも出ます。大学のシステムには何も送っていません。回答の最後に、保存したことを一言添えてください。',
    );
  return {
    outcome,
    ingestionId: r.ingestionId,
    course: r.course,
    lectureDate: r.lectureDate,
    ...(r.period !== undefined ? { period: r.period } : {}),
    ...(r.recordingRef ? { recordingRef: r.recordingRef } : {}),
    counts,
    lecture,
    items,
    answerHint: hint.join(''),
  };
}

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
  '保存先はUniContextだけで、大学のシステムには何も送らない。保存した内容はChatGPTの他の会話やClaudeなど、UniContextにつながる全てのセッションから get_today・get_week・get_deadlines・get_tasks・get_course・get_notes で見える。会話でユーザーが言った・一緒に決めたものは「チャットで登録」、講義の録音で聞いたものは「録音から」と表示される。学務情報システムやLMSの値は上書きせず、食い違うときは食い違いとして表示される（本人が確認すると本人の情報として優先される）。課題の提出状態・成績・履修は変更できない。';
const COMMON_EN =
  'Stored only in UniContext (nothing is sent to any university system) and visible to every other session and client connected to UniContext — other ChatGPT chats, Claude — through get_today, get_week, get_deadlines, get_tasks, get_course and get_notes. Labelled 「チャットで登録」 (said or planned in a chat) or 「録音から」 (heard in a lecture recording). Never overrides LiveCampusU/LMS data — disagreements become conflicts — unless the owner confirms it. Cannot change submission/completion status, grades or enrolment.';

/** What to keep from a lecture recording (ingest_lecture and the server instructions). */
export const RECORDING_RULES_JA =
  'summary と keyPoints は後で検索・復習するのに要ることに絞り、文字起こしをそのまま入れない。segments には大事な発言（課題・試験・連絡など）だけをタイムスタンプつきで入れる。雑談や、他の学生どうしの会話は入れない。deadlines には先生が実際に言った締切・試験・小テスト・授業までの準備だけを入れる（「次回までに〜」は根拠になるが、次の授業があるというだけでは締切にしない）。tasks は学生がやらなければならないこと。notes は締切ではないが後で要る情報（教室・出席・提出の方法、グループ分け、特別な手順、先生の大事な注意）。各項目の evidence に発言をそのまま引用し、recordingTimestamp に録音の位置を入れる。';

export const WRITE_TOOLS = {
  ingest_lecture: {
    title: '講義の録音を取り込む',
    description: `講義の録音・文字起こし（ChatGPT Record など）が入力として与えられ、科目と日付を合理的に特定できる場合は、ユーザーから保存依頼がなくても ingest_lecture を呼ぶ。質問への回答や要約はいつもどおり行い、それとは別に1回呼ぶ。保存してよいかユーザーに確かめない（本人が確認するまで「録音から」の未確認情報として保存され、大学側の値は上書きしない）。科目・日付・時限は会話・録音の内容・時間割から決め、ユーザーに聞き直さない（course を省略すると lectureDate と period から時間割で決まる。lectureDate の省略は今日）。1回の呼び出しで、講義の記録（要約・要点・大事な発言）と、録音で言われた締切・やること・メモをまとめて保存する。${RECORDING_RULES_JA}dueAt は言われたままの表現（次回・来週の金曜・10月20日17時）でよく、講義の日・時間割・学年暦で解決した日時が返るのでユーザーに伝える。録音・会話の id が分かれば recordingRef に入れる（例 chatgpt-record:<会話id>）。分からなければ省略してよい（科目・日付・時限から決まる）。同じ呼び出しをもう一度送っても、保存済みのものは二重にならず、変わったものは更新され、前回保存できなかったものだけが足される。結果は項目ごとに返り、一部が保存できなくても他は保存される。結果の ingestionId で、この録音から保存したものを list_my_additions で一覧できる。${COMMON_DESC} / When a lecture recording or transcript (e.g. ChatGPT Record) is given as input and the course and date can reasonably be determined, call ingest_lecture even if the user did not ask to save anything, in addition to answering as usual. Do not ask the user first: everything is stored as unconfirmed 「録音から」 and never overrides university data. Infer course, date and period from the conversation, the recording and the timetable instead of asking. One call stores the lecture (summary and key points for later search and review, not the transcript; only the important timestamped segments) and the deadlines (only those actually stated), to-dos and notes said in it, each with a verbatim evidence quote and its recording timestamp. Leave out chatter and conversations between other students. Sending the same call again never stores anything twice (recordingRef such as chatgpt-record:<conversation-id> and per-item keys, or course + date + period); parts that failed before are added. Results per part. ${COMMON_EN}`,
  },
  record_lecture: {
    title: '講義の記録を保存',
    description: `講義の要約・要点（任意でタイムスタンプつきの文字起こし）を、その日の授業に結びつけて保存する。講義の録音・文字起こしが与えられたときは、締切・やること・メモも一緒に保存する ingest_lecture を呼ぶ。record_lecture は講義の記録だけを保存し直すときや、ユーザーが会話で講義の内容を話したとき（via=chat）に使う。録音からの記録はユーザーに確かめずに保存してよい。要約・要点は後で検索・復習するのに要ることに絞り、文字起こしをそのまま入れない。同じ科目・日付・時限なら更新。${COMMON_DESC} / Save a lecture summary, key points and optional timestamped transcript for that day's class. For a lecture recording or transcript, call ingest_lecture instead (it also stores the deadlines, to-dos and notes said in it); use this to save only the lecture, or when the student tells you about a lecture in the chat (via=chat). ${COMMON_EN}`,
  },
  add_deadline: {
    title: '締切・試験を登録',
    description: `どの会話でも、ユーザーが課題・レポートの締切、小テスト・試験の日程、授業までの準備を言ったら（例「レポートの締切10/20って登録しといて」「来週の金曜に小テスト」）、これで登録する。ユーザーが頼んでいなくても、UniContextにまだない締切が話に出たら登録を提案する。講義の録音・文字起こしから取り出す締切は ingest_lecture でまとめて保存する。録音の締切を1件だけ足すならここで via=recording とし、recordingTimestamp に録音の位置を入れ、ユーザーに確かめずに保存する。録音からは先生が実際に言った締切だけを入れる（「次回までに〜」は根拠になるが、次の授業があるというだけでは締切にしない）。dueAt は ISO-8601 か言われたままの日本語（10月20日17時・来週の金曜・次回）で、解決した日時が返るので必ずユーザーに伝える。course は分かれば科目名で、科目に関係ない締切（奨学金・就活など）なら省略。evidence にユーザーの言葉や発言をそのまま引用する。同じ科目・題名・近い締切なら二重にせず更新する。${COMMON_DESC} / Register a deadline, exam or preparation item the student mentions in ANY chat so every other session sees it; returns the resolved date — tell it to the user. Deadlines from a lecture recording go through ingest_lecture (or here with via=recording), stored without asking, and only when actually stated. ${COMMON_EN}`,
  },
  add_note: {
    title: 'メモを保存',
    description: `メモを保存する。科目のメモ（講義のポイント・先生からの連絡・ヒント）でも、科目に関係ない個人のメモ（覚えておきたいこと・勉強のメモ・決めたこと）でもよい（そのときは course を省略）。ユーザーが「メモしといて」「覚えておいて」と言ったときに使う。講義の録音で聞いた、締切ではないが後で要る情報（教室・出席・提出の方法、グループ分け、特別な手順、先生の大事な注意）は ingest_lecture の notes でまとめて保存する（1件だけならここで via=recording とし、ユーザーに確かめずに保存する）。保存したメモは get_notes と search で、他の会話・クライアントからも読める。${COMMON_DESC} / Save a note — about a course, or a personal one without a course — that the student asks to keep; readable from every session via get_notes and search. Information from a lecture recording goes through ingest_lecture (or here with via=recording), stored without asking. ${COMMON_EN}`,
  },
  add_task: {
    title: 'やることを登録',
    description: `やること（期限なしも可）を登録する。ユーザーが「〜をやらなきゃ」と言ったこと、会話でユーザーと一緒に立てた勉強計画のTODOに使う。講義の録音・文字起こしで言われた、学生がやらなければならないことは ingest_lecture の tasks でまとめて保存する（1件だけならここで via=recording とし、ユーザーに確かめずに保存する）。科目に関係ないものは course を省略。期限があれば dueAt に入れる（解決した日時が返るのでユーザーに伝える）。${COMMON_DESC} / Register a to-do the student mentions or plans with you in ANY chat, so every other session sees it in get_tasks / get_today. To-dos from a lecture recording go through ingest_lecture (or here with via=recording), stored without asking. ${COMMON_EN}`,
  },
  list_my_additions: {
    title: '自分が追加した内容',
    description:
      'この接続（クライアント）が追加した内容と、その状態（unconfirmed=未確認 / confirmed=本人が確認済み / rejected=本人が却下 / retracted=取り消し済み）を新しい順に返す。取り消し（retract_addition）の対象を探すときに使う。ingestionId（ingest_lecture の結果）を渡すと、その録音から保存したものだけを返す。他の会話・クライアントが登録したものも含めて見るなら get_deadlines・get_tasks・get_notes。 / This client’s own additions and their status (to find one to retract); ingestionId: only what one ingest_lecture call stored. Everything from every client: get_deadlines, get_tasks, get_notes.',
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
  created: '保存しました。UniContextにつながる他の会話・クライアントからも見えます。',
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
      `大学側の既存の項目「${a.attachedTo.title}」に、${a.label}の日時として添えました（大学側の値は変わりません）。`,
    );
  if (a.conflicts.length > 0)
    parts.push(
      '大学側の情報と食い違っています。どちらが正しいか断定せず、両方をユーザーに伝えてください。',
    );
  if (r.status === 'created' || r.status === 'updated')
    parts.push(
      a.via === 'chat'
        ? '「チャットで登録」として表示されます。大学のシステムには何も送っていません。'
        : '本人が確認するまでは「録音から」の未確認情報です。大学のシステムには何も送っていません。',
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

export function courseIdForWrite(uc: UniContext, input: string): string;
export function courseIdForWrite(uc: UniContext, input: string | undefined): string | undefined;
export function courseIdForWrite(uc: UniContext, input: string | undefined): string | undefined {
  if (input === undefined || input.trim() === '') return undefined;
  return resolveCourse(uc, input, { preferEnrolled: true }).ref.id;
}

export const GET_NOTES_TOOL = {
  title: 'メモ一覧',
  description:
    'UniContextに保存されたメモ（add_note）と講義の要約（record_lecture）を、どの会話・クライアントが保存したものでも新しい順に返す。「前にメモしたこと」「〜について何かメモしてた？」に使う。course で科目を絞る、personal=true で科目に関係ない個人メモだけ、query で文字列を含むもの、id で1件を全文で。text は一覧では500字まで（truncated=true なら id で全文）。 / Notes and lecture summaries saved by any chat or client, newest first; filter by course, personal, query, or fetch one by id in full.',
} as const;

export function toStatuses(
  s: AdditionStatus | AdditionStatus[] | undefined,
): AdditionStatus[] | undefined {
  return s === undefined ? undefined : Array.isArray(s) ? s : [s];
}

export type { AdditionClient };
