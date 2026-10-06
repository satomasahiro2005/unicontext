/**
 * Freshness: how old the information behind an answer is, judged against what the answer is used
 * for. Health (coverage.ts: is the source working?) and freshness (is what it last read recent
 * enough for this use?) are different questions: a source can be healthy and still be 90 minutes
 * behind for a "is the 2nd period cancelled?" question. Each use has a budget; a view carries
 * how its sources stand against the budgets, and the AI refreshes with refresh_sources when they
 * are exceeded (the student never has to check or ask).
 */

/** What a piece of information is used for (the budgets below are per use). */
export type FreshnessUse =
  | 'schedule'
  | 'deadlines'
  | 'assignments'
  | 'messages'
  | 'announcements'
  | 'materials'
  | 'calendar'
  | 'grades'
  | 'attendance';

export const FRESHNESS_USES: readonly FreshnessUse[] = [
  'schedule',
  'deadlines',
  'assignments',
  'messages',
  'announcements',
  'materials',
  'calendar',
  'grades',
  'attendance',
];

/**
 * Budgets in minutes. schedule = cancellations and rooms (the learning-management system, its
 * public cancellation notices, Teams); deadlines/assignments = the LMS, Ed, Teams assignments.
 */
export const FRESHNESS_BUDGET_MINUTES: Record<FreshnessUse, number> = {
  schedule: 45,
  deadlines: 90,
  assignments: 90,
  messages: 120,
  announcements: 120,
  materials: 24 * 60,
  calendar: 60,
  grades: 24 * 60,
  attendance: 24 * 60,
};

/**
 * fresh: within the budget. aging: over it, less than twice over. stale: twice the budget or
 * more. unknown: nothing was ever read.
 */
export type FreshnessLevel = 'fresh' | 'aging' | 'stale' | 'unknown';

export function ageMinutesOf(lastSuccessAt: string | undefined, now: Date): number | undefined {
  if (!lastSuccessAt) return undefined;
  const t = Date.parse(lastSuccessAt);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.round((now.getTime() - t) / 60_000));
}

export function freshnessLevel(
  ageMinutes: number | undefined,
  budgetMinutes: number,
): FreshnessLevel {
  if (ageMinutes === undefined) return 'unknown';
  if (ageMinutes <= budgetMinutes) return 'fresh';
  return ageMinutes < 2 * budgetMinutes ? 'aging' : 'stale';
}

const LEVEL_RANK: Record<FreshnessLevel, number> = { fresh: 0, unknown: 1, aging: 2, stale: 3 };

/** The worse of the levels (stale > aging > unknown > fresh). */
export function worstLevel(levels: readonly FreshnessLevel[]): FreshnessLevel {
  let worst: FreshnessLevel = 'fresh';
  for (const l of levels) if (LEVEL_RANK[l] > LEVEL_RANK[worst]) worst = l;
  return worst;
}

/** What decides which uses a source serves (connector metadata). */
export interface UseSource {
  /** Undefined: the connector is not loaded, so what it serves is unknown (it serves nothing). */
  capabilities: readonly string[] | undefined;
  authority: string | undefined;
  referenceOnly: boolean;
}

/**
 * Whether a source feeds a use. schedule: timetable/room sources (the academic system, its public
 * cancellation notices) and the collaboration platform's posts (Teams: a teacher posts a room
 * change). Attendance is read by the academic system (the source that also holds the student's enrollments, not its public notices). Reference-only sources (the syllabus
 * catalog) feed no use: they are not live information.
 */
export function sourceServesUse(s: UseSource, use: FreshnessUse): boolean {
  if (s.referenceOnly || !s.capabilities) return false;
  const caps = new Set(s.capabilities);
  switch (use) {
    case 'schedule':
      return (
        caps.has('timetable') ||
        caps.has('rooms') ||
        (s.authority === 'collaboration' && caps.has('messages'))
      );
    case 'deadlines':
      return caps.has('assignments') || caps.has('exams');
    case 'assignments':
      return caps.has('assignments');
    case 'messages':
      return caps.has('messages');
    case 'announcements':
      return caps.has('announcements');
    case 'materials':
      return caps.has('materials');
    case 'calendar':
      return caps.has('calendar');
    case 'grades':
      return caps.has('grades');
    case 'attendance':
      return s.authority === 'academic-system' && caps.has('enrollments');
  }
}

export interface FreshnessSource {
  sourceId: string;
  label: string;
  /** Minutes since the last successful read; undefined: never read. */
  ageMinutes: number | undefined;
}

export interface StaleSource {
  sourceId: string;
  label: string;
  /** Undefined: never read successfully. */
  ageMinutes: number | undefined;
  budgetMinutes: number;
}

export interface FreshnessEvaluation {
  /** Every source is within the budget of the use. */
  fresh: boolean;
  /** Age of the oldest source (undefined without sources or when none was ever read). */
  oldestAgeMinutes: number | undefined;
  /** The sources over the budget (or never read), oldest first. */
  staleSources: StaleSource[];
}

