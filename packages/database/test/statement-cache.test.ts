import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { cacheStatements, identityLinks, openDatabase } from '../src/index.js';

describe('statement cache', () => {
  it('reuses one statement per SQL text, also for drizzle queries', () => {
    const db = openDatabase();
    const sql = 'SELECT 1 AS one';
    expect(db.sqlite.prepare(sql)).toBe(db.sqlite.prepare(sql));
    const q = () => db.orm.select().from(identityLinks).where(eq(identityLinks.leftId, 'x')).get();
    let prepares = 0;
    const prepare = db.sqlite.prepare.bind(db.sqlite);
    const statements = new Set<unknown>();
    db.sqlite.prepare = ((source: string) => {
      prepares++;
      const s = prepare(source);
      statements.add(s);
      return s;
    }) as typeof db.sqlite.prepare;
    for (let i = 0; i < 100; i++) q();
    expect(prepares).toBe(100);
    expect(statements.size).toBe(1);
    db.close();
  });

  it('hands a cached statement out with its default modes', () => {
    const db = openDatabase();
    db.sqlite.exec('CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1), (2)');
    const sql = 'SELECT a FROM t ORDER BY a';
    // drizzle switches its statements to raw mode
    expect(db.sqlite.prepare(sql).raw().all()).toEqual([[1], [2]]);
    expect(db.sqlite.prepare(sql).all()).toEqual([{ a: 1 }, { a: 2 }]);
    expect(db.sqlite.prepare(sql).pluck().all()).toEqual([1, 2]);
    expect(db.sqlite.prepare(sql).get()).toEqual({ a: 1 });
    db.close();
  });

  it('does not share a statement that is busy iterating', () => {
    const db = openDatabase();
    db.sqlite.exec('CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1), (2)');
    const sql = 'SELECT a FROM t ORDER BY a';
    const outer = db.sqlite.prepare(sql);
    const seen: number[] = [];
    for (const row of outer.iterate() as Iterable<{ a: number }>) {
      const inner = db.sqlite.prepare(sql);
      expect(inner).not.toBe(outer);
      seen.push(row.a, (inner.all() as { a: number }[]).length);
    }
    expect(seen).toEqual([1, 2, 2, 2]);
    db.close();
  });

  it('keeps a bounded number of statements', () => {
    const sqlite = new Database(':memory:');
    cacheStatements(sqlite, 2);
    const a = sqlite.prepare('SELECT 1');
    const two = sqlite.prepare('SELECT 2');
    expect(sqlite.prepare('SELECT 1')).toBe(a); // refreshed: SELECT 2 is now the oldest
    sqlite.prepare('SELECT 3');
    expect(sqlite.prepare('SELECT 1')).toBe(a);
    const b = sqlite.prepare('SELECT 2');
    expect(b).not.toBe(two); // evicted
    expect(sqlite.prepare('SELECT 2')).toBe(b);
    sqlite.close();
  });
});
