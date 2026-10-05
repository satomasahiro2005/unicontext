import {
  ADDITIONS_SOURCE_ID,
  type Announcement,
  type Assignment,
  type CanonicalEntity,
  type ChangeEvent,
  type ClassSession,
  type Conflict,
  type CourseOffering,
  type Enrollment,
  entityLabel,
  type Document,
  type Exam,
  type Importance,
  type JsonValue,
  type Lecture,
  type Material,
  type Message,
  type Submission,
  type Task,
  type Thread,
} from '@unicontext/canonical-model';
import {
  addLocalDays,
  addZonedDays,
  type Clock,
  DEFAULT_TIMEZONE,
  formatDateJa,
  formatShortJa,
  NotFoundError,
  ValidationError,
  parseZonedDate,
  startOfZonedDay,
  startOfZonedWeek,
  systemClock,
  termPartLabel,
  type UniversityProfile,
  zonedDateString,
  zonedParts,
} from '@unicontext/core';
import {
  ChangeEventStore,
  EntityStore,
  RawStore,
  ReadMarkStore,
  SourceReferenceStore,
  createStores,
  type UniContextDatabase,
} from '@unicontext/database';
import type { IdentityResolver } from '@unicontext/identity';
import {
  buildDeadlineCoverage,
  type CoverageCourse,
  type CoverageSourceInput,
  type CoverageUndated,
  type DeadlineCoverage,
} from './coverage.js';
import {
  type ConflictResolver,
  type Resolution,
  toCitation,
  uniqueCitations,
} from '@unicontext/provenance';
import type { SearchService } from '@unicontext/search';
import { PersonalSchedule, type PersonalSession } from './personal-schedule.js';
import {
  type EnrolledOffering,
  formatPaceSlot,
  type OfferingTermParts,
  slotHalves,
  PACE_PREDICATE,
  type PaceSlot,
  type TaskEngine,
  weekStartOf,
  weekStartOfDue,
} from '@unicontext/task-engine';
import { additionViaOfAuthority } from './additions.js';
import { readAnnouncementExtra } from './announcements.js';
import {
  computeNextActions,
  type NextActionHost,
  type NextActionOptions,
  type NextActionsContext,
  summarizeNextActions,
} from './next-action.js';
import {
  CHANGE_LIMITS,
  changeRank,
  collapseByEntity,
  compactChangeValues,
  compactSummary,
  isHiddenChange,
  pickChanges,
} from './change-digest.js';
import {
  compareFiles,
  extraString,
  folderOfFile,
  normalizeFolderPath,
  readAttachments,
} from './discussion.js';
import type {
  AdminContext,
  AnnouncementDetail,
  AnnouncementItem,
  ChangeItem,
  ChangesContext,
  Citation,
  ClassItem,
  ClassPreparationContext,
  ClassReviewContext,
  ConflictItem,
  CourseEnrollmentView,
  EnrollmentNote,
  CourseAssignmentItem,
  CourseContext,
  CourseFileItem,
  CourseFilesContext,
  CourseFolderItem,
  CourseRef,
  DayContext,
  DeadlineContext,
  DeadlineItem,
  DiscussionItem,
  RecordedMarker,
  ExamPreparationContext,
  FactItem,
  LectureBundle,
  LectureNoteItem,
  MaterialItem,
  PaceCourseItem,
  PaceItem,
  PaceOverview,
  PaceSlotView,
  PreparationItem,
  QuestionItem,
  ResolvedValue,
  SegmentItem,
  SourceStatus,
  TaskItem,
  TeamsActivityContext,
  TermOfDate,
  TodayContext,
  TomorrowContext,
  WeekContext,
} from './types.js';

export interface ContextEngineOptions {
  db: UniContextDatabase;
  resolver: ConflictResolver;
  identity: IdentityResolver;
  tasks: TaskEngine;
  search?: SearchService;
  clock?: Clock;
  timezone?: string;
  profile?: UniversityProfile;
  /**
   * True for sources that only describe offerings (a public syllabus catalog). Their offerings stay
   * out of the today / week / changes views unless the student is enrolled in them.
   */
  isReferenceSource?: (sourceId: string) => boolean;
  /**
   * Every known source with its capabilities and health, for the deadline coverage of the views
   * (coverage.ts). Without it, only unhealthy sources from the health store are reported.
   */
  coverageSources?: () => CoverageSourceInput[];
}

/** Whether the student is enrolled in a course offering (§14: any linked offering counts). */
export interface EnrollmentScope {
  enrolled: boolean;
  /** Source of each matching active enrollment (undefined = entered by the user). */
  sourceIds: (string | undefined)[];
  /** Academic term of the offering when the profile's calendar knows it. */
  term: { id: string; name: string; start: string; end: string } | undefined;
}

const OPEN_STATUSES: Task['status'][] = ['pending', 'in_progress', 'unknown'];
const DAY = 86_400_000;
const COURSE_FILES_LIMIT = 200;
/** Newest materials listed per class preparation (the rest: get_course / list_course_files). */
const PREPARATION_MATERIALS = 8;
/** Newest course notices listed per class preparation. */
const PREPARATION_ANNOUNCEMENTS = 5;

