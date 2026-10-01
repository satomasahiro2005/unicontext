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
  /** One-line explanation with the source, e.g. "2限 データベースシステム論 / 教室: 21教室（根拠: 学務情報システム 10/1 09:42取得）". */
  summary: string;
}

export interface DeadlineItem extends Cited {
  taskId: string;
  kind: 'assignment' | 'exam_preparation' | 'extracted' | 'manual';
  title: string;
  course: CourseRef | undefined;
  dueAt: string;
  status: TaskStatus;
  origin: FactOrigin;
  overdue: boolean;
  hoursLeft: number;
  evidence: string | undefined;
  summary: string;
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
}
export type TodayContext = DayContext<'today'>;
export type TomorrowContext = DayContext<'tomorrow'>;

export interface WeekContext extends BundleBase<'week'> {
  from: string;
  to: string;
  days: { date: string; classes: ClassItem[] }[];
  deadlines: DeadlineItem[];
  exams: DeadlineItem[];
  changes: ChangeItem[];
  conflicts: ConflictItem[];
}

export interface CourseContext extends BundleBase<'course'> {
  course: CourseRef;
  instructors: string[];
  schedule: { dayOfWeek: number; period: number | undefined; room: string | undefined }[];
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
}
