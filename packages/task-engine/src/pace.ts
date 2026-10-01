import type { Task } from '@unicontext/canonical-model';
import {
  addLocalDays,
  findPeriod,
  startOfZonedWeek,
  ValidationError,
  type UniversityProfile,
  zonedDateString,
} from '@unicontext/core';
import type { PaceSlot } from './class-schedule.js';

/*
 * Pacing for offerings without a weekly class time (時間割外 / 集中講義): the student's own weekly
 * self-study slots (pace_slots, input as text) and how far behind the weekly "今週分" tasks are.
 */

const DAY_CHARS = '日月火水木金土';

/** Example slot text for help and hints. */
export const PACE_SLOT_EXAMPLE = '土 10:00-11:30';

/** "土" for 6 … "日" for 0. */
export function dayChar(dayOfWeek: number): string {
  return DAY_CHARS[dayOfWeek] ?? '?';
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function usage(text: string): ValidationError {
  return new ValidationError(`自習時間「${text}」を読み取れません（例: 土 10:00-11:30 / 土2限）`);
}

const DASH = '[-~〜～ー–—−]';
const SLOT_TIME = new RegExp(`^(\\d{1,2}):(\\d{2})\\s*${DASH}\\s*(\\d{1,2}):(\\d{2})$`);
const SLOT_PERIOD = /^(\d{1,2})\s*限$/;

/**
 * Parse one weekly self-study slot: "土 10:00-11:30", "土曜 10:00〜11:30", "土2限", "土曜2限".
 * Full-width digits, colons and tildes are accepted. A period takes its times from the profile.
 */
export function parsePaceSlot(text: string, profile?: UniversityProfile | undefined): PaceSlot {
  const norm = text.normalize('NFKC').trim();
  const m = /^([日月火水木金土])(?:曜日?)?\s*(.+)$/.exec(norm);
  if (!m) throw usage(text);
  const dayOfWeek = DAY_CHARS.indexOf(m[1] as string);
  const rest = (m[2] as string).trim();

  const period = SLOT_PERIOD.exec(rest);
  if (period) {
    const n = Number(period[1]);
    const def = n > 0 && profile ? findPeriod(profile, n) : undefined;
    if (!def)
      throw new ValidationError(
        `${n}限の時刻が分かりません。「${dayChar(dayOfWeek)} 10:00-11:30」のように時刻で指定してください`,
      );
    return { dayOfWeek, period: n, startTime: def.start, endTime: def.end };
  }

  const t = SLOT_TIME.exec(rest);
  if (!t) throw usage(text);
  const [sh, sm, eh, em] = [t[1], t[2], t[3], t[4]].map(Number) as [number, number, number, number];
  if (sh > 23 || eh > 23 || sm > 59 || em > 59)
    throw new ValidationError(`自習時間「${text}」の時刻が正しくありません`);
  if (eh * 60 + em <= sh * 60 + sm)
    throw new ValidationError(`自習時間「${text}」は終了が開始より後になるようにしてください`);
  return {
    dayOfWeek,
    startTime: `${pad2(sh)}:${pad2(sm)}`,
    endTime: `${pad2(eh)}:${pad2(em)}`,
  };
}

/** Parse several slots; duplicates are dropped and the result is sorted by weekday and time. */
export function parsePaceSlots(
  texts: readonly string[],
  profile?: UniversityProfile | undefined,
): PaceSlot[] {
  const seen = new Set<string>();
  const out: PaceSlot[] = [];
  for (const text of texts) {
    const slot = parsePaceSlot(text, profile);
    const key = formatPaceSlot(slot);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(slot);
  }
  return out.sort(
    (a, b) => a.dayOfWeek - b.dayOfWeek || (a.startTime ?? '').localeCompare(b.startTime ?? ''),
  );
}

/** "土 10:00-11:30" or "土2限". */
export function formatPaceSlot(slot: PaceSlot): string {
  const day = dayChar(slot.dayOfWeek);
  if (slot.period) return `${day}${slot.period}限`;
  if (slot.startTime && slot.endTime) return `${day} ${slot.startTime}-${slot.endTime}`;
  if (slot.startTime) return `${day} ${slot.startTime}-`;
  return `${day}曜`;
}

// ---- weekly tasks -----------------------------------------------------------------------------

/** Local Monday ('YYYY-MM-DD') of the week containing `date`. */
export function weekStartOf(date: Date, timezone: string): string {
  return zonedDateString(startOfZonedWeek(date, timezone), timezone);
}

/** Monday of the week a weekly task belongs to (its dueAt is Sunday 23:59 local). */
export function weekStartOfDue(dueAt: string, timezone: string): string {
  return addLocalDays(zonedDateString(new Date(dueAt), timezone), -6);
}

export interface PaceStatus {
  /** Consecutive past weeks (ending before the current week) whose weekly task is not done. */
  behindWeeks: number;
  /** The course's assignments that are past due and still open. */
  unsubmitted: number;
  /** Monday of the latest week whose weekly task the student completed. */
  lastCompletedWeek?: string;
}

const DONE: ReadonlySet<string> = new Set(['completed', 'submitted', 'cancelled']);
const OPEN: ReadonlySet<string> = new Set(['pending', 'in_progress', 'unknown']);

/**
 * How far behind the student is in an offering. `tasks` are the offering's tasks (weekly_pace and
 * assignment ones; others are ignored). Pure: the clock and time zone are arguments.
 */
export function paceStatus(
  tasks: readonly Pick<Task, 'taskKind' | 'status' | 'dueAt'>[],
  now: Date,
  timezone: string,
): PaceStatus {
  const current = weekStartOf(now, timezone);
  const weekly = new Map<string, Pick<Task, 'status'>>();
  for (const t of tasks)
    if (t.taskKind === 'weekly_pace' && t.dueAt) weekly.set(weekStartOfDue(t.dueAt, timezone), t);
  let behindWeeks = 0;
  for (let w = addLocalDays(current, -7); ; w = addLocalDays(w, -7)) {
    const t = weekly.get(w);
    if (!t || DONE.has(t.status)) break;
    behindWeeks++;
  }
  const nowMs = now.getTime();
  const unsubmitted = tasks.filter(
    (t) =>
      t.taskKind === 'assignment' &&
      t.dueAt !== undefined &&
      Date.parse(t.dueAt) < nowMs &&
      OPEN.has(t.status),
  ).length;
  let lastCompletedWeek: string | undefined;
  for (const [w, t] of weekly)
    if (t.status === 'completed' && w <= current && (!lastCompletedWeek || w > lastCompletedWeek))
      lastCompletedWeek = w;
  return { behindWeeks, unsubmitted, ...(lastCompletedWeek ? { lastCompletedWeek } : {}) };
}
