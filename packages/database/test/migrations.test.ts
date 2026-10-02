import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getTableColumns, getTableName, is, Table } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.js';
import {
  currentSchemaVersion,
  getAppliedMigrations,
  migrate,
  MIGRATIONS,
  openDatabase,
} from '../src/index.js';

describe('migrations', () => {
  it('are numbered 001.. and consecutive', () => {
    expect(MIGRATIONS.map((m) => m.name)).toEqual([
      '001_initial',
      '002_fact_model',
      '003_change_events',
      '004_identity_links',
      '005_tasks',
      '006_search',
      '007_source_monitoring',
      '008_additions',
      '009_read_marks',
    ]);
  });

  it('apply from scratch and are idempotent', () => {
    const sqlite = new Database(':memory:');
    const first = migrate(sqlite);
    expect(first.applied).toHaveLength(MIGRATIONS.length);
    expect(first.currentVersion).toBe(MIGRATIONS.length);
    const second = migrate(sqlite);
    expect(second.applied).toHaveLength(0);
    expect(getAppliedMigrations(sqlite).map((m) => m.version)).toEqual(
      MIGRATIONS.map((m) => m.version),
    );
  });

  it('tolerate another process migrating the same file concurrently (daemon + CLI)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'uc-mig-'));
    try {
      const file = path.join(dir, 'unicontext.db');
      const a = new Database(file);
      const b = new Database(file);
      a.pragma('busy_timeout = 5000');
      let raced = false;
      // `now` runs after `a` read schema_migrations and before it applies the first migration.
      const result = migrate(a, {
        now: () => {
          if (!raced) {
            raced = true;
            migrate(b);
          }
          return new Date('2026-10-01T00:00:00Z');
        },
      });
      expect(result.applied).toHaveLength(0);
      expect(result.currentVersion).toBe(MIGRATIONS.length);
      a.close();
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upgrade step by step from an older schema', () => {
    const sqlite = new Database(':memory:');
    migrate(sqlite, { targetVersion: 3 });
    expect(currentSchemaVersion(sqlite)).toBe(3);
    expect(() => sqlite.prepare('SELECT * FROM tasks').all()).toThrow();
    sqlite
      .prepare(
        "INSERT INTO raw_sources (id, connector, created_at, updated_at) VALUES ('s', 'c', 'x', 'x')",
      )
      .run();
    const res = migrate(sqlite);
    expect(res.applied.map((m) => m.version)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(sqlite.prepare('SELECT id FROM raw_sources').all()).toEqual([{ id: 's' }]);
  });

  it('refuse a modified applied migration', () => {
    const sqlite = new Database(':memory:');
    migrate(sqlite);
    const tampered = MIGRATIONS.map((m, i) => (i === 0 ? { ...m, sql: `${m.sql}\n-- edited` } : m));
    expect(() => migrate(sqlite, { migrations: tampered })).toThrow(/checksum/);
  });

  it('refuse a database newer than the build', () => {
    const sqlite = new Database(':memory:');
    migrate(sqlite);
    expect(() => migrate(sqlite, { migrations: MIGRATIONS.slice(0, 2) })).toThrow(/newer/);
  });

  it('roll back a failing migration', () => {
    const sqlite = new Database(':memory:');
    const bad = [
      ...MIGRATIONS,
      {
        version: MIGRATIONS.length + 1,
        name: `${String(MIGRATIONS.length + 1).padStart(3, '0')}_bad`,
        sql: 'CREATE TABLE ok_table (x TEXT); SELECT * FROM missing_table;',
      },
    ];
    expect(() => migrate(sqlite, { migrations: bad })).toThrow(/_bad/);
    expect(currentSchemaVersion(sqlite)).toBe(MIGRATIONS.length);
    expect(() => sqlite.prepare('SELECT * FROM ok_table').all()).toThrow();
  });

  it('match the drizzle schema column-for-column', () => {
    const db = openDatabase();
    for (const value of Object.values(schema)) {
      if (!is(value, Table)) continue;
      const name = getTableName(value);
      const actual = (db.sqlite.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[])
        .map((c) => c.name)
        .sort();
      const expected = Object.values(getTableColumns(value))
        .map((c) => c.name)
        .sort();
      expect(actual, name).toEqual(expected);
    }
    db.close();
  });

  it('create trigram FTS tables', () => {
    const db = openDatabase();
    const tables = (
      db.sqlite.prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%fts5%trigram%'").all() as {
        name: string;
      }[]
    )
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual([
      'fts_announcements',
      'fts_document_chunks',
      'fts_documents',
      'fts_lecture_segments',
      'fts_messages',
    ]);
    db.close();
  });
});
