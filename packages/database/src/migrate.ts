import { MigrationError, sha256 } from '@unicontext/core';
import type Database from 'better-sqlite3';
import { MIGRATIONS, type Migration } from './migrations/index.js';

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  appliedAt: string;
}

export interface MigrateOptions {
  migrations?: readonly Migration[];
  /** Stop after this version (used by migration tests). */
  targetVersion?: number;
  now?: () => Date;
}

export interface MigrateResult {
  applied: AppliedMigration[];
  currentVersion: number;
}

export function migrationChecksum(m: Migration): string {
  return sha256(m.sql.replace(/\r\n/g, '\n').trim());
}

function ensureTable(sqlite: Database.Database): void {
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
}

export function getAppliedMigrations(sqlite: Database.Database): AppliedMigration[] {
  ensureTable(sqlite);
  const rows = sqlite
    .prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version')
    .all() as {
    version: number;
    name: string;
    checksum: string;
    applied_at: string;
  }[];
  return rows.map((r) => ({
    version: r.version,
    name: r.name,
    checksum: r.checksum,
    appliedAt: r.applied_at,
  }));
}

export function currentSchemaVersion(sqlite: Database.Database): number {
  const applied = getAppliedMigrations(sqlite);
  return applied.length ? (applied[applied.length - 1]?.version ?? 0) : 0;
}

function validateList(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1)
      throw new MigrationError(
        `Migration versions must be consecutive from 1; got ${m.version} at position ${i + 1}`,
      );
    if (!m.name.startsWith(String(m.version).padStart(3, '0')))
      throw new MigrationError(`Migration name ${m.name} must start with its version`);
  });
}

/**
 * Apply pending migrations in order, each in its own transaction. Refuses to run when an applied
 * migration was edited (checksum mismatch) or the DB is newer than this build.
 */
export function migrate(sqlite: Database.Database, options: MigrateOptions = {}): MigrateResult {
  const migrations = options.migrations ?? MIGRATIONS;
  const now = options.now ?? (() => new Date());
  validateList(migrations);
  const applied = getAppliedMigrations(sqlite);
  for (const a of applied) {
    const m = migrations[a.version - 1];
    if (!m)
      throw new MigrationError(
        `Database schema version ${a.version} is newer than this UniContext build supports (${migrations.length})`,
      );
    if (migrationChecksum(m) !== a.checksum)
      throw new MigrationError(`Applied migration ${a.name} was modified (checksum mismatch)`);
  }
  const target = options.targetVersion ?? migrations.length;
  const done: AppliedMigration[] = [];
  const insert = sqlite.prepare(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  );
  for (const m of migrations) {
    if (m.version <= applied.length || m.version > target) continue;
    const record: AppliedMigration = {
      version: m.version,
      name: m.name,
      checksum: migrationChecksum(m),
      appliedAt: now().toISOString(),
    };
    try {
      sqlite.transaction(() => {
        sqlite.exec(m.sql);
        insert.run(record.version, record.name, record.checksum, record.appliedAt);
      })();
    } catch (e) {
      throw new MigrationError(`Migration ${m.name} failed`, { cause: e });
    }
    done.push(record);
  }
  return { applied: done, currentVersion: currentSchemaVersion(sqlite) };
}
