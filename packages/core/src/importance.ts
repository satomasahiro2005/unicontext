/**
 * Rule-based importance of a university notice (no AI). The academic system's own "importance"
 * flag is not usable at Shizuoka (every LiveCampusU notice carries the same value), so connectors
 * classify by what the notice is about:
 *
 * - high: class changes (休講・補講・教室変更・試験), anything tied to one of the student's courses,
 *   reminders about the student's own unsubmitted work, and personal procedures with a deadline
 *   (履修登録, 学生証, 授業料の納付 …);
 * - low: general campaigns — 就職・キャリア, メルマガ, 調査・アンケート, 説明会・セミナー・イベント, 募集 …;
 * - normal: everything else (including optional applications such as 奨学金・授業料免除).
 *
 * When the body is known (LiveCampusU notices read by the student), a notice the title leaves at
 * normal becomes high if its text is marked 【重要】 or asks for a personal procedure.
 */

export type NoticeImportance = 'critical' | 'high' | 'normal' | 'low';

export interface NoticeImportanceInput {
  title: string;
  body?: string | undefined;
  /**
   * Notice kind from the source's own type (LiveCampusU contact kinds: cancellation, makeup, exam,
   * roomChange, assignment, reminder, notice …).
   */
  kind?: string | undefined;
  /** The notice is linked to one of the student's course offerings. */
  courseLinked?: boolean;
  /** The source explicitly marks the notice important (e.g. 【重要】 in the title). */
  flaggedImportant?: boolean;
}

export interface NoticeImportanceResult {
  importance: NoticeImportance;
  /** Short machine-readable reason (rule id), useful in tests and provenance. */
  rule: string;
}

/** Career/marketing campaigns: low even when they mention 試験 or 提出 (e.g. 教員採用試験ガイダンス). */
const STRONG_CAMPAIGN =
  /就活|就職|キャリア|インターン|企業説明|業界研究|採用試験|メルマガ|メールマガジン|試読|プレゼント|キャンペーン/;

/** General information and invitations: low unless they are about a class or a personal procedure. */
const CAMPAIGN =
  /調査|アンケート|説明会|セミナー|ガイダンス|講演会|イベント|フェア|フェスタ|募集|ボランティア|サークル|体験会|交流会|ワークショップ|コンテスト|開催|参加者|コンサート|チケット|観戦|式典|祝賀|点検会|カフェ|留学|つどい/;

/** Class changes recognizable from the title alone. */
const CLASS_CHANGE =
  /休講|補講|教室変更|講義室変更|試験(?:日程|時間割|教室|の実施|について)|定期試験|追試|再試/;

/** Personal procedures the student must do themselves by a deadline. */
const PERSONAL_PROCEDURE =
  /履修登録|履修取消|履修申請|学生証|学生カード|授業料(?:の)?(?:納付|納入|口座)|健康診断|在籍確認|成績(?:確認|異議)|卒業(?:要件|判定)|進級|休学|退学|本人確認|未提出|提出(?:期限|〆切|締切)|再提出/;

/** Applications that only concern students who opt in. */
const OPTIONAL_APPLICATION = /奨学金|授業料免除|免除申請|寮|保険|割引|貸与|単位互換|集中講義/;

const IMPORTANT_MARK = /【\s*(?:重要|至急|緊急|必読|要対応)\s*】|［\s*重要\s*］|\[\s*重要\s*\]/;

export function classifyNoticeImportance(input: NoticeImportanceInput): NoticeImportanceResult {
  const title = input.title.normalize('NFKC');
  if (
    input.kind === 'cancellation' ||
    input.kind === 'makeup' ||
    input.kind === 'roomChange' ||
    input.kind === 'exam'
  )
    return { importance: 'high', rule: `kind:${input.kind}` };
  if (input.kind === 'reminder') return { importance: 'high', rule: 'kind:reminder' };
  if (input.courseLinked) return { importance: 'high', rule: 'course' };
  const marked = input.flaggedImportant === true || IMPORTANT_MARK.test(title);
  if (marked) return { importance: 'high', rule: 'marked-important' };
  if (STRONG_CAMPAIGN.test(title)) return { importance: 'low', rule: 'campaign' };
  if (CLASS_CHANGE.test(title)) return { importance: 'high', rule: 'class-change' };
  if (PERSONAL_PROCEDURE.test(title) && !OPTIONAL_APPLICATION.test(title))
    return { importance: 'high', rule: 'personal-procedure' };
  if (CAMPAIGN.test(title)) return { importance: 'low', rule: 'campaign' };
  // The body only ever raises a notice whose title says nothing either way (campaign titles stay
  // low even when their text mentions a 提出期限, and optional applications stay normal).
  const body = (input.body ?? '').normalize('NFKC');
  if (body && !OPTIONAL_APPLICATION.test(title)) {
    if (IMPORTANT_MARK.test(body)) return { importance: 'high', rule: 'body:marked-important' };
    if (PERSONAL_PROCEDURE.test(body) && !OPTIONAL_APPLICATION.test(body))
      return { importance: 'high', rule: 'body:personal-procedure' };
  }
  return { importance: 'normal', rule: 'default' };
}
