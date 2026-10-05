import {
  type ClassSession,
  type CourseOffering,
  stableId,
  TERM_SLOTS_PREDICATE,
  type TermHalf,
  TermSlotsValueSchema,
} from '@unicontext/canonical-model';
import {
  addLocalDays,
  type Clock,
  classDay,
  classWindow,
  dayOfWeekOfDate,
  DEFAULT_TIMEZONE,
  expandWeeklySlots,
  findPeriod,
  findTerm,
  halvesWindow,
  inHalfSwitchover,
  isWholeTerm,
  normalizeHalves,
  type StudentScope,
  systemClock,
  type TermDefinition,
  termForDate,
  termHalfOf,
  termPart,
  termPartLabel,
  type UniversityProfile,
  zonedDateString,
  zonedTime,
} from '@unicontext/core';
import { EntityStore, type UniContextDatabase } from '@unicontext/database';
import { FactStore } from '@unicontext/provenance';
import { type EnrollmentDeclaration, enrollmentDeclarations } from './enrollment-declaration.js';

/** User fact (origin user) holding the weekly self-study slots of an offering. */
export const PACE_PREDICATE = 'pace_slots';

/** One weekly self-study slot (value of the pace_slots fact: `{ slots: PaceSlot[] }`). */
export interface PaceSlot {
  /** 0 = Sunday … 6 = Saturday */
  dayOfWeek: number;
  startTime?: string;
  endTime?: string;
  period?: number;
}

export type ScheduleType = NonNullable<CourseOffering['scheduleType']>;

/** Calendar categories that mean "no classes" (LiveCampusU listType Holiday, …). */
const HOLIDAY_CATEGORIES = new Set(['holiday', '祝日', '休日']);

export interface ClassScheduleOptions {
  db: UniContextDatabase;
  clock?: Clock;
  timezone?: string;
  profile?: UniversityProfile;
  student?: StudentScope;
  facts?: FactStore;
  /** Identity: canonical id and connected ids of a course offering (§14). */
  canonical?: (id: string) => string;
  expand?: (id: string) => string[];
}

/** A course whose academic enrollment status and the student's declaration disagree. */
export interface EnrollmentOverride {
  offering: EnrolledOffering;
  academic: 'active' | 'dropped';
  declaration: EnrollmentDeclaration;
}

/** Whether the student takes an offering, per the academic system and the student. */
export interface EnrollmentStatus {
  /** The academic system's student enrollment (none = no enrollment record at all). */
  academic: 'active' | 'dropped' | 'none';
  declaration?: EnrollmentDeclaration;
  /** What the views use: the student's declaration over the academic status. */
  taken: boolean;
}

export interface EnrolledOffering {
  /** Canonical offering. */
  offering: CourseOffering;
  /** Every linked offering id. */
  ids: string[];
  scheduleType: ScheduleType;
  term: TermDefinition | undefined;
  /** Halves of the term (前半 / 後半) it meets in; undefined = not stated (whole term). */
  termParts: OfferingTermParts | undefined;
}

/**
 * The halves of its term (前半 / 後半) an offering meets in, from the best source across linked
 * offerings: the academic system's per-slot text (term_slots fact, 「前期前半/金5・6」) first, then
 * per-slot or offering-level termParts of a linked offering (the syllabus 開講時期).
 */
export interface OfferingTermParts {
  /** Union over the slots, sorted (前半, 後半). */
  halves: TermHalf[];
  /** Per timetable slot when the source states it per slot. */
  slots: { dayOfWeek: number; period?: number; halves: TermHalf[] }[];
  /** Fact or offering the value comes from (its citations are the provenance). */
  evidenceId: string;
  via: 'term_slots' | 'offering';
}

/** The half of the term a date is in (for the timetable weekday that date follows). */
export interface CurrentHalf {
  term: TermDefinition;
  half: TermHalf;
  /** e.g. 後期前半 (the profile's name for the half). */
  label: string;
  /** In the switch-over weeks the half depends on the weekday (第8回 / 第9回 differ by weekday). */
  switchover: boolean;
}

/** Halves a slot meets in: the slot's own entry, else the offering-level union. */
export function slotHalves(
  parts: OfferingTermParts | undefined,
  slot: { dayOfWeek: number; period?: number | undefined },
): TermHalf[] | undefined {
  if (!parts) return undefined;
  const own = parts.slots.filter(
    (s) =>
      s.dayOfWeek === slot.dayOfWeek &&
      (s.period === undefined || slot.period === undefined || s.period === slot.period),
  );
  return own.length ? normalizeHalves(own.flatMap((s) => s.halves)) : parts.halves;
}