/** Judge the sources that feed one use against its budget. */
export function evaluateFreshness(
  sources: readonly FreshnessSource[],
  use: FreshnessUse,
): FreshnessEvaluation {
  const budgetMinutes = FRESHNESS_BUDGET_MINUTES[use];
  const staleSources: StaleSource[] = sources
    .filter((s) => s.ageMinutes === undefined || s.ageMinutes > budgetMinutes)
    .map((s) => ({
      sourceId: s.sourceId,
      label: s.label,
      ageMinutes: s.ageMinutes,
      budgetMinutes,
    }))
    .sort(
      (a, b) =>
        (b.ageMinutes ?? Number.POSITIVE_INFINITY) - (a.ageMinutes ?? Number.POSITIVE_INFINITY),
    );
  const ages = sources.map((s) => s.ageMinutes).filter((a): a is number => a !== undefined);
  return {
    fresh: staleSources.length === 0,
    oldestAgeMinutes: ages.length ? Math.max(...ages) : undefined,
    staleSources,
  };
}

/** One use of a view: the evaluation plus its budget and an overall level. */
export interface UseFreshness extends FreshnessEvaluation {
  budgetMinutes: number;
  /** The worst level among the sources ('unknown' when no source feeds the use). */
  freshness: FreshnessLevel;
  /** How many sources feed the use. */
  sourceCount: number;
}

export interface ViewFreshness {
  /** When the freshness was judged (the view's time). */
  asOf: string;
  perUse: {
    deadlines: UseFreshness;
    schedule: UseFreshness;
    announcements: UseFreshness;
  };
}

/** A source as the freshness needs it (the coverage input minus what it does not use). */
export interface FreshnessInput extends UseSource {
  sourceId: string;
  label: string;
  lastSuccessAt: string | undefined;
}

export function useFreshness(
  sources: readonly FreshnessInput[],
  use: FreshnessUse,
  now: Date,
): UseFreshness {
  const budgetMinutes = FRESHNESS_BUDGET_MINUTES[use];
  const serving = sources
    .filter((s) => sourceServesUse(s, use))
    .map((s) => ({
      sourceId: s.sourceId,
      label: s.label,
      ageMinutes: ageMinutesOf(s.lastSuccessAt, now),
    }));
  const evaluation = evaluateFreshness(serving, use);
  return {
    ...evaluation,
    budgetMinutes,
    freshness:
      serving.length === 0
        ? 'unknown'
        : worstLevel(serving.map((s) => freshnessLevel(s.ageMinutes, budgetMinutes))),
    sourceCount: serving.length,
  };
}

export function buildViewFreshness(sources: readonly FreshnessInput[], now: Date): ViewFreshness {
  return {
    asOf: now.toISOString(),
    perUse: {
      deadlines: useFreshness(sources, 'deadlines', now),
      schedule: useFreshness(sources, 'schedule', now),
      announcements: useFreshness(sources, 'announcements', now),
    },
  };
}

/** Which uses a view's answers depend on. */
const VIEW_USES: Record<string, readonly ('deadlines' | 'schedule' | 'announcements')[]> = {
  today: ['schedule', 'deadlines'],
  tomorrow: ['schedule', 'deadlines'],
  week: ['schedule', 'deadlines'],
  deadline: ['deadlines'],
  course: ['schedule', 'deadlines', 'announcements'],
  'teams-activity': ['announcements'],
  'class-preparation': ['schedule'],
  'exam-preparation': ['deadlines', 'announcements'],
};

/**
 * One sentence for the answer hint when a view's information is older than its use allows
 * (undefined when every use of the view is fresh). The AI refreshes with refresh_sources before
 * relying on it; it does not ask the student to check.
 */
export function freshnessHint(data: unknown): string | undefined {
  const d = data as { view?: string; freshness?: ViewFreshness } | undefined;
  const perUse = d?.freshness?.perUse;
  if (!perUse || !d?.view) return undefined;
  const stale = new Map<string, StaleSource>();
  for (const use of VIEW_USES[d.view] ?? []) {
    for (const s of perUse[use]?.staleSources ?? [])
      if (s.ageMinutes !== undefined) {
        const prev = stale.get(s.sourceId);
        if (!prev || (prev.ageMinutes ?? 0) < s.ageMinutes) stale.set(s.sourceId, s);
      }
  }
  if (stale.size === 0) return undefined;
  const list = [...stale.values()].sort((a, b) => (b.ageMinutes ?? 0) - (a.ageMinutes ?? 0));
  return `${list
    .slice(0, 3)
    .map((s) => `${s.label} は ${s.ageMinutes}分前の情報です`)
    .join('。')}。refresh_sources で更新できます。`;
}

/** A source with its age against the budget of what it serves (refresh_sources). */
export interface SourceFreshness {
  sourceId: string;
  label: string;
  health: 'ok' | 'auth_required' | 'stale' | 'failing' | 'never_synced';
  lastSuccessAt?: string | undefined;
  ageMinutes?: number | undefined;
  intervalMinutes?: number | undefined;
  freshness: FreshnessLevel;
  /** Connector health state ("healthy", "auth_required", ...), when known. */
  state: string | undefined;
  /** The uses it serves among those asked for. */
  uses: FreshnessUse[];
  /** Tightest budget among `uses`. */
  budgetMinutes: number;
}
