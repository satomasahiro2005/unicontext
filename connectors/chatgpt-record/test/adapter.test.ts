import { rm } from 'node:fs/promises';
import path from 'node:path';
import { type SyncResult, type WatchListener } from '@unicontext/connector-sdk';
import { ManualClock } from '@unicontext/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  externalIdFor,
  rootKeyFor,
  type FileEventKind,
  type TranscriptPayload,
  type WatcherLike,
  type WatcherOptions,
} from '../src/index.js';
import {
  collect,
  createAdapter,
  lectureTree,
  makeTempDir,
  put,
  removeDir,
  setMtime,
  SRT_LECTURE,
  TXT_LECTURE,
  VTT_LECTURE,
  WHISPER_JSON,
} from './helpers.js';

let root: string;
let cache: string;

beforeEach(async () => {
  root = await makeTempDir();
  cache = await makeTempDir('uc-record-cache-');
});
afterEach(async () => {
  await removeDir(root);
  await removeDir(cache);
});

const pl = (item: { payload: unknown }): TranscriptPayload => item.payload as TranscriptPayload;

describe('manual import', () => {
  it('importFile returns a SyncResult with a transcript.file item', async () => {
    const abs = await put(root, 'elsewhere/lecture.vtt', VTT_LECTURE);
    const adapter = createAdapter({ watchDir: path.join(root, 'Records') });
    const res = await adapter.importFile(abs, {
      courseHint: 'データベースシステム論',
      date: '2026-10-01',
      title: '第3回',
    });
    expect(res.hasMore).toBe(false);
    expect(res.items).toHaveLength(1);
    const [item] = res.items;
    expect(item?.sourceType).toBe('transcript.file');
    expect(item?.externalId).toMatch(/^file:[0-9a-f]{16}$/);
    expect(pl(item as { payload: unknown })).toMatchObject({
      fileName: 'lecture.vtt',
      format: 'vtt',
      title: '第3回',
      courseHint: 'データベースシステム論',
      language: 'ja',
      importer: 'chatgpt-record',
    });
    expect(pl(item as { payload: unknown }).recordedAt).toBe('2026-09-30T15:00:00.000Z');
    expect(JSON.stringify(item?.payload)).not.toContain(root); // no absolute paths in the payload
    // importing the same path again keeps the id (update, not duplicate)
    const again = await adapter.importFile(abs);
    expect(again.items[0]?.externalId).toBe(item?.externalId);
  });

  it('importFile inside watchDir derives the course from the folder and shares the scan id', async () => {
    const records = path.join(root, 'Records');
    const abs = await put(
      records,
      '2026前期/データベースシステム論/2026-10-01 10-40.vtt',
      VTT_LECTURE,
    );
    const adapter = createAdapter({ watchDir: records }, { cacheDir: cache });
    const res = await adapter.importFile(abs);
    expect(pl(res.items[0] as { payload: unknown }).courseHint).toBe('データベースシステム論');
    expect(res.items[0]?.externalId).toBe(
      externalIdFor(
        rootKeyFor(path.resolve(records)),
        '2026前期/データベースシステム論/2026-10-01 10-40.vtt',
      ),
    );
    // already imported: the folder scan does not emit it again
    expect((await collect(adapter, { mode: 'incremental' })).items).toEqual([]);
  });

  it('importFile rejects unsupported and empty files', async () => {
    const adapter = createAdapter({ watchDir: path.join(root, 'Records') });
    const docx = await put(root, 'a.docx', 'x');
    await expect(adapter.importFile(docx)).rejects.toThrow(/Unsupported transcript format/);
    const empty = await put(root, 'empty.txt', '\n');
    await expect(adapter.importFile(empty)).rejects.toThrow(/No transcript segments/);
    await expect(adapter.importFile(path.join(root, 'missing.txt'))).rejects.toThrow();
  });

  it('importText detects the format and builds a content-addressed id', async () => {
    const adapter = createAdapter({ watchDir: path.join(root, 'Records') });
    const vtt = await adapter.importText(VTT_LECTURE, { date: '2026-10-01', courseHint: 'DB' });
    expect(pl(vtt.items[0] as { payload: unknown })).toMatchObject({
      format: 'vtt',
      fileName: 'transcript.vtt',
    });
    const json = await adapter.importText(WHISPER_JSON, { fileName: 'whisper-out.json' });
    expect(pl(json.items[0] as { payload: unknown })).toMatchObject({
      format: 'json',
      title: 'whisper-out',
    });
    const txt = await adapter.importText(TXT_LECTURE, { importer: 'zoom' });
    expect(pl(txt.items[0] as { payload: unknown })).toMatchObject({
      format: 'txt',
      importer: 'zoom',
    });
    expect(txt.items[0]?.externalId).toMatch(/^text:[0-9a-f]{16}$/);
    const txt2 = await adapter.importText(TXT_LECTURE);
    expect(txt2.items[0]?.externalId).toBe(txt.items[0]?.externalId);
  });
});

