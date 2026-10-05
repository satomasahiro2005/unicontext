import { z } from 'zod';
import { ExtraSchema, IsoDateTimeSchema, LocalDateSchema, LocalTimeSchema } from './common.js';
import { type EntityKind, idSchema } from './ids.js';

const base = <K extends EntityKind>(kind: K) => ({
  id: idSchema(kind),
  kind: z.literal(kind),
  extra: ExtraSchema,
});

export const UniversitySchema = z.object({
  ...base('university'),
  name: z.string().min(1),
  shortName: z.string().optional(),
  timezone: z.string().optional(),
});

export const CampusSchema = z.object({
  ...base('campus'),
  universityId: idSchema('university').optional(),
  name: z.string().min(1),
  address: z.string().optional(),
});

export const AcademicTermSchema = z.object({
  ...base('academicTerm'),
  universityId: idSchema('university').optional(),
  name: z.string().min(1),
  academicYear: z.number().int(),
  /** Free-form term code such as "前期", "後期", "spring". */
  termCode: z.string().optional(),
  startsOn: LocalDateSchema.optional(),
  endsOn: LocalDateSchema.optional(),
});

export const PersonRoleSchema = z.enum(['student', 'instructor', 'ta', 'staff', 'other']);
export const PersonSchema = z.object({
  ...base('person'),
  name: z.string().min(1),
  nameKana: z.string().optional(),
  email: z.string().optional(),
  roles: z.array(PersonRoleSchema).default([]),
  /** True for the user running UniContext. */
  isSelf: z.boolean().optional(),
});

/** The abstract course ("データベースシステム論"), independent of year/teacher/timeslot (§8). */
export const CourseSchema = z.object({
  ...base('course'),
  universityId: idSchema('university').optional(),
  courseCode: z.string().optional(),
  title: z.string().min(1),
  titleEn: z.string().optional(),
  department: z.string().optional(),
  credits: z.number().optional(),
});

/**
 * Half of a term (前半 / 後半, about 8 class weeks each). Universities such as Shizuoka split each
 * 前期 / 後期 into halves; a course meets in one of them or in both.
 */
export const TermHalfSchema = z.enum(['前半', '後半']);
export type TermHalf = z.infer<typeof TermHalfSchema>;

/**
 * Fact predicate on a course offering: the half of the term each timetable slot meets in, as the
 * academic system prints it per slot (「前期前半/金5・6, 前期後半/金5・6」). Value: TermSlotsValue.
 */
export const TERM_SLOTS_PREDICATE = 'term_slots';
export const TermSlotsValueSchema = z.object({
  slots: z.array(
    z.object({
      half: TermHalfSchema,
      dayOfWeek: z.number().int().min(0).max(6),
      period: z.number().int().positive().optional(),
    }),
  ),
});
export type TermSlotsValue = z.infer<typeof TermSlotsValueSchema>;

/**
 * Personal conditions of the student in a course (§17 effective schedule). One single-valued fact
 * predicate per condition on the course offering: `condition:group` = the group / 班 the student
 * belongs to ("B"). Sources: the university (authoritative), a document or post (extracted), the
 * student in a chat or a lecture recording (MCP additions, extracted until confirmed).
 */
export const COURSE_CONDITIONS = ['group'] as const;
export type CourseCondition = (typeof COURSE_CONDITIONS)[number];
export const CONDITION_PREDICATE_PREFIX = 'condition:';
export const GROUP_CONDITION_PREDICATE = `${CONDITION_PREDICATE_PREFIX}group`;
export function conditionPredicate(name: CourseCondition): string {
  return `${CONDITION_PREDICATE_PREFIX}${name}`;
}

/** Normalizes a group label (「Ｂ」「B班」「Bグループ」「グループB」「b」) to "B"; undefined if not a group. */
export function normalizeGroupLabel(s: string): string | undefined {
  const t = s
    .normalize('NFKC')
    .trim()
    .replace(/^(?:グループ|班|group)\s*/i, '')
    .replace(/\s*(?:班|グループ|組|group|g)$/i, '')
    .trim();
  if (/^[A-Za-z]$/.test(t)) return t.toUpperCase();
  if (/^\d{1,2}$/.test(t)) return String(Number(t));
  return undefined;
}

