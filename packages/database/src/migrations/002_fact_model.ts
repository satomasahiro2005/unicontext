import type { Migration } from './types.js';

// Facts (§9) and conflicts (§12).
export const migration2: Migration = {
  version: 2,
  name: '002_fact_model',
  sql: `
CREATE TABLE conflicts (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  status TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_json TEXT,
  reason TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX conflicts_subject_predicate ON conflicts (subject, predicate);
CREATE INDEX conflicts_status ON conflicts (status);
CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  value_json TEXT NOT NULL,
  origin TEXT NOT NULL,
  confidence REAL NOT NULL,
  observed_at TEXT NOT NULL,
  valid_from TEXT,
  valid_until TEXT,
  source_reference_id TEXT NOT NULL,
  producer_type TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  evidence TEXT,
  retracted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX facts_subject_predicate ON facts (subject, predicate);
CREATE INDEX facts_source_ref ON facts (source_reference_id);
`,
};
