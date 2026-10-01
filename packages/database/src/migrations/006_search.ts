import type { Migration } from './types.js';

// Full-text search (§15). trigram tokenizer: substring matching works for Japanese text without
// a morphological analyzer (e.g. 「正規化」 matches inside 「データの正規化について」).
// Plus optional embedding storage (§16).
export const migration6: Migration = {
  version: 6,
  name: '006_search',
  sql: `
CREATE VIRTUAL TABLE fts_documents USING fts5(entity_id UNINDEXED, course_offering_id UNINDEXED, title, body, tokenize='trigram');
CREATE VIRTUAL TABLE fts_document_chunks USING fts5(entity_id UNINDEXED, course_offering_id UNINDEXED, title, body, tokenize='trigram');
CREATE VIRTUAL TABLE fts_announcements USING fts5(entity_id UNINDEXED, course_offering_id UNINDEXED, title, body, tokenize='trigram');
CREATE VIRTUAL TABLE fts_messages USING fts5(entity_id UNINDEXED, course_offering_id UNINDEXED, title, body, tokenize='trigram');
CREATE VIRTUAL TABLE fts_lecture_segments USING fts5(entity_id UNINDEXED, course_offering_id UNINDEXED, title, body, tokenize='trigram');
CREATE TABLE embeddings (
  entity_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (entity_id, provider, model)
);
`,
};
