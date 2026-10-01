import type { Migration } from './types.js';

// Raw layer (§6), sync state (§35), health (§38), canonical entity tables (§7) and source references (§10).
export const migration1: Migration = {
  version: 1,
  name: '001_initial',
  sql: `
CREATE TABLE academic_terms (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  university_id TEXT,
  name TEXT,
  academic_year INTEGER,
  starts_on TEXT,
  ends_on TEXT
);
CREATE TABLE announcements (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  course_offering_id TEXT,
  title TEXT,
  published_at TEXT,
  importance TEXT,
  scope TEXT
);
CREATE INDEX announcements_offering ON announcements (course_offering_id);
CREATE INDEX announcements_published ON announcements (published_at);
CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  course_offering_id TEXT,
  title TEXT,
  due_at TEXT
);
CREATE INDEX assignments_offering ON assignments (course_offering_id);
CREATE INDEX assignments_due ON assignments (due_at);
CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  course_offering_id TEXT,
  title TEXT,
  starts_at TEXT,
  ends_at TEXT
);
CREATE INDEX calendar_events_starts ON calendar_events (starts_at);
CREATE TABLE campuses (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  university_id TEXT,
  name TEXT
);
CREATE TABLE class_sessions (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  course_offering_id TEXT,
  date TEXT,
  period INTEGER,
  starts_at TEXT,
  ends_at TEXT,
  room TEXT,
  status TEXT
);
CREATE INDEX class_sessions_date ON class_sessions (date);
CREATE INDEX class_sessions_offering ON class_sessions (course_offering_id);
CREATE TABLE connector_health (
  source_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  message TEXT,
  checked_at TEXT NOT NULL,
  last_success_at TEXT,
  last_failure_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  retry_after TEXT,
  detected_version TEXT
);
CREATE TABLE course_offerings (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  course_id TEXT,
  term_id TEXT,
  academic_year INTEGER,
  term TEXT,
  title TEXT,
  course_code TEXT
);
CREATE INDEX course_offerings_course ON course_offerings (course_id);
CREATE INDEX course_offerings_code ON course_offerings (course_code);
CREATE TABLE courses (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  course_code TEXT,
  title TEXT
);
CREATE INDEX courses_code ON courses (course_code);
CREATE TABLE document_chunks (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  document_id TEXT,
  ordinal INTEGER
);
CREATE INDEX document_chunks_document ON document_chunks (document_id);
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  title TEXT,
  path TEXT,
  mime_type TEXT,
  content_hash TEXT,
  course_offering_id TEXT,
  modified_at TEXT
);
CREATE INDEX documents_offering ON documents (course_offering_id);
CREATE TABLE enrollments (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  person_id TEXT,
  course_offering_id TEXT,
  role TEXT,
  status TEXT
);
CREATE INDEX enrollments_offering ON enrollments (course_offering_id);
CREATE TABLE exams (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  course_offering_id TEXT,
  title TEXT,
  starts_at TEXT,
  ends_at TEXT
);
CREATE INDEX exams_offering ON exams (course_offering_id);
CREATE INDEX exams_starts ON exams (starts_at);
CREATE TABLE grades (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  course_offering_id TEXT,
  assignment_id TEXT,
  score REAL
);
CREATE INDEX grades_offering ON grades (course_offering_id);
CREATE TABLE lecture_segments (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  transcript_id TEXT,
  ordinal INTEGER,
  start_ms INTEGER
);
CREATE INDEX lecture_segments_transcript ON lecture_segments (transcript_id, ordinal);
CREATE TABLE lecture_transcripts (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  lecture_id TEXT,
  course_offering_id TEXT,
  recorded_at TEXT
);
CREATE INDEX lecture_transcripts_lecture ON lecture_transcripts (lecture_id);
CREATE TABLE lectures (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  course_offering_id TEXT,
  class_session_id TEXT,
  date TEXT
);
CREATE INDEX lectures_offering ON lectures (course_offering_id, date);
CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  name TEXT
);
CREATE TABLE materials (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  course_offering_id TEXT,
  title TEXT,
  material_kind TEXT,
  document_id TEXT,
  published_at TEXT,
  lecture_id TEXT
);
CREATE INDEX materials_offering ON materials (course_offering_id);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  thread_id TEXT,
  course_offering_id TEXT,
  sent_at TEXT,
  author_name TEXT
);
CREATE INDEX messages_thread ON messages (thread_id);
CREATE INDEX messages_offering ON messages (course_offering_id);
CREATE TABLE persons (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  name TEXT,
  email TEXT
);
CREATE TABLE raw_blobs (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  source_id TEXT NOT NULL,
  raw_item_id TEXT,
  mime_type TEXT,
  size INTEGER NOT NULL,
  storage TEXT NOT NULL,
  path TEXT,
  data BLOB,
  created_at TEXT NOT NULL
);
CREATE INDEX raw_blobs_source ON raw_blobs (source_id);
CREATE INDEX raw_blobs_item ON raw_blobs (raw_item_id);
CREATE TABLE raw_items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  source_updated_at TEXT,
  content_hash TEXT NOT NULL,
  deleted_at TEXT,
  normalized_at TEXT,
  normalized_hash TEXT,
  normalizer_version TEXT,
  normalize_error TEXT,
  FOREIGN KEY (source_id) REFERENCES raw_sources(id)
);
CREATE UNIQUE INDEX raw_items_source_key ON raw_items (source_id, source_type, external_id);
CREATE INDEX raw_items_pending ON raw_items (source_id, normalized_at);
CREATE TABLE raw_sources (
  id TEXT PRIMARY KEY,
  connector TEXT NOT NULL,
  adapter TEXT,
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_sync_at TEXT
);
CREATE TABLE source_references (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL,
  source_id TEXT,
  source_label TEXT,
  authority TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  url TEXT,
  retrieved_at TEXT NOT NULL,
  raw_item_id TEXT,
  location_json TEXT,
  entity_id TEXT
);
CREATE INDEX source_refs_entity ON source_references (entity_id);
CREATE INDEX source_refs_raw ON source_references (raw_item_id);
CREATE INDEX source_refs_source ON source_references (source_id);
CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  assignment_id TEXT,
  status TEXT,
  submitted_at TEXT
);
CREATE INDEX submissions_assignment ON submissions (assignment_id);
CREATE TABLE sync_state (
  source_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  cursor TEXT,
  etag TEXT,
  delta_token TEXT,
  last_modified TEXT,
  extra_json TEXT,
  last_mode TEXT,
  last_full_sync_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_id, scope)
);
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  course_offering_id TEXT,
  title TEXT
);
CREATE INDEX threads_offering ON threads (course_offering_id);
CREATE TABLE universities (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  name TEXT
);
`,
};
