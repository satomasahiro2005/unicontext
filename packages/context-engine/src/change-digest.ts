import type { ChangeEvent, JsonValue } from '@unicontext/canonical-model';

/*
 * Compact change lists for the views (§13, §45). The raw change log holds every field-level event
 * of every sync — thousands after a first sync, with full before/after bodies — which no AI client
 * can use. The views show what matters: one item per entity, the relevant ones first, a capped
 * number of them, values cut short; get_recent_changes (since / course / limit) gives more.
 */

/** How many change items each view returns at most. */
export const CHANGE_LIMITS = {
  /** get_today / get_tomorrow (changes since yesterday) */
  day: 30,
  /** get_week (last 7 days) */
  week: 25,
  /** get_course (last 14 days of one course) */
  course: 20,
  /** get_recent_changes default and maximum */
  changes: 50,
  changesMax: 200,
} as const;

/** Index-level kinds that are never news on their own (their document / transcript is). */
const HIDDEN_KINDS = new Set<string>(['documentChunk', 'lectureSegment', 'lectureTranscript']);

/** Longest string kept in a before/after value or a summary. */
const VALUE_CHARS = 80;
const SUMMARY_CHARS = 200;

/** Fields whose change alone is bookkeeping, not news. */
const BOOKKEEPING_FIELDS = new Set<string>(['extra', 'read', 'bodyStatus', 'authorName', 'url']);
/** Text fields that a connector fills in later (a notice's body fetched after its title). */
const FILLED_LATER_FIELDS = new Set<string>(['body', 'text', 'description']);

function isEmpty(v: JsonValue | undefined): boolean {
  return v === undefined || v === null || v === '';
}

/** An update that only records bookkeeping or fills in a text that was not fetched before. */
export function isBookkeepingUpdate(c: ChangeEvent): boolean {
  if (c.type !== 'updated' || c.changedFields.length === 0) return false;
  return c.changedFields.every(
    (f) => BOOKKEEPING_FIELDS.has(f) || (FILLED_LATER_FIELDS.has(f) && isEmpty(c.before?.[f])),
  );
}

export function isHiddenChange(c: ChangeEvent): boolean {
  if (HIDDEN_KINDS.has(c.entityKind)) return true;
  if (isBookkeepingUpdate(c)) return true;
  // A course appearing in the catalogue / timetable is not news; its enrolment is.
  return c.type === 'created' && (c.entityKind === 'course' || c.entityKind === 'courseOffering');
}

function cut(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function isShort(v: JsonValue | undefined): boolean {
  if (v === undefined || v === null || typeof v === 'number' || typeof v === 'boolean') return true;
  return typeof v === 'string' && v.length <= VALUE_CHARS;
}

/**
 * before/after of an update, reduced to the changed fields whose values are short scalars (締切,
 * 教室, 状態 …); bodies and objects are left to the summary. created/deleted/conflict events carry
 * no values (their summary says what happened).
 */
export function compactChangeValues(c: ChangeEvent): {
  before: Record<string, JsonValue> | null;
  after: Record<string, JsonValue> | null;
} {
  const none = { before: null, after: null };
  if (c.type !== 'updated') return none;
  const fields = c.changedFields.filter((f) => isShort(c.before?.[f]) && isShort(c.after?.[f]));
  if (fields.length === 0) return none;
  const pick = (o: Record<string, JsonValue> | null): Record<string, JsonValue> | null => {
    if (!o) return null;
    const out: Record<string, JsonValue> = {};
    for (const f of fields) if (f in o) out[f] = o[f] ?? null;
    return out;
  };
  return { before: pick(c.before), after: pick(c.after) };
}

export function compactSummary(s: string): string {
  return cut(s, SUMMARY_CHARS);
}

export interface CollapsedChange {
  event: ChangeEvent;
  /** Events about the same entity folded into this item. */
  count: number;
  /** Newest observedAt of the group. */
  latestAt: string;
}

/**
 * One item per entity (conflict events apart): the creation when the entity is new in the window
 * (and not deleted since), otherwise the newest event. Input and output newest first.
 */
export function collapseByEntity(newestFirst: readonly ChangeEvent[]): CollapsedChange[] {
  const groups = new Map<string, ChangeEvent[]>();
  for (const c of newestFirst) {
    const key = c.type.startsWith('conflict') ? `${c.entityId}#${c.type}` : c.entityId;
    const g = groups.get(key);
    if (g) g.push(c);
    else groups.set(key, [c]);
  }
  const out: CollapsedChange[] = [];
  for (const g of groups.values()) {
    const newest = g[0] as ChangeEvent;
    const created = newest.type === 'deleted' ? undefined : g.find((c) => c.type === 'created');
    out.push({ event: created ?? newest, count: g.length, latestAt: newest.observedAt });
  }
  return out;
}

/**
 * Pick at most `limit` items: lower `rank` first, newest first within a rank. The result is in
 * newest-first order again.
 */
export function pickChanges(
  items: readonly CollapsedChange[],
  rank: (c: ChangeEvent) => number,
  limit: number,
): CollapsedChange[] {
  const ranked = items
    .map((c, i) => ({ c, i, r: rank(c.event) }))
    .sort((a, b) => a.r - b.r || b.c.latestAt.localeCompare(a.c.latestAt) || a.i - b.i)
    .slice(0, Math.max(0, limit));
  return ranked
    .sort((a, b) => b.c.latestAt.localeCompare(a.c.latestAt) || a.i - b.i)
    .map((x) => x.c);
}

/** 0 = decisive for the schedule, 3 = background. */
export function changeRank(c: ChangeEvent, important: boolean): number {
  if (c.type === 'conflict_detected') return 0;
  switch (c.entityKind) {
    case 'classSession':
    case 'assignment':
    case 'exam':
    case 'submission':
      return 0;
    case 'announcement':
      if (important) return 0;
      return c.type === 'created' ? 1 : 2;
    case 'material':
    case 'document':
    case 'message':
    case 'grade':
    case 'lecture':
      return 1;
    case 'calendarEvent':
    case 'enrollment':
    case 'courseOffering':
      return 2;
    default:
      return 3;
  }
}
