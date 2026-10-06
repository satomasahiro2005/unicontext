import type {
  ChangeEventType,
  EntityKind,
  FactOrigin,
  HealthState,
  IdentityLink,
  Importance,
  JsonValue,
  TaskStatus,
} from '@unicontext/canonical-model';
import type { Citation } from '@unicontext/provenance';
import type { DeadlineCoverage } from './coverage.js';
import type { EstimatedDue } from './estimate.js';
import type { NextActionSummary } from './next-action.js';

export type { Citation } from '@unicontext/provenance';

/** Every bundle item carries citations back to the source (§49, §75). */
export interface Cited {
  citations: Citation[];
}

export interface CourseRef {
  /** Canonical course offering id (identity-resolved, §14). */
  id: string;
  title: string;
  courseCode: string | undefined;
  /** All linked ids across sources. */
  linkedIds: string[];
}

export interface ValueCandidate {
  value: JsonValue;
  origin: FactOrigin;
  authority: string;
  source: string;
  observedAt: string;
  citation: Citation | undefined;
}

/** A value after conflict resolution (§12). status "conflict" means sources disagree — say so. */
export interface ResolvedValue<T extends JsonValue = JsonValue> {
  value: T | undefined;
  status: 'resolved' | 'conflict' | 'none';
  origin: FactOrigin | undefined;
  method: string | undefined;
  candidates: ValueCandidate[];
}

/**
 * Academic term of a date. Terms (前期 / 後期) may be split into halves of about 8 class weeks
 * (前半 / 後半); `part` names the half the date is in (e.g. 後期前半).
 */
export interface TermOfDate {
  id: string;
  name: string;
  /** e.g. 後期前半; absent when the term has no halves or the date is outside both. */
  part?: string | undefined;
  /** Switch-over weeks: which half a class is in depends on its weekday. */
  partNote?: string | undefined;
}

export interface ClassItem extends Cited {
  sessionId: string;
  course: CourseRef;
  date: string;
  period: number | undefined;
  startsAt: string | undefined;
  endsAt: string | undefined;
  room: ResolvedValue<string>;
  status: ResolvedValue<string>;
  cancelled: boolean;
  note: string | undefined;
  /** class = a meeting of the course; self_study = the student's own study slot (自習). */
  sessionKind: 'class' | 'self_study';
  /**
   * Halves of the term the course meets in: 後期前半 / 後期後半 (half-term course, about 8 weeks)
   * or 後期（前半・後半） (whole term). Absent when no source states it.
   */
  termPart?: string | undefined;
  /** One-line explanation with the source, e.g. "2限 データベースシステム論 / 教室: 21教室（根拠: 学務情報システム 10/1 09:42取得）". */
  summary: string;
  /**
   * The meeting as the academic system's timetable (and its notices) says it, before the
   * student's personal conditions. Undefined when the meeting exists only in a group schedule
   * (a B-group Friday of a course the timetable lists on Monday).
   */
  rawSchedule?: RawSchedule | undefined;
  /** The meeting for this student, after personal conditions (group …). */
  effectiveSchedule: EffectiveSchedule;
  // stream D
  /**
   * An instructor's post says this meeting is in another room but names no fact-grade day (「次回は
   * 21教室」, a post without a day). `room` shows both values as a conflict; this says who said what.
   */
  roomHint?: RoomHintInfo | undefined;
  /** The room as a place (building, campus) and the Location id derived from it; absent without a room. */
  place?: PlaceInfo | undefined;
  locationId?: string | undefined;
  /** The trip from the previous meeting of the day (or from home) when the student told its length. */
  travelFromPrevious?: TravelInfo | undefined;
}

