import {
  attentionRequired,
  briefing,
  studentState,
  type UniContext,
} from '@unicontext/context-engine';
import { z } from 'zod';

/**
 * MCP side of the next-action engine (packages/context-engine next-action.ts / attention.ts):
 * `get_next_action` for 「何すればいい？」, and decision material for unattended scheduled tasks
 * (`get_student_state`, `get_attention_required`, `get_briefing`). All read-only.
 */

export const NEXT_ACTION_INSTRUCTIONS_JA =
  '学生は自分で優先順位を決めません。「何すればいい？」「暇」「やることある？」「次なにする？」などと聞かれたら get_next_action を呼び、top の what（すぐ始められる一歩）を why・締切・リンクと一緒に1行で伝えてください（順位は UniContext が決めます。学生に選ばせない）。会話の最初の返答では、何を聞かれても先に get_next_action（または get_today の next）を確認し、urgent が true（未提出の締切が48時間以内）なら、その top を1行だけ先に伝えてから質問に答えてください。定期実行のタスクでは get_attention_required（毎時の見守り）や get_briefing（朝・夜のまとめ）を使い、nothingImportant が true なら何も通知しないでください。全体を見て判断するときは get_student_state を使います。授業は effectiveSchedule（本人のグループなどの条件を反映した予定）で伝えてください。rawSchedule は時間割どおりの値です。notAttending の授業（他のグループの日など）を本人の授業として伝えず、status が unknown の授業はグループ次第だと伝えてください。';

export const NEXT_ACTION_INSTRUCTIONS_EN =
  'The student does not prioritise: for "what should I do / I am free / anything to do?" call get_next_action and state top.what (a step startable now) with its why, due date and link in one line. In the first reply of a conversation, whatever was asked, check get_next_action (or get_today.next) first and, when urgent is true (an unsubmitted deadline within 48 h), say the top action in one line before answering. Scheduled tasks use get_attention_required (hourly watcher) or get_briefing (morning/evening digest) and stay silent when nothingImportant is true; get_student_state is the one-call snapshot for judging. Classes: tell effectiveSchedule (after the student’s group and other personal conditions); rawSchedule is the plain timetable. Never present notAttending meetings (another group’s day) as the student’s class; say unknown meetings depend on the group.';

const courseField = z
  .string()
  .min(1)
  .describe('科目の id、または科目名・科目コードの一部 / Course id, or part of its title or code');

export const NEXT_ACTION_TOOL = {
  title: '今やること',
  description:
    '今やるべきこと1つ（top）と、その次の2〜3件（next）を返す。順位は締切までの時間・残りの作業量と空き時間（時間割・夜）・未提出・配点・試験・明日の授業準備・締切不明の課題・情報源の取りこぼしから UniContext が決める。各項目は what（5分以内に始められる具体的な一歩、例「小レポート1: 課題文を開いて設問を読む（10分）」）、why（なぜ今か）、締切、作業量の見積もり、リンク、科目つき。「何すればいい？」「暇」「やることある？」に使い、学生に選ばせず top をそのまま伝える。urgent=true は48時間以内の未提出締切あり。 / The one thing to do now (top) plus the next 2–3, ranked deterministically from deadline proximity, remaining effort vs free time, submission state, weight, exams, class prep, unknown-deadline items and source coverage. Each has a startable step (what), a short reason (why), due date, effort estimate, link and course. Use for "what should I do?"; say top as is.',
} as const;

export const nextActionShape = {
  count: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe('top の後に返す件数（既定3） / How many after the top one (default 3)'),
  course: courseField.optional(),
};

export const STUDENT_STATE_TOOL = {
  title: '学生の今の状況',
  description:
    '今この時点の状況を1回で返す: 今の授業・次の授業（教室・休講）、今日と明日の授業、未提出の課題（締切・作業量・リンク・提出状況）、試験、その他のタスク、関係する最近の変更と重要なお知らせ、本人がチャットや録音から登録したメモ、学期の前半・後半、情報源の取りこぼし、UniContext が決めた「今やること」の提案（suggestion、並べ替えてよい）。判断材料をまとめて見るときに使う。 / One-call snapshot of now for an AI that judges: current/next class with room and cancellations, today and tomorrow, unsubmitted assignments with due/effort/links, exams, tasks, recent changes and important notices, the student’s own notes, half-term, coverage gaps, and UniContext’s ranked next actions as a suggestion (may be re-ranked).',
} as const;