/**
 * Weekly class sessions of the student's own course offerings (§17): stored ClassSessions (休講・
 * 補講・教室変更 from notices, imports) merged over sessions generated from the timetable, the term's
 * class weeks and the academic calendar (holidays, substitute days). Generated sessions are not
 * stored: they are recomputed for any date range, so a timetable or calendar change never leaves
 * stale rows behind. Offerings without a regular weekly timetable (時間割外 / 集中講義) get no class
 * sessions, only the student's own self-study slots (pace_slots, origin user).
 */
export class ClassSchedule {
  private readonly db: UniContextDatabase;
  private readonly clock: Clock;
  readonly timezone: string;
  readonly profile: UniversityProfile | undefined;
  readonly student: StudentScope | undefined;
  private readonly entities: EntityStore;
  private readonly facts: FactStore;
  private readonly canonical: (id: string) => string;
  private readonly expand: (id: string) => string[];

  constructor(options: ClassScheduleOptions) {
    this.db = options.db;
    this.clock = options.clock ?? systemClock;
    this.timezone = options.timezone ?? DEFAULT_TIMEZONE;
    this.profile = options.profile;
    this.student = options.student;
    this.entities = new EntityStore(this.db, { clock: this.clock });
    this.facts = options.facts ?? new FactStore(this.db, this.clock);
    this.canonical = options.canonical ?? ((id) => id);
    this.expand = options.expand ?? ((id) => [id]);
  }

  private get calendar(): UniversityProfile['academicCalendar'] | undefined {
    return this.profile?.academicCalendar;
  }

  /** Term containing a local date (default today). */
  currentTerm(date: string = zonedDateString(this.clock.now(), this.timezone)) {
    const cal = this.calendar;
    return cal ? termForDate(cal, date) : undefined;
  }

  /** Term of an offering (academic year + 前期/後期 label) from the profile's academic calendar. */
  termOf(offering: Pick<CourseOffering, 'academicYear' | 'term'>): TermDefinition | undefined {
    const cal = this.calendar;
    return cal ? findTerm(cal, offering.academicYear, offering.term) : undefined;
  }

  /**
   * Schedule type across linked offerings: the academic system's 時間割外 / 集中 marking wins over a
   * syllabus timetable of the regular class.
   */
  scheduleTypeOf(ids: readonly string[]): ScheduleType {
    const offs = ids
      .map((id) => this.entities.getOfKind('courseOffering', id))
      .filter((o): o is CourseOffering => o !== undefined);
    const marked = offs.find((o) => o.scheduleType && o.scheduleType !== 'regular');
    if (marked?.scheduleType) return marked.scheduleType;
    return offs.some((o) => o.schedule.length > 0) ? 'regular' : 'unscheduled';
  }

  /**
   * Offerings the student takes, one per canonical offering: active student enrollments of the
   * academic system with the student's own declaration applied (enrollment-declaration.ts) — a
   * course the student says they do not take is left out, a dropped one they say they take is kept.
   * `raw` = the academic system's list as it is (for reading synced documents, whose tables name
   * courses the student may have dropped).
   */
  enrolledOfferings(options: { raw?: boolean } = {}): EnrolledOffering[] {
    return this.enrollmentEntries(options.raw === true)
      .filter((e) => options.raw === true || e.taken)
      .map((e) => e.offering);
  }

  /**
   * Courses where the student's declaration and the academic system disagree about taking it:
   * listed as active but declared not_taking, or dropped but declared taking.
   */
  enrollmentOverrides(): EnrollmentOverride[] {
    return this.enrollmentEntries(false)
      .filter(
        (e) => e.declaration && (e.academic === 'active') !== (e.declaration.value === 'taking'),
      )
      .map((e) => ({
        offering: e.offering,
        academic: e.academic,
        declaration: e.declaration as EnrollmentDeclaration,
      }));
  }

  /** Every linked id of the courses the academic system lists but the student says they do not take. */
  declaredNotTaken(): Set<string> {
    return new Set(
      this.enrollmentOverrides()
        .filter((o) => o.declaration.value === 'not_taking')
        .flatMap((o) => o.offering.ids),
    );
  }

