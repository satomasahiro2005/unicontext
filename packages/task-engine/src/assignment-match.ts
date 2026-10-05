/**
 * Is a to-do an AI client wrote (add_task / add_deadline kind prep / ingest_lecture tasks) the same
 * work as an assignment a system already knows? (docs/ARCHITECTURE.md §3.13 「Recorded work that
 * already exists」.)
 *
 * The student told ChatGPT 「レポート1：レンタル店のER図を作成する（提出期限は未確認）」 after the
 * 10/1 class, while Ed already had 「当日課題 (小レポート1)」 due 10/6 17:00. Kept apart, the to-do
 * got an estimated deadline (10/8) and the chat said the deadline was unknown. This decides, from
 * plain data and deterministically (no LLM):
 *  - the title: the same numbered item (レポート1 ~ 小レポート1 ~ 当日課題 (小レポート1); numbers
 *    must match), or close titles;
 *  - the text: content words shared by the to-do (title, notes) and the assignment (description);
 *  - the timing: the assignment appeared around the lecture / the day it was told, or is due soon
 *    after it (one long closed before it is another item).
 * `linked` = the same work (the to-do becomes part of the assignment's task: its due date and status
 * come from the source); `candidate` = possibly the same (both stay, but the to-do is never given an
 * estimated deadline while the candidate has a known one).
 */

const DAY = 86_400_000;

export type AssignmentMatchLevel = 'linked' | 'candidate';

export interface MatchableItem {
  title: string;
  /** Notes, evidence: the item's own text. */
  texts?: (string | undefined)[];
  /** When the item was given: the lecture date (YYYY-MM-DD, local noon) or when it was told. */
  referenceAt?: string | undefined;
}

export interface MatchableAssignment {
  id: string;
  title: string;
  description?: string | undefined;
  /** Its known due date (from the source, resolved), if any. */
  dueAt?: string | undefined;
  /** When it appeared: available-from, the lesson / module date … (ISO). */
  appearedAt?: (string | undefined)[];
}

export interface AssignmentMatch {
  assignmentId: string;
  title: string;
  dueAt: string | undefined;
  level: AssignmentMatchLevel;
  score: number;
  /** Why, in short Japanese phrases (「同じ番号の項目（レポート1）」「10/1の授業の頃に出た」). */
  reasons: string[];
}

export const LINK_SCORE = 0.8;
export const CANDIDATE_SCORE = 0.5;
const LINK_MARGIN = 0.2;

/** Words for kinds of numbered work, by family: 小レポート1 and Report 1 are the same item. */
const FAMILIES: [RegExp, string][] = [
  [/^(?:小?レポート|レポ|report)$/, 'report'],
  [/^(?:課題|宿題|assignment|homework|hw|kadai)$/, 'assignment'],
  [/^(?:演習|練習問題|問題|exercise)$/, 'exercise'],
  [/^(?:小テスト|確認テスト|テスト|クイズ|quiz|test)$/, 'quiz'],
  [/^(?:実験|lab)$/, 'lab'],
];

