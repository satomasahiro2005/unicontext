import { AuthRequiredError } from '@unicontext/core';
import { describe, expect, it } from 'vitest';
import type { RawItem, RawDeletion, SyncCursor } from '@unicontext/connector-sdk';
import { harness } from './helpers.js';

const folders = (items: RawItem[]): string[] =>
  items.filter((i) => i.sourceType === 'szvpn.folder').map((i) => i.externalId).sort();
const files = (items: RawItem[]): string[] =>
  items.filter((i) => i.sourceType === 'szvpn.file').map((i) => i.externalId).sort();

async function fullWalk(h: ReturnType<typeof harness>): Promise<{ items: RawItem[]; deletions: RawDeletion[]; cursor: SyncCursor }> {
  const all: RawItem[] = [];
  const dels: RawDeletion[] = [];
  let cursor: SyncCursor | undefined;
  // Run until the frontier is exhausted (no new folders listed).
  for (let i = 0; i < 20; i++) {
    const r = await h.adapter.sync({ mode: i === 0 ? 'initial' : 'incremental', ...(cursor ? { cursor } : {}) });
    all.push(...r.items);
    dels.push(...(r.deletions ?? []));
    cursor = r.cursor;
    const listedThisRun = r.items.some((it) => it.sourceType === 'szvpn.folder');
    if (!listedThisRun && i > 0) break;
  }
  return { items: all, deletions: dels, cursor: cursor! };
}

describe('shizuoka-vpn-files walk', () => {
  it('walks the whole accessible tree, metadata-only, with full paths', async () => {
    const h = harness();
    const { items } = await fullWalk(h);
    const f = files(items);
    // Files from several depths and naming styles are all indexed by full path.
    expect(f).toContain('fs-share:.DS_Store');
    expect(f).toContain('fs-share:class/2024コンピュータ入門（教員A）/資料/第1回.pdf');
    expect(f).toContain('fs-share:class/2025Webシステム設計演習/課題/kadai1.md');
    expect(f).toContain('fs-share:class/2026年度データ処理演習/week01.pdf');
    expect(f).toContain('fs-share:class/共通/注意事項.pdf');
    // Folders are recorded too (for browsing), including the root.
    expect(folders(items)).toContain('fs-share:');
    expect(folders(items)).toContain('fs-share:class');
  });

  it('records a 403 root once as forbidden and never as a deletion', async () => {
    const h = harness();
    const { items, deletions } = await fullWalk(h);
    const report = items.find((i) => i.externalId === 'fs-share:report');
    expect(report?.sourceType).toBe('szvpn.folder');
    expect((report?.payload as { status: string }).status).toBe('forbidden');
    expect(deletions).toHaveLength(0);
  });

  it('a flaky 403/empty on a known folder keeps the last good listing and makes no deletion', async () => {
    const h = harness();
    await fullWalk(h); // index everything once
    const cursorState = (await h.adapter.sync({ mode: 'incremental' })).cursor; // settle

    // Now the course folder flakes: 403 then empty. It must not delete its files.
    const client = h.client;
    client.script['class/2026年度データ処理演習'] = [
      { status: 'forbidden', httpStatus: 403, message: 'ファイル参照エラー' },
      { status: 'empty', httpStatus: 200 },
    ];
    // Force a re-list of that folder by advancing the clock past the refresh window.
    h.clock.set(new Date('2026-10-07T01:00:00Z'));
    let deletions: RawDeletion[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await h.adapter.sync({ mode: 'incremental', ...(cursorState ? { cursor: cursorState } : {}) });
      deletions = deletions.concat(r.deletions ?? []);
    }
    expect(deletions.filter((d) => d.sourceType === 'szvpn.file')).toHaveLength(0);
  });

  it('reconciles a real deletion only from a successful re-listing', async () => {
    const h = harness();
    const first = await fullWalk(h);
    expect(files(first.items)).toContain('fs-share:class/2026年度データ処理演習/week01.pdf');

    // The file genuinely disappears; the folder lists OK without it.
    h.client.tree.listings['class/2026年度データ処理演習'] = [
      { name: 'readme.txt', isFile: 'yes', size: '1.00 KB', timestamp: 'Thu Oct  1 08:40:00 2026' },
    ];
    h.clock.set(new Date('2026-10-09T01:00:00Z'));
    const dels: RawDeletion[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await h.adapter.sync({ mode: 'incremental', cursor: first.cursor });
      dels.push(...(r.deletions ?? []));
      first.cursor = r.cursor!;
    }
    expect(dels).toContainEqual({
      sourceType: 'szvpn.file',
      externalId: 'fs-share:class/2026年度データ処理演習/week01.pdf',
    });
  });

  it('a lost session aborts with auth_required and makes no changes', async () => {
    const h = harness();
    h.client.script[''] = [{ status: 'session', httpStatus: 302 }];
    await expect(h.adapter.sync({ mode: 'initial' })).rejects.toBeInstanceOf(AuthRequiredError);
    const health = await h.adapter.health();
    expect(health.state).toBe('auth_required');
  });

  it('never declares `complete` (so unseen items are never deleted by the engine)', async () => {
    const h = harness();
    const r = await h.adapter.sync({ mode: 'initial' });
    expect(r.complete).toBeUndefined();
  });

  it('resumes the walk across runs via the cursor (bounded per run)', async () => {
    const h = harness({ config: { walk: { maxFoldersPerRun: 1 } } });
    const r1 = await h.adapter.sync({ mode: 'initial' });
    // Only one folder listed in the first run.
    expect(folders(r1.items)).toHaveLength(1);
    const r2 = await h.adapter.sync({ mode: 'incremental', cursor: r1.cursor });
    expect(folders(r2.items).length).toBeGreaterThanOrEqual(1);
    // Eventually everything is indexed.
    const rest = await fullWalk(harness());
    expect(files(rest.items)).toContain('fs-share:class/共通/注意事項.pdf');
  });
});