  /** The academic status and the student's declaration for one offering (any linked id). */
  enrollmentStatusOf(courseOfferingId: string): EnrollmentStatus {
    const id = this.canonical(courseOfferingId);
    const ids = new Set([id, ...this.expand(id), courseOfferingId]);
    const entry = this.enrollmentEntries(false).find((e) => e.offering.ids.some((x) => ids.has(x)));
    const declaration =
      entry?.declaration ?? enrollmentDeclarations(this.facts, [[...ids]])[0] ?? undefined;
    const academic = entry?.academic ?? 'none';
    const taken =
      declaration?.value === 'not_taking'
        ? false
        : declaration?.value === 'taking'
          ? academic !== 'none'
          : academic === 'active';
    return { academic, ...(declaration ? { declaration } : {}), taken };
  }

  private enrollmentEntries(raw: boolean): {
    offering: EnrolledOffering;
    academic: 'active' | 'dropped';
    declaration: EnrollmentDeclaration | undefined;
    taken: boolean;
  }[] {
    const self = new Set(
      this.entities
        .list('person')
        .filter((p) => p.isSelf)
        .map((p) => p.id),
    );
    const found = new Map<string, { offering: EnrolledOffering; academic: 'active' | 'dropped' }>();
    const enrollments = this.entities
      .list('enrollment')
      .filter(
        (e) =>
          e.role === 'student' &&
          (e.status === 'active' || (!raw && e.status === 'dropped')) &&
          (self.size === 0 || self.has(e.personId)),
      )
      // An active enrollment wins over a dropped one of the same canonical offering.
      .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'));
    for (const e of enrollments) {
      const id = this.canonical(e.courseOfferingId);
      if (found.has(id)) continue;
      const ids = [...new Set([id, ...this.expand(id), e.courseOfferingId])];
      const offering =
        this.entities.getOfKind('courseOffering', id) ??
        this.entities.getOfKind('courseOffering', e.courseOfferingId);
      if (!offering) continue;
      const linked = ids
        .map((x) => this.entities.getOfKind('courseOffering', x))
        .filter((o): o is CourseOffering => o !== undefined);
      const term =
        this.termOf(offering) ?? linked.map((o) => this.termOf(o)).find((t) => t !== undefined);
      found.set(id, {
        offering: {
          offering,
          ids,
          scheduleType: this.scheduleTypeOf(ids),
          term,
          termParts: this.termPartsOf(ids),
        },
        academic: e.status === 'active' ? 'active' : 'dropped',
      });
    }
    const list = [...found.values()];
    const declarations = raw
      ? list.map(() => undefined)
      : enrollmentDeclarations(
          this.facts,
          list.map((e) => e.offering.ids),
        );
    return list.map((e, i) => {
      const declaration = declarations[i];
      const taken = declaration ? declaration.value === 'taking' : e.academic === 'active';
      return { ...e, declaration, taken };
    });
  }

  /**
   * Halves of the term (前半 / 後半) across linked offerings: the latest term_slots fact (the
   * academic system's per-slot text) wins over a linked offering's termParts (syllabus 開講時期).
   */
  termPartsOf(ids: readonly string[]): OfferingTermParts | undefined {
    const facts = this.facts.active({ subjects: ids, predicate: TERM_SLOTS_PREDICATE });
    for (const f of [...facts].reverse()) {
      const v = TermSlotsValueSchema.safeParse(f.value);
      if (!v.success || v.data.slots.length === 0) continue;
      const bySlot = new Map<string, { dayOfWeek: number; period?: number; halves: TermHalf[] }>();
      for (const s of v.data.slots) {
        const key = `${s.dayOfWeek}|${s.period ?? ''}`;
        const cur = bySlot.get(key) ?? {
          dayOfWeek: s.dayOfWeek,
          ...(s.period !== undefined ? { period: s.period } : {}),
          halves: [],
        };
        cur.halves = normalizeHalves([...cur.halves, s.half]);
        bySlot.set(key, cur);
      }
      const slots = [...bySlot.values()];
      return {
        halves: normalizeHalves(slots.flatMap((s) => s.halves)),
        slots,
        evidenceId: f.id,
        via: 'term_slots',
      };
    }
    const offs = ids
      .map((id) => this.entities.getOfKind('courseOffering', id))
      .filter((o): o is CourseOffering => o !== undefined);
    for (const o of offs) {
      const slots = o.schedule
        .filter((s) => s.termParts?.length)
        .map((s) => ({
          dayOfWeek: s.dayOfWeek,
          ...(s.period !== undefined ? { period: s.period } : {}),
          halves: normalizeHalves(s.termParts ?? []),
        }));
      const halves = normalizeHalves([...(o.termParts ?? []), ...slots.flatMap((s) => s.halves)]);
      if (halves.length) return { halves, slots, evidenceId: o.id, via: 'offering' };
    }
    return undefined;
  }

