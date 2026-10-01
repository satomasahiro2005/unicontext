import type { Fact } from '@unicontext/canonical-model';
import { NotFoundError, ValidationError } from '@unicontext/core';
import { PACE_PREDICATE, parsePaceSlots, type PaceSlot } from '@unicontext/task-engine';
import type { UniContext } from './runtime.js';
import type { CourseRef } from './types.js';

export {
  formatPaceSlot,
  PACE_PREDICATE,
  PACE_SLOT_EXAMPLE,
  parsePaceSlot,
  parsePaceSlots,
  type PaceSlot,
} from '@unicontext/task-engine';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Validate a slot given as an object (REST / JSON input). */
function checkSlot(raw: unknown): PaceSlot {
  if (!raw || typeof raw !== 'object')
    throw new ValidationError('自習時間の形式が正しくありません');
  const s = raw as Record<string, unknown>;
  const day = s.dayOfWeek;
  if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6)
    throw new ValidationError('自習時間のdayOfWeekは0（日）〜6（土）で指定してください');
  const out: PaceSlot = { dayOfWeek: day };
  for (const key of ['startTime', 'endTime'] as const) {
    const v = s[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !HHMM.test(v))
      throw new ValidationError(`自習時間の${key}は HH:MM で指定してください`);
    out[key] = v;
  }
  if (s.period !== undefined) {
    if (typeof s.period !== 'number' || !Number.isInteger(s.period) || s.period < 1)
      throw new ValidationError('自習時間のperiodは1以上の整数で指定してください');
    out.period = s.period;
  }
  if (!out.period && !(out.startTime && out.endTime))
    throw new ValidationError('自習時間には時刻（開始と終了）か時限が必要です');
  if (out.startTime && out.endTime && out.endTime <= out.startTime)
    throw new ValidationError('自習時間は終了が開始より後になるようにしてください');
  return out;
}

/** Text ("土 10:00-11:30", "土2限") and/or slot objects → validated slots. */
export function normalizePaceSlots(
  input: readonly (string | PaceSlot)[],
  profile: UniContext['profile'],
): PaceSlot[] {
  const texts = input.filter((x): x is string => typeof x === 'string');
  const objects = input.filter((x): x is PaceSlot => typeof x !== 'string').map(checkSlot);
  const parsed = parsePaceSlots(texts, profile);
  const seen = new Set<string>();
  return [...parsed, ...objects]
    .filter((s) => {
      const key = JSON.stringify([
        s.dayOfWeek,
        s.period ?? null,
        s.startTime ?? null,
        s.endTime ?? null,
      ]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (a, b) => a.dayOfWeek - b.dayOfWeek || (a.startTime ?? '').localeCompare(b.startTime ?? ''),
    );
}

/**
 * Store the student's weekly self-study slots of an offering (user-origin fact `pace_slots`; an
 * empty list clears them) and refresh the derived weekly tasks. The user's own surfaces (CLI, Web
 * UI) call this; AI clients can only propose the same value (§50).
 */
export function setPaceSlots(
  uc: Pick<UniContext, 'profile' | 'resolver' | 'identity' | 'sync' | 'tasks'>,
  course: Pick<CourseRef, 'id'>,
  input: readonly (string | PaceSlot)[],
  options: { note?: string } = {},
): { slots: PaceSlot[]; fact: Fact } {
  if (!uc.sync.stores.entities.getOfKind('courseOffering', course.id))
    throw new NotFoundError(`course offering ${course.id}`);
  const slots = normalizePaceSlots(input, uc.profile);
  const { fact } = uc.resolver.correct({
    subject: course.id,
    predicate: PACE_PREDICATE,
    value: { slots: slots.map((s) => ({ ...s })) },
    ...(options.note ? { note: options.note } : {}),
  });
  uc.identity.invalidate();
  uc.tasks.derive();
  return { slots, fact };
}