/**
 * Multi-valued fact predicate on a course offering: one dated meeting of a group schedule
 * (「2026年度情報科学実験B実施スケジュール: 10/02(金) B 科学実験室 #01」). The rows of an official
 * table (parsed from a synced document) or rows an AI client registered (add_session_rule).
 */
export const SESSION_RULE_PREDICATE = 'session_rule';
export const SessionRuleValueSchema = z.object({
  date: LocalDateSchema,
  /** Group this meeting is for; undefined = every group (a 休講 / holiday row). */
  group: z.string().min(1).max(8).optional(),
  /** held = the group meets on this date; no_class = nobody meets (休講, 祝日). */
  status: z.enum(['held', 'no_class']).default('held'),
  periods: z.array(z.number().int().positive()).optional(),
  startTime: LocalTimeSchema.optional(),
  endTime: LocalTimeSchema.optional(),
  room: z.string().max(100).optional(),
  /** Meeting number (#01 → 1). */
  number: z.number().int().positive().optional(),
  /** What is done (H1 FPGAと論理合成ツール …). */
  topic: z.string().max(200).optional(),
  note: z.string().max(200).optional(),
  /** Title of the document / post the table is in. */
  documentTitle: z.string().max(200).optional(),
});
export type SessionRuleValue = z.infer<typeof SessionRuleValueSchema>;

export const ScheduleSlotSchema = z.object({
  /** 0 = Sunday ... 6 = Saturday */
  dayOfWeek: z.number().int().min(0).max(6),
  period: z.number().int().positive().optional(),
  startTime: LocalTimeSchema.optional(),
  endTime: LocalTimeSchema.optional(),
  room: z.string().optional(),
  locationId: idSchema('location').optional(),
  /** Halves of the term this slot meets in, when the source says so per slot (overrides the offering's). */
  termParts: z.array(TermHalfSchema).optional(),
});
export type ScheduleSlot = z.infer<typeof ScheduleSlotSchema>;

/** A concrete run of a course: year, term, instructors and timetable slots (§8). */
export const CourseOfferingSchema = z.object({
  ...base('courseOffering'),
  courseId: idSchema('course').optional(),
  termId: idSchema('academicTerm').optional(),
  academicYear: z.number().int().optional(),
  term: z.string().optional(),
  title: z.string().min(1),
  courseCode: z.string().optional(),
  instructorIds: z.array(idSchema('person')).default([]),
  instructorNames: z.array(z.string()).default([]),
  schedule: z.array(ScheduleSlotSchema).default([]),
  /**
   * regular = weekly timetable slots; unscheduled = 時間割外 (no fixed weekly class, e.g. on-demand
   * or retake classes); intensive = 集中講義 (block dates). Only regular offerings get weekly
   * class sessions; absent means regular when `schedule` is non-empty.
   */
  scheduleType: z.enum(['regular', 'unscheduled', 'intensive']).optional(),
  /**
   * Halves of the term (前半 / 後半) the offering meets in, as the source states it (e.g. the
   * syllabus 開講時期 「後期後半」 → [後半], 「後期前半 ～ 後期後半」 → [前半, 後半]). Absent = the
   * source does not say; consumers then treat the offering as running the whole term.
   */
  termParts: z.array(TermHalfSchema).optional(),
  room: z.string().optional(),
  url: z.string().optional(),
});

export const EnrollmentSchema = z.object({
  ...base('enrollment'),
  personId: idSchema('person'),
  courseOfferingId: idSchema('courseOffering'),
  role: z.enum(['student', 'instructor', 'ta']).default('student'),
  status: z.enum(['active', 'dropped', 'completed']).default('active'),
});

