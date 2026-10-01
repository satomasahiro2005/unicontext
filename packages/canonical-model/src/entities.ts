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

export const ScheduleSlotSchema = z.object({
  /** 0 = Sunday ... 6 = Saturday */
  dayOfWeek: z.number().int().min(0).max(6),
  period: z.number().int().positive().optional(),
  startTime: LocalTimeSchema.optional(),
  endTime: LocalTimeSchema.optional(),
  room: z.string().optional(),
  locationId: idSchema('location').optional(),
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
