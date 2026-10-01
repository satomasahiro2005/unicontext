import { rm } from 'node:fs/promises';
import path from 'node:path';
import { type WatchListener, type SyncResult } from '@unicontext/connector-sdk';
import { ManualClock } from '@unicontext/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FileDocumentPayload,
  type FileEventKind,
  type WatcherFactory,
  type WatcherLike,
  type WatcherOptions,
  externalIdFor,
  rootKeyFor,
} from '../src/index.js';
import {
  buildUniversityTree,
  collect,
  createAdapter,
  makeDocx,
  makePdf,
  makeTempDir,
  put,
  removeDir,
  setMtime,
} from './helpers.js';

let root: string;
let cache: string;

beforeEach(async () => {
  root = await makeTempDir();
  cache = await makeTempDir('uc-local-files-cache-');
});
afterEach(async () => {
  await removeDir(root);
  await removeDir(cache);
});

const keyOf = (rel: string): string => externalIdFor(rootKeyFor(path.resolve(root)), rel);
const payloadOf = (items: { payload: unknown }[], i: number): FileDocumentPayload =>
  items[i]?.payload as FileDocumentPayload;
const byRel = (items: { payload: unknown }[]): Map<string, FileDocumentPayload> =>
  new Map(
    items.map((it) => [
      (it.payload as FileDocumentPayload).relativePath,
      it.payload as FileDocumentPayload,
    ]),
  );

describe('initial sync and extraction', () => {
  it('walks the roots, applies default excludes and extracts content', async () => {
    await buildUniversityTree(root);
    const adapter = createAdapter({ roots: [root] });
    const { items, warnings } = await collect(adapter, { mode: 'initial' });
    const files = byRel(items);
    expect([...files.keys()].sort()).toEqual(
      [
        '2026前期/データベースシステム論/index.html',
        '2026前期/データベースシステム論/lecture.mp4',
        '2026前期/データベースシステム論/photo.png',
        '2026前期/データベースシステム論/report.docx',
        '2026前期/データベースシステム論/slides 2026-10-01.pptx',
        '2026前期/データベースシステム論/メモ.md',
        '2026前期/データベースシステム論/第3回.pdf',
        'readme.txt',
        'ノート/todo.txt',
      ].sort(),
    );
    expect(warnings).toEqual([]);
    const dir = '2026前期/データベースシステム論';
    const pdf = files.get(`${dir}/第3回.pdf`);
    expect(pdf?.pages?.map((p) => p.text)).toEqual(['Relational model', 'Normalization']);
    expect(pdf?.mimeType).toBe('application/pdf');
    expect(pdf?.courseFolder).toBe('データベースシステム論');
    expect(pdf?.termFolder).toBe('2026前期');
    expect(pdf?.root).toBe(path.resolve(root));
    const pptx = files.get(`${dir}/slides 2026-10-01.pptx`);
    expect(pptx?.slides?.map((s) => s.title)).toEqual(['ER図', '正規化']);
    expect(pptx?.slides?.[0]?.notes).toBe('例を板書する');
    expect(files.get(`${dir}/report.docx`)?.text).toContain('レポート本文');
    expect(files.get(`${dir}/メモ.md`)?.text).toContain('レポートを提出する');
    expect(files.get(`${dir}/index.html`)?.text).toContain('授業ページ');
    expect(files.get(`${dir}/photo.png`)?.image).toEqual({ width: 64, height: 32 });
    expect(files.get(`${dir}/lecture.mp4`)).toMatchObject({ ext: 'mp4', mimeType: 'video/mp4' });
    expect(files.get(`${dir}/lecture.mp4`)?.text).toBeUndefined();
    expect(files.get('readme.txt')?.courseFolder).toBeUndefined();
    expect(files.get('ノート/todo.txt')?.courseFolder).toBe('ノート');
    for (const it of items) {
      expect(it.sourceType).toBe('file.document');
      expect((it.payload as FileDocumentPayload).hash).toMatch(/^[0-9a-f]{64}$/);
      expect(it.sourceUpdatedAt).toBe((it.payload as FileDocumentPayload).mtime);
    }
  });

  it('turns a corrupt file into a warning, not a failure', async () => {
    await put(root, 'good.txt', 'hello');
    await put(root, 'broken.pdf', 'this is not a pdf');
    const adapter = createAdapter({ roots: [root] });
    const { items, warnings } = await collect(adapter, { mode: 'initial' });
    expect(items).toHaveLength(2);
    expect(byRel(items).get('broken.pdf')?.note).toMatch(/extraction failed/);
    expect(byRel(items).get('broken.pdf')?.pages).toBeUndefined();
    expect(warnings.some((w) => w.includes('broken.pdf'))).toBe(true);
  });

  it('lists files above maxFileSizeMb as metadata only', async () => {
    await put(root, 'big.txt', 'x'.repeat(2000));
    await put(root, 'small.txt', 'tiny');
    const adapter = createAdapter({ roots: [root], maxFileSizeMb: 0.001 });
    const { items } = await collect(adapter, { mode: 'initial' });
    const files = byRel(items);
    expect(files.get('big.txt')?.text).toBeUndefined();
    expect(files.get('big.txt')?.note).toMatch(/metadata only/);
    expect(files.get('small.txt')?.text).toBe('tiny');
  });

  it('honours include and exclude globs', async () => {
    await put(root, 'a.pdf', makePdf(['A']));
    await put(root, 'b.txt', 'b');
    await put(root, 'private/c.pdf', makePdf(['C']));
    const adapter = createAdapter({ roots: [root], include: ['*.pdf'], exclude: ['private'] });
    const { items } = await collect(adapter, { mode: 'initial' });
    expect(items.map((i) => payloadOf([i], 0).relativePath)).toEqual(['a.pdf']);
  });

  it('pages large sets with hasMore / nextPageToken', async () => {
    for (let i = 0; i < 7; i++) await put(root, `f${i}.txt`, `file ${i}`);
    const adapter = createAdapter({ roots: [root], pageSize: 3 });
    const { pages, items } = await collect(adapter, { mode: 'initial' });
    expect(pages.map((p) => p.items.length)).toEqual([3, 3, 1]);
    expect(pages.map((p) => p.hasMore)).toEqual([true, true, false]);
    expect(pages[0]?.nextPageToken).toBe('3');
    expect(new Set(items.map((i) => i.externalId)).size).toBe(7);
  });

  it('reports a missing root as a warning and health as degraded', async () => {
    const missing = path.join(root, 'nope');
    const adapter = createAdapter({ roots: [missing] });
    const res = await collect(adapter, { mode: 'initial' });
    expect(res.items).toEqual([]);
    expect(res.warnings.join(' ')).toContain('Root directory not found');
    expect((await adapter.health()).state).toBe('degraded');
    expect((await createAdapter({ roots: [root] }).health()).state).toBe('healthy');
  });

  it('authenticate is not_required and capabilities are files/materials', async () => {
    const adapter = createAdapter({ roots: [root] });
    expect(await adapter.authenticate()).toEqual({ status: 'not_required' });
    expect(await adapter.capabilities()).toEqual(['files', 'materials']);
  });

  it('defaults to ~/University under the given home directory', async () => {
    const { resolveRoots } = await import('../src/index.js');
    expect(resolveRoots({}, path.join(root, 'home'))).toEqual([
      path.join(root, 'home', 'University'),
    ]);
    expect(resolveRoots({ roots: [] }, '/h')).toEqual([path.resolve('/h', 'University')]);
  });
});

