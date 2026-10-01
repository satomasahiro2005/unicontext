import type { Migration } from './types.js';

// Schema drift (§73) and detected product versions (§72).
export const migration7: Migration = {
  version: 7,
  name: '007_source_monitoring',
  sql: `
CREATE TABLE product_versions (
  source_id TEXT NOT NULL,
  product TEXT NOT NULL,
  version TEXT NOT NULL,
  known INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (source_id, product, version)
);
CREATE TABLE schema_drift (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  field_path TEXT NOT NULL,
  drift_kind TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  sample_raw_item_id TEXT,
  resolved_at TEXT
);
CREATE UNIQUE INDEX schema_drift_key ON schema_drift (source_id, source_type, field_path, drift_kind);
`,
};
