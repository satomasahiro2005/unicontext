import { migration1 } from './001_initial.js';
import { migration2 } from './002_fact_model.js';
import { migration3 } from './003_change_events.js';
import { migration4 } from './004_identity_links.js';
import { migration5 } from './005_tasks.js';
import { migration6 } from './006_search.js';
import { migration7 } from './007_source_monitoring.js';
import { migration8 } from './008_additions.js';
import { migration9 } from './009_read_marks.js';
import type { Migration } from './types.js';

export type { Migration } from './types.js';

/** All migrations in order. Append only. */
export const MIGRATIONS: readonly Migration[] = [
  migration1,
  migration2,
  migration3,
  migration4,
  migration5,
  migration6,
  migration7,
  migration8,
  migration9,
];
