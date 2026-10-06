/**
 * Busy time that is not a class (stream D). Calendar events (Outlook …) are time the student
 * cannot spend; so are the trips between meetings the student has told UniContext about.
 * `busyIntervals` merges non-cancelled class sessions, timed non-holiday calendar events and travel
 * into one list; overlaps between an event and a class (or two events) become `conflicts`.
 *
 * Everything here is a pure function of a `ScheduleSource` (the engine and a `UniContext` both
 * make one), so the views, the next-action engine and the attention alerts agree.
 */
import type { CalendarEvent, Fact } from '@unicontext/canonical-model';
import {
  addZonedDays,
  formatDateJa,
  parseZonedDate,
  zonedDateString,
  zonedParts,
} from '@unicontext/core';
import type { Citation } from '@unicontext/provenance';
import type { AttentionSeverity } from './attention.js';
import {
  HOME_KEY,
  placeLabel,
  placeOf,
  TRAVEL_PREDICATE,
  TravelBook,
  travelKeyOf,
  travelSubject,
} from './places.js';
import type { UniContext } from './runtime.js';
import type {
  BusyItem,
  CalendarEventItem,
  ClassItem,
  ScheduleOverlap,
  TravelInfo,
} from './types.js';

export type { BusyItem, ScheduleOverlap } from './types.js';
/** A stretch of busy time (class, event or the trip before one). */
export type BusyInterval = BusyItem;
/** Two busy stretches that overlap. */
export type BusyConflict = ScheduleOverlap;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** An event without an end blocks this long. */
const DEFAULT_EVENT_MINUTES = 60;
/**
 * Calendar entries that are not time the student spends: holidays, and the academic system's own
 * calendar mirror of the timetable (LiveCampusU lists every class as a `TimeTable` event: the class
 * session is the thing, its calendar copy is not a second one).
 */
const NOT_BUSY_CATEGORIES = new Set(['holiday', '祝日', '休日', 'timetable', '時間割']);

/** What the schedule needs to read; the engine and a UniContext both provide it. */
export interface ScheduleSource {
  timezone: string;
  now(): Date;
  /** The student's meetings from..to (local dates, inclusive): attending or not yet known. */
  classes(fromDate: string, toDate: string): ClassItem[];
  calendarEvents(): CalendarEvent[];
  citationsFor(ids: readonly string[]): Citation[];
  /** Live `travel:minutes` facts for trips that start at these place keys. */
  travelFacts(fromKeys: readonly string[]): Fact[];
}

export function sourceOfUc(uc: UniContext): ScheduleSource {
  return {
    timezone: uc.timezone,
    now: () => uc.clock.now(),
    classes: (fromDate, toDate) => {
      const out: ClassItem[] = [];
      const personal = uc.context.personalSchedule();
      const last = parseZonedDate(toDate, uc.timezone).getTime();
      for (
        let d = parseZonedDate(fromDate, uc.timezone);
        d.getTime() <= last;
        d = addZonedDays(d, 1, uc.timezone)
      )
        out.push(
          ...uc.context
            .classesOn(zonedDateString(d, uc.timezone), personal)
            .filter((c) => c.effectiveSchedule.status !== 'not_attending'),
        );
      return out;
    },
    calendarEvents: () => uc.sync.stores.entities.list('calendarEvent'),
    citationsFor: (ids) => uc.context.citationsFor(ids),
    travelFacts: (keys) =>
      uc.resolver.facts.active({
        subjects: keys.map(travelSubject),
        predicate: TRAVEL_PREDICATE,
      }),
  };
}

function isSource(x: ScheduleSource | UniContext): x is ScheduleSource {
  return !('context' in x);
}

const normTitle = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

const pad = (n: number): string => String(n).padStart(2, '0');

