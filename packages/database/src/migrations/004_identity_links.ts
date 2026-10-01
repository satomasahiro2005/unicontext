import type { Migration } from './types.js';

// Identity resolution links (§14).
export const migration4: Migration = {
  version: 4,
  name: '004_identity_links',
  sql: `
CREATE TABLE identity_links (
  id TEXT PRIMARY KEY,
  entity_kind TEXT NOT NULL,
  left_id TEXT NOT NULL,
  right_id TEXT NOT NULL,
  status TEXT NOT NULL,
  score REAL NOT NULL,
  method TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX identity_links_pair ON identity_links (left_id, right_id);
CREATE INDEX identity_links_right ON identity_links (right_id);
`,
};
