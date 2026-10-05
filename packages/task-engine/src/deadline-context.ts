import { normalizeGroupLabel } from '@unicontext/canonical-model';

/**
 * Reading of the sentence a deadline was extracted from, beyond the date itself:
 * - a done marker printed next to it (「履修登録期限(一般): 10月7日まで(済)」),
 * - the groups / 班 it is addressed to (「A班は10/5までに…」), and whether it is meant for the
 *   named group only or for it as well (「A班の皆様も」),
 * - a short title for the task (the sentence stays as evidence).
 */

/** 「(済)」「（済み）」「【完了】」「…まで 済」: the item is already done. */
const DONE_MARKER =
  /[（(【[]\s*(?:済|済み|完了|完了済み?|提出済み?|登録済み?|申請済み?|対応済み?)\s*[)）】\]]|(?:^|\s)(?:済|済み|完了済み?)\s*[。.]?\s*$/u;

export function doneMarker(sentence: string): string | undefined {
  const m = DONE_MARKER.exec(sentence.normalize('NFKC'));
  return m ? m[0].trim() : undefined;
}

export interface GroupAddress {
  /** Groups named in the sentence ("A"). */
  groups: string[];
  /**
   * True when the sentence is addressed to the named groups only (「A班は」「Bグループのみ」);
   * false when it names them in addition to everyone (「A班の皆様も」「A班も」).
   */
  exclusive: boolean;
}

const GROUP_MENTION = /(?:グループ\s*([A-Za-z])|([A-Za-z])\s*(?:班|グループ|組))(\S{0,8})/gu;

/** Groups a deadline sentence is addressed to, or undefined when it names none. */
export function groupAddress(sentence: string): GroupAddress | undefined {
  const s = sentence.normalize('NFKC');
  const groups: string[] = [];
  let inclusive = false;
  for (const m of s.matchAll(GROUP_MENTION)) {
    const g = normalizeGroupLabel(m[1] ?? m[2] ?? '');
    if (!g) continue;
    groups.push(g);
    // 「A班も」「A班の皆様も」「A班の方も」: the named group too, not only it.
    if (/^(?:の(?:皆様|皆さん|みなさん|方|人)?(?:々)?)?も/u.test(m[3] ?? '')) inclusive = true;
  }
  if (groups.length === 0) return undefined;
  return { groups: [...new Set(groups)], exclusive: !inclusive };
}

/** Verbal nouns that name the work but not its object (「登録は…までに」). */
const BARE_WORK =
  /^(?:登録|提出|申請|申込|申し込み|回答|入力|手続き?|支払い?|予約|参加|確認|受講|返却)$/u;

function cleanTitle(s: string, courseTitle: string | undefined): string {
  let t = s.normalize('NFKC');
  if (courseTitle) t = t.replace(courseTitle.normalize('NFKC'), ' ');
  return t
    .replace(/【[^】]*】|\[[^\]]*\]/gu, ' ')
    .replace(/(?:について|に関して|のお知らせ|のご案内|のお願い|のおしらせ)\s*$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A short title for a deadline task from its sentence: the topic before 「は／を／の」 and the
 * date (「レポートは10/9までに」→「レポート」), qualified by the notice title when the topic is a
 * bare 「登録」「提出」 (「teams 登録について」+「登録は…」→「teams 登録」). Undefined when nothing
 * short can be said; the caller then keeps the sentence.
 */
export function shortDeadlineTitle(
  sentence: string,
  sourceTitle: string | undefined,
  courseTitle: string | undefined,
): string | undefined {
  const s = sentence.normalize('NFKC').trim();
  const topic =
    /^[\s・*●○◦\-－]*([^\s,、。.:：]{1,20}?)(?:は|を|の(?:提出|締切|期限))[\s,、]*(?:\d|[(（]|次回|来週|今週|明日|本日|今日)/u
      .exec(s)?.[1]
      ?.trim();
  const titled = sourceTitle ? cleanTitle(sourceTitle, courseTitle) : '';
  // 「A班は…」 names who, not what.
  if (topic && !/^(?:グループ\s*[A-Za-z]|[A-Za-z]\s*(?:班|グループ|組))$/u.test(topic)) {
    if (!BARE_WORK.test(topic)) return topic;
    if (titled && titled.includes(topic) && titled.length <= 30) return titled;
    return titled && titled.length <= 20 ? `${titled}の${topic}` : topic;
  }
  // 「履修登録期限(一般): 10月7日まで」: the label before the colon.
  const label = /^([^:：]{2,24})[:：]/u.exec(s)?.[1]?.trim();
  if (label) return label.replace(/(?:期限|締切|〆切)\s*$/u, '').trim() || label;
  return undefined;
}
