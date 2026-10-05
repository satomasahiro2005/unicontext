import {
  ADDITIONS_SOURCE_ID,
  type ClassSession,
  GROUP_CONDITION_PREDICATE,
  SESSION_RULE_PREDICATE,
  SessionRuleValueSchema,
  type SessionRuleValue,
  stableId,
} from '@unicontext/canonical-model';
import {
  type ConflictResolver,
  type FactWithSource,
  toCitation,
  uniqueCitations,
} from '@unicontext/provenance';
import type { ClassSchedule } from '@unicontext/task-engine';
import type {
  Citation,
  ConditionProvenance,
  ConditionValueView,
  EffectiveSchedule,
  RawSchedule,
} from './types.js';

/**
 * The student's effective schedule (§17): the academic system's timetable (raw) with the student's
 * personal conditions applied. A course taught in groups on different dates (実験B: group A on
 * Mondays in C&C, group B on Fridays in 科学実験室) is listed in the timetable on one weekday for
 * everybody; with the student's group (condition:group) and the group schedule (session_rule rows
 * from the distributed table or registered by an AI client), every meeting gets a status:
 *
 * - attending: the student's group meets (rule row for the group, or no condition applies),
 * - not_attending: another group's day, or a 休講 of the group schedule — kept with the reason,
 * - unknown: the date depends on the group and the group is not known (or the sources disagree).
 *
 * Meetings the group schedule adds on days the timetable does not list (the B-group Fridays) are
 * generated, attending (group known) or unknown (group unknown). Nothing is dropped silently.
 *
 * Precedence: a value the student confirmed > the university > a synced document > a chat or a
 * recording (unconfirmed). Lower-ranked values that disagree are reported as conflicts.
 */

export interface PersonalSession {
  session: ClassSession;
  raw: RawSchedule | undefined;
  effective: Omit<EffectiveSchedule, 'date' | 'period' | 'startsAt' | 'endsAt' | 'room'> & {
    room?: string | undefined;
  };
}

interface RuleRow {
  value: SessionRuleValue;
  factId: string;
  provenance: ConditionProvenance;
  rank: number;
  confirmed: boolean;
  source: string;
  evidence: string | undefined;
  citation: Citation | undefined;
}

interface CourseRules {
  rows: RuleRow[];
  /** First and last date of a held row. */
  from: string;
  to: string;
  groups: string[];
}

interface GroupState {
  value: ConditionValueView | undefined;
  conflicts: { value: string; source: string }[];
  citations: Citation[];
}

const RANK: Record<ConditionProvenance, number> = {
  student: 4,
  university: 3,
  document: 2,
  chat: 1,
  recording: 1,
};

export const PROVENANCE_LABELS: Record<ConditionProvenance, string> = {
  student: '本人が確認',
  university: '大学のシステム',
  document: '配布資料',
  chat: 'チャットで登録（未確認）',
  recording: '録音から（未確認）',
};

export function provenanceOf(f: FactWithSource): ConditionProvenance {
  if (f.fact.origin === 'user') return 'student';
  const authority = f.source?.authority;
  if (authority === 'student-statement') return 'chat';
  if (authority === 'transcript') return 'recording';
  if (f.fact.origin === 'authoritative' && authority === 'academic-system') return 'university';
  if (f.source?.sourceId === ADDITIONS_SOURCE_ID) return 'chat';
  return f.fact.origin === 'authoritative' ? 'university' : 'document';
}

function sourceLabel(f: FactWithSource): string {
  return f.source?.sourceLabel ?? f.source?.sourceSystem ?? 'unknown';
}

export interface PersonalScheduleDeps {
  resolver: ConflictResolver;
  schedule: ClassSchedule;
  timezone: string;
  canonical: (id: string) => string;
  expand: (id: string) => string[];
  /** Enrolled canonical offerings (only they get generated meetings). */
  enrolled: () => { id: string; ids: string[] }[];
}