function hhmm(ms: number, tz: string): string {
  const p = zonedParts(new Date(ms), tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export interface ScheduleWindow {
  /** Classes, events and the trips before them, by start. */
  busy: BusyItem[];
  /** The timed calendar events of the window, with location and trip. */
  events: CalendarEventItem[];
  /** Overlaps of an event with a class or another event. */
  conflicts: ScheduleOverlap[];
}

interface Slot {
  item: BusyItem;
  startMs: number;
  endMs: number;
  /** The class item or event view to put the trip on. */
  target: { travelFromPrevious?: TravelInfo | undefined };
  /** The place key (building / area), if the meeting has a place. */
  key: string | undefined;
  /** Not sure the student attends (group unknown): busy, but never reported as an overlap. */
  tentative: boolean;
}

function isNotBusy(ev: CalendarEvent): boolean {
  return Boolean(ev.category) && NOT_BUSY_CATEGORIES.has((ev.category ?? '').toLowerCase());
}

/** The calendar copy of a class (same course, or the course's name in the title). */
function copiesClass(ev: CalendarEvent, c: ClassItem): boolean {
  if (ev.courseOfferingId && c.course.linkedIds.includes(ev.courseOfferingId)) return true;
  const title = normTitle(ev.title);
  const course = normTitle(c.course.title);
  return (
    course.length >= 3 && (title.includes(course) || (title.length >= 3 && course.includes(title)))
  );
}

/**
 * Busy time of [from, to): classes (pass the views' own `classes` to annotate them with the trip
 * before them), timed calendar events and the trips the student told about.
 */
export function scheduleWindow(
  src: ScheduleSource,
  from: Date,
  to: Date,
  classesIn?: readonly ClassItem[],
): ScheduleWindow {
  const tz = src.timezone;
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const fromDate = zonedDateString(from, tz);
  const toDate = zonedDateString(new Date(toMs - 1), tz);
  const slots: Slot[] = [];

  const classes = (classesIn ?? src.classes(fromDate, toDate)).filter(
    (c) => !c.cancelled && c.sessionKind === 'class' && c.startsAt && c.endsAt,
  );
  const classSlots: Slot[] = [];
  for (const c of classes) {
    const startMs = Date.parse(c.startsAt ?? '');
    const endMs = Date.parse(c.endsAt ?? '');
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    if (endMs <= fromMs || startMs >= toMs) continue;
    const room = typeof c.room.value === 'string' ? c.room.value : undefined;
    classSlots.push({
      item: {
        id: c.sessionId,
        kind: 'class',
        title: `${c.period ? `${c.period}限 ` : ''}${c.course.title}`,
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        ...(room ? { location: room } : {}),
        citations: c.citations,
      },
      startMs,
      endMs,
      target: c,
      key: travelKeyOf(room),
      tentative: c.effectiveSchedule.status === 'unknown',
    });
  }
  slots.push(...classSlots);

  const eventSlots: Slot[] = [];
  const eventViews = new Map<Slot, CalendarEventItem>();
  const seen = new Set<string>();
  const events = src
    .calendarEvents()
    .filter((e) => !e.allDay && !isNotBusy(e))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
  for (const ev of events) {
    const startMs = Date.parse(ev.startsAt);
    if (!Number.isFinite(startMs)) continue;
    const given = ev.endsAt ? Date.parse(ev.endsAt) : Number.NaN;
    const endMs =
      Number.isFinite(given) && given > startMs ? given : startMs + DEFAULT_EVENT_MINUTES * MIN;
    if (endMs <= fromMs || startMs >= toMs) continue;
    // A calendar copy of a class is that class, not a second thing to attend.
    if (
      classSlots.some(
        (s) => overlapMs(s, startMs, endMs) > 0 && copiesClass(ev, classFor(s, classes)),
      )
    )
      continue;
    // The same event from two calendars.
    const dupKey = `${normTitle(ev.title)}|${startMs}|${endMs}`;
    if (seen.has(dupKey)) continue;
    seen.add(dupKey);
    const citations = src.citationsFor([ev.id]);
    const view: CalendarEventItem = {
      id: ev.id,
      title: ev.title,
      startsAt: new Date(startMs).toISOString(),
      endsAt: new Date(endMs).toISOString(),
      ...(ev.location ? { location: ev.location } : {}),
      ...(placeOf(ev.location) ? { place: placeOf(ev.location) } : {}),
      ...(ev.category ? { category: ev.category } : {}),
      ...(ev.url ? { url: ev.url } : {}),
      citations,
      summary: '',
    };
    const slot: Slot = {
      item: {
        id: ev.id,
        kind: 'event',
        title: ev.title,
        start: view.startsAt,
        end: new Date(endMs).toISOString(),
        ...(ev.location ? { location: ev.location } : {}),
        citations,
      },
      startMs,
      endMs,
      target: view,
      key: travelKeyOf(ev.location),
      tentative: false,
    };
    eventSlots.push(slot);
    eventViews.set(slot, view);
  }
  slots.push(...eventSlots);
  slots.sort((a, b) => a.startMs - b.startMs || a.item.id.localeCompare(b.item.id));

  // Overlaps: an event with a class or with another event.
  const conflicts: ScheduleOverlap[] = [];
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i] as Slot;
      const b = slots[j] as Slot;
      if (b.startMs >= a.endMs) break;
      if (a.item.kind === 'class' && b.item.kind === 'class') continue;
      if (a.tentative || b.tentative) continue;
      const minutes = Math.round(
        (Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs)) / MIN,
      );
      if (minutes <= 0) continue;
      conflicts.push({
        a: a.item,
        b: b.item,
        minutes,
        summary: `${hhmm(a.startMs, tz)}-${hhmm(a.endMs, tz)} ${a.item.title}が${hhmm(b.startMs, tz)}-${hhmm(b.endMs, tz)} ${b.item.title}と${minutes}分重なっています`,
        citations: uniqueCitations([...a.item.citations, ...b.item.citations]),
      });
    }
  }

  // Trips: from home to the day's first place, then from place to place.
  const travelItems: BusyItem[] = [];
  const keys = [...new Set([HOME_KEY, ...slots.flatMap((s) => (s.key ? [s.key] : []))])];
  const book = new TravelBook(slots.some((s) => s.key) ? src.travelFacts(keys) : []);
  if (book.size > 0) {
    const byDay = new Map<string, Slot[]>();
    for (const s of slots) {
      const day = zonedDateString(new Date(s.startMs), tz);
      byDay.set(day, [...(byDay.get(day) ?? []), s]);
    }
    for (const day of [...byDay.values()]) {
      let last: string = HOME_KEY;
      for (const s of day) {
        if (!s.key) continue;
        const trip = book.between(last, s.key);
        if (trip && trip.minutes > 0) {
          const citations = src.citationsFor([trip.factId]);
          s.target.travelFromPrevious = {
            minutes: trip.minutes,
            from: placeLabel(last),
            ...(trip.mode ? { mode: trip.mode } : {}),
            citations,
          };
          travelItems.push({
            id: `travel:${s.item.id}`,
            kind: 'travel',
            title: `${placeLabel(last)}から移動（${s.item.title}へ）`,
            start: new Date(s.startMs - trip.minutes * MIN).toISOString(),
            end: new Date(s.startMs).toISOString(),
            citations,
          });
        }
        last = s.key;
      }
    }
  }

  const eventItems = eventSlots.map((s) => {
    const v = eventViews.get(s) as CalendarEventItem;
    const trip = v.travelFromPrevious;
    v.summary = `${formatDateJa(new Date(s.startMs), tz)} ${hhmm(s.startMs, tz)}-${hhmm(s.endMs, tz)} ${v.title}${v.location ? `（${v.location}）` : ''}${trip ? ` / ${trip.from}から移動${trip.minutes}分` : ''}`;
    return v;
  });

  const busy = [...slots.map((s) => s.item), ...travelItems].sort(
    (a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id),
  );
  return { busy, events: eventItems, conflicts };
}