describe('folder scan', () => {
  it('scans watchDir, infers the course from the folder, skips hidden/unsupported files', async () => {
    const records = path.join(root, 'Records');
    await lectureTree(records);
    const adapter = createAdapter({ watchDir: records });
    const { items, warnings } = await collect(adapter, { mode: 'initial' });
    expect(warnings).toEqual([]);
    const byName = new Map(items.map((i) => [pl(i).fileName, pl(i)]));
    expect([...byName.keys()].sort()).toEqual([
      '2026-10-01 10-40.vtt',
      '2026-10-03.json',
      '20261002_0900.txt',
    ]);
    expect(byName.get('2026-10-01 10-40.vtt')).toMatchObject({
      courseHint: 'データベースシステム論',
      recordedAt: '2026-10-01T01:40:00.000Z',
    });
    expect(byName.get('20261002_0900.txt')).toMatchObject({
      courseHint: '線形代数',
      recordedAt: '2026-10-02T00:00:00.000Z',
      title: '第3回 正規化',
    });
    expect(byName.get('2026-10-03.json')?.segments).toHaveLength(2);
  });

  it('uses the manifest: second sync emits nothing, modify re-emits, delete reports a deletion', async () => {
    const records = path.join(root, 'Records');
    const a = await put(records, 'DB/2026-10-01.vtt', VTT_LECTURE);
    await put(records, 'DB/2026-10-08.srt', SRT_LECTURE);
    await setMtime(a, 10);
    const adapter = createAdapter({ watchDir: records }, { cacheDir: cache });
    expect((await collect(adapter, { mode: 'initial' })).items).toHaveLength(2);
    expect((await collect(adapter, { mode: 'incremental' })).items).toEqual([]);

    await put(
      records,
      'DB/2026-10-01.vtt',
      `${VTT_LECTURE}\n5\n01:10:00.000 --> 01:10:02.000\n追記です\n`,
    );
    await setMtime(a, 20);
    const changed = await collect(adapter, { mode: 'incremental' });
    expect(changed.items.map((i) => pl(i).fileName)).toEqual(['2026-10-01.vtt']);
    expect(pl(changed.items[0] as { payload: unknown }).segments).toHaveLength(5);

    await setMtime(a, 30); // touched, same content: not re-emitted
    expect((await collect(adapter, { mode: 'incremental' })).items).toEqual([]);

    await rm(path.join(records, 'DB', '2026-10-08.srt'));
    const del = await collect(adapter, { mode: 'incremental' });
    expect(del.deletions).toEqual([keyOf2(records, 'DB/2026-10-08.srt')]);
    expect(del.items).toEqual([]);

    expect((await collect(adapter, { mode: 'full' })).items).toHaveLength(1);
  });

  it('persists the manifest in cacheDir; an unreachable watchDir keeps its transcripts', async () => {
    const records = path.join(root, 'Records');
    await put(records, 'DB/a.txt', TXT_LECTURE);
    const a1 = createAdapter({ watchDir: records }, { cacheDir: cache });
    await collect(a1, { mode: 'initial' });
    await a1.dispose();
    const a2 = createAdapter({ watchDir: records }, { cacheDir: cache });
    expect((await collect(a2, { mode: 'incremental' })).items).toEqual([]);
    await removeDir(records);
    const gone = await collect(a2, { mode: 'incremental' });
    expect(gone.deletions).toEqual([]);
    expect(gone.warnings.join(' ')).toContain('Watch directory not found');
    expect((await a2.health()).state).toBe('degraded');
  });

  it('warns about unparsable files without failing the sync, and retries only after a change', async () => {
    const records = path.join(root, 'Records');
    const bad = await put(records, 'DB/bad.json', '{nope');
    await put(records, 'DB/ok.txt', '[00:00:01] はい');
    await setMtime(bad, 5);
    const adapter = createAdapter({ watchDir: records });
    const first = await collect(adapter, { mode: 'initial' });
    expect(first.items.map((i) => pl(i).fileName)).toEqual(['ok.txt']);
    expect(first.warnings.some((w) => w.includes('bad.json'))).toBe(true);
    expect((await collect(adapter, { mode: 'incremental' })).warnings).toEqual([]);
    await put(records, 'DB/bad.json', JSON.stringify([{ start: 1, text: 'fixed' }]));
    await setMtime(bad, 50);
    expect(
      (await collect(adapter, { mode: 'incremental' })).items.map((i) => pl(i).fileName),
    ).toEqual(['bad.json']);
  });

  it('pages large folders', async () => {
    const records = path.join(root, 'Records');
    for (let i = 0; i < 5; i++) await put(records, `DB/f${i}.txt`, `[00:00:0${i}] 発言${i}`);
    const adapter = createAdapter({ watchDir: records, pageSize: 2 });
    const { pages, items } = await collect(adapter, { mode: 'initial' });
    expect(pages.map((p) => p.items.length)).toEqual([2, 2, 1]);
    expect(pages.map((p) => p.hasMore)).toEqual([true, true, false]);
    expect(new Set(items.map((i) => i.externalId)).size).toBe(5);
  });

  it('defaults watchDir to ~/University/Records', async () => {
    const { resolveWatchDir } = await import('../src/index.js');
    expect(resolveWatchDir({}, path.join(root, 'home'))).toBe(
      path.join(root, 'home', 'University', 'Records'),
    );
  });
});