  /** Timetable weekday a date follows (振替: 11/25(水) 月曜授業 → 1). */
  timetableDayOf(date: string): number {
    const cal = this.calendar;
    return cal ? classDay(cal, date).dayOfWeek : dayOfWeekOfDate(date);
  }

  /** The half of its term a date is in, or undefined (no halves defined / outside both). */
  currentHalf(
    date: string = zonedDateString(this.clock.now(), this.timezone),
  ): CurrentHalf | undefined {
    const cal = this.calendar;
    const term = cal ? termForDate(cal, date) : undefined;
    if (!cal || !term) return undefined;
    const half = termHalfOf(term, date, classDay(cal, date).dayOfWeek);
    if (!half) return undefined;
    return {
      term,
      half,
      label: termPart(term, half)?.name ?? termPartLabel(term.termCode, [half]) ?? half,
      switchover: inHalfSwitchover(term, date),
    };
  }

  /** Display label of an enrolled offering's halves (後期後半 / 後期（前半・後半）), if known. */
  termPartLabelOf(
    e: Pick<EnrolledOffering, 'offering' | 'term' | 'termParts'>,
  ): string | undefined {
    return termPartLabel(e.term?.termCode ?? e.offering.term, e.termParts?.halves);
  }

  /**
   * Whether an offering has classes (or work) in the half of its term that contains the date. True
   * when the halves or the date's half are unknown, and in the switch-over weeks.
   */
  runsOn(e: Pick<EnrolledOffering, 'term' | 'termParts'>, date: string): boolean {
    const halves = e.termParts?.halves;
    if (!e.term || isWholeTerm(halves)) return true;
    const cal = this.calendar;
    const half = termHalfOf(e.term, date, cal ? classDay(cal, date).dayOfWeek : undefined);
    if (half === undefined || halves?.includes(half)) return true;
    return inHalfSwitchover(e.term, date);
  }

  /** The student's weekly self-study slots for an offering (latest user fact wins). */
  paceSlots(offeringIds: readonly string[]): PaceSlot[] {
    const facts = this.facts
      .active({ subjects: offeringIds, predicate: PACE_PREDICATE })
      .filter((f) => f.origin === 'user')
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    const v = facts.at(-1)?.value as { slots?: unknown } | null | undefined;
    if (!v || !Array.isArray(v.slots)) return [];
    return v.slots.filter(
      (s): s is PaceSlot =>
        !!s &&
        typeof s === 'object' &&
        Number.isInteger((s as PaceSlot).dayOfWeek) &&
        (s as PaceSlot).dayOfWeek >= 0 &&
        (s as PaceSlot).dayOfWeek <= 6,
    );
  }

  private holidays(): Map<string, string> {
    const out = new Map<string, string>();
    for (const ev of this.entities.list('calendarEvent')) {
      if (!ev.allDay || !ev.category || !HOLIDAY_CATEGORIES.has(ev.category.toLowerCase()))
        continue;
      out.set(zonedDateString(new Date(ev.startsAt), this.timezone), ev.title);
    }
    return out;
  }

  private times(
    date: string,
    slot: {
      period?: number | undefined;
      startTime?: string | undefined;
      endTime?: string | undefined;
    },
  ): { startsAt?: string; endsAt?: string } {
    const def = slot.period && this.profile ? findPeriod(this.profile, slot.period) : undefined;
    const start = slot.startTime ?? def?.start;
    const end = slot.endTime ?? def?.end;
    const at = (hhmm: string | undefined): string | undefined => {
      if (!hhmm) return undefined;
      const [y, m, d] = date.split('-').map(Number);
      const [h, min] = hhmm.split(':').map(Number);
      return zonedTime(
        { year: y as number, month: m as number, day: d as number, hour: h, minute: min },
        this.timezone,
      ).toISOString();
    };
    const startsAt = at(start);
    const endsAt = at(end);
    return { ...(startsAt ? { startsAt } : {}), ...(endsAt ? { endsAt } : {}) };
  }

