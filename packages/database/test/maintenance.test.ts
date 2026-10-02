import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stableId } from '@unicontext/canonical-model';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backupDatabase,
  createStores,
  exportJsonl,
  exportJsonlToFile,
  importJsonl,
  importJsonlFile,
  openDatabase,
  purgeSource,
} from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seeded() {
  const db = openDatabase();
  const s = createStores(db);
  for (const src of ['a', 'b']) {
    s.raw.ensureSource({ id: src, connector: src });
    const raw = s.raw.upsertItem(src, { sourceType: 't', externalId: '1', payload: { x: src } });
    const id = stableId('announcement', src);
    s.entities.upsert(
      { id, kind: 'announcement', title: `お知らせ ${src}`, body: '正規化について' },
      { sourceId: src },
    );
    s.sourceRefs.upsert({
      id: stableId('sourceReference', src),
      sourceSystem: src,
      sourceId: src,
      authority: 'lms',
      sourceItemId: '1',
      retrievedAt: '2026-10-01T00:00:00Z',
      rawItemId: raw.item.id,
      entityId: id,
    });
  }
  return { db, s };
}

describe('JSONL export/import (§68)', () => {
  it('round-trips through a file', async () => {
    const { db } = seeded();
    const dir = mkdtempSync(path.join(tmpdir(), 'uc-jsonl-'));
    dirs.push(dir);
    const file = path.join(dir, 'export.jsonl');
    expect(exportJsonlToFile(db, file)).toBe(4);
    expect(readFileSync(file, 'utf8')).not.toContain('payload');
    const copy = openDatabase();
    const report = await importJsonlFile(copy, file, { strict: true });
    expect(report.imported).toMatchObject({ entity: 2, sourceReference: 2 });
    expect(createStores(copy).entities.list('announcement')).toHaveLength(2);
    db.close();
    copy.close();
  });

  it('reports invalid lines without aborting (or throws in strict mode)', () => {
    const { db } = seeded();
    const lines = [
      ...exportJsonl(db),
      '{"type":"entity","data":{"id":"x","kind":"nope"}}',
      'not json',
    ];
    const copy = openDatabase();
    const r = importJsonl(copy, lines);
    expect(r.errors.map((e) => e.line)).toEqual([lines.length - 1, lines.length]);
    expect(() => importJsonl(openDatabase(), lines, { strict: true })).toThrow(/JSONL line/);
  });
});

describe('backup (§62) and purge (§63)', () => {
  it('backs up the database with mappings and metadata, never secrets', async () => {
    const { db } = seeded();
    const dir = mkdtempSync(path.join(tmpdir(), 'uc-backup-'));
    dirs.push(dir);
    const b = await backupDatabase(db, dir, { now: new Date('2026-10-01T00:00:00Z') });
    expect(path.basename(b.directory)).toBe('unicontext-backup-20261001-000000');
    expect(JSON.parse(readFileSync(b.metadataFile, 'utf8'))).toMatchObject({
      containsSecrets: false,
      schemaVersion: 9,
    });
    expect(JSON.parse(readFileSync(b.mappingsFile, 'utf8'))).toEqual({ identityLinks: [] });
    db.close();
  });

  it('removes everything from one source and nothing else', () => {
    const { db, s } = seeded();
    const r = purgeSource(db, 'a');
    expect(r).toMatchObject({ rawItems: 1, sourceReferences: 1, entities: 1 });
    expect(s.raw.listSources().map((x) => x.id)).toEqual(['b']);
    expect(s.entities.list('announcement').map((e) => e.title)).toEqual(['お知らせ b']);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM fts_announcements').get()).toEqual({
      n: 1,
    });
  });

  it('keeps blob files when the purge transaction rolls back', () => {
    const blobsDir = mkdtempSync(path.join(tmpdir(), 'uc-purge-blobs-'));
    dirs.push(blobsDir);
    const db = openDatabase({ blobsDir });
    const s = createStores(db);
    s.raw.ensureSource({ id: 'a', connector: 'a' });
    const blob = s.raw.putBlob({ sourceId: 'a', data: new TextEncoder().encode('lecture.pdf') });
    const file = path.join(blobsDir, ...(blob.path ?? '').split('/'));
    expect(existsSync(file)).toBe(true);
    db.sqlite.exec(
      "CREATE TRIGGER fail_purge BEFORE DELETE ON raw_sources BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    expect(() => purgeSource(db, 'a')).toThrow(/boom/);
    expect(s.raw.getBlob(blob.id)).toBeDefined();
    expect(existsSync(file)).toBe(true);
    db.sqlite.exec('DROP TRIGGER fail_purge');
    expect(purgeSource(db, 'a').rawBlobs).toBe(1);
    expect(existsSync(file)).toBe(false);
    db.close();
  });
});
