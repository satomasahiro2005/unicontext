import type { EntityKind } from '@unicontext/canonical-model';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Every entity table has the same envelope: id, full JSON (`data`), owning source, timestamps,
 * soft-delete. Extra typed columns mirror entity fields (JS key == entity field name) so that
 * structured queries do not need json_extract.
 */
const envelope = () => ({
  id: text('id').primaryKey(),
  data: text('data').notNull(),
  sourceId: text('source_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
});

export const universities = sqliteTable('universities', { ...envelope(), name: text('name') });

export const campuses = sqliteTable('campuses', {
  ...envelope(),
  universityId: text('university_id'),
  name: text('name'),
});

export const academicTerms = sqliteTable('academic_terms', {
  ...envelope(),
  universityId: text('university_id'),
  name: text('name'),
  academicYear: integer('academic_year'),
  startsOn: text('starts_on'),
  endsOn: text('ends_on'),
});

export const persons = sqliteTable('persons', {
  ...envelope(),
  name: text('name'),
  email: text('email'),
});

export const courses = sqliteTable(
  'courses',
  { ...envelope(), courseCode: text('course_code'), title: text('title') },
  (t) => [index('courses_code').on(t.courseCode)],
);

export const courseOfferings = sqliteTable(
  'course_offerings',
  {
    ...envelope(),
    courseId: text('course_id'),
    termId: text('term_id'),
    academicYear: integer('academic_year'),
    term: text('term'),
    title: text('title'),
    courseCode: text('course_code'),
  },
  (t) => [
    index('course_offerings_course').on(t.courseId),
    index('course_offerings_code').on(t.courseCode),
  ],
);

export const enrollments = sqliteTable(
  'enrollments',
  {
    ...envelope(),
    personId: text('person_id'),
    courseOfferingId: text('course_offering_id'),
    role: text('role'),
    status: text('status'),
  },
  (t) => [index('enrollments_offering').on(t.courseOfferingId)],
);

export const assignments = sqliteTable(
  'assignments',
  {
    ...envelope(),
    courseOfferingId: text('course_offering_id'),
    title: text('title'),
    dueAt: text('due_at'),
  },
  (t) => [
    index('assignments_offering').on(t.courseOfferingId),
    index('assignments_due').on(t.dueAt),
  ],
);

export const submissions = sqliteTable(
  'submissions',
  {
    ...envelope(),
    assignmentId: text('assignment_id'),
    status: text('status'),
    submittedAt: text('submitted_at'),
  },
  (t) => [index('submissions_assignment').on(t.assignmentId)],
);

export const exams = sqliteTable(
  'exams',
  {
    ...envelope(),
    courseOfferingId: text('course_offering_id'),
    title: text('title'),
    startsAt: text('starts_at'),
    endsAt: text('ends_at'),
  },
  (t) => [index('exams_offering').on(t.courseOfferingId), index('exams_starts').on(t.startsAt)],
);

export const announcements = sqliteTable(
  'announcements',
  {
    ...envelope(),
    courseOfferingId: text('course_offering_id'),
    title: text('title'),
    publishedAt: text('published_at'),
    importance: text('importance'),
    scope: text('scope'),
  },
  (t) => [
    index('announcements_offering').on(t.courseOfferingId),
    index('announcements_published').on(t.publishedAt),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    ...envelope(),
    threadId: text('thread_id'),
    courseOfferingId: text('course_offering_id'),
    sentAt: text('sent_at'),
    authorName: text('author_name'),
  },
  (t) => [
    index('messages_thread').on(t.threadId),
    index('messages_offering').on(t.courseOfferingId),
  ],
);

export const threads = sqliteTable(
  'threads',
  { ...envelope(), courseOfferingId: text('course_offering_id'), title: text('title') },
  (t) => [index('threads_offering').on(t.courseOfferingId)],
);

export const materials = sqliteTable(
  'materials',
  {
    ...envelope(),
    courseOfferingId: text('course_offering_id'),
    title: text('title'),
    materialKind: text('material_kind'),
    documentId: text('document_id'),
    publishedAt: text('published_at'),
    lectureId: text('lecture_id'),
  },
  (t) => [index('materials_offering').on(t.courseOfferingId)],
);

export const documents = sqliteTable(
  'documents',
  {
    ...envelope(),
    title: text('title'),
    path: text('path'),
    mimeType: text('mime_type'),
    contentHash: text('content_hash'),
    courseOfferingId: text('course_offering_id'),
    modifiedAt: text('modified_at'),
  },
  (t) => [index('documents_offering').on(t.courseOfferingId)],
);

export const documentChunks = sqliteTable(
  'document_chunks',
  { ...envelope(), documentId: text('document_id'), ordinal: integer('ordinal') },
  (t) => [index('document_chunks_document').on(t.documentId)],
);

export const lectures = sqliteTable(
  'lectures',
  {
    ...envelope(),
    courseOfferingId: text('course_offering_id'),
    classSessionId: text('class_session_id'),
    date: text('date'),
  },
  (t) => [index('lectures_offering').on(t.courseOfferingId, t.date)],
);

export const lectureTranscripts = sqliteTable(
  'lecture_transcripts',
  {
    ...envelope(),
    lectureId: text('lecture_id'),
    courseOfferingId: text('course_offering_id'),
    recordedAt: text('recorded_at'),
  },
  (t) => [index('lecture_transcripts_lecture').on(t.lectureId)],
);

export const lectureSegments = sqliteTable(
  'lecture_segments',
  {
    ...envelope(),
    transcriptId: text('transcript_id'),
    ordinal: integer('ordinal'),
    startMs: integer('start_ms'),
  },
  (t) => [index('lecture_segments_transcript').on(t.transcriptId, t.ordinal)],
);

export const calendarEvents = sqliteTable(
  'calendar_events',
  {
    ...envelope(),
    courseOfferingId: text('course_offering_id'),
    title: text('title'),
    startsAt: text('starts_at'),
    endsAt: text('ends_at'),
  },
  (t) => [index('calendar_events_starts').on(t.startsAt)],
);

export const classSessions = sqliteTable(
  'class_sessions',
  {
    ...envelope(),
    courseOfferingId: text('course_offering_id'),
    date: text('date'),
    period: integer('period'),
    startsAt: text('starts_at'),
    endsAt: text('ends_at'),
    room: text('room'),
    status: text('status'),
  },
  (t) => [
    index('class_sessions_date').on(t.date),
    index('class_sessions_offering').on(t.courseOfferingId),
  ],
);

export const locations = sqliteTable('locations', { ...envelope(), name: text('name') });

export const grades = sqliteTable(
  'grades',
  {
    ...envelope(),
    courseOfferingId: text('course_offering_id'),
    assignmentId: text('assignment_id'),
    score: real('score'),
  },
  (t) => [index('grades_offering').on(t.courseOfferingId)],
);

/** Registry: entity kind -> drizzle table. */
export const ENTITY_TABLES = {
  university: universities,
  campus: campuses,
  academicTerm: academicTerms,
  person: persons,
  course: courses,
  courseOffering: courseOfferings,
  enrollment: enrollments,
  assignment: assignments,
  submission: submissions,
  exam: exams,
  announcement: announcements,
  message: messages,
  thread: threads,
  material: materials,
  document: documents,
  documentChunk: documentChunks,
  lecture: lectures,
  lectureTranscript: lectureTranscripts,
  lectureSegment: lectureSegments,
  calendarEvent: calendarEvents,
  classSession: classSessions,
  location: locations,
  grade: grades,
} as const satisfies Record<EntityKind, unknown>;

export type EntityTable = (typeof ENTITY_TABLES)[EntityKind];

/** Provenance pointers (§10). entity_id links a reference to the entity it supports. */
export const sourceReferences = sqliteTable(
  'source_references',
  {
    id: text('id').primaryKey(),
    sourceSystem: text('source_system').notNull(),
    sourceId: text('source_id'),
    sourceLabel: text('source_label'),
    authority: text('authority').notNull(),
    sourceItemId: text('source_item_id').notNull(),
    url: text('url'),
    retrievedAt: text('retrieved_at').notNull(),
    rawItemId: text('raw_item_id'),
    locationJson: text('location_json'),
    entityId: text('entity_id'),
  },
  (t) => [
    index('source_refs_entity').on(t.entityId),
    index('source_refs_raw').on(t.rawItemId),
    index('source_refs_source').on(t.sourceId),
  ],
);
