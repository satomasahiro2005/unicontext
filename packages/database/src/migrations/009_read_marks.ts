import type { Migration } from './types.js';

// UniContext's own read state of an item (announcements), independent of the source system's:
// a notice fetched on request is read in LiveCampusU but stays unread here until the user reads
// it in UniContext or marks it.
export const migration9: Migration = {
  version: 9,
  name: '009_read_marks',
  sql: `
CREATE TABLE read_marks (
  entity_id TEXT PRIMARY KEY,
  unread INTEGER NOT NULL,
  reason TEXT,
  updated_at TEXT NOT NULL
);
`,
};