/** An unconfirmed room from an announcement (`extra.roomHint`), resolved to one meeting. */
export interface RoomHintInfo {
  /** The room the post names. */
  room: string;
  announcementId: string;
  title: string;
  postedAt: string | undefined;
  /** How the meeting was chosen: the day the post names, or the next meeting after the post. */
  basis: 'named-day' | 'next-session';
  /** The room the timetable / facts give for the meeting (absent when none). */
  otherRoom: string | undefined;
  citations: Citation[];
}

export interface RawSchedule {
  date: string;
  period: number | undefined;
  startsAt: string | undefined;
  endsAt: string | undefined;
  room: string | undefined;
  /** 「学務情報システムの時間割」 or the stored session's source. */
  source: string;
}

/** Whether the student attends a meeting: attending, not_attending (another group's day), unknown. */
export type AttendanceStatus = 'attending' | 'not_attending' | 'unknown';

/**
 * Where a personal condition or a group schedule comes from: university = the academic system,
 * document = a synced document / post (配布スケジュール), chat = the student said it in a chat,
 * recording = heard in a lecture recording, student = confirmed by the student.
 */
export type ConditionProvenance = 'university' | 'document' | 'chat' | 'recording' | 'student';

export interface ConditionValueView {
  value: string;
  provenance: ConditionProvenance;
  /** Confirmed by the student (or stated by the university). */
  confirmed: boolean;
  source: string;
  evidence: string | undefined;
}

export interface EffectiveSchedule {
  status: AttendanceStatus;
  /** Why (「Aグループの実施日（本人はBグループ）」); absent when no personal condition applies. */
  reason?: string | undefined;
  date: string;
  period: number | undefined;
  startsAt: string | undefined;
  endsAt: string | undefined;
  room: string | undefined;
  /** The student's group the decision used (unknown → absent). */
  group?: ConditionValueView | undefined;
  /** Groups the schedule assigns this date to. */
  sessionGroups?: string[] | undefined;
  /** Meeting number in the group schedule (#03 → 3). */
  number?: number | undefined;
  topic?: string | undefined;
  /** Where the date rule comes from and the table line. */
  rule?:
    | {
        provenance: ConditionProvenance;
        confirmed: boolean;
        source: string;
        documentTitle: string | undefined;
        evidence: string | undefined;
      }
    | undefined;
  /** Sources that disagree about the group or the date (both are shown, none is picked silently). */
  conflicts?: { about: 'group' | 'session_rule'; values: { value: string; source: string }[] }[];
  citations: Citation[];
}

/**
 * The item rests only on what an AI client wrote through an MCP write tool — heard in a lecture
 * recording (「録音から」) or told / created in a chat (「チャットで登録」) — and the owner has not
 * confirmed it yet: show the label with the evidence. Every client and session sees these items.
 */
export interface RecordedMarker {
  label: '録音から' | 'チャットで登録';
  /** recording = heard in a lecture recording, chat = told / created in a chat. */
  via: 'recording' | 'chat';
  additionId: string | undefined;
  /** e.g. "ChatGPT Record", "ChatGPTとの会話" */
  source: string;
  /** "HH:MM:SS" in the recording */
  timestamp: string | undefined;
  evidence: string | undefined;
  confirmed: false;
}

export interface DeadlineItem extends Cited {
  taskId: string;
  kind: 'assignment' | 'exam_preparation' | 'extracted' | 'manual' | 'weekly_pace';
  title: string;
  course: CourseRef | undefined;
  dueAt: string;
  status: TaskStatus;
  origin: FactOrigin;
  overdue: boolean;
  hoursLeft: number;
  evidence: string | undefined;
  summary: string;
  /** Present when the deadline comes only from an AI client (recording or chat), unconfirmed. */
  recorded?: RecordedMarker | undefined;
  /**
   * What the student told in a chat / a recording said about this assignment (a to-do linked to
   * it: 「〔チャットで登録「レポート1：…」〕…」). Its due date and status are the source's.
   */
  details?: string | undefined;
}