  /** Start / end (ISO) of a period or a start–end time on a local date (profile period table). */
  slotTimes(
    date: string,
    slot: {
      period?: number | undefined;
      startTime?: string | undefined;
      endTime?: string | undefined;
    },
  ): { startsAt?: string; endsAt?: string } {
    return this.times(date, slot);
  }

  /** Periods of an offering's weekly timetable (across linked offerings), sorted. */
  timetablePeriods(ids: readonly string[]): number[] {
    for (const id of ids) {
      const o = this.entities.getOfKind('courseOffering', id);
      const periods = (o?.schedule ?? [])
        .map((s) => s.period)
        .filter((p): p is number => p !== undefined);
      if (periods.length) return [...new Set(periods)].sort((a, b) => a - b);
    }
    return [];
  }

  /** Generated (not stored) sessions in [fromDate, toDate) for the given or all enrolled offerings. */
  generated(fromDate: string, toDate: string, courseIds?: readonly string[]): ClassSession[] {
    const cal = this.calendar;
    if (!cal) return [];
    const wanted = courseIds ? new Set(courseIds.map((c) => this.canonical(c))) : undefined;
    const holidays = this.holidays();
    const out: ClassSession[] = [];
    for (const e of this.enrolledOfferings()) {
      const id = this.canonical(e.offering.id);
      if (wanted && !wanted.has(id)) continue;
      const term = e.term;
      const common = { holidays, ...(this.student ? { student: this.student } : {}) };
      if (term && e.scheduleType === 'regular') {
        const slots = e.offering.schedule.length
          ? e.offering.schedule
          : (e.ids
              .map((x) => this.entities.getOfKind('courseOffering', x))
              .find((o) => o && o.schedule.length > 0)?.schedule ?? []);
        for (const occ of expandWeeklySlots(
          slots,
          classWindow(term),
          { from: fromDate, to: toDate },
          cal,
          { ...common, exams: term.exams },
        )) {
          // A half-term course (前半 / 後半, per slot when the source says so) only meets in its half.
          const halves = slotHalves(e.termParts, occ.slot);
          if (!isWholeTerm(halves)) {
            const half = termHalfOf(term, occ.date, occ.slot.dayOfWeek);
            if (half && !halves?.includes(half)) continue;
          }
          const key = occ.slot.period ? String(occ.slot.period) : (occ.slot.startTime ?? 'day');
          const room = occ.slot.room ?? e.offering.room;
          const note = [...(occ.cancelled ? [occ.cancelled] : []), ...occ.notes].join(' / ');
          out.push({
            id: stableId('classSession', 'timetable', id, occ.date, key),
            kind: 'classSession',
            courseOfferingId: id as ClassSession['courseOfferingId'],
            date: occ.date,
            ...(occ.slot.period ? { period: occ.slot.period } : {}),
            ...this.times(occ.date, occ.slot),
            ...(room ? { room } : {}),
            status: occ.cancelled ? 'cancelled' : 'scheduled',
            ...(note ? { note } : {}),
            sessionKind: 'class',
          });
        }
      }
      const pace = this.paceSlots(e.ids);
      if (pace.length) {
        // Self-study follows the student's slot through the term's class weeks and exam period,
        // or the current term when the offering's term is unknown.
        const t = term ?? this.currentTerm(fromDate);
        if (!t) continue;
        const whole = { start: classWindow(t).start, end: t.exams?.end ?? classWindow(t).end };
        const win = !isWholeTerm(e.termParts?.halves)
          ? halvesWindow(t, e.termParts?.halves)
          : whole;
        for (const occ of expandWeeklySlots(
          pace,
          win,
          { from: fromDate, to: toDate },
          cal,
          common,
        )) {
          const key = occ.slot.period ? `p${occ.slot.period}` : (occ.slot.startTime ?? 'day');
          out.push({
            id: stableId('classSession', 'self_study', id, occ.date, key),
            kind: 'classSession',
            courseOfferingId: id as ClassSession['courseOfferingId'],
            date: occ.date,
            ...(occ.slot.period ? { period: occ.slot.period } : {}),
            ...this.times(occ.date, occ.slot),
            status: 'scheduled',
            note: '自習',
            sessionKind: 'self_study',
          });
        }
      }
    }
    return out;
  }

