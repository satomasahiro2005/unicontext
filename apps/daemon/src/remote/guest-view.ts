import type {
  ClassItem,
  DeadlineContext,
  DeadlineItem,
  WeekContext,
} from '@unicontext/context-engine';
import { termPartLabel, type TermHalf } from '@unicontext/core';
import type { GuestRole } from './guests.js';

/**
 * What a guest may see, cut down from the week view. Only facts a timetable or a deadline list
 * states: course titles, times, rooms, 休講, due dates and whether work was handed in. Never notice
 * bodies, mail, Teams posts, notes, grades, attendance, calendar events, the student's own
 * self-study slots or deadlines without a course (就活, personal), nor citations or source ids.
 */
export interface GuestClass {
  period: number | undefined;
  startsAt: string | undefined;
  endsAt: string | undefined;
  course: string;
  room: string | undefined;
  /** The room is disputed between sources: shown as 「要確認」. */
  roomUncertain: boolean;
  cancelled: boolean;
}

export interface GuestDeadline {
  course: string;
  title: string;
  dueAt: string;
  done: boolean;
  /**
   * Past due and not marked handed in. Only for assignments a submission system tracks, and
   * shown as 「提出未確認」, never 「未提出」: handing in on paper or by mail leaves no trace here.
   */
  overdue: boolean;
}

export interface GuestView {
  role: GuestRole;
  /** The week shown is next week (on Saturday and Sunday). */
  nextWeek: boolean;
  generatedAt: string;
  timezone: string;
  /** YYYY-MM-DD in the university's time zone. */
  today: string;
  from: string;
  to: string;
  days: { date: string; classes: GuestClass[]; note: string | undefined }[];
  /** family only: this week's deadlines plus open and overdue ones of the next two weeks. */
  deadlines?: GuestDeadline[];
  /** family only. */
  exams?: GuestDeadline[];
}

const DONE = new Set(['submitted', 'completed']);
const HIDDEN = new Set(['cancelled', 'expired_past_term']);

function guestClass(c: ClassItem): GuestClass {
  const room = typeof c.room.value === 'string' ? c.room.value : undefined;
  return {
    period: c.period,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    course: c.course.title,
    room,
    roomUncertain: c.room.status === 'conflict',
    cancelled: c.cancelled,
  };
}

const PAST_DAYS_SHOWN = 7;

const shortTitle = (t: string): string => {
  const one = t.replace(/\s+/g, ' ').trim();
  return one.length > 60 ? `${one.slice(0, 59)}…` : one;
};

/**
 * Course deadlines without the student's own pacing. Past ones only for the last week and only
 * when a submission system tracks them (`assignment`): a date read out of a notice has no
 * submission status, and a guest must not read 「期限切れ」 into it.
 */
function guestDeadlines(items: DeadlineItem[], now: Date): GuestDeadline[] {
  const seen = new Set<string>();
  const oldest = now.getTime() - PAST_DAYS_SHOWN * 86_400_000;
  return items
    .filter((d) => !seen.has(d.taskId) && seen.add(d.taskId))
    .filter((d) => d.course && d.kind !== 'weekly_pace' && !HIDDEN.has(d.status))
    .filter((d) => {
      const due = Date.parse(d.dueAt);
      if (due >= now.getTime()) return true;
      return due >= oldest && (d.kind === 'assignment' || DONE.has(d.status));
    })
    .map((d) => ({
      course: d.course?.title ?? '',
      title: shortTitle(d.title),
      dueAt: d.dueAt,
      done: DONE.has(d.status),
      overdue: Date.parse(d.dueAt) < now.getTime() && !DONE.has(d.status),
    }))
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

export function zonedDate(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

export function guestView(
  week: WeekContext,
  role: GuestRole,
  upcoming?: Pick<DeadlineContext, 'overdue' | 'upcoming'>,
  nextWeek = false,
): GuestView {
  const now = new Date(week.generatedAt);
  const view: GuestView = {
    role,
    nextWeek,
    generatedAt: week.generatedAt,
    timezone: week.timezone,
    today: zonedDate(week.generatedAt, week.timezone),
    from: week.from,
    to: week.to,
    days: week.days.map((d) => ({
      date: d.date,
      classes: d.classes.filter((c) => c.sessionKind === 'class').map(guestClass),
      note: d.noClassesReason,
    })),
  };
  if (role === 'family') {
    view.deadlines = guestDeadlines(
      [...week.deadlines, ...(upcoming?.overdue ?? []), ...(upcoming?.upcoming ?? [])],
      now,
    );
    view.exams = guestDeadlines(week.exams, now);
  }
  return view;
}

/** One registered course as a guest sees it: when and where it meets, nothing else. */
export interface GuestCourse {
  title: string;
  academicYear?: number;
  term?: string;
  /** 「後期前半」 when the course meets in one half of the term only. */
  termPart?: string;
  /** regular = weekly slots; unscheduled = 時間割外; intensive = 集中講義. */
  scheduleType: 'regular' | 'unscheduled' | 'intensive';
  slots: { day: string; period?: number; room?: string }[];
}

const DAY_JA = '日月火水木金土';

const termOrder = (term: string | undefined): number =>
  !term ? 3 : /前期|春/.test(term) ? 0 : /後期|秋/.test(term) ? 1 : 2;

/** The parts of the task engine's EnrolledOffering read here. */
export interface EnrolledLike {
  offering: {
    title: string;
    academicYear?: number | undefined;
    term?: string | undefined;
    room?: string | undefined;
    schedule: { dayOfWeek: number; period?: number | undefined; room?: string | undefined }[];
  };
  scheduleType: GuestCourse['scheduleType'];
  termParts: { halves: TermHalf[] } | undefined;
}

/** Everything the student registered for (every term), for a guest: the whole timetable at once. */
export function guestCourses(enrolled: readonly EnrolledLike[]): GuestCourse[] {
  const firstSlot = (c: EnrolledLike) => {
    const s = c.offering.schedule[0];
    return s ? ((s.dayOfWeek + 6) % 7) * 100 + (s.period ?? 0) : 9999;
  };
  return [...enrolled]
    .sort(
      (a, b) =>
        (a.offering.academicYear ?? 0) - (b.offering.academicYear ?? 0) ||
        termOrder(a.offering.term) - termOrder(b.offering.term) ||
        firstSlot(a) - firstSlot(b),
    )
    .map((c) => {
      const o = c.offering;
      const termPart = termPartLabel(o.term, c.termParts?.halves);
      return {
        title: o.title,
        ...(o.academicYear !== undefined ? { academicYear: o.academicYear } : {}),
        ...(o.term ? { term: o.term } : {}),
        ...(termPart ? { termPart } : {}),
        scheduleType: c.scheduleType,
        slots: o.schedule.map((s) => ({
          day: DAY_JA[s.dayOfWeek] ?? '?',
          ...(s.period !== undefined ? { period: s.period } : {}),
          ...((s.room ?? o.room) ? { room: s.room ?? o.room } : {}),
        })),
      };
    });
}
