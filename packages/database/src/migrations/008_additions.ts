import type { Migration } from './types.js';

// What AI clients wrote through the MCP write tools (record_lecture, add_deadline, add_note,
// add_task): one row per addition with its status (unconfirmed / confirmed / rejected / retracted),
// the entities and facts it produced, and the per-client idempotency key.
export const migration8: Migration = {
  version: 8,
  name: '008_additions',
  sql: `
CREATE TABLE additions (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_name TEXT,
  tool TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  course_offering_id TEXT,
  title TEXT NOT NULL,
  due_at TEXT,
  dedupe_key TEXT,
  idempotency_key TEXT,
  source_reference_id TEXT,
  entity_ids_json TEXT NOT NULL,
  own_entity_ids_json TEXT NOT NULL,
  fact_ids_json TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX additions_client ON additions (client_id, updated_at);
CREATE INDEX additions_status ON additions (status);
CREATE INDEX additions_dedupe ON additions (dedupe_key);
CREATE UNIQUE INDEX additions_idempotency ON additions (client_id, idempotency_key);
`,
};