const keyOf2 = (watchDir: string, rel: string): string =>
  externalIdFor(rootKeyFor(path.resolve(watchDir)), rel);

class FakeWatcher implements WatcherLike {
  handler: ((event: FileEventKind, p: string) => void) | undefined;
  closed = false;
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

describe('watch()', () => {
  it('debounces events into one SyncResult (fake watcher + manual clock)', async () => {
    const records = path.join(root, 'Records');
    const a = await put(records, 'DB/a.txt', TXT_LECTURE);
    const b = await put(records, 'DB/b.txt', '[00:00:01] b');
    const clock = new ManualClock(new Date('2026-10-01T00:00:00Z'));
    const fake = new FakeWatcher();
    let options: WatcherOptions | undefined;
    const adapter = createAdapter(
      { watchDir: records },
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
    const listener: WatchListener = { onResult: (r) => void results.push(r) };
    const handle = await adapter.watch(listener);

    await put(records, 'DB/a.txt', `${TXT_LECTURE}[00:02:00] 追加\n`);
    await setMtime(a, 900);
    const c = await put(records, 'DB/c.vtt', VTT_LECTURE);
    await rm(b);
    fake.fire('change', a);
    await clock.advance(600);
    fake.fire('add', c);
    fake.fire('unlink', b);
    fake.fire('add', path.join(records, '.hidden', 'x.txt'));
    fake.fire('add', path.join(records, 'DB', 'notes.pdf'));
    await clock.advance(999);
    expect(results).toHaveLength(0);
    await clock.advance(1);
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]?.items.map((i) => pl(i).fileName).sort()).toEqual(['a.txt', 'c.vtt']);
    expect(results[0]?.deletions).toEqual([
      { sourceType: 'transcript.file', externalId: keyOf2(records, 'DB/b.txt') },
    ]);
    expect(options?.ignored(path.join(records, '.git', 'x'))).toBe(true);
    expect(options?.ignored(path.join(records, 'DB', 'a.txt'))).toBe(false);

    const after = await collect(adapter, { mode: 'incremental' });
    expect(after.items).toEqual([]);
    expect(after.deletions).toEqual([]);

    await handle.close();
    expect(fake.closed).toBe(true);
  });

  it('does not watch a missing directory', async () => {
    const adapter = createAdapter({ watchDir: path.join(root, 'nope') });
    const errors: unknown[] = [];
    const handle = await adapter.watch({
      onResult: () => undefined,
      onError: (e) => errors.push(e),
    });
    expect(errors).toHaveLength(1);
    await handle.close();
  });

  it('works with the real file system watcher', async () => {
    const records = path.join(root, 'Records');
    await put(records, 'seed.txt', '[00:00:01] seed');
    const adapter = createAdapter({
      watchDir: records,
      watchDebounceMs: 150,
      watchStabilityMs: 100,
    });
    await collect(adapter, { mode: 'initial' });
    const results: SyncResult[] = [];
    const handle = await adapter.watch({ onResult: (r) => void results.push(r) });
    try {
      const abs = await put(records, '線形代数/2026-10-02 09-00.vtt', VTT_LECTURE);
      await vi.waitFor(
        () =>
          expect(results.flatMap((r) => r.items).map((i) => pl(i).fileName)).toContain(
            '2026-10-02 09-00.vtt',
          ),
        { timeout: 15000, interval: 100 },
      );
      const item = results
        .flatMap((r) => r.items)
        .find((i) => pl(i).fileName.startsWith('2026-10-02'));
      expect(pl(item as { payload: unknown })).toMatchObject({
        courseHint: '線形代数',
        format: 'vtt',
      });
      await rm(abs);
      await vi.waitFor(
        () =>
          expect(results.flatMap((r) => r.deletions ?? []).map((d) => d.externalId)).toContain(
            keyOf2(records, '線形代数/2026-10-02 09-00.vtt'),
          ),
        { timeout: 15000, interval: 100 },
      );
    } finally {
      await handle.close();
      await adapter.dispose();
    }
  }, 40000);
});

describe('adapter basics', () => {
  it('authenticate is not_required; capabilities are lectures', async () => {
    const adapter = createAdapter({ watchDir: root });
    expect(await adapter.authenticate()).toEqual({ status: 'not_required' });
    expect(await adapter.capabilities()).toEqual(['lectures']);
    expect((await adapter.health()).state).toBe('healthy');
  });
});