describe('manifest diffing', () => {
  it('does not re-emit unchanged files; re-emits modified ones; reports deletions', async () => {
    const a = await put(root, 'a.txt', 'one');
    await put(root, 'b.txt', 'two');
    await setMtime(a, 10);
    const adapter = createAdapter({ roots: [root] });
    const first = await collect(adapter, { mode: 'initial' });
    expect(first.items).toHaveLength(2);

    const second = await collect(adapter, { mode: 'incremental' });
    expect(second.items).toEqual([]);
    expect(second.deletions).toEqual([]);

    await put(root, 'a.txt', 'one changed');
    await setMtime(a, 20);
    const third = await collect(adapter, { mode: 'incremental' });
    expect(third.items.map((i) => payloadOf([i], 0).relativePath)).toEqual(['a.txt']);
    expect(payloadOf(third.items, 0).text).toBe('one changed');

    await rm(path.join(root, 'b.txt'));
    const fourth = await collect(adapter, { mode: 'incremental' });
    expect(fourth.items).toEqual([]);
    expect(fourth.deletions).toEqual([keyOf('b.txt')]);
    expect(fourth.pages[0]?.deletions?.[0]).toEqual({
      sourceType: 'file.document',
      externalId: keyOf('b.txt'),
    });
    expect((await collect(adapter, { mode: 'incremental' })).deletions).toEqual([]);
  });

  it('a touched file with identical content is not re-emitted (hash check)', async () => {
    const a = await put(root, 'a.txt', 'same');
    await setMtime(a, 10);
    const adapter = createAdapter({ roots: [root] });
    await collect(adapter, { mode: 'initial' });
    await setMtime(a, 99);
    const again = await collect(adapter, { mode: 'incremental' });
    expect(again.items).toEqual([]);
    // the manifest learned the new mtime, so the next run does not even read the file
    expect((await collect(adapter, { mode: 'incremental' })).items).toEqual([]);
  });

  it('mode full re-extracts everything', async () => {
    await put(root, 'a.txt', 'one');
    await put(root, 'b.txt', 'two');
    const adapter = createAdapter({ roots: [root] });
    await collect(adapter, { mode: 'initial' });
    expect((await collect(adapter, { mode: 'incremental' })).items).toHaveLength(0);
    expect((await collect(adapter, { mode: 'full' })).items).toHaveLength(2);
  });

  it('persists the manifest in cacheDir across adapter instances', async () => {
    await put(root, 'a.txt', 'one');
    const a1 = createAdapter({ roots: [root] }, { cacheDir: cache });
    expect((await collect(a1, { mode: 'initial' })).items).toHaveLength(1);
    await a1.dispose();
    const a2 = createAdapter({ roots: [root] }, { cacheDir: cache });
    expect((await collect(a2, { mode: 'incremental' })).items).toEqual([]);
    await rm(path.join(root, 'a.txt'));
    expect((await collect(a2, { mode: 'incremental' })).deletions).toEqual([keyOf('a.txt')]);
  });

  it('keeps the files of an unreachable root (unplugged drive) instead of deleting them', async () => {
    await put(root, 'a.txt', 'one');
    const a1 = createAdapter({ roots: [root] }, { cacheDir: cache });
    await collect(a1, { mode: 'initial' });
    await a1.dispose();
    await removeDir(root);
    const a2 = createAdapter({ roots: [root] }, { cacheDir: cache });
    const res = await collect(a2, { mode: 'incremental' });
    expect(res.deletions).toEqual([]);
    expect(res.warnings.join(' ')).toContain('Root directory not found');
    // a root that is no longer configured does delete its files
    const other = await makeTempDir();
    try {
      const a3 = createAdapter({ roots: [other] }, { cacheDir: cache });
      expect((await collect(a3, { mode: 'incremental' })).deletions).toEqual([keyOf('a.txt')]);
    } finally {
      await removeDir(other);
    }
  });

  it('a new file in a later run is emitted with a different hash id per root', async () => {
    const r2 = await makeTempDir();
    try {
      await put(root, 'same.txt', 'x');
      await put(r2, 'same.txt', 'x');
      const adapter = createAdapter({ roots: [root, r2] });
      const { items } = await collect(adapter, { mode: 'initial' });
      expect(items).toHaveLength(2);
      expect(new Set(items.map((i) => i.externalId)).size).toBe(2);
    } finally {
      await removeDir(r2);
    }
  });

  it('page 2 of a multi-page run does not re-scan (stable plan)', async () => {
    for (let i = 0; i < 4; i++) await put(root, `f${i}.txt`, `file ${i}`);
    const adapter = createAdapter({ roots: [root], pageSize: 2 });
    const p1 = await adapter.sync({ mode: 'initial' });
    await put(root, 'late.txt', 'late'); // appears mid-run; picked up by the next run
    const p2 = await adapter.sync({ mode: 'initial', pageToken: p1.nextPageToken as string });
    expect(p1.items.length + p2.items.length).toBe(4);
    expect(p2.hasMore).toBe(false);
    const next = await collect(adapter, { mode: 'incremental' });
    expect(next.items.map((i) => payloadOf([i], 0).relativePath)).toEqual(['late.txt']);
  });
});

