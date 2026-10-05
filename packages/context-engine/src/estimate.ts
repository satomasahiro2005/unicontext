/**
 * Estimated deadlines for open work whose due date is unknown (docs/ARCHITECTURE.md §3.13, 「Estimated deadlines」).
 *
 * The student: 「推測しなきゃわからない場合は？」「期限がわからない時にAIが楽観視するのも問題」.
 * An unknown deadline is neither left blank (which reads as "no hurry") nor stated as a fact: it
 * gets the EARLIEST plausible time, labelled 「推定」 with its basis, a range and where to confirm
 * it, and plans and alerts run against that. Estimates are computed on read from the course's own
 * data and the student's effective timetable (groups, half-terms, holidays); they are never
 * stored as a deadline and never touch university data.
 *
 * Order (deterministic, no LLM):
 *  (a) the course's own pattern: earlier items of the same series (小レポート1, 2 … / 第N回) with a
 *      known due date — the same offset from the class they were given in, the typical interval;
 *  (b) a relative rule in the item's own text (「次回授業まで」「1週間以内」「今日中」);
 *  (c) else the next class of the course after the item appeared (its start) — the fallback
 *      earliest;
 *  (d) else 7 days after it appeared, 23:59.
 * (a) and (b) together give the earliest of their candidates; (c) and (d) are only fallbacks.
 */
import { formatShortJa, zonedParts, zonedTime } from '@unicontext/core';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The class an item was given in is looked for this many days back. */
const GIVEN_IN_LOOKBACK_DAYS = 8;
/** The next class is looked for this many days ahead (breaks, half-terms). */
const NEXT_CLASS_LOOKAHEAD_DAYS = 35;

/**
 * `candidate`: not an estimate at all — the item may be an assignment UniContext already knows
 * (「レポート1」 = 「当日課題 (小レポート1)」), and that assignment's stated due date is used. No
 * pattern or fallback guess is made while such a candidate has a known due date.
 */
export type EstimateMethod = 'series' | 'relative_rule' | 'next_class' | 'default' | 'candidate';

/**
 * An estimated deadline: NOT a deadline anyone stated. Always say 「推定」, the basis and where to
 * confirm; plan and notify against `at` (the earliest plausible time).
 */
export interface EstimatedDue {
  label: '推定';
  /** Plan against this: the earliest plausible deadline. */
  at: string;
  /** Earliest plausible time (= at). */
  earliest: string;
  /** Latest plausible time of the range, when the basis gives one. */
  latest?: string | undefined;
  method: EstimateMethod;
  /** Why this time, in one Japanese sentence (「同じ科目の「小レポート1」は授業の5日後23:59締切」). */
  basis: string;
  /** medium = from the course's pattern or a rule in the item's text; low = a fallback. */
  confidence: 'low' | 'medium';
  /** Ready-to-say line: 「推定 10/8 10:20〜10/15 10:20（根拠…）・要確認: …」. */
  text: string;
  /** Where the real deadline can be confirmed (課題ページ, 授業で先生に …). */
  checkWhere: string;
  checkUrl?: string | undefined;
  /** The estimate is already past: the item may be overdue — confirm now. */
  passed: boolean;
}

/** What the estimator reads (built by the context engine; plain data in tests). */
export interface EstimateHost {
  now: Date;
  timezone: string;
  /**
   * Starts (ms) of the student's effective meetings of a course between two local dates
   * (inclusive), one per day (the day's first period), ascending; cancelled meetings and other
   * groups' days are left out.
   */
  meetings(courseId: string, fromDate: string, toDate: string): number[];
  /** Other items of the course with a stated due date (tasks of any status, assignments). */
  datedItems(courseId: string): { id: string; title: string; dueAt: string }[];
}

export interface EstimateSubject {
  id: string;
  title: string;
  courseId: string | undefined;
  /** When the item appeared (available-from, or when UniContext first saw it). */
  appearedAt: string;
  /** The item's own text: title, evidence, description, notes. */
  texts: string[];
  checkWhere: string;
  checkUrl?: string | undefined;
}

interface Candidate {
  at: number;
  method: 'series' | 'relative_rule';
  basis: string;
}

