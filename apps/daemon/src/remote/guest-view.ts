import type {
  ClassItem,
  DeadlineContext,
  DeadlineItem,
  WeekContext,
} from '@unicontext/context-engine';
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
  overdue: boolean;
}

export interface GuestView {
  role: GuestRole;
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

function guestDeadlines(items: DeadlineItem[]): GuestDeadline[] {
  const seen = new Set<string>();
  return items
    .filter((d) => !seen.has(d.taskId) && seen.add(d.taskId))
    .filter((d) => d.course && d.kind !== 'weekly_pace' && !HIDDEN.has(d.status))
    .map((d) => ({
      course: d.course?.title ?? '',
      title: d.title,
      dueAt: d.dueAt,
      done: DONE.has(d.status),
      overdue: d.overdue && !DONE.has(d.status),
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
): GuestView {
  const view: GuestView = {
    role,
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
    view.deadlines = guestDeadlines([
      ...week.deadlines,
      ...(upcoming?.overdue ?? []),
      ...(upcoming?.upcoming ?? []),
    ]);
    view.exams = guestDeadlines(week.exams);
  }
  return view;
}