// ------------------------------------------------------------------------------- watching

class FakeWatcher implements WatcherLike {
  handler: ((event: FileEventKind, p: string) => void) | undefined;
  closed = false;
  options: WatcherOptions | undefined;
  roots: string[] = [];
  onFile(handler: (event: FileEventKind, p: string) => void): void {
    this.handler = handler;
  }
  onError(): void {}
  ready(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  fire(event: FileEventKind, p: string): void {
    this.handler?.(event, p);
  }
}

describe('watch() with a fake watcher', () => {
  it('debounces events into one SyncResult with changed items and deletions', async () => {
    const a = await put(root, 'a.txt', 'one');
    const b = await put(root, 'b.txt', 'two');
    const clock = new ManualClock(new Date('2026-10-01T00:00:00Z'));
    const fake = new FakeWatcher();
    const factory: WatcherFactory = (roots, options) => {
      fake.roots = roots;
      fake.options = options;
      return fake;
    };
    const adapter = createAdapter(
      { roots: [root], watchDebounceMs: 1000 },
      { clock },
      { createWatcher: factory },
    );
    await collect(adapter, { mode: 'initial' });

    const results: SyncResult[] = [];
    const listener: WatchListener = { onResult: (r) => void results.push(r) };
    const handle = await adapter.watch(listener);
    expect(fake.roots).toEqual([path.resolve(root)]);

    await put(root, 'a.txt', 'one changed');
    await setMtime(a, 500);
    const c = await put(root, 'c.txt', 'three');
    await rm(b);
    fake.fire('change', a);
    await clock.advance(500);
    fake.fire('add', c);
    fake.fire('change', a); // duplicate event collapses
    fake.fire('unlink', b);
    fake.fire('add', path.join(root, '.hidden', 'x.txt')); // excluded
    await clock.advance(999);
    expect(results).toHaveLength(0); // debounce restarts on every event
    await clock.advance(1);
    await vi.waitFor(() => expect(results).toHaveLength(1));
    const [res] = results;
    expect(res?.items.map((i) => (i.payload as FileDocumentPayload).relativePath).sort()).toEqual([
      'a.txt',
      'c.txt',
    ]);
    expect(res?.deletions).toEqual([{ sourceType: 'file.document', externalId: keyOf('b.txt') }]);
    expect(res?.hasMore).toBe(false);

    // a following sync sees nothing new: the watcher updated the manifest
    const after = await collect(adapter, { mode: 'incremental' });
    expect(after.items).toEqual([]);
    expect(after.deletions).toEqual([]);

    await handle.close();
    expect(fake.closed).toBe(true);
    fake.fire('add', c);
    await clock.advance(5000);
    expect(results).toHaveLength(1);
  });

  it('skips events that change nothing (same content) and ignores excluded paths', async () => {
    const a = await put(root, 'a.txt', 'one');
    const clock = new ManualClock(new Date('2026-10-01T00:00:00Z'));
    const fake = new FakeWatcher();
    let options: WatcherOptions | undefined;
    const adapter = createAdapter(
      { roots: [root] },
      { clock },
      {
        createWatcher: (_roots, o) => {
          options = o;
          return fake;
        },
      },
    );
    await collect(adapter, { mode: 'initial' });
    const results: SyncResult[] = [];
    await adapter.watch({ onResult: (r) => void results.push(r) });
    await setMtime(a, 777);
    fake.fire('change', a);
    await clock.advance(1000);
    await new Promise((r) => setTimeout(r, 50));
    expect(results).toHaveLength(0);
    expect(options?.ignored(path.join(root, 'node_modules', 'x.js'))).toBe(true);
    expect(options?.ignored(path.join(root, 'ok.txt'))).toBe(false);
  });

  it('reports watcher batch errors through onError', async () => {
    const clock = new ManualClock(new Date('2026-10-01T00:00:00Z'));
    const fake = new FakeWatcher();
    const adapter = createAdapter({ roots: [root] }, { clock }, { createWatcher: () => fake });
    const errors: unknown[] = [];
    await adapter.watch({
      onResult: () => Promise.reject(new Error('boom')),
      onError: (e) => errors.push(e),
    });
    const f = await put(root, 'new.txt', 'x');
    fake.fire('add', f);
    await clock.advance(1000);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
  });

  it('does not watch when no root exists', async () => {
    const adapter = createAdapter({ roots: [path.join(root, 'missing')] });
    const errors: unknown[] = [];
    const handle = await adapter.watch({
      onResult: () => undefined,
      onError: (e) => errors.push(e),
    });
    expect(errors).toHaveLength(1);
    await handle.close();
  });
});

describe('watch() with the real file system watcher', () => {
  it('emits new, changed and removed files', async () => {
    await put(root, 'seed.txt', 'seed');
    const adapter = createAdapter({
      roots: [root],
      watchDebounceMs: 150,
      watchStabilityMs: 100,
    });
    await collect(adapter, { mode: 'initial' });
    const results: SyncResult[] = [];
    const handle = await adapter.watch({ onResult: (r) => void results.push(r) });
    try {
      const abs = await put(root, 'math/new.txt', 'hello watcher');
      await vi.waitFor(
        () => {
          const items = results.flatMap((r) => r.items);
          expect(
            items.some((i) => (i.payload as FileDocumentPayload).relativePath === 'math/new.txt'),
          ).toBe(true);
        },
        { timeout: 15000, interval: 100 },
      );
      const added = results
        .flatMap((r) => r.items)
        .find((i) => (i.payload as FileDocumentPayload).relativePath === 'math/new.txt');
      expect((added?.payload as FileDocumentPayload).courseFolder).toBe('math');
      expect((added?.payload as FileDocumentPayload).text).toBe('hello watcher');

      await rm(abs);
      await vi.waitFor(
        () => {
          expect(results.flatMap((r) => r.deletions ?? []).map((d) => d.externalId)).toContain(
            keyOf('math/new.txt'),
          );
        },
        { timeout: 15000, interval: 100 },
      );
    } finally {
      await handle.close();
      await adapter.dispose();
    }
  }, 40000);
});

describe('docx fixture sanity', () => {
  it('builds a DOCX that survives a roundtrip through sync', async () => {
    await put(root, 'c/r.docx', await makeDocx(['alpha', 'beta']));
    const { items } = await collect(createAdapter({ roots: [root] }), { mode: 'initial' });
    expect(payloadOf(items, 0).text).toContain('alpha');
  });
});