/**
 * Open work whose due date is unknown, with an estimate: 「推定」, the earliest plausible deadline
 * with its basis and range (estimate.ts). Never a stated deadline: listed apart from DeadlineItem,
 * and always said as 推定 with where to confirm.
 */
export interface EstimatedDeadlineItem extends Cited {
  taskId: string;
  kind: DeadlineItem['kind'];
  title: string;
  course: CourseRef | undefined;
  status: TaskStatus;
  origin: FactOrigin;
  estimatedDue: EstimatedDue;
  /** Hours until the estimate (negative: the estimate is past — confirm now). */
  hoursLeft: number;
  evidence: string | undefined;
  /** 「【推定】データベース: レポート1 締切不明・推定 10/8 10:20〜…（根拠…）。要確認: …」 */
  summary: string;
  recorded?: RecordedMarker | undefined;
}

export interface TaskItem extends Cited {
  taskId: string;
  title: string;
  course: CourseRef | undefined;
  dueAt: string | undefined;
  /** Unknown due date of work with a deadline: the estimate (「推定」). */
  estimatedDue?: EstimatedDue | undefined;
  status: TaskStatus;
  taskKind: string;
  origin: FactOrigin;
  createdBy: string;
  recorded?: RecordedMarker | undefined;
}

export interface ChangeItem extends Cited {
  id: string;
  entityId: string;
  entityKind: EntityKind;
  type: ChangeEventType;
  summary: string;
  changedFields: string[];
  before: Record<string, JsonValue> | null;
  after: Record<string, JsonValue> | null;
  occurredAt: string;
  observedAt: string;
  course: CourseRef | undefined;
  /** How many events about this entity were folded into this item (when more than one). */
  eventCount?: number | undefined;
}

/**
 * Views list changes compactly (change-digest.ts): one item per entity, the decisive ones first,
 * capped; `changesTotal` is how many there were, `changesOmitted` how many were left out.
 */
export interface ChangeDigest {
  changes: ChangeItem[];
  changesTotal?: number | undefined;
  changesOmitted?: number | undefined;
}

export interface AnnouncementItem extends Cited {
  id: string;
  title: string;
  body: string;
  publishedAt: string | undefined;
  importance: Importance;
  scope: string;
  author: string | undefined;
  course: CourseRef | undefined;
  category: string | undefined;
  /** Read state mirrored from the source system (true = read). Undefined = unknown / not tracked. */
  read: boolean | undefined;
  /**
   * UniContext's own unread flag (what to show as 未読): the user's mark in UniContext when set,
   * else `read === false` or UniContext itself opened it while unread at the source (a notice whose
   * body the sync or a request fetched stays unread here until read in UniContext).
   */
  unread: boolean;
  /** 'fetched' | 'notOpened' | 'pending' from the connector. 'notOpened' = unread at the source and the source opted out of opening unread notices; 'pending' = a later sync fetches it. */
  bodyStatus: string | undefined;
  attachments: AnnouncementAttachment[];
}

export interface AnnouncementAttachment {
  name: string;
  size?: number;
}

/** One announcement with its full (untruncated) body and detail-screen fields. */
export interface AnnouncementDetail extends AnnouncementItem {
  url: string | undefined;
  /** URLs found in the body. */
  links: string[];
  /** 講義名 targets from the detail screen. */
  courses: string[];
  /** 対象日 (YYYY-MM-DD). */
  targetDate: string | undefined;
}

export interface MaterialItem extends Cited {
  id: string;
  title: string;
  materialKind: string;
  url: string | undefined;
  publishedAt: string | undefined;
  documentId: string | undefined;
}

/** One post of a thread-based platform (Teams channel, forum): an announcement or a message. */
export interface DiscussionItem extends Cited {
  id: string;
  kind: 'announcement' | 'message';
  /** Post subject / announcement title, when there is one. */
  title: string | undefined;
  /** Plain text trimmed to 400 characters. */
  body: string;
  author: string | undefined;
  authorRole: string | undefined;
  sentAt: string | undefined;
  /** Thread (channel) title. */
  channel: string | undefined;
  platform: string | undefined;
  url: string | undefined;
  isReply: boolean;
  attachments: { name: string; url: string | undefined }[];
}