export const ATTENTION_TOOL = {
  title: '今知らせるべきこと',
  description:
    '毎時など無人で実行される見守りタスク用。この接続（クライアント）に前回伝えて以降、今学生に知らせるべきことだけを返す: 24時間以内・6時間以内になった未提出の締切、60分以内に始まる授業（教室つき）、新しい休講・教室変更・重要なお知らせ、ペースの遅れ、ログイン切れの情報源。各項目に重要度（severity）と、そのまま送れる短い日本語（line）がつき、text は約300字以内の通知文。同じことは重要度が上がらない限り繰り返さない。nothingImportant が true なら何も通知しない。 / For an hourly unattended watcher: only what to tell the student now since this client’s last call (≤24h / ≤6h unsubmitted deadlines, a class within 60 min with its room, new cancellations / room changes / important notices, falling behind, expired logins), each with severity and a ready-to-send line; `text` is a ≤300-character notification. Repeats only when severity rises. Stay silent when nothingImportant is true.',
} as const;

export const attentionShape = {
  dryRun: z
    .boolean()
    .optional()
    .describe(
      'true なら「伝えた」と記録しない（次回も同じ内容が返る） / Do not record this call as told',
    ),
};

export const BRIEFING_TOOL = {
  title: '朝・夜のまとめ',
  description:
    '定期実行タスク用のまとめ。kind は morning（今日の授業・まずやること・72時間以内の未提出）、evening（明日の授業と準備）、check（前回以降の新しいことだけ）で、省略すると時刻で決まる（11時前は朝、17時以降は夜）。前回のまとめ以降の休講・教室変更・重要なお知らせ、情報源の取りこぼしも含み、そのまま送れる約300字以内の text と、知らせることがなければ nothingImportant: true を返す。 / Digest for a scheduled task: morning (today’s classes, the first thing to do, unsubmitted work due within 72 h), evening (tomorrow), or check (only what is new); default by local time. Includes news since this client’s last briefing and coverage gaps, a ≤300-character ready-to-send `text`, and `nothingImportant: true` when there is nothing to tell.',
} as const;

export const briefingShape = {
  kind: z
    .enum(['morning', 'evening', 'check'])
    .optional()
    .describe('morning | evening | check（省略時は時刻で決める） / default by time of day'),
  dryRun: attentionShape.dryRun,
};

interface Output {
  data: unknown;
  options?: { hint?: string };
}

export function runNextAction(
  uc: UniContext,
  a: { count?: number | undefined; courseOfferingId?: string | undefined },
): Output {
  const data = uc.context.nextActions({
    ...(a.count !== undefined ? { count: a.count } : {}),
    ...(a.courseOfferingId ? { courseOfferingId: a.courseOfferingId } : {}),
  });
  return {
    data,
    options: {
      hint: data.top
        ? 'top.what をそのまま1行で（why と締切、link があればリンクも）先に伝え、学生に優先順位を考えさせないでください。next は「その次」として短く添えます。coverage.trusted が false なら締切の一覧が不完全かもしれないことも伝えてください。'
        : 'いまやることは見つかりませんでした。そのまま伝えてください。',
    },
  };
}

export function runStudentState(uc: UniContext): Output {
  return {
    data: studentState(uc),
    options: {
      hint: 'suggestion は UniContext が締切・作業量・空き時間から決めた順位です。本人のメモや会話を踏まえて並べ替えてもよいですが、最後は「今これをやる」を1つに絞って伝えてください。',
    },
  };
}

export function runAttention(
  uc: UniContext,
  clientId: string,
  a: { dryRun?: boolean | undefined },
): Output {
  const data = attentionRequired(uc, clientId, a.dryRun ? { dryRun: true } : {});
  return {
    data,
    options: {
      hint: data.nothingImportant
        ? 'nothingImportant が true です。何も通知しないでください。'
        : 'text をそのまま（または短く整えて）通知してください。',
    },
  };
}

export function runBriefing(
  uc: UniContext,
  clientId: string,
  a: { kind?: 'morning' | 'evening' | 'check' | undefined; dryRun?: boolean | undefined },
): Output {
  const data = briefing(uc, clientId, {
    ...(a.kind ? { kind: a.kind } : {}),
    ...(a.dryRun ? { dryRun: true } : {}),
  });
  return {
    data,
    options: {
      hint: data.nothingImportant
        ? 'nothingImportant が true です。何も通知しないでください。'
        : 'text をそのまま（または短く整えて）通知してください。',
    },
  };
}
