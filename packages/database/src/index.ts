export * from './schema/index.js';
export { MIGRATIONS, type Migration } from './migrations/index.js';
export * from './migrate.js';
export * from './db.js';
export * from './mappers.js';
export * from './stores/raw-store.js';
export * from './stores/entity-store.js';
export * from './stores/source-ref-store.js';
export * from './stores/change-event-store.js';
export * from './stores/source-state-stores.js';
export * from './stores/addition-store.js';
export * from './maintenance.js';
export { createStores, type Stores } from './stores/index.js';

// Data dir (§52), config (§53) and profile (§54) helpers live in core; re-exported for convenience.
export {
  resolveDataPaths,
  dataPathsFromRoot,
  ensureDataDirs,
  type DataPaths,
  loadConfig,
  parseConfig,
  type UniContextConfig,
  loadProfile,
  parseProfile,
  type UniversityProfile,
} from '@unicontext/core';