/** A file of the course's shared library (Teams SharePoint), with its folder. */
export interface CourseFileItem extends Cited {
  id: string;
  title: string;
  /** Library-relative path, e.g. "/00_講義資料/week1.pdf". */
  path: string | undefined;
  /** Folder without leading or trailing slash; '' = library root. */
  folder: string;
  channel: string | undefined;
  sizeBytes: number | undefined;
  modifiedAt: string | undefined;
  modifiedBy: string | undefined;
  url: string | undefined;
  mimeType: string | undefined;
  /** Kind of the material that points at this file, if any. */
  materialKind: string | undefined;
}

/** An assignment of a course with the student's submission state (all, not only upcoming). */
export interface CourseAssignmentItem extends Cited {
  id: string;
  title: string;
  dueAt: string | undefined;
  availableFrom: string | undefined;
  points: number | undefined;
  /** Status of the submission entity for this assignment; undefined when there is none. */
  status: 'not_submitted' | 'submitted' | 'late' | 'graded' | 'returned' | undefined;
  submittedAt: string | undefined;
  url: string | undefined;
  sourceId: string | undefined;
}

/** Whether the student takes a course, per the academic system and per the student. */
export interface CourseEnrollmentView {
  academic: 'active' | 'dropped' | 'none';
  declaration?:
    | {
        value: 'not_taking' | 'taking';
        confirmed: boolean;
        provenance: 'student' | 'chat' | 'recording';
        evidence: string | undefined;
        source: string;
        declaredAt: string;
      }
    | undefined;
  /** What the views use (the declaration wins over the academic status). */
  taken: boolean;
}

/**
 * The student's unconfirmed word and the academic system disagree about taking a course. The
 * views follow the student; this one line says so (「学務では履修中、本人は履修していないと登録」).
 */
export interface EnrollmentNote extends Cited {
  course: CourseRef;
  academic: 'active' | 'dropped';
  declared: 'not_taking' | 'taking';
  confirmed: false;
  evidence?: string;
  note: string;
}

export interface ConflictItem extends Cited {
  id: string;
  subject: string;
  subjectLabel: string;
  predicate: string;
  detectedAt: string;
  candidates: ValueCandidate[];
  /** Plain statement for the AI: the sources disagree. */
  note: string;
}

export interface PreparationItem extends Cited {
  sessionId: string;
  course: CourseRef;
  startsAt: string | undefined;
  /** Newest first, at most 10. */
  materials: MaterialItem[];
  /** How many materials there were when `materials` was cut short. */
  materialsTotal?: number | undefined;
  dueBeforeClass: DeadlineItem[];
  announcements: AnnouncementItem[];
}

export interface SegmentItem extends Cited {
  id: string;
  startMs: number;
  /** "HH:MM:SS" */
  timestamp: string;
  speaker: string | undefined;
  text: string;
}

export interface QuestionItem extends Cited {
  id: string;
  author: string | undefined;
  body: string;
  sentAt: string | undefined;
}

export interface FactItem extends Cited {
  id: string;
  subject: string;
  predicate: string;
  value: JsonValue;
  origin: FactOrigin;
  confidence: number;
  evidence: string | undefined;
}

/** Lecture aggregation (§21): session, slides, transcript, recording, announcements, questions, facts. */
export interface LectureBundle extends Cited {
  lectureId: string | undefined;
  date: string;
  title: string | undefined;
  course: CourseRef | undefined;
  session: ClassItem | undefined;
  slides: MaterialItem[];
  recordings: MaterialItem[];
  transcript: SegmentItem[];
  announcements: AnnouncementItem[];
  questions: QuestionItem[];
  facts: FactItem[];
  /** Summaries and notes an AI client wrote from the recording (origin extracted, unconfirmed until the owner confirms). */
  notes: LectureNoteItem[];
}

