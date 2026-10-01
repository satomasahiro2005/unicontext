import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stableId } from '@unicontext/canonical-model';
import { ManualClock } from '@unicontext/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createStores, openDatabase, type UniContextDatabase } from '../src/index.js';

let db: UniContextDatabase;
const dirs: string[] = [];
afterEach(() => {
  db?.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(blobs = false) {
  let blobsDir: string | undefined;
  if (blobs) {
    blobsDir = mkdtempSync(path.join(tmpdir(), 'uc-blobs-'));
    dirs.push(blobsDir);
  }
  db = openDatabase(blobsDir ? { blobsDir } : {});
  const clock = new ManualClock('2026-10-01T00:00:00.000Z');
  const stores = createStores(db, clock);
  stores.raw.ensureSource({ id: 'lcu', connector: 'livecampusu' });
  return { stores, clock };
}

describe('RawStore', () => {
  it('dedupes by content hash and tracks pending normalization', () => {
    const { stores } = setup();
    const a = stores.raw.upsertItem('lcu', {
      sourceType: 'course',
      externalId: '1',
      payload: { b: 1, a: 2 },
    });
    expect(a.status).toBe('inserted');
    const same = stores.raw.upsertItem('lcu', {
      sourceType: 'course',
      externalId: '1',
      payload: { a: 2, b: 1 },
    });
    expect(same.status).toBe('unchanged');
    expect(stores.raw.list({ pendingOnly: true })).toHaveLength(1);
    stores.raw.markNormalized(a.item.id, { version: '1' });
    expect(stores.raw.list({ pendingOnly: true })).toHaveLength(0);
    const changed = stores.raw.upsertItem('lcu', {
      sourceType: 'course',
      externalId: '1',
      payload: { a: 3 },
    });
    expect(changed.status).toBe('updated');
    expect(stores.raw.list({ pendingOnly: true })).toHaveLength(1);
  });

  it('marks deletions and restores', () => {
    const { stores } = setup();
    const a = stores.raw.upsertItem('lcu', { sourceType: 'course', externalId: '1', payload: {} });
    stores.raw.upsertItem('lcu', { sourceType: 'course', externalId: '2', payload: {} });
    stores.raw.markNormalized(a.item.id, { version: '1' });
    const gone = stores.raw.markMissingDeleted('lcu', ['course'], new Set([a.item.id]));
    expect(gone.map((g) => g.externalId)).toEqual(['2']);
    expect(stores.raw.list()).toHaveLength(1);
    expect(stores.raw.list({ includeDeleted: true })).toHaveLength(2);
    expect(
      stores.raw.upsertItem('lcu', { sourceType: 'course', externalId: '2', payload: {} }).status,
    ).toBe('restored');
  });

  it('stores blobs inline or on disk', () => {
    const inline = setup();
    const b = inline.stores.raw.putBlob({
      sourceId: 'lcu',
      data: new TextEncoder().encode('hello'),
      mimeType: 'text/plain',
    });
    expect(b.storage).toBe('inline');
    expect(inline.stores.raw.readBlob(b.id).toString()).toBe('hello');
    db.close();
    const file = setup(true);
    const f = file.stores.raw.putBlob({
      sourceId: 'lcu',
      data: new TextEncoder().encode('pdf bytes'),
    });
    expect(f.storage).toBe('file');
    // portable relative path: the same DB/blobs dir must resolve on macOS/Linux and Windows
    expect(f.path).toBe(`${f.sha256.slice(0, 2)}/${f.sha256}`);
    expect(file.stores.raw.readBlob(f.id).toString()).toBe('pdf bytes');
    // rows written by older Windows builds used "\" separators
    db.sqlite
      .prepare('UPDATE raw_blobs SET path = ? WHERE id = ?')
      .run(`${f.sha256.slice(0, 2)}\\${f.sha256}`, f.id);
    expect(file.stores.raw.readBlob(f.id).toString()).toBe('pdf bytes');
    expect(file.stores.raw.deleteBlobsBySource('lcu')).toBe(1);
  });
});

describe('EntityStore', () => {
  const offering = stableId('courseOffering', 'lcu', 'DB2026');
  it('validates, diffs, soft-deletes and restores', () => {
    const { stores } = setup();
    const created = stores.entities.upsert(
      {
        id: offering,
        kind: 'courseOffering',
        title: 'データベースシステム論',
        instructorIds: [],
        instructorNames: ['山田'],
        schedule: [],
      },
      { sourceId: 'lcu' },
    );
    expect(created.status).toBe('created');
    const again = stores.entities.upsert({ ...created.entity });
    expect(again.status).toBe('unchanged');
    const updated = stores.entities.upsert({ ...created.entity, room: '21教室' });
    expect(updated.status).toBe('updated');
    expect(updated.changedFields).toEqual(['room']);
    expect(
      stores.entities.list('courseOffering', { where: { title: 'データベースシステム論' } }),
    ).toHaveLength(1);
    expect(stores.entities.idsBySource('lcu')).toEqual([offering]);
    expect(stores.entities.softDelete(offering)).toBeDefined();
    expect(stores.entities.get(offering)).toBeUndefined();
    expect(stores.entities.upsert({ ...updated.entity }).status).toBe('restored');
  });

  it('rejects invalid entities', () => {
    const { stores } = setup();
    expect(() =>
      stores.entities.upsert({
        id: 'assignment:x',
        kind: 'assignment',
        title: '',
        dueAt: 'tomorrow',
      } as never),
    ).toThrow();
  });

  it('queries instants across offsets by range', () => {
    const { stores } = setup();
    const a1 = stableId('assignment', 'a1');
    const a2 = stableId('assignment', 'a2');
    stores.entities.upsert({
      id: a1,
      kind: 'assignment',
      title: '課題1',
      dueAt: '2026-10-08T23:59:00+09:00',
    });
    stores.entities.upsert({
      id: a2,
      kind: 'assignment',
      title: '課題2',
      dueAt: '2026-10-09T00:30:00Z',
    });
    const hits = stores.entities.listInRange(
      'assignment',
      'dueAt',
      '2026-10-08T00:00:00+09:00',
      '2026-10-09T00:00:00+09:00',
    );
    expect(hits.map((h) => h.title)).toEqual(['課題1']);
  });

  it('keeps the trigram FTS index in sync (Japanese substring match)', () => {
    const { stores } = setup();
    const id = stableId('announcement', 'x');
    stores.entities.upsert({
      id,
      kind: 'announcement',
      title: '第3回の補足',
      body: '今回はデータの正規化について説明しました。',
    });
    const q = (term: string) =>
      db.sqlite
        .prepare('SELECT entity_id FROM fts_announcements WHERE fts_announcements MATCH ?')
        .all(`"${term}"`);
    expect(q('正規化')).toEqual([{ entity_id: id }]);
    stores.entities.upsert({
      id,
      kind: 'announcement',
      title: '第3回の補足',
      body: 'ER図の書き方',
    });
    expect(q('正規化')).toEqual([]);
    stores.entities.softDelete(id);
    expect(q('ER図')).toEqual([]);
  });
});

describe('source state stores', () => {
  it('persist sync cursors, health, drift and product versions', () => {
    const { stores } = setup();
    stores.syncState.set(
      'lcu',
      { cursor: 'c1', deltaToken: 'd1', extra: { page: 2 } },
      { mode: 'initial', fullSync: true },
    );
    expect(stores.syncState.get('lcu')).toMatchObject({
      cursor: 'c1',
      deltaToken: 'd1',
      extra: { page: 2 },
      lastMode: 'initial',
    });
    stores.health.set('lcu', {
      state: 'degraded',
      checkedAt: '2026-10-01T00:00:00.000Z',
      consecutiveFailures: 1,
    });
    expect(stores.health.get('lcu')?.state).toBe('degraded');
    const fresh = stores.drift.record('lcu', 'course', [{ path: 'newField', kind: 'unknown' }]);
    expect(fresh).toHaveLength(1);
    expect(
      stores.drift.record('lcu', 'course', [{ path: 'newField', kind: 'unknown' }]),
    ).toHaveLength(0);
    expect(stores.drift.list({ sourceId: 'lcu' })[0]?.occurrences).toBe(2);
    stores.versions.record('lcu', 'LiveCampusU', '9.9', false);
    expect(stores.versions.latest('lcu')).toMatchObject({ version: '9.9', known: false });
  });
});