export class PersonalSchedule {
  private rulesCache: Map<string, CourseRules> | undefined;
  private readonly groupCache = new Map<string, GroupState>();

  constructor(private readonly deps: PersonalScheduleDeps) {}

  /** Group schedules of the enrolled courses (canonical id → rules). Computed once per instance. */
  private rules(): Map<string, CourseRules> {
    if (this.rulesCache) return this.rulesCache;
    const out = new Map<string, CourseRules>();
    const facts = this.deps.resolver.facts;
    for (const e of this.deps.enrolled()) {
      const active = facts.active({ subjects: e.ids, predicate: SESSION_RULE_PREDICATE });
      if (active.length === 0) continue;
      const rows: RuleRow[] = [];
      for (const f of facts.withSources(active)) {
        const v = SessionRuleValueSchema.safeParse(f.fact.value);
        if (!v.success) continue;
        const provenance = provenanceOf(f);
        rows.push({
          value: v.data,
          factId: f.fact.id,
          provenance,
          rank: RANK[provenance],
          confirmed: provenance === 'student' || provenance === 'university',
          source: sourceLabel(f),
          evidence: f.fact.evidence,
          citation: f.source ? toCitation(f.source, this.deps.timezone) : undefined,
        });
      }
      const held = rows.filter((r) => r.value.status === 'held');
      if (held.length === 0) continue;
      const dates = held.map((r) => r.value.date).sort();
      out.set(e.id, {
        rows,
        from: dates[0] as string,
        to: dates.at(-1) as string,
        groups: [...new Set(held.map((r) => r.value.group).filter((g): g is string => !!g))].sort(),
      });
    }
    this.rulesCache = out;
    return out;
  }

  /** Courses (canonical ids) that have a group schedule. */
  coursesWithRules(): string[] {
    return [...this.rules().keys()];
  }

  /** The student's group in a course and who says so (conflicts listed, never resolved silently). */
  group(courseId: string): GroupState {
    const id = this.deps.canonical(courseId);
    const cached = this.groupCache.get(id);
    if (cached) return cached;
    const res = this.deps.resolver.resolve(this.deps.expand(id), GROUP_CONDITION_PREDICATE);
    const view = (c: FactWithSource): ConditionValueView => {
      const provenance = provenanceOf(c);
      return {
        value: String(c.fact.value),
        provenance,
        confirmed: provenance === 'student' || provenance === 'university',
        source: sourceLabel(c),
        evidence: c.fact.evidence,
      };
    };
    const citations = uniqueCitations(
      res.candidates.flatMap((c) => (c.source ? [toCitation(c.source, this.deps.timezone)] : [])),
    );
    let state: GroupState;
    if (res.status === 'resolved' && res.winner && typeof res.value === 'string') {
      const winner = res.winner;
      state = {
        value: view(winner),
        conflicts: res.candidates
          .filter((c) => String(c.fact.value) !== res.value)
          .map((c) => ({ value: String(c.fact.value), source: sourceLabel(c) })),
        citations,
      };
      if (state.conflicts.length)
        state.conflicts.unshift({ value: String(res.value), source: sourceLabel(winner) });
    } else if (res.status === 'conflict') {
      state = {
        value: undefined,
        conflicts: res.candidates.map((c) => ({
          value: String(c.fact.value),
          source: sourceLabel(c),
        })),
        citations,
      };
    } else state = { value: undefined, conflicts: [], citations: [] };
    this.groupCache.set(id, state);
    return state;
  }

