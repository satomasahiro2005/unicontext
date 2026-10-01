/**
 * Product-level text conventions of LiveCampusU screens (not deployment-specific).
 *
 * Period convention shared with the syllabus connector: LCU prints 45-minute units in pairs
 * ("1・2", "3・4" … "13・14"); UniContext's period number is the pair index 1..7.
 */

export const WEEKDAY_CHARS = ['日', '月', '火', '水', '木', '金', '土'] as const;

/** LCU week number (1=月 … 6=土, 7=日) → JS day of week (0=日 … 6=土). */
export function lcuWeekToDayOfWeek(week: number): number | undefined {
  if (!Number.isInteger(week) || week < 1 || week > 7) return undefined;
  return week % 7;
}

/** "1・2" → 1, "13・14" → 7, "5" → 3 (single unit), otherwise undefined. */
export function periodFromLabel(label: string): number | undefined {
  const s = label.normalize('NFKC').trim();
  const m = /^(\d{1,2})(?:\s*[・･,、~〜-]\s*(\d{1,2}))?$/.exec(s);
  if (!m) return undefined;
  const first = Number(m[1]);
  if (!Number.isFinite(first) || first < 1 || first > 14) return undefined;
  return Math.ceil(first / 2);
}

export interface SubjectSlot {
  /** "前期前半" etc. */
  termPart: string;
  dayOfWeek: number;
  period: number | undefined;
  raw: string;
}

export interface SubjectText {
  title: string;
  /** Class name when the text carries one: "コンピュータネットワーク(1クラス)". */
  className?: string;
  slots: SubjectSlot[];
}

/** Split "科目名(クラス)" / "科目名（クラス）" into title and class. */
export function splitTitleClass(s: string): { title: string; className?: string } {
  const t = s.trim();
  const close = t.at(-1);
  if (close !== ')' && close !== '）') return { title: t };
  // Walk back to the matching opening bracket (class names may nest: 「（再履修（情）１）」).
  let depth = 0;
  for (let i = t.length - 1; i >= 0; i--) {
    const ch = t[i];
    if (ch === ')' || ch === '）') depth++;
    else if (ch === '(' || ch === '（') {
      depth--;
      if (depth === 0) {
        const title = t.slice(0, i).trim();
        if (!title) return { title: t };
        return { title, className: t.slice(i + 1, -1).trim() };
      }
    }
  }
  return { title: t };
}

/**
 * Parse the subject cell used by notices and assignments:
 * 「機械語と計算機械\r\n前期前半/金5・6, 前期前半/金7・8」 or 「コンピュータネットワーク(1クラス)<br>前期後半/月1・2」.
 */
export function parseSubjectText(text: string): SubjectText | undefined {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const first = lines[0];
  if (!first) return undefined;
  const { title, className } = splitTitleClass(first);
  if (!title) return undefined;
  const slots: SubjectSlot[] = [];
  for (const part of lines
    .slice(1)
    .join(',')
    .split(/[,、，]/)) {
    const raw = part.trim();
    if (!raw) continue;
    const m = /^(?:([^/]+)\/)?([日月火水木金土])\s*([\d０-９・･]+)?/.exec(raw);
    if (!m) continue;
    const dayOfWeek = WEEKDAY_CHARS.indexOf(m[2] as (typeof WEEKDAY_CHARS)[number]);
    if (dayOfWeek < 0) continue;
    slots.push({
      termPart: (m[1] ?? '').trim(),
      dayOfWeek,
      period: m[3] ? periodFromLabel(m[3]) : undefined,
      raw,
    });
  }
  return { title, ...(className !== undefined ? { className } : {}), slots };
}

/** Distinct periods of the slots on the given day; one value only when unambiguous. */
export function uniquePeriodOnDay(slots: SubjectSlot[], dayOfWeek: number): number | undefined {
  const set = new Set(
    slots.filter((s) => s.dayOfWeek === dayOfWeek && s.period !== undefined).map((s) => s.period),
  );
  return set.size === 1 ? [...set][0] : undefined;
}

/** "2026/07/24" → "2026-07-24". */
export function slashDateToIso(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(s.normalize('NFKC'));
  if (!m) return undefined;
  return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
}

export interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** "2026/07/23 10:30" (or date + separate time) → parts. */
export function parseSlashDateTime(
  date: string | undefined,
  time?: string,
): LocalDateTimeParts | undefined {
  if (!date) return undefined;
  const s = `${date} ${time ?? ''}`.normalize('NFKC');
  const m = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/.exec(s);
  if (!m) return undefined;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: m[4] ? Number(m[4]) : 0,
    minute: m[5] ? Number(m[5]) : 0,
  };
}

/** 「YYYY/MM/DD HH:MM ～ YYYY/MM/DD HH:MM」 → from/to parts. */
export function parseTermRange(s: string | undefined): {
  from?: LocalDateTimeParts;
  to?: LocalDateTimeParts;
} {
  if (!s) return {};
  const [a, b] = s.normalize('NFKC').split(/\s*[～〜~]\s*/);
  const from = parseSlashDateTime(a);
  const to = parseSlashDateTime(b);
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

/**
 * Room named in a 講義室変更 title, e.g. 「7/24(金) B班の教室を科学実験室から共41に変更します」 → 共41.
 * Rule-based, Japanese phrasing only; undefined when no pattern matches.
 */
export function extractRoomChange(title: string): { to: string; from?: string } | undefined {
  const t = title.normalize('NFKC');
  const patterns: RegExp[] = [
    /(?:教室|講義室|部屋|会場)を?\s*(?<from>[^、。\s]+?)\s*から\s*(?<to>[^、。\s]+?)\s*(?:に|へ)\s*変更/,
    /(?<from>[^、。\s]+?)\s*から\s*(?<to>[^、。\s]+?)\s*(?:に|へ)\s*(?:教室|講義室)?を?\s*変更/,
    /(?:教室|講義室|会場)(?:は|が|を)\s*(?<to>[^、。\s]+?)\s*(?:に変更|へ変更|です|となります|で行います|で実施)/,
    /(?<to>[^、。\s]+?)\s*(?:に|へ)\s*(?:教室|講義室)?\s*変更/,
  ];
  for (const re of patterns) {
    const m = re.exec(t);
    const to = m?.groups?.to?.replace(/^(?:の?教室を?|を)/, '').trim();
    if (to && to.length <= 30) {
      const from = m?.groups?.from?.replace(/^.*?(?:の?教室を|を)/, '').trim();
      return { to, ...(from ? { from } : {}) };
    }
  }
  return undefined;
}

/** First "HH:MM" in text (e.g. 「(9/25,共21,12:45-)」 → 12:45). */
export function firstTimeOfDay(text: string): { hour: number; minute: number } | undefined {
  const m = /(?:^|[^\d])([01]?\d|2[0-3])[:：]([0-5]\d)(?!\d)/.exec(text.normalize('NFKC'));
  if (!m) return undefined;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** Normalized course title for matching inside one source (NFKC, no spaces/brackets). */
export function titleKey(title: string): string {
  return title.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}