export interface LectureNoteItem extends Cited {
  id: string;
  kind: 'summary' | 'note';
  title: string;
  text: string;
  keyPoints: string[];
  origin: 'extracted';
}

export interface BundleBase<V extends string> {
  view: V;
  generatedAt: string;
  timezone: string;
}

export interface DayContext<V extends 'today' | 'tomorrow'> extends BundleBase<V> {
  date: string;
  classes: ClassItem[];
  changes: ChangeItem[];
  /** Relevant changes before the cap / how many of them are not listed (see ChangeDigest). */
  changesTotal?: number | undefined;
  changesOmitted?: number | undefined;
  deadlines: DeadlineItem[];
  tasks: TaskItem[];
  importantAnnouncements: AnnouncementItem[];
  preparation: PreparationItem[];
  conflicts: ConflictItem[];
  /** Courses the student says they (do not) take against the academic system, unconfirmed. */
  enrollmentNotes?: EnrollmentNote[] | undefined;
  /** Current term (and half: 前半 / 後半) of the academic calendar, if the date is inside one. */
  term?: TermOfDate | undefined;
  /** Why there are no classes (学期外, 未登録, 祝日 …) when `classes` is empty. */
  noClassesReason?: string | undefined;
  /**
   * Meetings the timetable lists on this date that are not the student's (another group's day,
   * a 休講 of the group schedule), with the reason: shown, never silently dropped.
   */
  notAttending?: ClassItem[] | undefined;
  // stream D
  /** The day's calendar events (Outlook …): busy time that is not a class, with location. */
  events?: CalendarEventItem[] | undefined;
  /** Events that overlap a class or each other. */
  overlaps?: ScheduleOverlap[] | undefined;
}
/** The student's own weekly self-study slot of an offering (自習), as stored and as text. */
export interface PaceSlotView {
  /** 0 = Sunday … 6 = Saturday */
  dayOfWeek: number;
  startTime: string | undefined;
  endTime: string | undefined;
  period: number | undefined;
  /** "土 10:00-11:30" / "土2限" */
  text: string;
}

/** An offering the student is falling behind in (時間割外・集中講義 without a weekly class). */
export interface PaceItem {
  course: CourseRef;
  /** Consecutive past weeks whose 「今週分」 task is not completed. */
  behindWeeks: number;
  /** Past-due assignments that are still open. */
  unsubmitted: number;
  /** Self-study slots, "土 10:00-11:30". */
  slots: string[];
  message: string;
}

/** One row of the pacing overview (`unicontext pace list`, GET /api/v1/pace). */
export interface PaceCourseItem {
  course: CourseRef;
  scheduleType: 'regular' | 'unscheduled' | 'intensive';
  enrolled: boolean;
  slots: PaceSlotView[];
  /** This week's 「今週分」 task, if there is one. */
  thisWeek: { taskId: string; status: TaskStatus; dueAt: string } | undefined;
  behindWeeks: number;
  unsubmitted: number;
}

export interface PaceOverview {
  courses: PaceCourseItem[];
}

export interface TodayContext extends DayContext<'today'> {
  /** Offerings the student is behind in; empty when on track. */
  pacing: PaceItem[];
  /** Which sources the deadlines come from and what is missing (never read "none" as "no deadline"). */
  coverage: DeadlineCoverage;
  /** What to do now (next-action engine), compact. */
  next?: NextActionSummary | undefined;
}
export type TomorrowContext = DayContext<'tomorrow'>;

