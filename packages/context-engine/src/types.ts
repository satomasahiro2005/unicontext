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
  /** One-line explanation with the source, e.g. "2限 データベースシステム論 / 教室: 21教室（根拠: 学務情報システム 10/1 09:42取得）". */
  summary: string;
}

/**
 * The item was only heard in a lecture recording (an AI client wrote it through an MCP write
 * tool) and the owner has not confirmed it yet: show 「録音から」 with the evidence.
 */
export interface RecordedMarker {
  label: '録音から';
  additionId: string | undefined;
  /** e.g. "ChatGPT Record" */
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
  /** Present when the deadline comes only from a lecture recording and is not confirmed yet. */
  recorded?: RecordedMarker | undefined;
}

export interface TaskItem extends Cited {
  taskId: string;
  title: string;
  course: CourseRef | undefined;
  dueAt: string | undefined;
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
   * UniContext's own unread flag (what to show as 未読): the user's mark in UniContext when set —
   * a notice fetched on request stays unread here until read in UniContext — else `read === false`.
   */
  unread: boolean;
  /** 'fetched' | 'notOpened' | 'pending' from the connector. 'notOpened' = unread at the source, body deliberately not fetched. */
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
  materials: MaterialItem[];
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
  deadlines: DeadlineItem[];
  tasks: TaskItem[];
  importantAnnouncements: AnnouncementItem[];
  preparation: PreparationItem[];
  conflicts: ConflictItem[];
  /** Current term of the academic calendar, if the date is inside one. */
  term?: { id: string; name: string } | undefined;
  /** Why there are no classes (学期外, 未登録, 祝日 …) when `classes` is empty. */
  noClassesReason?: string | undefined;
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
}
export type TomorrowContext = DayContext<'tomorrow'>;

export interface WeekContext extends BundleBase<'week'> {
  from: string;
  to: string;
  days: { date: string; classes: ClassItem[]; noClassesReason?: string | undefined }[];
  term?: { id: string; name: string } | undefined;
  deadlines: DeadlineItem[];
  exams: DeadlineItem[];
  changes: ChangeItem[];
  conflicts: ConflictItem[];
}

export interface CourseContext extends BundleBase<'course'> {
  course: CourseRef;
  instructors: string[];
  schedule: { dayOfWeek: number; period: number | undefined; room: string | undefined }[];
  /** regular (weekly), unscheduled (時間割外) or intensive (集中講義). */
  scheduleType: 'regular' | 'unscheduled' | 'intensive';
  /** Academic year / term label and the profile term id when known. */
  academicYear: number | undefined;
  term: string | undefined;
  termId: string | undefined;
  /** The student is enrolled (the academic system lists it as theirs). */
  enrolled: boolean;
  /** 再履修 class. */
  retake: boolean;
  /** The student's own self-study slots (pace_slots). */
  paceSlots: PaceSlotView[];
  room: ResolvedValue<string>;
  sources: { id: string; sourceId: string | undefined; citations: Citation[] }[];
  upcomingClasses: ClassItem[];
  recentLectures: LectureBundle[];
  deadlines: DeadlineItem[];
  announcements: AnnouncementItem[];
  materials: MaterialItem[];
  changes: ChangeItem[];
  conflicts: ConflictItem[];
  pendingLinks: IdentityLink[];
}

export interface DeadlineContext extends BundleBase<'deadline'> {
  overdue: DeadlineItem[];
  upcoming: DeadlineItem[];
}

export interface ChangesContext extends BundleBase<'changes'> {
  since: string;
  changes: ChangeItem[];
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
