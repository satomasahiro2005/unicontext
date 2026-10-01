import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate, type MigrateResult } from './migrate.js';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Orm = BetterSQLite3Database<Schema>;
export type SqliteDatabase = Database.Database;

/**
 * Seam for an encrypted backend (§33). Not implemented in v1.0: an implementation would load a
 * SQLCipher-enabled build and issue PRAGMA key before any other statement. The key itself must
 * come from the SecretStore, never from config or the DB.
 */
export interface DatabaseCipher {
  readonly name: string;
  /** Called right after opening, before migrations. */
  apply(sqlite: SqliteDatabase, key: string): void;
}

export interface OpenDatabaseOptions {
  /** File path, or ":memory:" (default). */
  path?: string;
  /** Directory for raw blobs (§52 blobs/). Without it blobs are stored inline. */
  blobsDir?: string;
  readonly?: boolean;
  /** Run pending migrations (default true). */
  migrate?: boolean;
  cipher?: DatabaseCipher;
  cipherKey?: string;
}

export interface UniContextDatabase {
  readonly sqlite: SqliteDatabase;
  readonly orm: Orm;
  readonly path: string;
  readonly blobsDir: string | undefined;
  readonly migration: MigrateResult | undefined;
  /** Run fn in a SQLite transaction (synchronous). */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function openDatabase(options: OpenDatabaseOptions = {}): UniContextDatabase {
  const file = options.path ?? ':memory:';
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file, { readonly: options.readonly ?? false });
  if (options.cipher) {
    if (!options.cipherKey) throw new Error('cipherKey is required when a cipher is configured');
    options.cipher.apply(sqlite, options.cipherKey);
  }
  if (file !== ':memory:' && !options.readonly) sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const migration = options.migrate === false || options.readonly ? undefined : migrate(sqlite);
  const orm = drizzle(sqlite, { schema });
  return {
    sqlite,
    orm,
    path: file,
    blobsDir: options.blobsDir,
    migration,
    transaction: <T>(fn: () => T): T => sqlite.transaction(fn)(),
    close: () => sqlite.close(),
  };
}