export const AssignmentSchema = z.object({
  ...base('assignment'),
  courseOfferingId: idSchema('courseOffering').optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  dueAt: IsoDateTimeSchema.optional(),
  availableFrom: IsoDateTimeSchema.optional(),
  points: z.number().optional(),
  submissionType: z.string().optional(),
  url: z.string().optional(),
});

export const SubmissionStatusSchema = z.enum([
  'not_submitted',
  'submitted',
  'late',
  'graded',
  'returned',
]);
export const SubmissionSchema = z.object({
  ...base('submission'),
  assignmentId: idSchema('assignment'),
  personId: idSchema('person').optional(),
  status: SubmissionStatusSchema,
  submittedAt: IsoDateTimeSchema.optional(),
  score: z.number().optional(),
});

export const ExamSchema = z.object({
  ...base('exam'),
  courseOfferingId: idSchema('courseOffering').optional(),
  title: z.string().min(1),
  examKind: z.enum(['midterm', 'final', 'quiz', 'report', 'other']).default('other'),
  startsAt: IsoDateTimeSchema.optional(),
  endsAt: IsoDateTimeSchema.optional(),
  room: z.string().optional(),
  locationId: idSchema('location').optional(),
  scope: z.string().optional(),
  notes: z.string().optional(),
});

export const ImportanceSchema = z.enum(['critical', 'high', 'normal', 'low']);
export type Importance = z.infer<typeof ImportanceSchema>;

export const AnnouncementSchema = z.object({
  ...base('announcement'),
  courseOfferingId: idSchema('courseOffering').optional(),
  title: z.string().min(1),
  body: z.string().default(''),
  publishedAt: IsoDateTimeSchema.optional(),
  authorName: z.string().optional(),
  authorId: idSchema('person').optional(),
  importance: ImportanceSchema.default('normal'),
  /** e.g. "university" for 大学からのお知らせ, "course" for course posts. */
  scope: z.enum(['university', 'faculty', 'course', 'other']).default('course'),
  category: z.string().optional(),
  url: z.string().optional(),
  lectureId: idSchema('lecture').optional(),
});

export const ThreadSchema = z.object({
  ...base('thread'),
  courseOfferingId: idSchema('courseOffering').optional(),
  title: z.string().min(1),
  platform: z.string().optional(),
  url: z.string().optional(),
  lectureId: idSchema('lecture').optional(),
});

export const MessageSchema = z.object({
  ...base('message'),
  threadId: idSchema('thread').optional(),
  courseOfferingId: idSchema('courseOffering').optional(),
  authorName: z.string().optional(),
  authorId: idSchema('person').optional(),
  authorRole: PersonRoleSchema.optional(),
  body: z.string().default(''),
  sentAt: IsoDateTimeSchema.optional(),
  url: z.string().optional(),
  isQuestion: z.boolean().optional(),
  lectureId: idSchema('lecture').optional(),
});

export const MaterialSchema = z.object({
  ...base('material'),
  courseOfferingId: idSchema('courseOffering').optional(),
  title: z.string().min(1),
  materialKind: z
    .enum(['slides', 'handout', 'recording', 'reading', 'code', 'link', 'other'])
    .default('other'),
  documentId: idSchema('document').optional(),
  url: z.string().optional(),
  publishedAt: IsoDateTimeSchema.optional(),
  lectureId: idSchema('lecture').optional(),
});

export const DocumentSchema = z.object({
  ...base('document'),
  title: z.string().min(1),
  mimeType: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  contentHash: z.string().optional(),
  /** Extracted plain text (chunks hold the searchable pieces). */
  text: z.string().optional(),
  pageCount: z.number().int().optional(),
  courseOfferingId: idSchema('courseOffering').optional(),
  modifiedAt: IsoDateTimeSchema.optional(),
});

export const DocumentChunkSchema = z.object({
  ...base('documentChunk'),
  documentId: idSchema('document'),
  ordinal: z.number().int().nonnegative(),
  text: z.string(),
  page: z.number().int().positive().optional(),
  heading: z.string().optional(),
});