function overlapMs(s: { startMs: number; endMs: number }, startMs: number, endMs: number): number {
  return Math.min(s.endMs, endMs) - Math.max(s.startMs, startMs);
}

function classFor(slot: Slot, classes: readonly ClassItem[]): ClassItem {
  return classes.find((c) => c.sessionId === slot.item.id) as ClassItem;
}

function uniqueCitations(list: Citation[]): Citation[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const k = `${c.sourceReferenceId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Class sessions, calendar events and trips of [from, to), by start:
 * `[{start, end, kind: 'class' | 'event' | 'travel', title, location?, citations}]`.
 */
export function busyIntervals(
  source: ScheduleSource | UniContext,
  from: Date,
  to: Date,
): BusyInterval[] {
  return scheduleWindow(isSource(source) ? source : sourceOfUc(source), from, to).busy;
}

/** Overlaps of events with classes (or each other) in [from, to): `[{a, b, minutes}]`. */
export function busyConflicts(
  source: ScheduleSource | UniContext,
  from: Date,
  to: Date,
): BusyConflict[] {
  return scheduleWindow(isSource(source) ? source : sourceOfUc(source), from, to).conflicts;
}

// ---------------------------------------------------------------------------------------------
// next-action

/** Provided by the engine's next-action host: busy time with events and trips, over given classes. */
export interface ScheduleBusyHost {
  scheduleBusy?: (classes: readonly ClassItem[], fromDate: string, toDate: string) => BusyItem[];
}

/**
 * Busy time for the free-minutes arithmetic of the next-action engine: the classes it already has,
 * plus (when the host knows) calendar events and the trips before meetings, as a union so a trip
 * that runs into a class is not subtracted twice. A host without events is classes only, as before.
 */
export function nextActionBusy(
  host: object,
  classes: readonly ClassItem[],
  fromDate: string,
  toDate: string,
): { start: number; end: number }[] {
  const hook = (host as ScheduleBusyHost).scheduleBusy;
  if (!hook) {
    return classes
      .filter((c) => !c.cancelled && c.sessionKind === 'class' && c.startsAt && c.endsAt)
      .map((c) => ({ start: Date.parse(c.startsAt ?? ''), end: Date.parse(c.endsAt ?? '') }))
      .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end));
  }
  const spans = hook(classes, fromDate, toDate)
    .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
    .sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}

// ---------------------------------------------------------------------------------------------
// views

/** `events` / `overlaps` of a day or week view (only the non-empty ones). */
export function scheduleViewFields(w: ScheduleWindow): {
  events?: CalendarEventItem[];
  overlaps?: ScheduleOverlap[];
} {
  return {
    ...(w.events.length ? { events: w.events } : {}),
    ...(w.conflicts.length ? { overlaps: w.conflicts } : {}),
  };
}

/** `events` / `overlaps` of a day, in the student state (`today.events`, `today.overlaps`). */
export interface ScheduleDayFields {
  events?: CalendarEventItem[] | undefined;
  overlaps?: ScheduleOverlap[] | undefined;
}

export function scheduleFieldsOf(day: ScheduleDayFields): {
  events?: CalendarEventItem[];
  overlaps?: ScheduleOverlap[];
} {
  return {
    ...(day.events?.length ? { events: day.events } : {}),
    ...(day.overlaps?.length ? { overlaps: day.overlaps } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// attention

/** An alert draft (attention.ts turns it into an AttentionItem). */
export interface ScheduleAlertDraft {
  subject: string;
  key: string;
  kind: 'room_change' | 'class_soon';
  severity: AttentionSeverity;
  line: string;
  course: string | undefined;
  at: string | undefined;
  link: undefined;
  citations: Citation[];
  nextEscalationAt: string | undefined;
  recommendedAction: string;
}

/**
 * Alerts about the calendar: an event that overlaps a class or another event today or tomorrow,
 * and an event whose location changed since the last call (change events with `location`).
 */
export function scheduleAlerts(uc: UniContext, since: string): ScheduleAlertDraft[] {
  const tz = uc.timezone;
  const now = uc.clock.now();
  const nowMs = now.getTime();
  const todayStart = parseZonedDate(zonedDateString(now, tz), tz);
  const tomorrowStart = addZonedDays(todayStart, 1, tz);
  const src = sourceOfUc(uc);
  const w = scheduleWindow(src, todayStart, addZonedDays(todayStart, 2, tz));
  const out: ScheduleAlertDraft[] = [];

  for (const o of w.conflicts) {
    // Over already: nothing left to decide.
    if (Math.min(Date.parse(o.a.end), Date.parse(o.b.end)) <= nowMs) continue;
    const startMs = Math.max(Date.parse(o.a.start), Date.parse(o.b.start));
    const today = startMs < tomorrowStart.getTime();
    const ids = [o.a.id, o.b.id].sort();
    out.push({
      subject: `overlap:${ids.join('|')}`,
      key: `overlap:${ids.join('|')}:${o.minutes}:${o.a.start}:${o.b.start}`,
      kind: 'class_soon',
      severity: today ? 'warning' : 'info',
      line: `【予定が重なっています】${today ? '今日' : '明日'} ${o.summary}`,
      course: undefined,
      at: new Date(startMs).toISOString(),
      link: undefined,
      citations: o.citations.slice(0, 2),
      nextEscalationAt: today ? undefined : tomorrowStart.toISOString(),
      recommendedAction: `どちらに出るか決める（${o.a.title} と ${o.b.title}）`,
    });
  }

  const changes = uc.context.changesSince({ since, limit: 200 }).changes;
  for (const ch of changes) {
    if (ch.entityKind !== 'calendarEvent' || !ch.changedFields.includes('location')) continue;
    const ev = uc.sync.stores.entities.getOfKind('calendarEvent', ch.entityId);
    if (!ev || ev.allDay || !ev.location) continue;
    const startMs = Date.parse(ev.startsAt);
    const endMs = ev.endsAt ? Date.parse(ev.endsAt) : startMs + DEFAULT_EVENT_MINUTES * MIN;
    if (!Number.isFinite(startMs) || endMs <= nowMs || startMs > nowMs + 7 * DAY) continue;
    const soon = startMs < tomorrowStart.getTime() + DAY;
    const when = `${formatDateJa(new Date(startMs), tz)} ${hhmm(startMs, tz)}`;
    out.push({
      subject: `event:${ev.id}`,
      key: `event-location:${ev.id}:${ev.location}`,
      kind: 'room_change',
      severity: soon ? 'warning' : 'info',
      line: `【場所変更】${when} ${ev.title}は${ev.location}です`,
      course: undefined,
      at: ev.startsAt,
      link: undefined,
      citations: ch.citations.slice(0, 2),
      nextEscalationAt: soon ? undefined : new Date(startMs - DAY).toISOString(),
      recommendedAction: `${when}の${ev.title}は${ev.location}へ行く`,
    });
  }
  return out;
}
