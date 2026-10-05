import type {
  NoClassDay,
  SubstituteDay,
  TermDefinition,
  TermPartDefinition,
  UniversityProfile,
} from './profile.js';
import type { TermHalf } from './term-parts.js';

/**
 * Academic calendar arithmetic on local dates ('YYYY-MM-DD'): which term a date is in, whether a
 * weekday has regular classes (学年暦 / 行事予定表 exceptions) and the weekly expansion of timetable
 * slots. Pure: no clock, no time zone (dates are already local), no I/O.
 */

export type AcademicCalendar = UniversityProfile['academicCalendar'];

/** Student-specific scope for campus/faculty-limited exceptions (config.yaml `student:`). */
export interface StudentScope {
  campus?: string | undefined;
  faculty?: string | undefined;
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(date: string): [number, number, number] {
  const m = YMD.exec(date);
  if (!m) throw new RangeError(`Invalid local date: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** 0 = Sunday … 6 = Saturday for a local date. */
export function dayOfWeekOfDate(date: string): number {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Local date plus n calendar days. */
export function addLocalDays(date: string, n: number): string {
  const [y, m, d] = parts(date);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/** The term whose whole span (学年暦) contains the date. */
export function termForDate(cal: AcademicCalendar, date: string): TermDefinition | undefined {
  return cal.terms.find((t) => t.start <= date && date <= t.end);
}

/** Term of an offering by academic year and term label (前期 / 後期 / term id / name). */
export function findTerm(
  cal: AcademicCalendar,
  year: number | undefined,
  term: string | undefined,
): TermDefinition | undefined {
  if (!term) return undefined;
  const t = term.normalize('NFKC').trim();
  const sameYear = cal.terms.filter((x) => year === undefined || x.year === year);
  return (
    sameYear.find((x) => x.id === t || x.termCode === t || x.name === t) ??
    // 「前学期」「2026年度 前期」 style labels
    sameYear.find((x) => x.termCode !== undefined && t.includes(x.termCode)) ??
    sameYear.find(
      (x) =>
        x.termCode !== undefined &&
        t.replace('学期', '期').includes(x.termCode.replace('学期', '期')),
    )
  );
}

/** Weeks with regular classes. */
export function classWindow(term: TermDefinition): { start: string; end: string } {
  return term.classes ?? { start: term.start, end: term.end };
}

function scopeMatches(want: string | undefined, have: string | undefined): boolean | undefined {
  if (!want) return true;
  if (!have) return undefined; // unknown: not applied, surfaced as a note
  const a = want.normalize('NFKC');
  const b = have.normalize('NFKC');
  return a.includes(b) || b.includes(a);
}

export interface ClassDayInfo {
  date: string;
  /** Timetable weekday this date follows (substitute days follow another weekday). */
  dayOfWeek: number;
  /** Set when there are no regular classes at all (holiday, 大学祭, 補講日 …). */
  noClasses?: string;
  /** Classes from this period on are cancelled (partial closure). */
  cancelledFrom?: { period: number; note: string };
  /** Substitute-day note (e.g. 月曜授業). */
  note?: string;
  /** Exceptions limited to a campus/faculty the student config does not name. */
  scopedNotes: string[];
}

function scopeLabel(d: NoClassDay): string {
  return [d.campus, d.faculty].filter(Boolean).join('・');
}

/**
 * Whether a date has regular classes. Substitute days win over holidays; `holidays` are extra
 * no-class dates from a source calendar (e.g. LiveCampusU's 祝日 entries), keyed by date.
 */
export function classDay(
  cal: AcademicCalendar,
  date: string,
  options: { holidays?: ReadonlyMap<string, string>; student?: StudentScope } = {},
): ClassDayInfo {
  const sub: SubstituteDay | undefined = cal.substituteDays.find((s) => s.date === date);
  const info: ClassDayInfo = {
    date,
    dayOfWeek: sub ? sub.dayOfWeek : dayOfWeekOfDate(date),
    scopedNotes: [],
  };
  if (sub?.note) info.note = sub.note;
  for (const d of cal.noClassDays.filter((x) => x.date === date)) {
    const campus = scopeMatches(d.campus, options.student?.campus);
    const faculty = scopeMatches(d.faculty, options.student?.faculty);
    if (campus === false || faculty === false) continue;
    if (campus === undefined || faculty === undefined) {
      info.scopedNotes.push(`${d.note}（${scopeLabel(d)}）`);
      continue;
    }
    if (d.fromPeriod) info.cancelledFrom = { period: d.fromPeriod, note: d.note };
    else info.noClasses = d.note;
  }
  if (!sub && !info.noClasses) {
    const holiday = options.holidays?.get(date);
    if (holiday) info.noClasses = holiday;
  }
  return info;
}

export interface WeeklySlot {
  dayOfWeek: number;
  period?: number | undefined;
  startTime?: string | undefined;
  endTime?: string | undefined;
  room?: string | undefined;
}

export interface SlotOccurrence<S extends WeeklySlot = WeeklySlot> {
  date: string;
  slot: S;
  /** The class does not take place (partial closure such as 7・8限以降休講). */
  cancelled?: string;
  /** Free-text notes for the day (substitute day, campus-limited closures). */
  notes: string[];
}

/**
 * Expand weekly slots over [from, to) local dates, inside the class window and outside the exam
 * period, honouring substitute days and no-class days.
 */
export function expandWeeklySlots<S extends WeeklySlot>(
  slots: readonly S[],
  window: { start: string; end: string },
  range: { from: string; to: string },
  cal: AcademicCalendar,
  options: {
    holidays?: ReadonlyMap<string, string>;
    student?: StudentScope;
    exams?: { start: string; end: string } | undefined;
  } = {},
): SlotOccurrence<S>[] {
  const out: SlotOccurrence<S>[] = [];
  if (slots.length === 0) return out;
  const first = range.from > window.start ? range.from : window.start;
  for (let date = first; date < range.to && date <= window.end; date = addLocalDays(date, 1)) {
    if (options.exams && options.exams.start <= date && date <= options.exams.end) continue;
    const day = classDay(cal, date, options);
    if (day.noClasses) continue;
    const notes = [...(day.note ? [day.note] : []), ...day.scopedNotes];
    for (const slot of slots) {
      if (slot.dayOfWeek !== day.dayOfWeek) continue;
      const cancelled =
        day.cancelledFrom && slot.period !== undefined && slot.period >= day.cancelledFrom.period
          ? day.cancelledFrom.note
          : undefined;
      out.push({ date, slot, ...(cancelled ? { cancelled } : {}), notes });
    }
  }
  return out;
}

function partRange(part: TermPartDefinition, dayOfWeek: number): { start: string; end: string } {
  return part.weekdays?.[String(dayOfWeek)] ?? { start: part.start, end: part.end };
}

/**
 * Which half (前半 / 後半) of the term a class day belongs to, for the timetable weekday it follows
 * (after 振替; default: the date's own weekday). The boundary is per weekday (the profile's
 * `weekdays`), so in the switch-over weeks a Thursday class can be in 後半 while the Monday class
 * of the same week is still in 前半. A Saturday follows the Friday before it and a Sunday the
 * Monday after it. Undefined when the term has no halves or the date lies outside both.
 */
export function termHalfOf(
  term: TermDefinition,
  date: string,
  dayOfWeek: number = dayOfWeekOfDate(date),
): TermHalf | undefined {
  const parts = term.parts;
  if (!parts || parts.length === 0) return undefined;
  const key = String(dayOfWeek);
  const hasOwn = parts.some((p) => p.weekdays?.[key]);
  if (!hasOwn && parts.some((p) => p.weekdays) && (dayOfWeek === 6 || dayOfWeek === 0)) {
    const shifted = dayOfWeek === 6 ? 5 : 1;
    const hit = termHalfOf(term, addLocalDays(date, dayOfWeek === 6 ? -1 : 1), shifted);
    if (hit) return hit;
  }
  const hits = parts.filter((p) => {
    const r = partRange(p, dayOfWeek);
    return r.start <= date && date <= r.end;
  });
  return hits[0]?.half;
}

/** The half's definition in a term. */
export function termPart(term: TermDefinition, half: TermHalf): TermPartDefinition | undefined {
  return term.parts?.find((p) => p.half === half);
}

/**
 * True in the switch-over weeks where both halves have classes depending on the weekday (the date
 * lies inside both halves' overall spans).
 */
export function inHalfSwitchover(term: TermDefinition, date: string): boolean {
  const parts = term.parts ?? [];
  return parts.length > 1 && parts.every((p) => p.start <= date && date <= p.end);
}

/**
 * Dates a course that meets only in the given halves can have classes or work: the union of those
 * halves' spans, else the term's class weeks (whole term, or no halves defined).
 */
export function halvesWindow(
  term: TermDefinition,
  halves: readonly TermHalf[] | undefined,
): { start: string; end: string } {
  const parts = (term.parts ?? []).filter((p) => halves?.includes(p.half));
  if (!halves || halves.length === 0 || parts.length === 0) return classWindow(term);
  return {
    start: parts.map((p) => p.start).sort()[0] as string,
    end: parts
      .map((p) => p.end)
      .sort()
      .at(-1) as string,
  };
}
