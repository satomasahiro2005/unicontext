import type { Migration } from './types.js';

// Event history (§13).
export const migration3: Migration = {
  version: 3,
  name: '003_change_events',
  sql: `
CREATE TABLE change_events (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  type TEXT NOT NULL,
  changed_fields_json TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  source_id TEXT,
  source_system TEXT,
  raw_item_id TEXT,
  occurred_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  course_offering_id TEXT,
  summary TEXT
);
CREATE INDEX change_events_observed ON change_events (observed_at);
CREATE INDEX change_events_entity ON change_events (entity_id);
`,
};