  /**
   * Sessions in [fromDate, toDate): stored sessions win over generated ones of the same course and
   * period; a stored session without period/time (e.g. 終日休講) replaces that course's generated
   * classes of the day. Self-study sessions are kept alongside.
   */
  sessionsBetween(fromDate: string, toDate: string, courseIds?: readonly string[]): ClassSession[] {
    const wanted = courseIds ? new Set(courseIds.map((c) => this.canonical(c))) : undefined;
    // Courses the student says they do not take: their stored meetings (休講 notices…) stay out too.
    const notTaken = this.declaredNotTaken();
    const stored = this.entities
      .listByDateRange('classSession', 'date', fromDate, toDate)
      .filter((s) => !wanted || wanted.has(this.canonical(s.courseOfferingId)))
      .filter((s) => !notTaken.has(s.courseOfferingId));
    const keyOf = (s: ClassSession): string =>
      `${s.date}|${this.canonical(s.courseOfferingId)}|${s.sessionKind ?? 'class'}|${s.period ?? s.startsAt ?? s.id}`;
    const seen = new Map<string, ClassSession>();
    for (const s of stored) {
      const key = keyOf(s);
      const prev = seen.get(key);
      const canonical = this.canonical(s.courseOfferingId);
      if (!prev || (prev.courseOfferingId !== canonical && s.courseOfferingId === canonical))
        seen.set(key, s);
    }
    // Stored sessions without period/time (a notice about "the class on 7/24") apply to every
    // generated class of that course on that day: 休講 cancels them, 教室変更 changes their room.
    // A makeup without a period stays a separate entry.
    const wholeDay = new Map<string, ClassSession>();
    for (const s of stored)
      if (s.period === undefined && s.startsAt === undefined && s.status !== 'makeup')
        wholeDay.set(`${s.date}|${this.canonical(s.courseOfferingId)}`, s);
    const absorbed = new Set<string>();
    for (const g of this.generated(fromDate, toDate, courseIds)) {
      const key = keyOf(g);
      if (seen.has(key)) continue;
      const day =
        g.sessionKind !== 'self_study'
          ? wholeDay.get(`${g.date}|${g.courseOfferingId}`)
          : undefined;
      if (day) {
        const first = !absorbed.has(day.id);
        absorbed.add(day.id);
        seen.set(key, {
          ...g,
          // The first merged class keeps the stored id so its facts (status, room) resolve.
          ...(first ? { id: day.id } : {}),
          status: day.status,
          ...(day.room ? { room: day.room } : {}),
          ...(day.note ? { note: day.note } : {}),
        });
        continue;
      }
      seen.set(key, g);
    }
    for (const id of absorbed)
      for (const [k, s] of seen) if (s.id === id && s.period === undefined) seen.delete(k);
    const startOf = (s: ClassSession): string =>
      s.startsAt ??
      (s.period ? this.times(s.date, { period: s.period }).startsAt : undefined) ??
      '~';
    return [...seen.values()].sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        startOf(a).localeCompare(startOf(b)) ||
        (a.period ?? 99) - (b.period ?? 99),
    );
  }

  /**
   * Why a date has no generated classes (for an empty 授業 list): outside every term, nothing
   * registered for the term, outside the class weeks / exam period, or a no-class day.
   */
  noClassesReason(date: string): string | undefined {
    const cal = this.calendar;
    if (!cal || cal.terms.length === 0) return undefined;
    const term = termForDate(cal, date);
    if (!term) return '学期外';
    const mine = this.enrolledOfferings().filter((e) => e.term?.id === term.id);
    if (mine.length === 0) return `${term.name}に登録した科目はまだありません`;
    const half = this.currentHalf(date);
    if (half && !half.switchover && !mine.some((e) => this.runsOn(e, date)))
      return `${half.label}に授業のある科目は登録されていません`;
    if (term.exams && term.exams.start <= date && date <= term.exams.end)
      return `${term.name}の定期試験期間`;
    const win = classWindow(term);
    if (date < win.start || date > win.end) return `${term.name}の授業期間外`;
    const day = classDay(cal, date, {
      holidays: this.holidays(),
      ...(this.student ? { student: this.student } : {}),
    });
    if (day.noClasses) return day.noClasses;
    return undefined;
  }

  sessionsOn(date: string): ClassSession[] {
    return this.sessionsBetween(date, addLocalDays(date, 1));
  }
}