function hms(ms: number): string {
  const s = Math.floor(ms / 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Builds purpose-specific context bundles (§17, §18) so AI agents never query the DB directly.
 * Every item carries citations (§49) and conflicts are passed through as conflicts (§12).
 */
export class ContextEngine {
  readonly timezone: string;
  private readonly db: UniContextDatabase;
  private readonly clock: Clock;
  private readonly entities: EntityStore;
  private readonly refs: SourceReferenceStore;
  private readonly changes: ChangeEventStore;
  private readonly readMarks: ReadMarkStore;
  private readonly resolver: ConflictResolver;
  private readonly identity: IdentityResolver;
  private readonly tasks: TaskEngine;
  private readonly search: SearchService | undefined;
  private readonly isReferenceSource: (sourceId: string) => boolean;
  private readonly coverageSources: () => CoverageSourceInput[];

  constructor(options: ContextEngineOptions) {
    this.isReferenceSource = options.isReferenceSource ?? (() => false);
    this.coverageSources = options.coverageSources ?? (() => this.storedSourceStates());
    this.db = options.db;
    this.clock = options.clock ?? systemClock;
    this.timezone =
      options.timezone ?? options.profile?.academicCalendar.timezone ?? DEFAULT_TIMEZONE;
    this.entities = new EntityStore(this.db, { clock: this.clock });
    this.refs = new SourceReferenceStore(this.db);
    this.changes = new ChangeEventStore(this.db);
    this.readMarks = new ReadMarkStore(this.db);
    this.resolver = options.resolver;
    this.identity = options.identity;
    this.tasks = options.tasks;
    this.search = options.search;
  }

  // ---------- building blocks ----------

  private now(): Date {
    return this.clock.now();
  }

  private base<V extends string>(view: V): { view: V; generatedAt: string; timezone: string } {
    return { view, generatedAt: this.now().toISOString(), timezone: this.timezone };
  }

  citationsFor(entityIds: readonly string[]): Citation[] {
    const out: Citation[] = [];
    for (const list of this.refs.forEntities(entityIds).values())
      out.push(...list.map((r) => toCitation(r, this.timezone)));
    return uniqueCitations(out);
  }

  courseRef(id: string | undefined): CourseRef | undefined {
    if (!id) return undefined;
    const linked = this.identity.expand(id);
    const canonical = linked[0] ?? id;
    const offering =
      this.entities.getOfKind('courseOffering', canonical) ??
      linked.map((l) => this.entities.getOfKind('courseOffering', l)).find(Boolean);
    return {
      id: canonical,
      title: offering?.title ?? canonical,
      courseCode: offering?.courseCode,
      linkedIds: linked,
    };
  }

  private requireCourse(id: string): CourseRef & { offering: CourseOffering } {
    const ref = this.courseRef(id);
    const offering = ref ? this.entities.getOfKind('courseOffering', ref.id) : undefined;
    if (!ref || !offering) throw new NotFoundError(`course offering ${id}`);
    return { ...ref, offering };
  }

  /**
   * The student's enrollments as the views use them: active ones of the academic system, minus
   * courses the student says they do not take, plus dropped ones the student says they take
   * (condition:enrollment, task-engine enrollment-declaration.ts).
   */
  private selfEnrollments(): Enrollment[] {
    const self = new Set(
      this.entities
        .list('person')
        .filter((p) => p.isSelf)
        .map((p) => p.id),
    );
    const schedule = this.tasks.schedule;
    const overrides = schedule.enrollmentOverrides();
    const notTaken = new Set(
      overrides.filter((o) => o.declaration.value === 'not_taking').flatMap((o) => o.offering.ids),
    );
    const takenAgain = new Set(
      overrides.filter((o) => o.declaration.value === 'taking').flatMap((o) => o.offering.ids),
    );
    return this.entities
      .list('enrollment')
      .filter(
        (e) =>
          e.role === 'student' &&
          (self.size === 0 || self.has(e.personId)) &&
          (e.status === 'active'
            ? !notTaken.has(e.courseOfferingId)
            : e.status === 'dropped' && takenAgain.has(e.courseOfferingId)),
      );
  }

  /** The academic enrollment and the student's declaration of one course (course view). */
  private enrollmentView(courseOfferingId: string): CourseEnrollmentView {
    const st = this.tasks.schedule.enrollmentStatusOf(courseOfferingId);
    const d = st.declaration;
    return {
      academic: st.academic,
      ...(d
        ? {
            declaration: {
              value: d.value,
              confirmed: d.confirmed,
              provenance: d.provenance,
              evidence: d.evidence,
              source: d.source,
              declaredAt: d.observedAt,
            },
          }
        : {}),
      taken: st.taken,
    };
  }

  /** Every linked id of the courses the student says they do not take (the system lists them). */
  private declaredNotTakenIds(): Set<string> {
    return this.tasks.schedule.declaredNotTaken();
  }

  /**
   * One line per course where the student's unconfirmed declaration and the academic system
   * disagree about taking it (「学務では履修中、本人は履修していないと登録」). The views follow the
   * student either way; a confirmed declaration needs no note (it is shown in the course view).
   */
  enrollmentNotes(): EnrollmentNote[] {
    return this.tasks.schedule
      .enrollmentOverrides()
      .filter((o) => !o.declaration.confirmed)
      .map((o) => {
        const ref = this.courseRef(o.offering.offering.id);
        const title = ref?.title ?? o.offering.offering.title;
        const d = o.declaration;
        const label = d.provenance === 'recording' ? '録音から・未確認' : 'チャットで登録・未確認';
        const what =
          d.value === 'not_taking'
            ? '学務では履修中、本人は履修していないと登録'
            : '学務では履修していない、本人は履修中と登録';
        const shown =
          d.value === 'not_taking' ? '表示から外しています' : '本人の授業として表示しています';
        const source = this.refs.get(d.sourceReferenceId);
        return {
          course: ref ?? {
            id: o.offering.offering.id,
            title,
            courseCode: o.offering.offering.courseCode,
            linkedIds: o.offering.ids,
          },
          academic: o.academic,
          declared: d.value,
          confirmed: false,
          ...(d.evidence ? { evidence: d.evidence } : {}),
          note: `${title}: ${what}（${label}）。${shown}`,
          citations: source ? [toCitation(source, this.timezone)] : [],
        };
      });
  }

  private linkedIdsOf(id: string): string[] {
    return [...new Set([id, ...this.identity.expand(id)])];
  }

  /** Every offering id (with its identity-linked ids) the student is enrolled in. */
  private enrolledIdSet(): Set<string> {
    const out = new Set<string>();
    for (const e of this.selfEnrollments())
      for (const id of this.linkedIdsOf(e.courseOfferingId)) out.add(id);
    return out;
  }

  /**
   * The student's enrollment in an offering: whether any linked offering has an active student
   * enrollment, which sources reported it, and the offering's academic term. Notifications use it
   * to stay silent about courses the student does not take.
   */
  enrollmentOf(courseOfferingId: string | undefined): EnrollmentScope {
    const none: EnrollmentScope = { enrolled: false, sourceIds: [], term: undefined };
    if (!courseOfferingId) return none;
    const linked = new Set(this.linkedIdsOf(courseOfferingId));
    const sourceIds: (string | undefined)[] = [];
    for (const e of this.selfEnrollments()) {
      if (!this.linkedIdsOf(e.courseOfferingId).some((id) => linked.has(id))) continue;
      sourceIds.push(this.entities.meta(e.id)?.sourceId);
    }
    if (sourceIds.length === 0) return none;
    const schedule = this.tasks.schedule;
    let term: EnrollmentScope['term'];
    for (const id of linked) {
      const offering = this.entities.getOfKind('courseOffering', id);
      const t = offering ? schedule.termOf(offering) : undefined;
      if (t) {
        term = { id: t.id, name: t.name, start: t.start, end: t.end };
        break;
      }
    }
    return { enrolled: true, sourceIds, term };
  }

  /** An offering known only from reference sources (a syllabus catalog) that the student does not take. */
  private isCatalogOnly(courseId: string | undefined, enrolled: ReadonlySet<string>): boolean {
    if (!courseId) return false;
    const linked = this.linkedIdsOf(courseId);
    if (linked.some((id) => enrolled.has(id))) return false;
    const sources = linked
      .map((id) => this.entities.meta(id)?.sourceId)
      .filter((x): x is string => x !== undefined);
    return sources.length > 0 && sources.every((x) => this.isReferenceSource(x));
  }

  /** Drops changes that only describe catalog (syllabus-only) offerings the student does not take. */
  private visibleChanges(list: ChangeEvent[]): ChangeEvent[] {
    if (list.length === 0) return list;
    const enrolled = this.enrolledIdSet();
    return list.filter((c) => {
      const course =
        c.courseOfferingId ?? (c.entityKind === 'courseOffering' ? c.entityId : undefined);
      const mine = course !== undefined && this.linkedIdsOf(course).some((id) => enrolled.has(id));
      if (mine) return true;
      const sourceId = c.source.sourceId;
      if (sourceId !== undefined && this.isReferenceSource(sourceId)) return false;
      return !this.isCatalogOnly(course, enrolled);
    });
  }

  private resolvedValue<T extends JsonValue>(res: Resolution, fallback?: T): ResolvedValue<T> {
    const candidates = res.candidates.map((c) => ({
      value: c.fact.value,
      origin: c.fact.origin,
      authority: c.authority,
      source: c.source?.sourceLabel ?? c.source?.sourceSystem ?? 'unknown',
      observedAt: c.fact.observedAt,
      citation: c.source ? toCitation(c.source, this.timezone) : undefined,
    }));
    if (res.status === 'none' && fallback !== undefined)
      return {
        value: fallback,
        status: 'resolved',
        origin: undefined,
        method: 'entity',
        candidates,
      };
    return {
      value: res.value as T | undefined,
      status: res.status,
      origin: res.origin,
      method: res.method,
      candidates,
    };
  }

  private describeValue(v: ResolvedValue<string>): string {
    if (v.status === 'conflict')
      return `情報が食い違っています（${v.candidates.map((c) => `${String(c.value)}: ${c.citation?.label ?? c.source}`).join(' / ')}）`;
    const cite = v.candidates[0]?.citation?.label;
    return `${v.value ?? '不明'}${cite ? `（根拠: ${cite}）` : ''}`;
  }

  /**
   * 前半 / 後半 of a course group (any linked ids): the halves, the display label (後期後半,
   * 後期（前半・後半）) and the term code they belong to.
   */
  termPartsFor(
    ids: readonly string[],
  ):
    | { parts: OfferingTermParts; label: string | undefined; termCode: string | undefined }
    | undefined {
    const schedule = this.tasks.schedule;
    const parts = schedule.termPartsOf(ids);
    if (!parts) return undefined;
    let termCode: string | undefined;
    for (const id of ids) {
      const o = this.entities.getOfKind('courseOffering', id);
      if (!o) continue;
      termCode = schedule.termOf(o)?.termCode ?? o.term;
      if (termCode) break;
    }
    return { parts, label: termPartLabel(termCode, parts.halves), termCode };
  }

  /** Where an offering's 前半 / 後半 comes from: the term_slots fact's source or the offering's. */
  private termPartCitations(parts: OfferingTermParts): Citation[] {
    if (parts.via === 'offering') return this.citationsFor([parts.evidenceId]);
    return this.resolver.facts
      .withSources(this.resolver.facts.getMany([parts.evidenceId]))
      .flatMap((f) => (f.source ? [toCitation(f.source, this.timezone)] : []));
  }

  /**
   * Term (and half) of a local date, for the `term` field of the day/week views. `span` (the week's
   * weekdays) adds a note when the half changes inside it: the boundary is per weekday.
   */
  termOfDate(date: string, span: readonly string[] = []): TermOfDate | undefined {
    const schedule = this.tasks.schedule;
    const term = schedule.currentTerm(date);
    if (!term) return undefined;
    const half = schedule.currentHalf(date);
    const labels = new Set(
      [date, ...span]
        .map((d) => schedule.currentHalf(d))
        .filter((h) => h?.term.id === term.id)
        .map((h) => h?.label),
    );
    return {
      id: term.id,
      name: term.name,
      ...(half ? { part: half.label } : {}),
      ...(labels.size > 1
        ? {
            partNote: `この週は${[...labels].sort((a, b) => Number(b?.endsWith('前半')) - Number(a?.endsWith('前半'))).join('と')}の切り替わり: 前半と後半の境目は曜日ごとに違う（第8回までが前半、第9回からが後半）。各授業のtermPartを参照`,
          }
        : {}),
    };
  }

  classItem(session: ClassSession, personal?: PersonalSession): ClassItem {
    const course = this.courseRef(session.courseOfferingId) ?? {
      id: session.courseOfferingId,
      title: session.courseOfferingId,
      courseCode: undefined,
      linkedIds: [session.courseOfferingId],
    };
    const at = session.startsAt
      ? new Date(session.startsAt)
      : new Date(parseZonedDate(session.date, this.timezone).getTime() + 12 * 3_600_000);
    const subjects = [session.id, ...course.linkedIds];
    const effectiveRoom = personal?.effective.room;
    const roomRes = this.resolvedValue<string>(
      this.resolver.resolve(subjects, 'room', { at }),
      session.room,
    );
    // The group schedule names the room of the student's group (科学実験室 / C&C): it wins over
    // the timetable's 「情報科学科実習室1 他」, which stays in the candidates and in rawSchedule.
    const room: ResolvedValue<string> =
      personal && effectiveRoom && roomRes.status !== 'conflict'
        ? {
            value: effectiveRoom,
            status: 'resolved',
            origin: personal.effective.rule?.confirmed ? 'user' : 'extracted',
            method: 'group_schedule',
            candidates: [
              {
                value: effectiveRoom,
                origin: 'extracted',
                authority: personal.effective.rule?.provenance ?? 'document',
                source: personal.effective.rule?.source ?? 'group schedule',
                observedAt: this.now().toISOString(),
                citation: personal.effective.citations[0],
              },
              ...roomRes.candidates,
            ],
          }
        : roomRes;
    const status = this.resolvedValue<string>(
      this.resolver.resolve([session.id], 'class_status', { at }),
      session.status,
    );
    const cancelled = status.status === 'resolved' && status.value === 'cancelled';
    const selfStudy = session.sessionKind === 'self_study';
    // 前半 / 後半 of this meeting's slot (per slot when the source says so), else of the course.
    const tp = this.termPartsFor(course.linkedIds);
    const termPart = tp
      ? (termPartLabel(
          tp.termCode,
          selfStudy
            ? tp.parts.halves
            : slotHalves(tp.parts, {
                dayOfWeek: this.tasks.schedule.timetableDayOf(session.date),
                period: session.period,
              }),
        ) ?? tp.label)
      : undefined;
    const time = session.period
      ? `${session.period}限`
      : session.startsAt
        ? formatShortJa(new Date(session.startsAt), this.timezone)
        : session.date;
    // A half-term course says so in the summary (「［後期後半のみ］」).
    const halfOnly = termPart !== undefined && /[前後]半$/.test(termPart);
    const summary = selfStudy
      ? `${formatDateJa(parseZonedDate(session.date, this.timezone), this.timezone)} ${time} ${course.title}（自習・本人が設定した時間）`
      : `${formatDateJa(parseZonedDate(session.date, this.timezone), this.timezone)} ${time} ${course.title}${halfOnly ? `［${termPart}のみ］` : ''}${cancelled ? '（休講）' : ''} / 教室: ${this.describeValue(room)}`;
    const eff = personal?.effective;
    const attendanceNote =
      eff?.status === 'not_attending'
        ? `［本人は出席なし: ${eff.reason ?? ''}］`
        : eff?.status === 'unknown'
          ? `［要確認: ${eff.reason ?? 'グループによる'}］`
          : eff?.reason
            ? `［${eff.reason}］`
            : '';
    const effectiveSchedule: ClassItem['effectiveSchedule'] = {
      status: eff?.status ?? 'attending',
      ...(eff?.reason ? { reason: eff.reason } : {}),
      date: session.date,
      period: session.period,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      room: typeof room.value === 'string' ? room.value : undefined,
      ...(eff?.group ? { group: eff.group } : {}),
      ...(eff?.sessionGroups ? { sessionGroups: eff.sessionGroups } : {}),
      ...(eff?.number ? { number: eff.number } : {}),
      ...(eff?.topic ? { topic: eff.topic } : {}),
      ...(eff?.rule ? { rule: eff.rule } : {}),
      ...(eff?.conflicts?.length ? { conflicts: eff.conflicts } : {}),
      citations: eff?.citations ?? [],
    };
    const raw = personal ? personal.raw : this.rawOf(session);
    return {
      sessionId: session.id,
      course,
      date: session.date,
      period: session.period,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      room,
      status,
      cancelled,
      note: session.note,
      sessionKind: selfStudy ? 'self_study' : 'class',
      ...(termPart ? { termPart } : {}),
      summary: `${summary}${attendanceNote}`,
      ...(raw ? { rawSchedule: raw } : {}),
      effectiveSchedule,
      citations: uniqueCitations([
        ...this.citationsFor([session.id]),
        ...room.candidates.flatMap((c) => (c.citation ? [c.citation] : [])),
        ...effectiveSchedule.citations,
      ]),
    };
  }

  private rawOf(s: ClassSession): ClassItem['rawSchedule'] {
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

  /** The student's personal conditions and group schedules, read fresh (one per view call). */
  personalSchedule(): PersonalSchedule {
    const schedule = this.tasks.schedule;
    return new PersonalSchedule({
      resolver: this.resolver,
      schedule,
      timezone: this.timezone,
      canonical: (id) => this.identity.canonical(id),
      expand: (id) => this.identity.expand(id),
      enrolled: () =>
        schedule
          .enrolledOfferings()
          .map((e) => ({ id: this.identity.canonical(e.offering.id), ids: e.ids })),
    });
  }

  /**
   * Every meeting of a local date as the student sees it (effective schedule): timetable sessions
   * with their attendance status, plus meetings only the group schedule lists. Sorted by time.
   */
  classesOn(date: string, personal: PersonalSchedule = this.personalSchedule()): ClassItem[] {
    const enrolled = this.enrolledIdSet();
    const startOf = (p: PersonalSession): string =>
      p.session.startsAt ??
      (p.session.period
        ? this.tasks.schedule.slotTimes(p.session.date, { period: p.session.period }).startsAt
        : undefined) ??
      '~';
    return personal
      .apply(date, this.tasks.schedule.sessionsOn(date))
      .filter((p) => !this.isCatalogOnly(p.session.courseOfferingId, enrolled))
      .sort(
        (a, b) =>
          startOf(a).localeCompare(startOf(b)) ||
          (a.session.period ?? 99) - (b.session.period ?? 99),
      )
      .map((p) => this.classItem(p.session, p));
  }

  /** The student's meetings of a date as sessions (attending / unknown; another group's day left out). */
  effectiveSessionsOn(date: string): ClassSession[] {
    return this.personalSchedule()
      .apply(date, this.tasks.schedule.sessionsOn(date))
      .filter((p) => p.effective.status !== 'not_attending')
      .map((p) => p.session);
  }

  /** classesOn split: the student's meetings (attending / unknown) and the others. */
  private splitClasses(items: ClassItem[]): { classes: ClassItem[]; notAttending: ClassItem[] } {
    return {
      classes: items.filter((c) => c.effectiveSchedule.status !== 'not_attending'),
      notAttending: items.filter((c) => c.effectiveSchedule.status === 'not_attending'),
    };
  }

  /** Why a day has no meetings for the student when the timetable lists some (another group's day). */
  private notAttendingReason(notAttending: ClassItem[]): string | undefined {
    const first = notAttending[0];
    if (!first) return undefined;
    return `時間割上の授業はあるが本人は出席なし（${first.course.title}: ${first.effectiveSchedule.reason ?? ''}）`;
  }

  /**
   * Sessions on a local date, one per (canonical course, period/start), sorted by time: stored
   * sessions merged over the ones generated from the timetable and the academic calendar.
   */
  sessionsOn(date: string): ClassSession[] {
    const sessions = this.tasks.schedule.sessionsOn(date);
    if (sessions.length === 0) return sessions;
    const enrolled = this.enrolledIdSet();
    return sessions.filter((s) => !this.isCatalogOnly(s.courseOfferingId, enrolled));
  }

  private taskCitations(t: Task): Citation[] {
    const ids = [t.assignmentId, t.examId].filter(
      (x): x is NonNullable<typeof x> => x !== undefined,
    );
    const fromFacts = this.resolver.facts
      .withSources(this.resolver.facts.getMany(t.sourceFactIds))
      .flatMap((f) => (f.source ? [toCitation(f.source, this.timezone)] : []));
    return uniqueCitations([...this.citationsFor(ids), ...fromFacts]);
  }

  /**
   * 「録音から」/「チャットで登録」: the task rests only on what an AI client wrote — heard in a
   * lecture recording or told in a chat (unconfirmed, no system or user fact behind it).
   */
  recordedMarker(t: Task): RecordedMarker | undefined {
    if (t.origin === 'authoritative' || t.origin === 'user' || t.sourceFactIds.length === 0)
      return undefined;
    const facts = this.resolver.facts
      .withSources(this.resolver.facts.getMany(t.sourceFactIds))
      .filter((f) => !f.fact.retractedAt);
    if (facts.some((f) => f.fact.origin === 'authoritative' || f.fact.origin === 'user'))
      return undefined;
    const rec = facts.find((f) => f.source?.sourceId === ADDITIONS_SOURCE_ID);
    if (!rec?.source) return undefined;
    const item = rec.source.sourceItemId;
    const hash = item.lastIndexOf('#');
    const via = additionViaOfAuthority(rec.source.authority);
    return {
      label: via === 'chat' ? 'チャットで登録' : '録音から',
      via,
      additionId: hash >= 0 ? item.slice(hash + 1) : undefined,
      source: rec.source.sourceLabel ?? rec.source.sourceSystem,
      timestamp: rec.source.location?.timestamp,
      evidence: rec.fact.evidence ?? t.evidence,
      confirmed: false,
    };
  }

  deadlineItem(t: Task): DeadlineItem | undefined {
    if (!t.dueAt) return undefined;
    const due = new Date(t.dueAt);
    const hoursLeft = Math.round(((due.getTime() - this.now().getTime()) / 3_600_000) * 10) / 10;
    const course = this.courseRef(t.courseOfferingId);
    const citations = this.taskCitations(t);
    const recorded = this.recordedMarker(t);
    const origin = recorded
      ? recorded.via === 'chat'
        ? '（チャットで登録）'
        : '（録音から・未確認）'
      : t.origin === 'extracted'
        ? '（文章から抽出）'
        : t.origin === 'inferred'
          ? '（推定）'
          : '';
    return {
      taskId: t.id,
      kind: t.taskKind,
      title: t.title,
      course,
      dueAt: t.dueAt,
      status: t.status,
      origin: t.origin,
      overdue: hoursLeft < 0,
      hoursLeft,
      evidence: t.evidence ?? recorded?.evidence,
      summary: `${recorded ? `【${recorded.label}】` : ''}${course ? `${course.title}: ` : ''}${t.title} 締切 ${formatShortJa(due, this.timezone)}${origin}${citations[0] ? `（根拠: ${citations[0].label}）` : ''}`,
      citations,
      ...(recorded ? { recorded } : {}),
    };
  }

  private taskItem(t: Task): TaskItem {
    return {
      taskId: t.id,
      title: t.title,
      course: this.courseRef(t.courseOfferingId),
      dueAt: t.dueAt,
      status: t.status,
      taskKind: t.taskKind,
      origin: t.origin,
      createdBy: t.createdBy,
      citations: this.taskCitations(t),
      ...(() => {
        const recorded = this.recordedMarker(t);
        return recorded ? { recorded } : {};
      })(),
    };
  }

  private deadlines(
    from: Date | undefined,
    to: Date,
    options: { courseOfferingId?: string; kinds?: Task['taskKind'][] } = {},
  ): DeadlineItem[] {
    return this.tasks
      .list({
        statuses: OPEN_STATUSES,
        ...(from ? { dueFrom: from.toISOString() } : {}),
        dueTo: to.toISOString(),
        includeUndated: false,
        ...(options.courseOfferingId ? { courseOfferingId: options.courseOfferingId } : {}),
      })
      .filter((t) => !options.kinds || options.kinds.includes(t.taskKind))
      .filter(this.takenFilter(options.courseOfferingId))
      .map((t) => this.deadlineItem(t))
      .filter((d): d is DeadlineItem => d !== undefined);
  }

  /** One change, compact: changed fields only, values and summary cut short, ≤ 2 citations. */
  changeItem(c: ChangeEvent, eventCount = 1): ChangeItem {
    const { before, after } = compactChangeValues(c);
    return {
      id: c.id,
      entityId: c.entityId,
      entityKind: c.entityKind,
      type: c.type,
      summary: compactSummary(c.summary ?? `${c.entityKind} ${c.type}`),
      changedFields: c.changedFields,
      before,
      after,
      occurredAt: c.occurredAt,
      observedAt: c.observedAt,
      course: this.courseRef(c.courseOfferingId),
      citations: this.citationsFor([c.entityId]).slice(0, 2),
      ...(eventCount > 1 ? { eventCount } : {}),
    };
  }

  /**
   * The changes a view shows (change-digest.ts): visible, one item per entity, the decisive ones
   * first, at most `limit`. `mine` keeps course changes only for the current term's courses
   * (grades: any enrolled course) and, without a course, important or university-wide notices,
   * calendar events and conflicts.
   */
  private changeDigest(
    events: ChangeEvent[],
    options: { limit: number; mine: boolean },
  ): { changes: ChangeItem[]; changesTotal: number; changesOmitted: number } {
    const newestFirst = this.visibleChanges(events)
      .filter((c) => !isHiddenChange(c))
      .reverse();
    const notices = new Map<string, Announcement | undefined>();
    const notice = (c: ChangeEvent): Announcement | undefined => {
      if (c.entityKind !== 'announcement') return undefined;
      if (!notices.has(c.entityId))
        notices.set(
          c.entityId,
          this.entities.get(c.entityId, { includeDeleted: true }) as Announcement | undefined,
        );
      return notices.get(c.entityId);
    };
    const important = (c: ChangeEvent): boolean => {
      const a = notice(c);
      return (
        a?.importance === 'critical' ||
        a?.importance === 'high' ||
        /休講|補講|教室変更/.test(a?.title ?? c.summary ?? '')
      );
    };
    let kept = newestFirst;
    if (options.mine) {
      const enrolled = this.enrolledIdSet();
      const termIds = new Set(this.currentTermOfferings().flatMap((e) => e.ids));
      const current = termIds.size > 0 ? termIds : enrolled;
      // Without any enrolment data there is nothing to scope by.
      const takes = (course: string, set: ReadonlySet<string>): boolean =>
        set.size === 0 || this.linkedIdsOf(course).some((id) => set.has(id));
      kept = newestFirst.filter((c) => {
        // The view lists the open conflicts themselves.
        if (c.type.startsWith('conflict')) return false;
        const course =
          c.courseOfferingId ?? (c.entityKind === 'courseOffering' ? c.entityId : undefined);
        if (course) return takes(course, c.entityKind === 'grade' ? enrolled : current);
        if (c.entityKind !== 'announcement') return true;
        if (important(c)) return true;
        // A university-wide notice is news when it appears, not when its body is fetched later.
        const a = notice(c);
        return c.type === 'created' && a?.scope === 'university' && a.importance !== 'low';
      });
    }
    const collapsed = collapseByEntity(kept);
    const picked = pickChanges(collapsed, (c) => changeRank(c, important(c)), options.limit);
    return {
      changes: picked.map((p) => this.changeItem(p.event, p.count)),
      changesTotal: collapsed.length,
      changesOmitted: collapsed.length - picked.length,
    };
  }

  /**
   * UniContext's own unread flag: the user's mark when there is one (a notice fetched on request
   * stays unread here until read in UniContext), otherwise the source's read state.
   */
  isUnread(a: Announcement): boolean {
    const mark = this.readMarks.get(a.id);
    if (mark) return mark.unread;
    return readAnnouncementExtra(a.extra).read === false;
  }

  /** Mark an announcement read/unread in UniContext only (never at the source). */
  setAnnouncementRead(id: string, read: boolean, reason = 'user'): AnnouncementItem {
    const a = this.entities.getOfKind('announcement', id);
    if (!a) throw new NotFoundError(`announcement ${id}`);
    this.readMarks.set(id, !read, reason, this.now().toISOString());
    return this.announcementItem(a);
  }

  /**
   * Announcements whose body the connector has not fetched: unread at the source (`notOpened`,
   * fetching marks them read there) or read but not fetched yet (`pending`). Newest first.
   */
  unopenedAnnouncements(): AnnouncementItem[] {
    return this.listAnnouncements().filter(
      (a) => a.bodyStatus === 'notOpened' || a.bodyStatus === 'pending',
    );
  }

  announcementItem(a: Announcement): AnnouncementItem {
    const extra = readAnnouncementExtra(a.extra);
    return {
      id: a.id,
      title: a.title,
      body: truncate(a.body, 400),
      publishedAt: a.publishedAt,
      importance: a.importance,
      scope: a.scope,
      author: a.authorName,
      course: this.courseRef(a.courseOfferingId),
      category: a.category,
      read: extra.read,
      unread: this.isUnread(a),
      bodyStatus: extra.bodyStatus,
      attachments: extra.attachments,
      citations: this.citationsFor([a.id]),
    };
  }

  /** One announcement with its full body and detail-screen fields, or undefined when unknown. */
  getAnnouncement(id: string): AnnouncementDetail | undefined {
    const a = this.entities.getOfKind('announcement', id);
    if (!a) return undefined;
    const extra = readAnnouncementExtra(a.extra);
    return {
      ...this.announcementItem(a),
      body: a.body,
      url: a.url,
      links: extra.links,
      courses: extra.courses,
      targetDate: extra.targetDate,
    };
  }

  /**
   * Announcements newest first. `since` is inclusive and `until` exclusive (ISO date or instant);
   * announcements without a publish time only appear when neither bound is given.
   */
  listAnnouncements(
    opts: {
      since?: string;
      until?: string;
      unreadOnly?: boolean;
      courseOfferingId?: string;
      importance?: readonly Importance[];
      limit?: number;
    } = {},
  ): AnnouncementItem[] {
    const bound = (label: string, v: string | undefined): number | undefined => {
      if (v === undefined) return undefined;
      const t = Date.parse(v);
      if (Number.isNaN(t)) throw new ValidationError(`${label} must be an ISO date or time: ${v}`);
      return t;
    };
    const since = bound('since', opts.since);
    const until = bound('until', opts.until);
    const ids = opts.courseOfferingId ? this.linkedIdsOf(opts.courseOfferingId) : undefined;
    const rows = this.entities
      .list('announcement', ids ? { where: { courseOfferingId: ids } } : {})
      .filter((a) => {
        if (opts.importance && !opts.importance.includes(a.importance)) return false;
        if (opts.unreadOnly && !this.isUnread(a)) return false;
        if (since !== undefined || until !== undefined) {
          const t = a.publishedAt ? Date.parse(a.publishedAt) : Number.NaN;
          if (Number.isNaN(t)) return false;
          if (since !== undefined && t < since) return false;
          if (until !== undefined && t >= until) return false;
        }
        return true;
      })
      .map((a) => ({ a, t: a.publishedAt ? Date.parse(a.publishedAt) : Number.NEGATIVE_INFINITY }))
      .sort((x, y) => (y.t === x.t ? x.a.id.localeCompare(y.a.id) : y.t - x.t))
      .map((x) => x.a);
    const limited = opts.limit !== undefined ? rows.slice(0, Math.max(0, opts.limit)) : rows;
    return limited.map((a) => this.announcementItem(a));
  }

  materialItem(m: Material): MaterialItem {
    return {
      id: m.id,
      title: m.title,
      materialKind: m.materialKind,
      url: m.url,
      publishedAt: m.publishedAt,
      documentId: m.documentId,
      citations: this.citationsFor([m.id, ...(m.documentId ? [m.documentId] : [])]),
    };
  }

  conflictItem(c: Conflict): ConflictItem {
    const subject = this.entities.get(c.subject, { includeDeleted: true });
    const facts = this.resolver.facts.withSources(
      this.resolver.facts.getMany(c.candidates.map((x) => x.factId)),
    );
    const cite = new Map(
      facts.map((f) => [f.fact.id, f.source ? toCitation(f.source, this.timezone) : undefined]),
    );
    const candidates = c.candidates.map((x) => ({
      value: x.value,
      origin: x.origin,
      authority: x.authority,
      source: x.sourceLabel ?? x.sourceSystem,
      observedAt: x.observedAt,
      citation: cite.get(x.factId),
    }));
    const label = subject ? entityLabel(subject) : c.subject;
    return {
      id: c.id,
      subject: c.subject,
      subjectLabel: label,
      predicate: c.predicate,
      detectedAt: c.detectedAt,
      candidates,
      note: `「${label}」の${c.predicate}について情報源の間で食い違いがあります: ${candidates.map((x) => `${conflictValueText(x.value)}（${x.citation?.label ?? x.source}）`).join(' / ')}`,
      citations: uniqueCitations(candidates.flatMap((x) => (x.citation ? [x.citation] : []))),
    };
  }

  /**
   * Open conflicts that matter now (today / tomorrow / week): about a course of the current term,
   * or about no course. Conflicts of ended terms stay in get_conflicts and the course view.
   */
  private currentConflicts(): ConflictItem[] {
    const termIds = new Set(this.currentTermOfferings().flatMap((e) => e.ids));
    const current = termIds.size > 0 ? termIds : this.enrolledIdSet();
    const dayAgo = this.now().getTime() - DAY;
    // A date value, or a deadline value ({ dueAt, phrase, rule }).
    const past = (v: JsonValue): boolean => {
      const raw =
        typeof v === 'string'
          ? v
          : v && typeof v === 'object' && !Array.isArray(v) && typeof v.dueAt === 'string'
            ? v.dueAt
            : undefined;
      const t = raw === undefined ? Number.NaN : Date.parse(raw);
      return !Number.isNaN(t) && t < dayAgo;
    };
    const valueCourse = (c: Conflict): string | undefined => {
      for (const x of c.candidates) {
        const v = x.value;
        if (
          v &&
          typeof v === 'object' &&
          !Array.isArray(v) &&
          typeof v.courseOfferingId === 'string'
        )
          return v.courseOfferingId;
      }
      return undefined;
    };
    return this.resolver
      .listConflicts({ status: 'open' })
      .filter((c) => {
        // Disagreeing dates that are all in the past no longer change what to do.
        if (c.candidates.length > 0 && c.candidates.every((x) => past(x.value))) return false;
        const e = this.entities.get(c.subject, { includeDeleted: true }) as
          (CanonicalEntity & { courseOfferingId?: string }) | undefined;
        const course =
          e?.kind === 'courseOffering' || c.subject.startsWith('courseOffering:')
            ? c.subject
            : (e?.courseOfferingId ?? valueCourse(c));
        return (
          !course || current.size === 0 || this.linkedIdsOf(course).some((id) => current.has(id))
        );
      })
      .map((c) => this.conflictItem(c));
  }

  private openConflicts(courseIds?: readonly string[]): ConflictItem[] {
    const all = this.resolver.listConflicts({ status: 'open' });
    const filtered = courseIds
      ? all.filter((c) => {
          if (courseIds.includes(c.subject)) return true;
          const e = this.entities.get(c.subject, { includeDeleted: true }) as
            (CanonicalEntity & { courseOfferingId?: string }) | undefined;
          return e?.courseOfferingId !== undefined && courseIds.includes(e.courseOfferingId);
        })
      : all;
    return filtered.map((c) => this.conflictItem(c));
  }

  private announcementsBetween(
    from: Date,
    to: Date,
    filter: (a: Announcement) => boolean = () => true,
  ): AnnouncementItem[] {
    return this.entities
      .listInRange('announcement', 'publishedAt', from.toISOString(), to.toISOString())
      .filter(filter)
      .reverse()
      .map((a) => this.announcementItem(a));
  }

  private materialsFor(courseIds: readonly string[], since?: Date): MaterialItem[] {
    return this.entities
      .list('material', { where: { courseOfferingId: courseIds } })
      .filter((m) => !since || !m.publishedAt || new Date(m.publishedAt) >= since)
      .map((m) => this.materialItem(m));
  }

  // ---------- thread-based platforms (Teams), files, assignments ----------

  private platformOf(
    extra: Record<string, JsonValue> | undefined,
    thread?: Thread,
  ): string | undefined {
    return (
      extraString(extra, 'platform') ??
      (thread ? (extraString(thread.extra, 'platform') ?? thread.platform) : undefined)
    );
  }

  /** Announcements and messages of thread-based platforms for the offerings, newest first. */
  private discussionFor(
    courseIds: readonly string[] | undefined,
    options: { since?: number; platform?: (p: string | undefined) => boolean; limit?: number } = {},
  ): DiscussionItem[] {
    const threads = new Map<string, Thread>(
      this.entities.list('thread').map((t) => [t.id, t] as const),
    );
    const out: { at: string | undefined; id: string; make: () => DiscussionItem }[] = [];
    const keep = (at: string | undefined, platform: string | undefined): boolean => {
      if (options.platform && !options.platform(platform)) return false;
      if (options.since === undefined) return true;
      const t = at ? Date.parse(at) : Number.NaN;
      return !Number.isNaN(t) && t >= options.since;
    };
    let messages: Message[];
    if (courseIds) {
      const threadIds = [...threads.values()]
        .filter((t) => t.courseOfferingId !== undefined && courseIds.includes(t.courseOfferingId))
        .map((t) => t.id);
      messages = [
        ...this.entities.list('message', { where: { courseOfferingId: courseIds } }),
        ...this.entities
          .list('message', { where: { threadId: threadIds } })
          .filter((m) => !m.courseOfferingId),
      ];
    } else messages = this.entities.list('message');
    for (const m of messages) {
      const thread = m.threadId ? threads.get(m.threadId) : undefined;
      const platform = this.platformOf(m.extra, thread);
      if (!platform && !m.threadId) continue;
      if (!keep(m.sentAt, platform)) continue;
      out.push({ at: m.sentAt, id: m.id, make: () => this.messageItem(m, thread, platform) });
    }
    const announcements = this.entities
      .list('announcement', courseIds ? { where: { courseOfferingId: courseIds } } : {})
      .filter((a) => extraString(a.extra, 'platform') !== undefined);
    for (const a of announcements)
      if (keep(a.publishedAt, extraString(a.extra, 'platform')))
        out.push({ at: a.publishedAt, id: a.id, make: () => this.postItem(a) });
    out.sort((x, y) => (y.at ?? '').localeCompare(x.at ?? '') || x.id.localeCompare(y.id));
    return (options.limit !== undefined ? out.slice(0, options.limit) : out).map((x) => x.make());
  }

  private messageItem(
    m: Message,
    thread: Thread | undefined,
    platform: string | undefined,
  ): DiscussionItem {
    return {
      id: m.id,
      kind: 'message',
      title: extraString(m.extra, 'subject'),
      body: truncate(m.body, 400),
      author: m.authorName,
      authorRole: m.authorRole,
      sentAt: m.sentAt,
      channel: thread?.title ?? extraString(m.extra, 'channelName'),
      platform,
      url: m.url ?? thread?.url,
      isReply: m.extra?.isReply === true,
      attachments: readAttachments(m.extra),
      citations: this.citationsFor([m.id]),
    };
  }

  private postItem(a: Announcement): DiscussionItem {
    return {
      id: a.id,
      kind: 'announcement',
      title: a.title,
      body: truncate(a.body, 400),
      author: a.authorName,
      authorRole: undefined,
      sentAt: a.publishedAt,
      channel: extraString(a.extra, 'channelName'),
      platform: extraString(a.extra, 'platform'),
      url: a.url,
      isReply: false,
      attachments: readAttachments(a.extra),
      citations: this.citationsFor([a.id]),
    };
  }

  /** Documents of the offerings as file items, folder then title; no `courseIds` = every course's. */
  private filesFor(
    courseIds: readonly string[] | undefined,
    filter: (d: Document) => boolean = () => true,
  ): Omit<CourseFileItem, 'citations'>[] {
    const materialKinds = new Map<string, string>();
    for (const m of this.entities.list(
      'material',
      courseIds ? { where: { courseOfferingId: courseIds } } : {},
    ))
      if (m.documentId && m.materialKind !== 'other')
        materialKinds.set(m.documentId, m.materialKind);
    return this.entities
      .list('document', courseIds ? { where: { courseOfferingId: courseIds } } : {})
      .filter((d) => d.courseOfferingId !== undefined && filter(d))
      .map((d): Omit<CourseFileItem, 'citations'> => ({
        id: d.id,
        title: d.title,
        path: d.path,
        folder: folderOfFile(d.extra, d.path),
        channel: extraString(d.extra, 'channelName'),
        sizeBytes: d.sizeBytes,
        modifiedAt: d.modifiedAt,
        modifiedBy: extraString(d.extra, 'modifiedBy'),
        url: d.url,
        mimeType: d.mimeType,
        materialKind: materialKinds.get(d.id),
      }))
      .sort(compareFiles);
  }

  private cited(files: Omit<CourseFileItem, 'citations'>[]): CourseFileItem[] {
    return files.map((f) => ({ ...f, citations: this.citationsFor([f.id]) }));
  }

  /** Assignments of the offerings with their submission state, newest due first (undated last). */
  private assignmentsFor(
    courseIds: readonly string[] | undefined,
    filter: (a: Assignment) => boolean = () => true,
  ): CourseAssignmentItem[] {
    const assignments = this.entities
      .list('assignment', courseIds ? { where: { courseOfferingId: courseIds } } : {})
      .filter(filter);
    if (assignments.length === 0) return [];
    const latest = new Map<string, Submission>();
    for (const s of this.entities.list('submission', {
      where: { assignmentId: assignments.map((a) => a.id) },
    })) {
      const prev = latest.get(s.assignmentId);
      if (!prev || (s.submittedAt ?? '') > (prev.submittedAt ?? '')) latest.set(s.assignmentId, s);
    }
    const dueMs = (a: CourseAssignmentItem): number =>
      a.dueAt ? Date.parse(a.dueAt) : Number.NEGATIVE_INFINITY;
    return assignments
      .map((a): CourseAssignmentItem => ({
        id: a.id,
        title: a.title,
        dueAt: a.dueAt,
        availableFrom: a.availableFrom,
        points: a.points,
        status: latest.get(a.id)?.status,
        submittedAt: latest.get(a.id)?.submittedAt,
        url: a.url,
        sourceId: this.entities.meta(a.id)?.sourceId,
        citations: this.citationsFor([a.id]),
      }))
      .sort((x, y) => dueMs(y) - dueMs(x) || x.title.localeCompare(y.title, 'ja'));
  }

  private preparationFor(item: ClassItem): PreparationItem {
    const start = item.startsAt
      ? new Date(item.startsAt)
      : parseZonedDate(item.date, this.timezone);
    const ids = item.course.linkedIds;
    const lectures = this.entities
      .list('lecture', { where: { courseOfferingId: ids } })
      .filter((l) => l.date === item.date);
    const lectureIds = new Set(lectures.map((l) => l.id));
    const relevant = this.entities
      .list('material', { where: { courseOfferingId: ids } })
      .filter(
        (m) =>
          (m.lectureId && lectureIds.has(m.lectureId)) ||
          (m.publishedAt &&
            start.getTime() - new Date(m.publishedAt).getTime() < 7 * DAY &&
            new Date(m.publishedAt) <= start),
      )
      .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
    const materials = relevant.slice(0, PREPARATION_MATERIALS).map((m) => this.materialItem(m));
    const dueBeforeClass = this.deadlines(this.now(), new Date(start.getTime() + 60_000), {
      courseOfferingId: item.course.id,
    });
    const announcements = this.announcementsBetween(
      new Date(start.getTime() - 7 * DAY),
      start,
      (a) => a.courseOfferingId !== undefined && ids.includes(a.courseOfferingId),
    ).slice(0, PREPARATION_ANNOUNCEMENTS);
    return {
      sessionId: item.sessionId,
      course: item.course,
      startsAt: item.startsAt,
      materials,
      ...(relevant.length > materials.length ? { materialsTotal: relevant.length } : {}),
      dueBeforeClass,
      announcements,
      citations: uniqueCitations([
        ...item.citations,
        ...materials.flatMap((m) => m.citations),
        ...announcements.flatMap((a) => a.citations),
      ]),
    };
  }

  // ---------- views (§18) ----------

  private day<V extends 'today' | 'tomorrow'>(view: V, offset: number): DayContext<V> {
    const now = this.now();
    const dayStart = addZonedDays(startOfZonedDay(now, this.timezone), offset, this.timezone);
    const date = zonedDateString(dayStart, this.timezone);
    const { classes, notAttending } = this.splitClasses(this.classesOn(date));
    const since = addZonedDays(startOfZonedDay(now, this.timezone), -1, this.timezone);
    const changes = this.changeDigest(this.changes.list({ since: since.toISOString() }), {
      limit: CHANGE_LIMITS.day,
      mine: true,
    });
    const horizon = addZonedDays(dayStart, 15, this.timezone);
    const deadlines = this.deadlines(new Date(now.getTime() - 7 * DAY), horizon);
    const tasks = this.tasks
      .list({ statuses: OPEN_STATUSES })
      .filter(this.takenFilter())
      .filter((t) => !t.dueAt || new Date(t.dueAt) >= new Date(now.getTime() - 7 * DAY))
      .slice(0, 30)
      .map((t) => this.taskItem(t));
    const importantAnnouncements = this.announcementsBetween(
      new Date(now.getTime() - 3 * DAY),
      new Date(now.getTime() + 1),
      // General campaigns (importance low: 就活, メルマガ, 調査 …) stay out of the daily view.
      (a) =>
        a.importance === 'critical' ||
        a.importance === 'high' ||
        (a.scope === 'university' && a.importance !== 'low'),
    );
    // One preparation per course and day (consecutive periods of a 実験 are one class).
    const prepared = new Set<string>();
    const preparation = classes
      .filter((c) => !c.cancelled)
      .filter((c) => !prepared.has(c.course.id) && Boolean(prepared.add(c.course.id)))
      .map((c) => this.preparationFor(c));
    const term = this.termOfDate(date);
    const reason =
      classes.length === 0
        ? (this.notAttendingReason(notAttending) ?? this.tasks.schedule.noClassesReason(date))
        : undefined;
    return {
      ...this.base(view),
      date,
      ...(term ? { term } : {}),
      ...(reason ? { noClassesReason: reason } : {}),
      classes,
      ...(notAttending.length ? { notAttending } : {}),
      ...changes,
      deadlines,
      tasks,
      importantAnnouncements,
      preparation,
      conflicts: this.currentConflicts(),
      ...this.enrollmentNotesField(),
    };
  }

  private enrollmentNotesField(): { enrollmentNotes?: EnrollmentNote[] } {
    const notes = this.enrollmentNotes();
    return notes.length ? { enrollmentNotes: notes } : {};
  }

  /**
   * Keeps work of courses the student takes: a task of a course the student says they do not take
   * is left out of the views (kept in the database and in that course's own view).
   */
  private takenFilter(scopedCourse?: string): (t: { courseOfferingId?: string }) => boolean {
    if (scopedCourse) return () => true;
    const out = this.declaredNotTakenIds();
    if (out.size === 0) return () => true;
    return (t) =>
      !t.courseOfferingId || !this.linkedIdsOf(t.courseOfferingId).some((id) => out.has(id));
  }

  /** getTodayContext() → {classes, changes, deadlines, tasks, importantAnnouncements, preparation, conflicts, pacing} (§17). */
  today(): TodayContext {
    return {
      ...this.day('today', 0),
      pacing: this.pacing(),
      coverage: this.deadlineCoverage(),
      next: summarizeNextActions(this.nextActions()),
    };
  }

  /** Sources from the health store only (no connector metadata): their capabilities are unknown. */
  private storedSourceStates(): CoverageSourceInput[] {
    const stores = createStores(this.db, this.clock);
    return new RawStore(this.db, { clock: this.clock }).listSources().map((s) => {
      const h = stores.health.get(s.id);
      return {
        sourceId: s.id,
        label: s.displayName ?? s.id,
        capabilities: undefined,
        authority: undefined,
        referenceOnly: this.isReferenceSource(s.id),
        state: h?.state,
        lastSuccessAt: h?.lastSuccessAt,
        staleAfterMs: undefined,
      };
    });
  }

  /**
   * Which sources feed the deadlines and what is known to be missing (coverage.ts): for one course,
   * or for the student's current-term courses.
   */
  deadlineCoverage(courseOfferingId?: string): DeadlineCoverage {
    const now = this.now();
    const sourceOf = (id: string): string | undefined => this.entities.meta(id)?.sourceId;
    let courses: CoverageCourse[];
    let scope: Set<string>;
    if (courseOfferingId) {
      const ref = this.courseRef(courseOfferingId);
      const ids = ref?.linkedIds ?? [courseOfferingId];
      scope = new Set(ids);
      courses = [
        {
          id: ref?.id ?? courseOfferingId,
          title: ref?.title ?? courseOfferingId,
          sourceIds: ids.map(sourceOf).filter((x): x is string => x !== undefined),
        },
      ];
    } else {
      const current = this.currentTermOfferings();
      scope = new Set(current.flatMap((e) => e.ids));
      courses = current.map((e) => ({
        id: this.courseRef(e.offering.id)?.id ?? e.offering.id,
        title: e.offering.title,
        sourceIds: e.ids.map(sourceOf).filter((x): x is string => x !== undefined),
      }));
    }
    const undated: CoverageUndated[] = this.tasks
      .list({ statuses: OPEN_STATUSES })
      .filter(
        (t) =>
          !t.dueAt &&
          t.taskKind === 'assignment' &&
          t.courseOfferingId !== undefined &&
          scope.has(t.courseOfferingId),
      )
      .map((t) => {
        const course = this.courseRef(t.courseOfferingId);
        const assignment = t.assignmentId
          ? this.entities.getOfKind('assignment', t.assignmentId)
          : undefined;
        return {
          course: course ? { id: course.id, title: course.title } : undefined,
          title: t.title,
          url: assignment?.url,
        };
      });
    const tz = this.timezone;
    return buildDeadlineCoverage({
      now,
      sources: this.coverageSources(),
      courses,
      undated,
      courseScoped: courseOfferingId !== undefined,
      formatTime: (iso) => {
        const p = zonedParts(new Date(iso), tz);
        return `${p.month}/${p.day} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
      },
    });
  }

  /**
   * What to do now (next-action.ts): one recommended action and the next few, ranked
   * deterministically from deadlines, effort, free time, submission state and source coverage.
   */
  nextActions(options: NextActionOptions = {}): NextActionsContext {
    return computeNextActions(this.nextActionHost(), options);
  }

  /** The read model of the next-action engine (also used by the student-state / attention views). */
  nextActionHost(): NextActionHost {
    const enrolled = this.enrolledIdSet();
    const dropped = new Set([
      ...this.entities
        .list('enrollment')
        .filter((e) => e.status === 'dropped' && e.role === 'student')
        .flatMap((e) => this.linkedIdsOf(e.courseOfferingId)),
      // Courses the student says they do not take (rejected / dropped although still listed).
      ...this.declaredNotTakenIds(),
    ]);
    const schedule = this.tasks.schedule;
    const offerings = schedule.enrolledOfferings();
    return {
      now: this.now(),
      timezone: this.timezone,
      openTasks: () => this.tasks.list({ statuses: OPEN_STATUSES }),
      assignment: (id) => this.entities.getOfKind('assignment', id),
      submission: (assignmentId) =>
        this.entities
          .list('submission', { where: { assignmentId } })
          .sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''))[0],
      exam: (id) => this.entities.getOfKind('exam', id),
      courseRef: (id) => this.courseRef(id),
      citations: (t) => this.taskCitations(t),
      recorded: (t) => this.recordedMarker(t),
      notTaken: (id) => {
        const linked = this.linkedIdsOf(id);
        if (linked.some((x) => enrolled.has(x))) return false;
        return linked.some((x) => dropped.has(x)) || this.isCatalogOnly(id, enrolled);
      },
      halfOver: (id, date) => {
        const linked = new Set(this.linkedIdsOf(id));
        const e = offerings.find((o) => o.ids.some((x) => linked.has(x)));
        if (!e?.termParts || !e.term || e.term.end < date) return false;
        return !schedule.runsOn(e, date) && schedule.currentHalf(date)?.half === '後半';
      },
      classes: (from, to) => {
        // The student's meetings only (another group's day is not a class to go to).
        const personal = this.personalSchedule();
        const out: ClassItem[] = [];
        for (let d = from; d <= to; d = addLocalDays(d, 1))
          out.push(
            ...this.classesOn(d, personal).filter(
              (c) => c.effectiveSchedule.status !== 'not_attending',
            ),
          );
        return out;
      },
      preparation: (item) => this.preparationFor(item),
      pacing: () => this.pacing(),
      coverage: () => this.deadlineCoverage(),
      sourceUrl: (sourceId) => {
        const url = this.entities
          .list('assignment')
          .find((a) => a.url && this.entities.meta(a.id)?.sourceId === sourceId)?.url;
        try {
          return url ? new URL(url).origin : undefined;
        } catch {
          return undefined;
        }
      },
      sourceLabelOf: (entityId) => this.citationsFor([entityId])[0]?.sourceLabel,
    };
  }

  paceSlotView(slot: PaceSlot): PaceSlotView {
    return {
      dayOfWeek: slot.dayOfWeek,
      startTime: slot.startTime,
      endTime: slot.endTime,
      period: slot.period,
      text: formatPaceSlot(slot),
    };
  }

  /**
   * Enrolled offerings of the current term (all of them when the profile has no academic
   * calendar; none outside every term).
   */
  private currentTermOfferings(): EnrolledOffering[] {
    const schedule = this.tasks.schedule;
    const all = schedule.enrolledOfferings();
    const cal = schedule.profile?.academicCalendar;
    if (!cal || cal.terms.length === 0) return all;
    const current = schedule.currentTerm();
    return current ? all.filter((e) => e.term?.id === current.id) : [];
  }

  /** Offerings without a weekly class time that the student is falling behind in. */
  pacing(): PaceItem[] {
    const out: PaceItem[] = [];
    const today = zonedDateString(this.now(), this.timezone);
    for (const e of this.currentTermOfferings()) {
      if (e.scheduleType === 'regular') continue;
      // A half-term course (前半 / 後半) is not behind outside its half.
      if (!this.tasks.schedule.runsOn(e, today)) continue;
      const course = this.courseRef(e.offering.id);
      if (!course) continue;
      const st = this.tasks.paceStatusOf(e.offering.id);
      if (st.behindWeeks === 0 && st.unsubmitted === 0) continue;
      const message =
        st.behindWeeks === 1
          ? `${course.title} 先週分が未完了`
          : st.behindWeeks >= 2
            ? `${course.title} ${st.behindWeeks}週分遅れています`
            : `${course.title} 未提出の課題 ${st.unsubmitted}件`;
      out.push({
        course,
        behindWeeks: st.behindWeeks,
        unsubmitted: st.unsubmitted,
        slots: this.tasks.schedule.paceSlots(e.ids).map(formatPaceSlot),
        message,
      });
    }
    return out.sort(
      (a, b) =>
        b.behindWeeks - a.behindWeeks ||
        b.unsubmitted - a.unsubmitted ||
        a.course.title.localeCompare(b.course.title, 'ja'),
    );
  }

  /**
   * Pacing overview: every enrolled course of the current term plus any course that has
   * self-study slots, with this week's 「今週分」 task.
   */
  paceOverview(): PaceOverview {
    const schedule = this.tasks.schedule;
    const refs = new Map<string, CourseRef>();
    for (const e of this.currentTermOfferings()) {
      const ref = this.courseRef(e.offering.id);
      if (ref) refs.set(ref.id, ref);
    }
    const subjects = new Set(
      this.resolver.facts
        .activePairs()
        .filter((p) => p.predicate === PACE_PREDICATE)
        .map((p) => p.subject),
    );
    for (const subject of subjects) {
      const ref = this.courseRef(subject);
      if (ref && !refs.has(ref.id) && this.entities.getOfKind('courseOffering', ref.id))
        refs.set(ref.id, ref);
    }
    const enrolledAnyTerm = schedule.enrolledOfferings();
    const currentWeek = weekStartOf(this.now(), this.timezone);
    const courses: PaceCourseItem[] = [];
    for (const ref of refs.values()) {
      const tasks = this.tasks.list({ courseOfferingId: ref.id });
      const weekly = tasks.find(
        (t) =>
          t.taskKind === 'weekly_pace' &&
          t.dueAt !== undefined &&
          weekStartOfDue(t.dueAt, this.timezone) === currentWeek,
      );
      const st = this.tasks.paceStatusOf(ref.id);
      courses.push({
        course: ref,
        scheduleType: schedule.scheduleTypeOf(ref.linkedIds),
        enrolled: enrolledAnyTerm.some((e) => e.ids.includes(ref.id)),
        slots: schedule.paceSlots(ref.linkedIds).map((s) => this.paceSlotView(s)),
        thisWeek:
          weekly && weekly.dueAt
            ? { taskId: weekly.id, status: weekly.status, dueAt: weekly.dueAt }
            : undefined,
        behindWeeks: st.behindWeeks,
        unsubmitted: st.unsubmitted,
      });
    }
    return {
      courses: courses.sort(
        (a, b) =>
          Number(b.enrolled) - Number(a.enrolled) ||
          a.course.title.localeCompare(b.course.title, 'ja'),
      ),
    };
  }

  tomorrow(): TomorrowContext {
    return this.day('tomorrow', 1);
  }

  week(): WeekContext {
    const now = this.now();
    const from = startOfZonedWeek(now, this.timezone);
    const to = addZonedDays(from, 7, this.timezone);
    const personal = this.personalSchedule();
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = zonedDateString(addZonedDays(from, i, this.timezone), this.timezone);
      const { classes, notAttending } = this.splitClasses(this.classesOn(date, personal));
      const reason =
        classes.length === 0
          ? (this.notAttendingReason(notAttending) ?? this.tasks.schedule.noClassesReason(date))
          : undefined;
      return {
        date,
        classes,
        ...(reason ? { noClassesReason: reason } : {}),
        ...(notAttending.length ? { notAttending } : {}),
      };
    });
    const term = this.termOfDate(
      zonedDateString(now, this.timezone),
      days.slice(0, 5).map((d) => d.date),
    );
    const all = this.deadlines(from, to);
    return {
      ...this.base('week'),
      ...(term ? { term } : {}),
      from: from.toISOString(),
      to: to.toISOString(),
      days,
      deadlines: all.filter((d) => d.kind !== 'exam_preparation'),
      coverage: this.deadlineCoverage(),
      exams: all.filter((d) => d.kind === 'exam_preparation'),
      ...this.changeDigest(
        this.changes.list({ since: new Date(now.getTime() - 7 * DAY).toISOString() }),
        { limit: CHANGE_LIMITS.week, mine: true },
      ),
      conflicts: this.currentConflicts(),
      ...this.enrollmentNotesField(),
      next: summarizeNextActions(this.nextActions()),
    };
  }

  course(courseOfferingId: string): CourseContext {
    const c = this.requireCourse(courseOfferingId);
    const now = this.now();
    const ids = c.linkedIds;
    const offerings = ids
      .map((id) => this.entities.getOfKind('courseOffering', id))
      .filter((o): o is CourseOffering => o !== undefined);
    const today = zonedDateString(now, this.timezone);
    const sessions = this.upcomingClassesOf(c.id, today, 120, 5);
    const schedule = this.tasks.schedule;
    const scheduleType = schedule.scheduleTypeOf(ids);
    const termOffering =
      offerings.find((o) => o.id === c.id && o.term) ?? offerings.find((o) => o.term);
    const enrolled = schedule.enrolledOfferings().some((e) => e.ids.includes(c.id));
    const lectures = this.entities
      .list('lecture', { where: { courseOfferingId: ids }, orderBy: 'date' })
      .filter((l) => l.date <= today)
      .slice(-3)
      .reverse()
      .map((l) => this.lectureBundle(l));
    const files = this.filesFor(ids);
    const tp = this.termPartsFor(ids);
    const slotPart = (s: { dayOfWeek: number; period?: number | undefined }): string | undefined =>
      tp && tp.parts.slots.length > 0
        ? termPartLabel(tp.termCode, slotHalves(tp.parts, s))
        : undefined;
    const perSlot =
      new Set(c.offering.schedule.map((s) => slotPart(s) ?? '')).size > 1 ||
      c.offering.schedule.some((s) => slotPart(s) !== undefined && slotPart(s) !== tp?.label);
    return {
      ...this.base('course'),
      course: { id: c.id, title: c.title, courseCode: c.courseCode, linkedIds: c.linkedIds },
      instructors: [...new Set(offerings.flatMap((o) => o.instructorNames))],
      schedule:
        scheduleType === 'regular'
          ? c.offering.schedule.map((s) => {
              const part = perSlot ? slotPart(s) : undefined;
              return {
                dayOfWeek: s.dayOfWeek,
                period: s.period,
                room: s.room,
                ...(part ? { termPart: part } : {}),
              };
            })
          : [],
      scheduleType,
      academicYear: termOffering?.academicYear ?? c.offering.academicYear,
      term: termOffering?.term ?? c.offering.term,
      termId: termOffering ? schedule.termOf(termOffering)?.id : undefined,
      ...(tp?.label
        ? {
            termPart: tp.label,
            termPartCitations: this.termPartCitations(tp.parts),
          }
        : {}),
      enrolled,
      enrollment: this.enrollmentView(c.id),
      retake: offerings.some((o) => (o.extra as { retake?: unknown } | undefined)?.retake === true),
      paceSlots: schedule.paceSlots(ids).map((x) => this.paceSlotView(x)),
      room: this.resolvedValue<string>(this.resolver.resolve(ids, 'room'), c.offering.room),
      sources: ids.map((id) => ({
        id,
        sourceId: this.entities.meta(id)?.sourceId,
        citations: this.citationsFor([id]),
      })),
      upcomingClasses: sessions,
      recentLectures: lectures,
      deadlines: this.deadlines(
        new Date(now.getTime() - 7 * DAY),
        addZonedDays(now, 60, this.timezone),
        { courseOfferingId: c.id },
      ),
      coverage: this.deadlineCoverage(c.id),
      announcements: this.entities
        .list('announcement', { where: { courseOfferingId: ids } })
        .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
        .slice(0, 10)
        .map((a) => this.announcementItem(a)),
      materials: this.materialsFor(ids),
      discussion: this.discussionFor(ids, { limit: 20 }),
      files: this.cited(files.slice(0, COURSE_FILES_LIMIT)),
      filesTotal: files.length,
      assignments: this.assignmentsFor(ids),
      ...this.changeDigest(
        this.changes.list({
          since: new Date(now.getTime() - 14 * DAY).toISOString(),
          courseOfferingIds: ids,
        }),
        { limit: CHANGE_LIMITS.course, mine: false },
      ),
      conflicts: this.openConflicts(ids),
      pendingLinks: ids.flatMap((id) =>
        this.identity.listLinks({ entityId: id, status: 'suggested' }),
      ),
    };
  }

  deadline(options: { days?: number; courseOfferingId?: string } = {}): DeadlineContext {
    const now = this.now();
    const all = this.deadlines(
      new Date(now.getTime() - 30 * DAY),
      addZonedDays(now, options.days ?? 14, this.timezone),
      options.courseOfferingId ? { courseOfferingId: options.courseOfferingId } : {},
    );
    return {
      ...this.base('deadline'),
      overdue: all.filter((d) => d.overdue),
      upcoming: all.filter((d) => !d.overdue),
      coverage: this.deadlineCoverage(options.courseOfferingId),
    };
  }

  /** What changed since `since` (default: start of yesterday) — "昨日から何が変わった？" (§13, §45). */
  changesSince(
    options: { since?: string; courseOfferingId?: string; limit?: number } = {},
  ): ChangesContext {
    const since =
      options.since ??
      addZonedDays(startOfZonedDay(this.now(), this.timezone), -1, this.timezone).toISOString();
    const ids = options.courseOfferingId
      ? this.identity.expand(options.courseOfferingId)
      : undefined;
    return {
      ...this.base('changes'),
      since,
      ...this.changeDigest(
        this.changes.list({ since, ...(ids ? { courseOfferingIds: ids } : {}) }),
        {
          limit: Math.min(options.limit ?? CHANGE_LIMITS.changes, CHANGE_LIMITS.changesMax),
          mine: false,
        },
      ),
      conflicts: this.openConflicts(ids),
    };
  }

  /**
   * Teams activity since `since` (default: 7 days ago): posts, changed files and assignments that
   * are new, due or changed. Only entities of a `teams*` platform.
   */
  teamsActivity(
    options: { since?: string; courseOfferingId?: string; limit?: number } = {},
  ): TeamsActivityContext {
    const since = /^\d{4}-\d{2}-\d{2}$/.test(options.since ?? '')
      ? parseZonedDate(options.since ?? '', this.timezone).toISOString()
      : (options.since ??
        addZonedDays(startOfZonedDay(this.now(), this.timezone), -7, this.timezone).toISOString());
    const sinceMs = Date.parse(since);
    if (Number.isNaN(sinceMs))
      throw new ValidationError(`since must be an ISO date or time: ${since}`);
    const ids = options.courseOfferingId ? this.linkedIdsOf(options.courseOfferingId) : undefined;
    const isTeams = (platform: string | undefined): boolean =>
      platform?.startsWith('teams') ?? false;
    const after = (v: string | undefined): boolean => {
      const t = v ? Date.parse(v) : Number.NaN;
      return !Number.isNaN(t) && t >= sinceMs;
    };
    const posts = this.discussionFor(ids, {
      since: sinceMs,
      platform: isTeams,
      limit: options.limit ?? 50,
    });
    const files = this.cited(
      this.filesFor(
        ids,
        (d) => isTeams(extraString(d.extra, 'platform')) && after(d.modifiedAt),
      ).sort(
        (a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? '') || compareFiles(a, b),
      ),
    );
    const touched = new Set<string>();
    for (const c of this.changes.list({ since, types: ['updated'] })) {
      if (c.entityKind === 'assignment') touched.add(c.entityId);
      else if (c.entityKind === 'submission') {
        const s = this.entities.getOfKind('submission', c.entityId);
        if (s) touched.add(s.assignmentId);
      }
    }
    const assignments = this.assignmentsFor(
      ids,
      (a) =>
        isTeams(extraString(a.extra, 'platform')) &&
        (after(a.availableFrom) || after(a.dueAt) || touched.has(a.id)),
    );
    const subjects = new Set([...posts, ...files, ...assignments].map((x) => x.id));
    return {
      ...this.base('teams-activity'),
      since,
      posts,
      files,
      assignments,
      conflicts: this.openConflicts().filter((c) => subjects.has(c.subject)),
    };
  }

  /** The files of a course directly in a folder, plus its immediate subfolders. */
  courseFiles(options: { courseOfferingId: string; path?: string }): CourseFilesContext {
    const c = this.requireCourse(options.courseOfferingId);
    const path = normalizeFolderPath(options.path);
    const all = this.filesFor(c.linkedIds);
    const prefix = path === '' ? '' : `${path}/`;
    const counts = new Map<string, number>();
    for (const f of all) {
      if (f.folder === path || !f.folder.startsWith(prefix)) continue;
      const name = f.folder.slice(prefix.length).split('/')[0] ?? '';
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const folders: CourseFolderItem[] = [...counts]
      .map(([name, fileCount]) => ({ name, path: `${prefix}${name}`, fileCount }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
    return {
      ...this.base('course-files'),
      course: { id: c.id, title: c.title, courseCode: c.courseCode, linkedIds: c.linkedIds },
      path,
      folders,
      files: this.cited(all.filter((f) => f.folder === path)),
    };
  }

  /**
   * The next `limit` meetings of one course for the student (effective schedule: another group's
   * days left out, group-schedule meetings included) within `days` days from `from`.
   */
  private upcomingClassesOf(
    courseId: string,
    from: string,
    days: number,
    limit: number,
  ): ClassItem[] {
    const ids = new Set(this.linkedIdsOf(courseId));
    const personal = this.personalSchedule();
    if (!personal.coursesWithRules().some((id) => ids.has(id)))
      return this.tasks.schedule
        .sessionsBetween(from, addLocalDays(from, days), [courseId])
        .slice(0, limit)
        .map((s) => this.classItem(s));
    const out: ClassItem[] = [];
    for (let i = 0, d = from; i < days && out.length < limit; i++, d = addLocalDays(d, 1))
      for (const c of this.classesOn(d, personal))
        if (
          ids.has(c.course.id) &&
          c.effectiveSchedule.status !== 'not_attending' &&
          out.length < limit
        )
          out.push(c);
    return out;
  }

  private nextSession(courseIds: readonly string[], after: Date): ClassSession | undefined {
    return this.entities
      .list('classSession', { where: { courseOfferingId: courseIds }, orderBy: 'date' })
      .filter((s) => s.status !== 'cancelled')
      .find(
        (s) =>
          (s.endsAt
            ? new Date(s.endsAt)
            : addZonedDays(parseZonedDate(s.date, this.timezone), 1, this.timezone)) > after,
      );
  }

  classPreparation(options: {
    sessionId?: string;
    courseOfferingId?: string;
  }): ClassPreparationContext {
    let item: ClassItem | undefined;
    if (options.sessionId) {
      const s = this.entities.getOfKind('classSession', options.sessionId);
      item = s ? this.classItem(s) : undefined;
    } else if (options.courseOfferingId) {
      const today = zonedDateString(this.now(), this.timezone);
      // The student's next meeting (effective schedule), else the next stored session.
      item = this.upcomingClassesOf(options.courseOfferingId, today, 60, 3).find(
        (c) => !c.endsAt || new Date(c.endsAt) > this.now(),
      );
      if (!item) {
        const s = this.nextSession(this.identity.expand(options.courseOfferingId), this.now());
        item = s ? this.classItem(s) : undefined;
      }
    } else {
      item = this.classesOn(zonedDateString(this.now(), this.timezone)).find(
        (c) =>
          c.effectiveSchedule.status !== 'not_attending' &&
          (!c.endsAt || new Date(c.endsAt) > this.now()),
      );
      if (!item) {
        const s = this.nextAnySession();
        item = s ? this.classItem(s) : undefined;
      }
    }
    if (!item)
      return {
        ...this.base('class-preparation'),
        session: undefined,
        preparation: undefined,
        previousLecture: undefined,
      };
    const date = item.date;
    const prev = this.entities
      .list('lecture', { where: { courseOfferingId: item.course.linkedIds }, orderBy: 'date' })
      .filter((l) => l.date < date)
      .pop();
    return {
      ...this.base('class-preparation'),
      session: item,
      preparation: this.preparationFor(item),
      previousLecture: prev ? this.lectureBundle(prev) : undefined,
    };
  }

  private nextAnySession(): ClassSession | undefined {
    const today = zonedDateString(this.now(), this.timezone);
    const until = zonedDateString(addZonedDays(this.now(), 14, this.timezone), this.timezone);
    return this.entities
      .listByDateRange('classSession', 'date', today, until)
      .find((s) => s.status !== 'cancelled' && (!s.endsAt || new Date(s.endsAt) > this.now()));
  }

  classReview(
    options: {
      lectureId?: string;
      sessionId?: string;
      courseOfferingId?: string;
      date?: string;
    } = {},
  ): ClassReviewContext {
    let lecture: LectureBundle | undefined;
    if (options.lectureId || options.sessionId || (options.courseOfferingId && options.date)) {
      lecture = this.lecture(options);
    } else {
      const today = zonedDateString(this.now(), this.timezone);
      const ids = options.courseOfferingId
        ? this.identity.expand(options.courseOfferingId)
        : undefined;
      const sessions = (
        ids
          ? this.entities.list('classSession', {
              where: { courseOfferingId: ids },
              orderBy: 'date',
            })
          : this.entities.list('classSession', { orderBy: 'date' })
      ).filter(
        (s) =>
          s.date <= today &&
          (!s.startsAt || new Date(s.startsAt) <= this.now()) &&
          s.status !== 'cancelled',
      );
      const last = sessions[sessions.length - 1];
      if (last) lecture = this.lecture({ sessionId: last.id });
    }
    const courseId = lecture?.course?.id;
    return {
      ...this.base('class-review'),
      lecture,
      nextDeadlines: courseId
        ? this.deadlines(this.now(), addZonedDays(this.now(), 14, this.timezone), {
            courseOfferingId: courseId,
          })
        : [],
    };
  }

  /** Lecture aggregation (§21) by lecture id, session id, or (course, date). */
  lecture(options: {
    lectureId?: string;
    sessionId?: string;
    courseOfferingId?: string;
    date?: string;
  }): LectureBundle | undefined {
    if (options.lectureId) {
      const l = this.entities.getOfKind('lecture', options.lectureId);
      return l ? this.lectureBundle(l) : undefined;
    }
    let courseId = options.courseOfferingId;
    let date = options.date;
    if (options.sessionId) {
      const s = this.entities.getOfKind('classSession', options.sessionId);
      if (!s) return undefined;
      courseId = s.courseOfferingId;
      date = s.date;
    }
    if (!courseId || !date) return undefined;
    const ids = this.identity.expand(courseId);
    const lecture = this.entities.list('lecture', { where: { courseOfferingId: ids, date } })[0];
    if (lecture) return this.lectureBundle(lecture);
    return this.lectureBundle({ id: undefined, courseOfferingId: courseId, date });
  }

  private lectureBundle(
    l: Lecture | { id: undefined; courseOfferingId: string; date: string },
  ): LectureBundle {
    const course = this.courseRef(l.courseOfferingId);
    const ids = course?.linkedIds ?? [];
    const lectureIds = new Set<string>();
    if (l.id) lectureIds.add(l.id);
    for (const other of this.entities.list('lecture', {
      where: { courseOfferingId: ids, date: l.date },
    }))
      lectureIds.add(other.id);
    const lecture = l.id ? (l as Lecture) : undefined;
    const sessionEntity =
      (lecture?.classSessionId
        ? this.entities.getOfKind('classSession', lecture.classSessionId)
        : undefined) ??
      this.entities.list('classSession', { where: { courseOfferingId: ids, date: l.date } })[0];
    const dayStart = parseZonedDate(l.date, this.timezone);
    const dayEnd = addZonedDays(dayStart, 1, this.timezone);
    const materials = this.entities
      .list('material', { where: { courseOfferingId: ids } })
      .filter(
        (m) =>
          (m.lectureId && lectureIds.has(m.lectureId)) ||
          (m.publishedAt &&
            new Date(m.publishedAt) >= dayStart &&
            new Date(m.publishedAt) < dayEnd),
      );
    const transcripts = [...lectureIds].flatMap((id) =>
      this.entities.list('lectureTranscript', { where: { lectureId: id } }),
    );
    const segments: SegmentItem[] = transcripts.flatMap((t) =>
      this.entities
        .list('lectureSegment', { where: { transcriptId: t.id }, orderBy: 'ordinal' })
        .map((s) => ({
          id: s.id,
          startMs: s.startMs,
          timestamp: hms(s.startMs),
          speaker: s.speaker,
          text: s.text,
          citations: this.citationsFor([s.id]),
        })),
    );
    const announcements = this.entities
      .list('announcement', { where: { courseOfferingId: ids } })
      .filter(
        (a) =>
          (a.lectureId && lectureIds.has(a.lectureId)) ||
          (a.publishedAt &&
            new Date(a.publishedAt) >= dayStart &&
            new Date(a.publishedAt) < dayEnd),
      )
      .map((a) => this.announcementItem(a));
    const questions: QuestionItem[] = this.entities
      .list('message', { where: { courseOfferingId: ids } })
      .filter(
        (m) =>
          (m.lectureId && lectureIds.has(m.lectureId)) ||
          (m.isQuestion &&
            m.sentAt &&
            new Date(m.sentAt) >= dayStart &&
            new Date(m.sentAt) < dayEnd),
      )
      .map((m) => ({
        id: m.id,
        author: m.authorName,
        body: m.body,
        sentAt: m.sentAt,
        citations: this.citationsFor([m.id]),
      }));
    const factSubjects = [...lectureIds, ...(sessionEntity ? [sessionEntity.id] : [])];
    const facts: FactItem[] = this.resolver.facts
      .withSources(this.resolver.facts.active({ subjects: factSubjects }))
      .map((f) => ({
        id: f.fact.id,
        subject: f.fact.subject,
        predicate: f.fact.predicate,
        value: f.fact.value,
        origin: f.fact.origin,
        confidence: f.fact.confidence,
        evidence: f.fact.evidence,
        citations: f.source ? [toCitation(f.source, this.timezone)] : [],
      }));
    const notes: LectureNoteItem[] = [];
    for (const id of lectureIds) {
      const lec = this.entities.getOfKind('lecture', id);
      const summary = lec?.extra?.summary;
      if (lec && typeof summary === 'string')
        notes.push({
          id: lec.id,
          kind: 'summary',
          title: lec.title ?? l.date,
          text: summary,
          keyPoints: lec.topics,
          origin: 'extracted',
          citations: this.citationsFor([lec.id]),
        });
    }
    if (ids.length > 0)
      for (const d of this.entities.list('document', { where: { courseOfferingId: ids } })) {
        const x = d.extra;
        if (x?.recorded !== true) continue;
        const lectureId = typeof x.lectureId === 'string' ? x.lectureId : undefined;
        // record_lecture's own summary document is already listed as the lecture's summary.
        if (lectureId && x.summaryOf === lectureId) continue;
        const here = lectureId ? lectureIds.has(lectureId) : x.lectureDate === l.date;
        if (!here) continue;
        notes.push({
          id: d.id,
          kind: 'note',
          title: d.title,
          text: d.text ?? '',
          keyPoints: [],
          origin: 'extracted',
          citations: this.citationsFor([d.id]),
        });
      }
    const session = sessionEntity ? this.classItem(sessionEntity) : undefined;
    const slides = materials
      .filter((m) => m.materialKind !== 'recording')
      .map((m) => this.materialItem(m));
    const recordings = materials
      .filter((m) => m.materialKind === 'recording')
      .map((m) => this.materialItem(m));
    return {
      lectureId: lecture?.id,
      date: l.date,
      title: lecture?.title ?? (course ? `${course.title} ${l.date}` : undefined),
      course,
      session,
      slides,
      recordings,
      transcript: segments,
      announcements,
      questions,
      facts,
      notes,
      citations: uniqueCitations([
        ...this.citationsFor([...lectureIds, ...transcripts.map((t) => t.id)]),
        ...(session?.citations ?? []),
        ...slides.flatMap((s) => s.citations),
        ...segments.slice(0, 3).flatMap((s) => s.citations),
      ]),
    };
  }

  examPreparation(
    options: { examId?: string; courseOfferingId?: string } = {},
  ): ExamPreparationContext {
    const now = this.now();
    let exams: Exam[];
    if (options.examId) {
      const e = this.entities.getOfKind('exam', options.examId);
      exams = e ? [e] : [];
    } else {
      const ids = options.courseOfferingId
        ? this.identity.expand(options.courseOfferingId)
        : undefined;
      exams = this.entities
        .listInRange(
          'exam',
          'startsAt',
          now.toISOString(),
          addZonedDays(now, 60, this.timezone).toISOString(),
        )
        .filter(
          (e) => !ids || (e.courseOfferingId !== undefined && ids.includes(e.courseOfferingId)),
        );
    }
    const items = exams.map((e) => {
      const task = this.tasks.list().find((t) => t.examId === e.id);
      const base: DeadlineItem =
        (task && this.deadlineItem(task)) ??
        ({
          taskId: '',
          kind: 'exam_preparation',
          title: e.title,
          course: this.courseRef(e.courseOfferingId),
          dueAt: e.startsAt ?? '',
          status: 'unknown',
          origin: 'authoritative',
          overdue: false,
          hoursLeft: e.startsAt ? (new Date(e.startsAt).getTime() - now.getTime()) / 3_600_000 : 0,
          evidence: undefined,
          summary: e.title,
          citations: this.citationsFor([e.id]),
        } satisfies DeadlineItem);
      const at = e.startsAt ? new Date(e.startsAt) : undefined;
      return {
        ...base,
        examId: e.id,
        room: this.resolvedValue<string>(
          this.resolver.resolve([e.id], 'room', at ? { at } : {}),
          e.room,
        ),
        scope: e.scope,
        daysLeft: e.startsAt
          ? Math.ceil((new Date(e.startsAt).getTime() - now.getTime()) / DAY)
          : 0,
        citations: uniqueCitations([...this.citationsFor([e.id]), ...base.citations]),
      };
    });
    const courseIds = [
      ...new Set(
        exams.flatMap((e) => (e.courseOfferingId ? this.identity.expand(e.courseOfferingId) : [])),
      ),
    ];
    const announcements = this.entities
      .list('announcement', { where: { courseOfferingId: courseIds } })
      .filter((a) => /試験|テスト|exam|範囲/i.test(`${a.title}${a.body}`))
      .map((a) => this.announcementItem(a));
    const transcriptMentions: SegmentItem[] = [];
    if (this.search && courseIds.length) {
      for (const h of this.search.lexical(['試験'], { kinds: ['lectureSegment'] })) {
        if (h.courseOfferingId && !courseIds.includes(h.courseOfferingId)) continue;
        const s = this.entities.getOfKind('lectureSegment', h.id);
        if (s)
          transcriptMentions.push({
            id: s.id,
            startMs: s.startMs,
            timestamp: hms(s.startMs),
            speaker: s.speaker,
            text: s.text,
            citations: h.citations,
          });
      }
    }
    return {
      ...this.base('exam-preparation'),
      exams: items,
      announcements,
      transcriptMentions,
      materials: this.materialsFor(courseIds),
    };
  }

  /** Administrative overview: university notices, source health, things awaiting the user's confirmation. */
  admin(): AdminContext {
    const now = this.now();
    const stores = createStores(this.db, this.clock);
    const raw = new RawStore(this.db, { clock: this.clock });
    const sources: SourceStatus[] = raw.listSources().map((s) => {
      const h = stores.health.get(s.id);
      const v = stores.versions.latest(s.id);
      return {
        sourceId: s.id,
        displayName: s.displayName,
        state: h?.state ?? 'unknown',
        message: h?.message,
        lastSyncAt: s.lastSyncAt,
        lastSuccessAt: h?.lastSuccessAt,
        detectedVersion: v?.version ?? h?.detectedVersion,
        versionKnown: v?.known,
        openDrift: stores.drift.list({ sourceId: s.id, unresolvedOnly: true }).length,
      };
    });
    return {
      ...this.base('admin'),
      universityAnnouncements: this.announcementsBetween(
        new Date(now.getTime() - 14 * DAY),
        new Date(now.getTime() + 1),
        (a) => a.scope === 'university' || a.scope === 'faculty',
      ),
      sources,
      conflicts: this.openConflicts(),
      pendingLinks: this.identity.listLinks({ status: 'suggested' }),
      unscheduledWithoutPace: this.currentTermOfferings().flatMap((e) => {
        if (e.scheduleType === 'regular' || this.tasks.schedule.paceSlots(e.ids).length > 0)
          return [];
        const course = this.courseRef(e.offering.id);
        return course ? [{ course, scheduleType: e.scheduleType }] : [];
      }),
    };
  }

  /** Day-of-week helper for callers rendering timetables. */
  weekdayOf(date: string): number {
    return zonedParts(parseZonedDate(date, this.timezone), this.timezone).weekday;
  }
}

/** A conflict candidate's value in one line: a deadline value by its phrase, else as JSON text. */
function conflictValueText(v: JsonValue): string {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (typeof v.phrase === 'string') return v.phrase;
    return JSON.stringify(v);
  }
  return String(v);
}
