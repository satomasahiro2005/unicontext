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

/** Prepared statements kept per connection (distinct SQL texts; the least recently used go first). */
export const STATEMENT_CACHE_SIZE = 500;

/**
 * Make `sqlite.prepare` reuse statements for the same SQL text (drizzle and the stores prepare a
 * statement on every query). A better-sqlite3 statement holds ~9 KB of native memory that V8 does
 * not count, so it is only freed when a garbage collection happens to finalize its wrapper: a loop
 * of a few hundred thousand queries (identity resolution, task derivation over a catalog) grew the
 * process by gigabytes while the JS heap stayed small. A cached statement is handed out again with
 * its default modes (drizzle switches its statements to raw mode), and a statement that is busy (an
 * open iterate()) is never shared.
 */
export function cacheStatements(sqlite: SqliteDatabase, max = STATEMENT_CACHE_SIZE): void {
  const prepare = sqlite.prepare.bind(sqlite) as (source: string) => Database.Statement;
  const cache = new Map<string, Database.Statement>();
  const cached = (source: string): Database.Statement => {
    const hit = cache.get(source);
    if (hit && !hit.busy) {
      cache.delete(source);
      cache.set(source, hit);
      if (hit.reader) hit.raw(false).pluck(false).expand(false);
      return hit;
    }
    const stmt = prepare(source);
    if (!hit) {
      cache.set(source, stmt);
      if (cache.size > max) cache.delete(cache.keys().next().value as string);
    }
    return stmt;
  };
  sqlite.prepare = cached as SqliteDatabase['prepare'];
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
  cacheStatements(sqlite);
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