/** One lecture meeting; aggregates session, slides, transcript, questions (§21). */
export const LectureSchema = z.object({
  ...base('lecture'),
  courseOfferingId: idSchema('courseOffering').optional(),
  classSessionId: idSchema('classSession').optional(),
  date: LocalDateSchema,
  title: z.string().optional(),
  number: z.number().int().positive().optional(),
  topics: z.array(z.string()).default([]),
});

export const LectureTranscriptSchema = z.object({
  ...base('lectureTranscript'),
  lectureId: idSchema('lecture').optional(),
  courseOfferingId: idSchema('courseOffering').optional(),
  title: z.string().optional(),
  language: z.string().optional(),
  recordedAt: IsoDateTimeSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  /** Importer that produced it, e.g. "chatgpt-record", "zoom". */
  importer: z.string().optional(),
  documentId: idSchema('document').optional(),
});

export const LectureSegmentSchema = z.object({
  ...base('lectureSegment'),
  transcriptId: idSchema('lectureTranscript'),
  ordinal: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative().optional(),
  speaker: z.string().optional(),
  text: z.string(),
});

export const CalendarEventSchema = z.object({
  ...base('calendarEvent'),
  courseOfferingId: idSchema('courseOffering').optional(),
  title: z.string().min(1),
  startsAt: IsoDateTimeSchema,
  endsAt: IsoDateTimeSchema.optional(),
  allDay: z.boolean().optional(),
  location: z.string().optional(),
  description: z.string().optional(),
  url: z.string().optional(),
  category: z.string().optional(),
});

export const ClassSessionStatusSchema = z.enum([
  'scheduled',
  'cancelled',
  'makeup',
  'online',
  'changed',
]);
export const ClassSessionSchema = z.object({
  ...base('classSession'),
  courseOfferingId: idSchema('courseOffering'),
  date: LocalDateSchema,
  period: z.number().int().positive().optional(),
  startsAt: IsoDateTimeSchema.optional(),
  endsAt: IsoDateTimeSchema.optional(),
  room: z.string().optional(),
  locationId: idSchema('location').optional(),
  status: ClassSessionStatusSchema.default('scheduled'),
  number: z.number().int().positive().optional(),
  note: z.string().optional(),
  /** class = a meeting of the course; self_study = a study slot the student set (自習, origin user). */
  sessionKind: z.enum(['class', 'self_study']).optional(),
});

export const LocationSchema = z.object({
  ...base('location'),
  name: z.string().min(1),
  building: z.string().optional(),
  room: z.string().optional(),
  campusId: idSchema('campus').optional(),
  online: z.boolean().optional(),
  url: z.string().optional(),
});

export const GradeSchema = z.object({
  ...base('grade'),
  courseOfferingId: idSchema('courseOffering').optional(),
  assignmentId: idSchema('assignment').optional(),
  score: z.number().optional(),
  maxScore: z.number().optional(),
  letter: z.string().optional(),
  gradePoint: z.number().optional(),
  finalizedAt: IsoDateTimeSchema.optional(),
});

export const ENTITY_SCHEMAS = {
  university: UniversitySchema,
  campus: CampusSchema,
  academicTerm: AcademicTermSchema,
  person: PersonSchema,
  course: CourseSchema,
  courseOffering: CourseOfferingSchema,
  enrollment: EnrollmentSchema,
  assignment: AssignmentSchema,
  submission: SubmissionSchema,
  exam: ExamSchema,
  announcement: AnnouncementSchema,
  message: MessageSchema,
  thread: ThreadSchema,
  material: MaterialSchema,
  document: DocumentSchema,
  documentChunk: DocumentChunkSchema,
  lecture: LectureSchema,
  lectureTranscript: LectureTranscriptSchema,
  lectureSegment: LectureSegmentSchema,
  calendarEvent: CalendarEventSchema,
  classSession: ClassSessionSchema,
  location: LocationSchema,
  grade: GradeSchema,
} as const satisfies Record<EntityKind, z.ZodType>;