export interface WeekContext extends BundleBase<'week'> {
  from: string;
  to: string;
  days: {
    date: string;
    classes: ClassItem[];
    noClassesReason?: string | undefined;
    /** Timetable meetings of the day that are not the student's (see DayContext.notAttending). */
    notAttending?: ClassItem[] | undefined;
  }[];
  term?: TermOfDate | undefined;
  deadlines: DeadlineItem[];
  exams: DeadlineItem[];
  coverage: DeadlineCoverage;
  changes: ChangeItem[];
  /** Relevant changes before the cap / how many of them are not listed (see ChangeDigest). */
  changesTotal?: number | undefined;
  changesOmitted?: number | undefined;
  conflicts: ConflictItem[];
  /** See DayContext.enrollmentNotes. */
  enrollmentNotes?: EnrollmentNote[] | undefined;
  /** What to do now (next-action engine), compact. */
  next?: NextActionSummary | undefined;
  // stream D
  /** The week's calendar events, with location (see DayContext.events). */
  events?: CalendarEventItem[] | undefined;
  /** Events that overlap a class or each other. */
  overlaps?: ScheduleOverlap[] | undefined;
}

export interface CourseContext extends BundleBase<'course'> {
  course: CourseRef;
  instructors: string[];
  schedule: {
    dayOfWeek: number;
    period: number | undefined;
    room: string | undefined;
    /** Half of the term this slot meets in when it differs between slots (後期前半 …). */
    termPart?: string | undefined;
  }[];
  /** regular (weekly), unscheduled (時間割外) or intensive (集中講義). */
  scheduleType: 'regular' | 'unscheduled' | 'intensive';
  /** Academic year / term label and the profile term id when known. */
  academicYear: number | undefined;
  term: string | undefined;
  termId: string | undefined;
  /**
   * Halves of the term the course meets in: 後期前半 / 後期後半 (about 8 weeks) or 後期（前半・後半）;
   * absent when no source states it (then it runs the whole term).
   */
  termPart?: string | undefined;
  /** Where termPart comes from (学務情報システム per-slot text, or the syllabus 開講時期). */
  termPartCitations?: Citation[] | undefined;
  /**
   * The student takes it: the academic system lists it as theirs, unless the student says they do
   * not take it (or the system dropped it and the student says they do) — see `enrollment`.
   */
  enrolled: boolean;
  /** The academic system's enrollment and the student's own declaration (condition:enrollment). */
  enrollment?: CourseEnrollmentView | undefined;
  /** 再履修 class. */
  retake: boolean;
  /** The student's own self-study slots (pace_slots). */
  paceSlots: PaceSlotView[];
  room: ResolvedValue<string>;
  sources: { id: string; sourceId: string | undefined; citations: Citation[] }[];
  upcomingClasses: ClassItem[];
  recentLectures: LectureBundle[];
  deadlines: DeadlineItem[];
  /** Which sources this course's deadlines come from and what is missing. */
  coverage: DeadlineCoverage;
  announcements: AnnouncementItem[];
  materials: MaterialItem[];
  /** Newest 20 posts (announcements and messages) of thread-based platforms for the course. */
  discussion: DiscussionItem[];
  /** Files of the course (folder, then title), at most 200; `filesTotal` is the full count. */
  files: CourseFileItem[];
  filesTotal: number;
  /** All assignments of the course, newest due first. */
  assignments: CourseAssignmentItem[];
  changes: ChangeItem[];
  /** Relevant changes before the cap / how many of them are not listed (see ChangeDigest). */
  changesTotal?: number | undefined;
  changesOmitted?: number | undefined;
  conflicts: ConflictItem[];
  pendingLinks: IdentityLink[];
}

export interface TeamsActivityContext extends BundleBase<'teams-activity'> {
  since: string;
  posts: DiscussionItem[];
  files: CourseFileItem[];
  assignments: CourseAssignmentItem[];
  conflicts: ConflictItem[];
}

export interface CourseFolderItem {
  name: string;
  /** Folder path without leading or trailing slash. */
  path: string;
  /** Files in the folder and everything below it. */
  fileCount: number;
}

