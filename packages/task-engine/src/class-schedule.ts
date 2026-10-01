import { type ClassSession, type CourseOffering, stableId } from '@unicontext/canonical-model';
import {
  addLocalDays,
  type Clock,
  classDay,
  classWindow,
  DEFAULT_TIMEZONE,
  expandWeeklySlots,
  findPeriod,
  findTerm,
  type StudentScope,
  systemClock,
  type TermDefinition,
  termForDate,
  type UniversityProfile,
  zonedDateString,
  zonedTime,
} from '@unicontext/core';
import { EntityStore, type UniContextDatabase } from '@unicontext/database';
import { FactStore } from '@unicontext/provenance';

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

export interface EnrolledOffering {
  /** Canonical offering. */
  offering: CourseOffering;
  /** Every linked offering id. */
  ids: string[];
  scheduleType: ScheduleType;
  term: TermDefinition | undefined;
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

  /** Offerings the student is enrolled in, one per canonical offering. */
  enrolledOfferings(): EnrolledOffering[] {
    const self = new Set(
      this.entities
        .list('person')
        .filter((p) => p.isSelf)
        .map((p) => p.id),
    );
    const out = new Map<string, EnrolledOffering>();
    for (const e of this.entities.list('enrollment')) {
      if (e.status !== 'active' || e.role !== 'student') continue;
      if (self.size > 0 && !self.has(e.personId)) continue;
      const id = this.canonical(e.courseOfferingId);
      if (out.has(id)) continue;
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
      out.set(id, { offering, ids, scheduleType: this.scheduleTypeOf(ids), term });
    }
    return [...out.values()];
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
        const win = { start: classWindow(t).start, end: t.exams?.end ?? classWindow(t).end };
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
    const stored = this.entities
      .listByDateRange('classSession', 'date', fromDate, toDate)
      .filter((s) => !wanted || wanted.has(this.canonical(s.courseOfferingId)));
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