const KEY_RE =
  /(小?レポート|レポ|report|課題|宿題|assignment|homework|hw|kadai|演習|練習問題|問題|exercise|小テスト|確認テスト|テスト|クイズ|quiz|test|実験|lab)\s*(?:no\.?|#|第)?\s*(\d+|[一二三四五六七八九十])/gu;

const KANJI: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function familyOf(word: string): string | undefined {
  return FAMILIES.find(([re]) => re.test(word))?.[1];
}

/** Numbered work items named in a title: 「当日課題 (小レポート1)」 → report#1. */
export function itemKeys(title: string): { family: string; n: number }[] {
  const s = title.normalize('NFKC').toLowerCase();
  const out: { family: string; n: number }[] = [];
  for (const m of s.matchAll(KEY_RE)) {
    const family = familyOf(m[1] as string);
    const raw = m[2] as string;
    const n = KANJI[raw] ?? Number(raw);
    if (family && Number.isFinite(n) && !out.some((k) => k.family === family && k.n === n))
      out.push({ family, n });
  }
  return out;
}

/** Families named in a title without a number (「レポート」「課題」). */
function familiesIn(title: string): Set<string> {
  const s = title.normalize('NFKC').toLowerCase();
  const out = new Set<string>();
  for (const m of s.matchAll(
    /小?レポート|report|課題|宿題|assignment|homework|演習|exercise|小テスト|クイズ|quiz|実験/gu,
  )) {
    const f = familyOf(m[0]);
    if (f) out.add(f);
  }
  return out;
}

function norm(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function numbers(s: string): string {
  return (s.normalize('NFKC').match(/\d+/g) ?? []).map((d) => String(Number(d))).join(',');
}

function dice(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    if (s.length === 1) out.add(s);
    return out;
  };
  const x = grams(a);
  const y = grams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let n = 0;
  for (const g of x) if (y.has(g)) n++;
  return (2 * n) / (x.size + y.size);
}

/** Words that say nothing about which item it is. */
const STOP = new Set([
  '課題',
  'レポート',
  '小レポート',
  '当日課題',
  '提出',
  '作成',
  '授業',
  '講義',
  '確認',
  '期限',
  '締切',
  '現時点',
  '未確認',
  '内容',
  '必要',
  '記載',
  '投稿',
  '番号',
  '感想',
  'ポイント',
  'スレッド',
  '文章',
  '補足',
  '前提',
  '仮定',
  '整理',
  '想定',
  '業務',
]);

/** Content words: runs of kanji / katakana / latin letters (≥ 2), minus generic ones. */
export function contentWords(text: string): Set<string> {
  const s = text.normalize('NFKC').toLowerCase();
  const out = new Set<string>();
  for (const m of s.matchAll(/[\p{Script=Han}]{2,}|[\p{Script=Katakana}ー]{2,}|[a-z]{2,}/gu)) {
    const w = m[0];
    if (!STOP.has(w)) out.add(w);
  }
  return out;
}

type TitleSignal = { score: number; reason?: string } | 'conflict';

function titleSignal(item: string, assignment: string): TitleSignal {
  const ki = itemKeys(item);
  const ka = itemKeys(assignment);
  const shared = ki.find((k) => ka.some((x) => x.family === k.family && x.n === k.n));
  if (shared)
    return { score: 0.6, reason: `同じ番号の項目（${item.trim()} / ${assignment.trim()}）` };
  // Both name a numbered item of the same kind, with other numbers: レポート1 vs 小レポート2.
  if (ki.some((k) => ka.some((x) => x.family === k.family && x.n !== k.n))) return 'conflict';
  const nx = norm(item);
  const ny = norm(assignment);
  if (!nx || !ny) return { score: 0 };
  const dx = numbers(item);
  const dy = numbers(assignment);
  if (dx && dy && dx !== dy) return 'conflict';
  const [short, long] = nx.length <= ny.length ? [nx, ny] : [ny, nx];
  if (nx === ny || (short.length >= 3 && long.includes(short)) || dice(nx, ny) >= 0.6)
    return { score: 0.6, reason: '題名がほぼ同じ' };
  const fi = familiesIn(item);
  const sameKind = [...familiesIn(assignment)].some((f) => fi.has(f));
  if (sameKind || dice(nx, ny) >= 0.35)
    return { score: 0.3, reason: sameKind ? '同じ種類の課題' : '題名が似ている' };
  return { score: 0 };
}

function shortDate(ms: number): string {
  const d = new Date(ms + 9 * 3_600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/**
 * Timing: +0.25 when the assignment appeared within a week of when the item was given, or is due
 * within 4 weeks after it; −0.4 when it closed more than 2 days before (another, older item).
 */
function timingSignal(
  ref: number | undefined,
  a: MatchableAssignment,
): { score: number; reason?: string } {
  if (ref === undefined) return { score: 0 };
  const due = a.dueAt ? Date.parse(a.dueAt) : Number.NaN;
  if (Number.isFinite(due) && due < ref - 2 * DAY) return { score: -0.4 };
  const appeared = (a.appearedAt ?? [])
    .map((x) => (x ? Date.parse(x) : Number.NaN))
    .filter((x) => Number.isFinite(x));
  const near = appeared.find((x) => Math.abs(x - ref) <= 7 * DAY);
  if (near !== undefined) return { score: 0.25, reason: `${shortDate(near)}の授業の頃に出た課題` };
  if (Number.isFinite(due) && due >= ref - DAY && due <= ref + 28 * DAY)
    return { score: 0.25, reason: `${shortDate(ref)}の後すぐ（${shortDate(due)}）が締切` };
  if (appeared.length > 0 && appeared.every((x) => Math.abs(x - ref) > 21 * DAY))
    return { score: -0.4 };
  return { score: 0 };
}

/** Score one pair; undefined when they cannot be the same item. */
export function scoreAssignmentMatch(
  item: MatchableItem,
  a: MatchableAssignment,
): { score: number; reasons: string[] } | undefined {
  const title = titleSignal(item.title, a.title);
  if (title === 'conflict') return undefined;
  const reasons: string[] = [];
  if (title.reason) reasons.push(title.reason);
  let score = title.score;
  const mine = contentWords([item.title, ...(item.texts ?? [])].filter(Boolean).join('\n'));
  const theirs = contentWords(`${a.title}\n${a.description ?? ''}`);
  const shared = [...mine].filter((w) => theirs.has(w));
  if (shared.length > 0) {
    score += shared.length >= 2 ? 0.3 : 0.1;
    reasons.push(`本文の語が共通（${shared.slice(0, 3).join('・')}）`);
  }
  const ref = item.referenceAt ? Date.parse(item.referenceAt) : Number.NaN;
  const timing = timingSignal(Number.isFinite(ref) ? ref : undefined, a);
  score += timing.score;
  if (timing.reason) reasons.push(timing.reason);
  return { score: Math.round(score * 100) / 100, reasons };
}

/**
 * The assignment the item is (or may be) — `linked` needs the same item by title, a score of at
 * least {@link LINK_SCORE} and a clear lead over the next one; `candidate` at least
 * {@link CANDIDATE_SCORE}. Pass only assignments of the item's course (every linked offering).
 */
export function matchAssignment(
  item: MatchableItem,
  assignments: readonly MatchableAssignment[],
): AssignmentMatch | undefined {
  const scored = assignments
    .map((a) => ({ a, s: scoreAssignmentMatch(item, a) }))
    .filter(
      (x): x is { a: MatchableAssignment; s: { score: number; reasons: string[] } } =>
        x.s !== undefined && x.s.score >= CANDIDATE_SCORE,
    )
    .sort((x, y) => y.s.score - x.s.score || x.a.id.localeCompare(y.a.id));
  const best = scored[0];
  if (!best) return undefined;
  const second = scored[1];
  const strongTitle = titleSignal(item.title, best.a.title);
  const linked =
    best.s.score >= LINK_SCORE &&
    strongTitle !== 'conflict' &&
    strongTitle.score >= 0.6 &&
    (!second || best.s.score - second.s.score >= LINK_MARGIN);
  return {
    assignmentId: best.a.id,
    title: best.a.title,
    dueAt: best.a.dueAt,
    level: linked ? 'linked' : 'candidate',
    score: best.s.score,
    reasons: best.s.reasons,
  };
}

/**
 * A to-do's notes as details of the assignment it was linked to: sentences that only say the
 * deadline is not known are dropped (the assignment knows it).
 */
export function notesAsDetails(notes: string | undefined): string | undefined {
  if (!notes) return undefined;
  const sentences = notes
    .split(/(?<=[。\n])/u)
    .filter(
      (s) =>
        !/(?:提出)?(?:期限|締切|締め切り)[^。\n]*(?:未確認|不明|未定|わから|分から|まだ)/u.test(s),
    );
  const text = sentences.join('').trim();
  return text || undefined;
}