export interface CourseFilesContext extends BundleBase<'course-files'> {
  course: CourseRef;
  /** Normalized folder path ('' = library root). */
  path: string;
  folders: CourseFolderItem[];
  files: CourseFileItem[];
}

export interface DeadlineContext extends BundleBase<'deadline'> {
  overdue: DeadlineItem[];
  upcoming: DeadlineItem[];
  /**
   * Open work with an unknown due date, by estimate (earliest first). Estimates, not deadlines:
   * say 「推定」 with the basis and where to confirm.
   */
  estimated: EstimatedDeadlineItem[];
  coverage: DeadlineCoverage;
}

export interface ChangesContext extends BundleBase<'changes'> {
  since: string;
  changes: ChangeItem[];
  /** Relevant changes before the cap / how many of them are not listed (see ChangeDigest). */
  changesTotal?: number | undefined;
  changesOmitted?: number | undefined;
  conflicts: ConflictItem[];
}

export interface ClassPreparationContext extends BundleBase<'class-preparation'> {
  session: ClassItem | undefined;
  preparation: PreparationItem | undefined;
  previousLecture: LectureBundle | undefined;
}

export interface ClassReviewContext extends BundleBase<'class-review'> {
  lecture: LectureBundle | undefined;
  nextDeadlines: DeadlineItem[];
}

export interface ExamPreparationContext extends BundleBase<'exam-preparation'> {
  exams: (DeadlineItem & {
    examId: string;
    room: ResolvedValue<string>;
    scope: string | undefined;
    daysLeft: number;
  })[];
  announcements: AnnouncementItem[];
  transcriptMentions: SegmentItem[];
  materials: MaterialItem[];
}

export interface SourceStatus {
  sourceId: string;
  displayName: string | undefined;
  state: HealthState | 'unknown';
  message: string | undefined;
  lastSyncAt: string | undefined;
  lastSuccessAt: string | undefined;
  detectedVersion: string | undefined;
  versionKnown: boolean | undefined;
  openDrift: number;
}

export interface AdminContext extends BundleBase<'admin'> {
  universityAnnouncements: AnnouncementItem[];
  sources: SourceStatus[];
  conflicts: ConflictItem[];
  pendingLinks: IdentityLink[];
  /** Enrolled 時間割外 / 集中講義 courses of the current term without self-study slots. */
  unscheduledWithoutPace: { course: CourseRef; scheduleType: 'unscheduled' | 'intensive' }[];
}

// stream D: calendar events, places and travel

/** A room or an event's location as a place (places.ts): building, campus, and its Location id. */
export interface PlaceInfo {
  building?: string | undefined;
  room: string;
  campus?: string | undefined;
  locationId: string;
}

/** A trip the student told UniContext about (set_travel_time), shown on the meeting it leads to. */
export interface TravelInfo {
  minutes: number;
  /** 自宅 or the place of the previous meeting. */
  from: string;
  mode?: string | undefined;
  citations: Citation[];
}

/** One busy stretch: a class, a calendar event, or the trip before one of them. */
export interface BusyItem {
  id: string;
  kind: 'class' | 'event' | 'travel';
  title: string;
  /** ISO instants. */
  start: string;
  end: string;
  location?: string | undefined;
  citations: Citation[];
}

/** Two busy stretches that overlap, and for how long. */
export interface ScheduleOverlap {
  a: BusyItem;
  b: BusyItem;
  minutes: number;
  /** 「13:00-14:00 ゼミ（工5-22）が 2限 データベース と20分重なっています」 */
  summary: string;
  citations: Citation[];
}

/** A calendar event (not an all-day or holiday entry) as the views list it. */
export interface CalendarEventItem extends Cited {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | undefined;
  location?: string | undefined;
  place?: PlaceInfo | undefined;
  category?: string | undefined;
  url?: string | undefined;
  travelFromPrevious?: TravelInfo | undefined;
  summary: string;
}