  /**
   * Meetings of a local date for the student: `raw` sessions of the timetable (stored + generated)
   * with their effective status, plus meetings only the group schedule lists.
   */
  apply(date: string, raw: readonly ClassSession[]): PersonalSession[] {
    const rules = this.rules();
    const out: PersonalSession[] = [];
    const byCourse = new Map<string, ClassSession[]>();
    for (const s of raw) {
      const course = this.deps.canonical(s.courseOfferingId);
      if (s.sessionKind === 'self_study' || !rules.has(course)) {
        out.push({ session: s, raw: rawOf(s), effective: { status: 'attending', citations: [] } });
        continue;
      }
      byCourse.set(course, [...(byCourse.get(course) ?? []), s]);
    }
    for (const [course, r] of rules) {
      const sessions = byCourse.get(course) ?? [];
      out.push(...this.applyCourse(course, r, date, sessions));
    }
    return out;
  }

  private applyCourse(
    course: string,
    rules: CourseRules,
    date: string,
    sessions: ClassSession[],
  ): PersonalSession[] {
    const onDate = rules.rows.filter((r) => r.value.date === date);
    const g = this.group(course);
    const group = g.value?.value;
    const groupBase = {
      ...(g.value ? { group: g.value } : {}),
      ...(g.conflicts.length
        ? { conflicts: [{ about: 'group' as const, values: g.conflicts }] }
        : {}),
    };
    if (onDate.length === 0) {
      // Outside the group schedule's span: the timetable as it is.
      if (date < rules.from || date > rules.to)
        return sessions.map((s) => ({
          session: s,
          raw: rawOf(s),
          effective: { status: 'attending', citations: [] },
        }));
      // Inside it but not listed: not this group's meeting when the group is known and listed.
      const known = group !== undefined && rules.groups.includes(group);
      return sessions.map((s) => ({
        session: s,
        raw: rawOf(s),
        effective: {
          status: known ? 'not_attending' : 'unknown',
          reason: known
            ? `グループ別の実施スケジュールにこの日の${group}グループの回はない`
            : 'グループ別の実施スケジュールにこの日の記載がない（本人のグループによる）',
          ...groupBase,
          citations: g.citations,
        },
      }));
    }
    // The best-ranked source for this date decides; the others are shown when they disagree.
    const top = Math.max(...onDate.map((r) => r.rank));
    const best = dedupeRows(onDate.filter((r) => r.rank === top));
    const lower = onDate.filter((r) => r.rank < top);
    const describe = (r: RuleRow): string =>
      r.value.status === 'no_class'
        ? (r.value.note ?? '休講')
        : `${r.value.group ?? '全員'}${r.value.room ? ` ${r.value.room}` : ''}`;
    const bestText = new Set(best.map(describe));
    const disagree = lower.filter((r) => !bestText.has(describe(r)));
    const ruleConflicts = disagree.length
      ? [
          {
            about: 'session_rule' as const,
            values: [...best, ...disagree].map((r) => ({ value: describe(r), source: r.source })),
          },
        ]
      : [];
    const conflicts = [...(groupBase.conflicts ?? []), ...ruleConflicts];
    const citations = uniqueCitations([
      ...best.flatMap((r) => (r.citation ? [r.citation] : [])),
      ...g.citations,
    ]);
    const ruleView = (r: RuleRow): NonNullable<EffectiveSchedule['rule']> => ({
      provenance: r.provenance,
      confirmed: r.confirmed,
      source: r.source,
      documentTitle: r.value.documentTitle,
      evidence: r.evidence,
    });
    const base = {
      ...(g.value ? { group: g.value } : {}),
      ...(conflicts.length ? { conflicts } : {}),
      citations,
    };

    const noClass = best.find((r) => r.value.status === 'no_class');
    if (noClass)
      return sessions.map((s) => ({
        session: s,
        raw: rawOf(s),
        effective: {
          status: 'not_attending' as const,
          reason: `グループ別の実施スケジュールでは${noClass.value.note ?? '休講'}`,
          rule: ruleView(noClass),
          ...base,
        },
      }));

    const held = best.filter((r) => r.value.status === 'held');
    const heldGroups = [...new Set(held.map((r) => r.value.group).filter((x): x is string => !!x))];
    // A held row without a group is everybody's meeting.
    const mine =
      held.find((r) => r.value.group === undefined) ??
      (group !== undefined ? held.find((r) => r.value.group === group) : undefined);
    const label = heldGroups.join('・');
    const unconfirmed = (r: RuleRow | undefined): string =>
      r && !r.confirmed ? `（${PROVENANCE_LABELS[r.provenance]}）` : '';

    if (group !== undefined && !mine)
      return sessions.map((s) => ({
        session: s,
        raw: rawOf(s),
        effective: {
          status: 'not_attending' as const,
          reason: `${label}グループの実施日（本人は${group}グループ）${unconfirmed(held[0])}`,
          sessionGroups: heldGroups,
          ...(held[0] ? { rule: ruleView(held[0]) } : {}),
          ...base,
        },
      }));

    const row = mine ?? held[0];
    const status = mine ? ('attending' as const) : ('unknown' as const);
    const reason = mine
      ? `${mine.value.group ?? '全グループ'}${mine.value.group ? 'グループ' : ''}の実施日${row?.value.number ? `（第${row.value.number}回）` : ''}${unconfirmed(row)}`
      : `グループによって実施日が違う（この日は${label}グループ）。本人のグループが未登録`;
    const effective = (): PersonalSession['effective'] => ({
      status,
      reason,
      sessionGroups: heldGroups,
      ...(mine?.value.room ? { room: mine.value.room } : {}),
      ...(mine?.value.number ? { number: mine.value.number } : {}),
      ...(mine?.value.topic ? { topic: mine.value.topic } : {}),
      ...(row ? { rule: ruleView(row) } : {}),
      ...base,
    });
    if (sessions.length)
      return sessions.map((s) => ({
        session: mine?.value.room ? { ...s, room: mine.value.room } : s,
        raw: rawOf(s),
        effective: effective(),
      }));
    // The timetable has no meeting this day: the group schedule's own meeting(s).
    const enrolled = this.deps.enrolled().find((e) => e.id === course);
    const periods = row?.value.periods?.length
      ? row.value.periods
      : this.deps.schedule.timetablePeriods(enrolled?.ids ?? [course]);
    const slots: { period?: number; startTime?: string; endTime?: string }[] =
      row?.value.startTime && !row.value.periods?.length
        ? [
            {
              startTime: row.value.startTime,
              ...(row.value.endTime ? { endTime: row.value.endTime } : {}),
            },
          ]
        : periods.length
          ? periods.map((p) => ({ period: p }))
          : [{}];
    return slots.map((slot) => {
      const key = slot.period ? String(slot.period) : (slot.startTime ?? 'day');
      const session: ClassSession = {
        id: stableId('classSession', 'session_rule', course, date, key),
        kind: 'classSession',
        courseOfferingId: course as ClassSession['courseOfferingId'],
        date,
        ...(slot.period ? { period: slot.period } : {}),
        ...this.deps.schedule.slotTimes(date, slot),
        ...(mine?.value.room ? { room: mine.value.room } : {}),
        status: 'scheduled',
        ...(row?.value.number ? { number: row.value.number } : {}),
        ...(row?.value.note ? { note: row.value.note } : {}),
        sessionKind: 'class',
      };
      return { session, raw: undefined, effective: effective() };
    });
  }
}

/** One row per (group, room, status): the same table synced twice (Teams + local copy) is one. */
function dedupeRows(rows: RuleRow[]): RuleRow[] {
  const seen = new Map<string, RuleRow>();
  for (const r of rows) {
    const k = `${r.value.status}|${r.value.group ?? ''}|${r.value.room ?? ''}|${r.value.number ?? ''}`;
    if (!seen.has(k)) seen.set(k, r);
  }
  return [...seen.values()];
}

function rawOf(s: ClassSession): RawSchedule {
  return {
    date: s.date,
    period: s.period,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    room: s.room,
    source:
      s.sessionKind === 'self_study'
        ? '本人が設定した自習時間'
        : '学務情報システムの時間割・お知らせ',
  };
}