export type University = z.infer<typeof UniversitySchema>;
export type Campus = z.infer<typeof CampusSchema>;
export type AcademicTerm = z.infer<typeof AcademicTermSchema>;
export type Person = z.infer<typeof PersonSchema>;
export type Course = z.infer<typeof CourseSchema>;
export type CourseOffering = z.infer<typeof CourseOfferingSchema>;
export type Enrollment = z.infer<typeof EnrollmentSchema>;
export type Assignment = z.infer<typeof AssignmentSchema>;
export type Submission = z.infer<typeof SubmissionSchema>;
export type Exam = z.infer<typeof ExamSchema>;
export type Announcement = z.infer<typeof AnnouncementSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type Material = z.infer<typeof MaterialSchema>;
export type Document = z.infer<typeof DocumentSchema>;
export type DocumentChunk = z.infer<typeof DocumentChunkSchema>;
export type Lecture = z.infer<typeof LectureSchema>;
export type LectureTranscript = z.infer<typeof LectureTranscriptSchema>;
export type LectureSegment = z.infer<typeof LectureSegmentSchema>;
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;
export type ClassSession = z.infer<typeof ClassSessionSchema>;
export type Location = z.infer<typeof LocationSchema>;
export type Grade = z.infer<typeof GradeSchema>;

/** Maps an entity kind to its TS type. */
export type EntityOfKind = { [K in EntityKind]: z.infer<(typeof ENTITY_SCHEMAS)[K]> };
export type CanonicalEntity = EntityOfKind[EntityKind];
/** Input form (defaults optional) for each kind. */
export type EntityInputOfKind = { [K in EntityKind]: z.input<(typeof ENTITY_SCHEMAS)[K]> };
export type CanonicalEntityInput = EntityInputOfKind[EntityKind];

export const CanonicalEntitySchema = z.discriminatedUnion('kind', [
  UniversitySchema,
  CampusSchema,
  AcademicTermSchema,
  PersonSchema,
  CourseSchema,
  CourseOfferingSchema,
  EnrollmentSchema,
  AssignmentSchema,
  SubmissionSchema,
  ExamSchema,
  AnnouncementSchema,
  MessageSchema,
  ThreadSchema,
  MaterialSchema,
  DocumentSchema,
  DocumentChunkSchema,
  LectureSchema,
  LectureTranscriptSchema,
  LectureSegmentSchema,
  CalendarEventSchema,
  ClassSessionSchema,
  LocationSchema,
  GradeSchema,
]);

/** Validate any entity (applies defaults). Throws ZodError on invalid input. */
export function parseEntity(value: unknown): CanonicalEntity {
  return CanonicalEntitySchema.parse(value) as CanonicalEntity;
}

/** Validate an entity of a known kind. */
export function parseEntityOfKind<K extends EntityKind>(kind: K, value: unknown): EntityOfKind[K] {
  return ENTITY_SCHEMAS[kind].parse(value) as EntityOfKind[K];
}

/** Human-facing label of an entity (title or name), used in summaries. */
export function entityLabel(entity: CanonicalEntity): string {
  const r = entity as unknown as Record<string, unknown>;
  for (const key of ['title', 'name', 'date']) {
    const v = r[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return entity.id;
}

/**
 * Entity fields that are mirrored as facts so they participate in provenance and conflict
 * resolution (§9, §12). Predicate names match the default authority rules.
 */
export const DEFAULT_FACT_FIELDS: Partial<Record<EntityKind, Record<string, string>>> = {
  courseOffering: { room: 'room' },
  classSession: { room: 'room', status: 'class_status', startsAt: 'starts_at' },
  assignment: { dueAt: 'assignment_due' },
  exam: { startsAt: 'exam_at', room: 'room' },
  submission: { status: 'submission_status' },
  grade: { score: 'grade', letter: 'grade_letter' },
};
