import type { Migration } from './types.js';

// Task engine (§19).
export const migration5: Migration = {
  version: 5,
  name: '005_tasks',
  sql: `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  course_offering_id TEXT,
  assignment_id TEXT,
  exam_id TEXT,
  source_fact_ids_json TEXT NOT NULL,
  due_at TEXT,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  task_kind TEXT NOT NULL,
  origin TEXT NOT NULL,
  status_set_by TEXT NOT NULL,
  status_evidence_fact_id TEXT,
  evidence TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tasks_due ON tasks (due_at);
CREATE INDEX tasks_status ON tasks (status);
`,
};