function localDate(ms: number, tz: string): string {
  const p = zonedParts(new Date(ms), tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** 23:59 local of the day `ms` falls on. */
function endOfDay(ms: number, tz: string): number {
  const p = zonedParts(new Date(ms), tz);
  return zonedTime(
    { year: p.year, month: p.month, day: p.day, hour: 23, minute: 59 },
    tz,
  ).getTime();
}

/** 「5日7時間」「2時間」「30分」 */
export function durationText(ms: number): string {
  const minutes = Math.round(ms / MINUTE);
  const d = Math.floor(minutes / (24 * 60));
  const h = Math.floor((minutes % (24 * 60)) / 60);
  const m = minutes % 60;
  if (d > 0) return h > 0 ? `${d}日${h}時間` : `${d}日`;
  if (h > 0) return m > 0 && h < 3 ? `${h}時間${m}分` : `${h}時間`;
  return `${m}分`;
}

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

function meetingText(ms: number, tz: string): string {
  const p = zonedParts(new Date(ms), tz);
  return `${p.month}/${p.day}(${WEEKDAY_JA[p.weekday]}) ${p.hour}:${String(p.minute).padStart(2, '0')}`;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[\s()（）[\]【】「」『』:：\-_・.,、。/／]/g, '');
}

/** Series of a title: its first number and the text around it (小レポート1 → 「小レポート」, 1). */
export function seriesOf(title: string): { n: number; prefix?: string; full: string } | undefined {
  const s = title.normalize('NFKC');
  const m = /\d+/.exec(s);
  if (!m) return undefined;
  const prefix = norm(s.slice(0, m.index));
  return {
    n: Number(m[0]),
    ...(prefix.length >= 2 ? { prefix } : {}),
    full: norm(`${s.slice(0, m.index)}#${s.slice(m.index + m[0].length)}`),
  };
}

function sameSeries(
  a: NonNullable<ReturnType<typeof seriesOf>>,
  b: NonNullable<ReturnType<typeof seriesOf>>,
): boolean {
  return (a.prefix !== undefined && a.prefix === b.prefix) || a.full === b.full;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

const KANJI_NUM: Record<string, number> = {
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

function numberOf(s: string): number | undefined {
  const n = Number(s.normalize('NFKC'));
  if (Number.isFinite(n) && n > 0) return n;
  return KANJI_NUM[s];
}

/** Estimate the deadline of one item. Pure over the host: same data and `now`, same answer. */
export function estimateDue(subject: EstimateSubject, host: EstimateHost): EstimatedDue {
  const tz = host.timezone;
  const fmt = (ms: number): string => formatShortJa(new Date(ms), tz);
  const appeared = Date.parse(subject.appearedAt);
  const course = subject.courseId;

  const meetings = (fromMs: number, toMs: number): number[] =>
    course ? host.meetings(course, localDate(fromMs, tz), localDate(toMs, tz)) : [];
  /** The class an item due / seen at `ms` was given in: the latest meeting at or before it. */
  const givenIn = (ms: number): number | undefined =>
    meetings(ms - GIVEN_IN_LOOKBACK_DAYS * DAY, ms)
      .filter((m) => m <= ms)
      .at(-1);
  /** The first `count` meetings strictly after `ms`. */
  const after = (ms: number, count: number, days = NEXT_CLASS_LOOKAHEAD_DAYS): number[] =>
    meetings(ms, ms + days * DAY)
      .filter((m) => m > ms)
      .slice(0, count);

  const candidates: Candidate[] = [];

  // (a) The course's own pattern.
  const own = seriesOf(subject.title);
  if (course && own) {
    const siblings = host
      .datedItems(course)
      .filter((x) => x.id !== subject.id)
      .map((x) => ({ ...x, series: seriesOf(x.title), due: Date.parse(x.dueAt) }))
      .filter(
        (x): x is typeof x & { series: NonNullable<typeof x.series> } =>
          x.series !== undefined &&
          Number.isFinite(x.due) &&
          x.series.n !== own.n &&
          sameSeries(own, x.series),
      );
    const seen = new Set<string>();
    const unique = siblings.filter((x) => {
      const k = `${x.series.n}|${x.due}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const withOffset = unique
      .map((x) => {
        const anchor = givenIn(x.due);
        return { ...x, anchor, offset: anchor === undefined ? undefined : x.due - anchor };
      })
      .sort((a, b) => a.series.n - b.series.n);
    const sibText = (x: (typeof withOffset)[number]): string =>
      `同じ科目の「${x.title}」は締切${fmt(x.due)}${x.offset !== undefined ? `（授業の${durationText(x.offset)}後）` : ''}`;

    // Typical interval between numbered items (two or more known).
    const byNumber = new Map<number, (typeof withOffset)[number]>();
    for (const x of withOffset) if (!byNumber.has(x.series.n)) byNumber.set(x.series.n, x);
    const numbered = [...byNumber.values()];
    const nearest = [...numbered].sort(
      (a, b) =>
        Math.abs(a.series.n - own.n) - Math.abs(b.series.n - own.n) || a.series.n - b.series.n,
    )[0];
    if (numbered.length >= 2 && nearest) {
      const steps: number[] = [];
      for (let i = 1; i < numbered.length; i++) {
        const p = numbered[i - 1];
        const q = numbered[i];
        if (p && q) steps.push((q.due - p.due) / (q.series.n - p.series.n));
      }
      const interval = median(steps);
      if (interval >= DAY && interval <= 31 * DAY)
        candidates.push({
          at: nearest.due + interval * (own.n - nearest.series.n),
          method: 'series',
          basis: `${sibText(nearest)}。同じ続きものは約${durationText(interval)}ごと`,
        });
    } else if (nearest?.anchor !== undefined && nearest.offset !== undefined) {
      // One known item: one item per class, the same offset from its class.
      const k = nearest.series.n;
      if (own.n > k) {
        const step = own.n - k;
        const given = after(nearest.anchor, step, step * 7 + 21)[step - 1];
        if (given !== undefined)
          candidates.push({
            at: given + nearest.offset,
            method: 'series',
            basis: `${sibText(nearest)}。1回の授業に1つずつ出るとして、${meetingText(given, tz)}の授業から同じ間隔`,
          });
      }
    }
    // It may have been given in the class just before it appeared (earliest plausible).
    const anchor = Number.isFinite(appeared)
      ? (givenIn(appeared) ?? after(appeared, 1)[0])
      : undefined;
    if (anchor !== undefined) {
      const offsets = withOffset.filter((x) => x.offset !== undefined);
      const shortest = offsets.sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0))[0];
      if (shortest?.offset !== undefined)
        candidates.push({
          at: anchor + shortest.offset,
          method: 'series',
          basis: `${sibText(shortest)}。${meetingText(anchor, tz)}の授業で出たとして同じ間隔`,
        });
    }
  }

  // (b) A relative rule in the item's own text.
  if (Number.isFinite(appeared)) {
    const text = subject.texts.filter(Boolean).join('\n').normalize('NFKC');
    const quote = (re: RegExp): string => re.exec(text)?.[0] ?? '';
    const nextClassRe =
      /次回(?:の)?(?:授業|講義)?(?:まで|の?(?:開始|最初|冒頭|始め|はじめ)|に提出|に持参)|次の(?:授業|講義)(?:まで|の?(?:開始|最初|冒頭)|に提出)/;
    if (nextClassRe.test(text)) {
      const next = after(appeared, 1)[0];
      if (next !== undefined)
        candidates.push({
          at: next,
          method: 'relative_rule',
          basis: `本文に「${quote(nextClassRe)}」とあるので、次の授業（${meetingText(next, tz)}）の開始`,
        });
    }
    const within = /([0-9]+|[一二三四五六七八九十])\s*(週間|日)以内/.exec(text);
    const n = within?.[1] ? numberOf(within[1]) : undefined;
    if (within && n !== undefined) {
      const days = within[2] === '週間' ? n * 7 : n;
      candidates.push({
        at: appeared + days * DAY,
        method: 'relative_rule',
        basis: `本文に「${within[0]}」とあるので、出た時（${fmt(appeared)}）から${days}日`,
      });
    }
    const today = /今日中|本日中|当日中/.exec(text);
    if (today)
      candidates.push({
        at: endOfDay(appeared, tz),
        method: 'relative_rule',
        basis: `本文に「${today[0]}」とあるので、出た日の23:59`,
      });
    const week = /今週中|今週末まで/.exec(text);
    if (week) {
      const wd = zonedParts(new Date(appeared), tz).weekday;
      candidates.push({
        at: endOfDay(appeared + ((7 - wd) % 7) * DAY, tz),
        method: 'relative_rule',
        basis: `本文に「${week[0]}」とあるので、その週の日曜23:59`,
      });
    }
  }

  const plausible = candidates
    .filter((c) => Number.isFinite(c.at) && (!Number.isFinite(appeared) || c.at >= appeared))
    .sort((a, b) => a.at - b.at);
  const nowMs = host.now.getTime();
  const build = (
    at: number,
    latest: number | undefined,
    method: EstimateMethod,
    basis: string,
    confidence: EstimatedDue['confidence'],
  ): EstimatedDue => {
    const range = latest !== undefined && latest > at + MINUTE ? latest : undefined;
    const passed = at < nowMs;
    return {
      label: '推定',
      at: new Date(at).toISOString(),
      earliest: new Date(at).toISOString(),
      ...(range !== undefined ? { latest: new Date(range).toISOString() } : {}),
      method,
      basis,
      confidence,
      text: `推定 ${fmt(at)}${range !== undefined ? `〜${fmt(range)}` : ''}（${basis}）${passed ? '・もう過ぎている可能性' : ''}。要確認: ${subject.checkWhere}`,
      checkWhere: subject.checkWhere,
      ...(subject.checkUrl ? { checkUrl: subject.checkUrl } : {}),
      passed,
    };
  };

  const first = plausible[0];
  if (first) {
    const last = plausible.at(-1);
    return build(first.at, last?.at, first.method, first.basis, 'medium');
  }

  // (c) The next class of the course after the item appeared: the fallback earliest.
  const from = Number.isFinite(appeared) ? appeared : nowMs;
  const next = after(from, 2);
  if (next[0] !== undefined)
    return build(
      next[0],
      next[1],
      'next_class',
      `締切の手がかりがないため、出た後の最初の授業（${meetingText(next[0], tz)}）の開始を最も早い締切とみなす${next[1] !== undefined ? '。遅くとも次の次の授業まで' : ''}`,
      'low',
    );

  // (d) Default: a week after it appeared, 23:59.
  const at = endOfDay(from + 7 * DAY, tz);
  return build(
    at,
    endOfDay(from + 14 * DAY, tz),
    'default',
    `締切の手がかりも授業の予定もないため、出てから1週間後の23:59とみなす`,
    'low',
  );
}

/**
 * The item may be an assignment with a known due date: plan against that date, say which
 * assignment it is and that it is the same work is to be confirmed — never a guessed time.
 */
export function candidateDue(
  subject: Pick<EstimateSubject, 'checkWhere' | 'checkUrl'>,
  candidate: { title: string; dueAt: string; source?: string | undefined },
  host: Pick<EstimateHost, 'now' | 'timezone'>,
): EstimatedDue | undefined {
  const at = Date.parse(candidate.dueAt);
  if (!Number.isFinite(at)) return undefined;
  const when = formatShortJa(new Date(at), host.timezone);
  const basis = `同じ課題とみられる「${candidate.title}」${candidate.source ? `（${candidate.source}）` : ''}の締切が${when}`;
  const passed = at < host.now.getTime();
  return {
    label: '推定',
    at: new Date(at).toISOString(),
    earliest: new Date(at).toISOString(),
    method: 'candidate',
    basis,
    confidence: 'medium',
    text: `${when}（${basis}。同じものか要確認）${passed ? '・もう過ぎている可能性' : ''}。要確認: ${subject.checkWhere}`,
    checkWhere: subject.checkWhere,
    ...(subject.checkUrl ? { checkUrl: subject.checkUrl } : {}),
    passed,
  };
}
