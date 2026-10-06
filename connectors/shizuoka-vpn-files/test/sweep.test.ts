import type { RawItem, SyncCursor, SyncInput, SyncResult } from '@unicontext/connector-sdk';
import { AuthRequiredError } from '@unicontext/core';
import { describe, expect, it } from 'vitest';
import { academicYear, isPrefetchPath, ShizuokaVpnFilesConfigSchema, type SessionMarker } from '../src/index.js';
import { harness, NOW, testClock } from './helpers.js';

/*
 * The index-first walk inside one sign-in's window: right after a sign-in (time known), a sync
 * keeps going page after page until the tree is indexed, the per-session cap, or the window ends.
 */

function marker(signedInAt?: string): SessionMarker & { signedIn: string | undefined; verified: string | undefined } {
  const m = {
    signedIn: signedInAt,
    verified: signedInAt,
    read: () => m.verified,
    write: (v: string | undefined) => {
      m.verified = v;
      if (v === undefined) m.signedIn = undefined;
    },
    readSignedInAt: () => m.signedIn,
    writeSignedInAt: (v: string) => {
      m.signedIn = v;
      m.verified = v;
    },
  };
  return m;
}

const minutesAgo = (n: number): string => new Date(NOW.getTime() - n * 60_000).toISOString();
const folders = (items: RawItem[]): string[] =>
  items.filter((i) => i.sourceType === 'szvpn.folder').map((i) => i.externalId);

/** What the sync engine does: call again with the page token while hasMore. */
async function engineRun(
  adapter: { sync(i: SyncInput): Promise<SyncResult> },
  input: SyncInput,
  onPage?: (page: number) => void,
): Promise<{ pages: SyncResult[]; items: RawItem[]; cursor: SyncCursor | undefined }> {
  const pages: SyncResult[] = [];
  let token: string | undefined;
  do {
    onPage?.(pages.length);
    const r = await adapter.sync({ ...input, ...(token ? { pageToken: token } : {}) });
    pages.push(r);
    token = r.hasMore ? r.nextPageToken : undefined;
  } while (token && pages.length < 100);
  return { pages, items: pages.flatMap((p) => p.items), cursor: pages.at(-1)?.cursor };
}

// The synthetic tree has 12 folders (9 listable + 3 forbidden roots).
const TREE_FOLDERS = 12;

describe('walking the whole tree inside a fresh sign-in window', () => {
  it('right after a sign-in, one sync pages through the whole tree (pacing per page unchanged)', async () => {
    const h = harness({
      config: { walk: { maxFoldersPerRun: 3, maxRetries: 0 } },
      sessionMarker: marker(minutesAgo(1)),
    });
    const run = await engineRun(h.adapter, { mode: 'initial' });
    expect(run.pages.length).toBeGreaterThan(3);
    expect(run.pages.slice(0, -1).every((p) => p.hasMore === true)).toBe(true);
    expect(run.pages.at(-1)?.hasMore).toBeUndefined();
    // Each page stayed within maxFoldersPerRun list requests.
    expect(new Set(folders(run.items)).size).toBe(TREE_FOLDERS);
    expect(h.client.listCalls).toHaveLength(TREE_FOLDERS);
    expect(folders(run.items)).toContain('fs-share:class/共通');
  });

  it('a session whose sign-in time is unknown keeps the old one page per sync', async () => {
    const m = marker(minutesAgo(1));
    m.signedIn = undefined; // verified, but not signed in by this UniContext
    const h = harness({ config: { walk: { maxFoldersPerRun: 3, maxRetries: 0 } }, sessionMarker: m });
    const run = await engineRun(h.adapter, { mode: 'initial' });
    expect(run.pages).toHaveLength(1);
    expect(h.client.listCalls).toHaveLength(3);
  });

  it('stops at the session window (sign-in time + sessionMaxMinutes − margin)', async () => {
    const clock = testClock();
    const h = harness({
      clock,
      config: { walk: { maxFoldersPerRun: 2, maxRetries: 0 } },
      sessionMarker: marker(minutesAgo(50)),
    });
    const run = await engineRun(h.adapter, { mode: 'initial' }, (p) => {
      // Page p starts 3·p minutes in: signed in 50 min ago, the window (60 − 5 = 55 min) has
      // closed by the end of the third page (56 min).
      clock.set(new Date(NOW.getTime() + p * 3 * 60_000));
    });
    expect(run.pages).toHaveLength(3);
    expect(run.pages.at(-1)?.hasMore).toBeUndefined();
    // Stopped by the window, not because the tree was done: the third page lists nothing.
    expect(h.client.listCalls).toHaveLength(4);
  });

  it('respects maxFoldersPerSession', async () => {
    const h = harness({
      config: { walk: { maxFoldersPerRun: 2, maxFoldersPerSession: 4, maxRetries: 0 } },
      sessionMarker: marker(minutesAgo(1)),
    });
    const run = await engineRun(h.adapter, { mode: 'initial' });
    expect(run.pages).toHaveLength(2);
    expect(h.client.listCalls).toHaveLength(4);
  });

  it('later pages never re-seed the frontier, and the cursor carries the progress', async () => {
    const h = harness({ config: { walk: { maxFoldersPerRun: 4, maxRetries: 0 } }, sessionMarker: marker(minutesAgo(1)) });
    await engineRun(h.adapter, { mode: 'full' });
    // The share root is listed exactly once even though the sync mode is `full`.
    expect(h.client.listCalls.filter((d) => d === '')).toHaveLength(1);
  });

  it('a session lost on a later page keeps what was listed (cursor saved, no deletion) and says so', async () => {
    const m = marker(minutesAgo(1));
    const h = harness({ config: { walk: { maxFoldersPerRun: 3, maxRetries: 0 } }, sessionMarker: m });
    // The 5th list request (on page 2) bounces to the sign-in page.
    let n = 0;
    const listDir = h.client.listDir.bind(h.client);
    h.client.listDir = (req) => (++n === 5 ? Promise.resolve({ status: 'session', httpStatus: 302 }) : listDir(req));
    const run = await engineRun(h.adapter, { mode: 'initial' });
    expect(run.pages).toHaveLength(2);
    const last = run.pages[1]!;
    expect(last.hasMore).toBeUndefined();
    expect(last.deletions).toBeUndefined();
    expect(last.warnings?.join(' ')).toMatch(/session ended during the walk/);
    expect(folders(run.items).length).toBe(4); // 3 on page 1, 1 before the drop on page 2
    // The cursor holds the frontier, so the next sign-in resumes instead of starting over.
    const extra = last.cursor?.extra as { roots: Record<string, { frontier: string[]; folders: Record<string, unknown> }> };
    expect(Object.keys(extra.roots['fs-share']!.folders)).toHaveLength(4);
    expect(extra.roots['fs-share']!.frontier.length).toBeGreaterThan(0);
    // The session is forgotten: the next run asks for a sign-in.
    expect(m.verified).toBeUndefined();
    expect((await h.adapter.health()).state).toBe('auth_required');
    expect((await h.adapter.authenticate()).status).toBe('auth_required');
  });

  it('a session lost on the first request still fails the run with auth_required and no items', async () => {
    const h = harness({ sessionMarker: marker(minutesAgo(1)) });
    h.client.script[''] = [{ status: 'session', httpStatus: 302 }];
    await expect(h.adapter.sync({ mode: 'initial' })).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('with saved credentials a dropped session is signed in again and the walk goes on', async () => {
    const m = marker(minutesAgo(1));
    let autos = 0;
    const h = harness({
      config: { walk: { maxFoldersPerRun: 3, maxRetries: 0 } },
      sessionMarker: m,
      autoSignIn: () => {
        autos++;
        return Promise.resolve({ status: 'authenticated', message: 'auto', fresh: true });
      },
    });
    let n = 0;
    const listDir = h.client.listDir.bind(h.client);
    h.client.listDir = (req) => (++n === 5 ? Promise.resolve({ status: 'session', httpStatus: 302 }) : listDir(req));
    const run = await engineRun(h.adapter, { mode: 'initial' });
    expect(autos).toBe(1);
    expect(new Set(folders(run.items)).size).toBe(TREE_FOLDERS);
    expect(m.signedIn).toBe(NOW.toISOString()); // the new sign-in opened a new window
  });

  it('with saved credentials that cannot sign in, the reason reaches the error', async () => {
    const h = harness({
      sessionMarker: marker(minutesAgo(1)),
      autoSignIn: () =>
        Promise.resolve({ status: 'auth_required', message: '自動サインインできませんでした: 二段階認証' }),
    });
    h.client.script[''] = [{ status: 'session', httpStatus: 302 }];
    await expect(h.adapter.sync({ mode: 'initial' })).rejects.toThrow(/二段階認証/);
  });

  it('authenticate() signs in again by itself when the marker is too old', async () => {
    const m = marker(minutesAgo(90));
    const h = harness({
      sessionMarker: m,
      autoSignIn: () => Promise.resolve({ status: 'authenticated', message: 'auto', fresh: true }),
    });
    const r = await h.adapter.authenticate();
    expect(r.status).toBe('authenticated');
    expect(r).not.toHaveProperty('fresh');
    expect(m.signedIn).toBe(NOW.toISOString());
  });

  it('a session the automatic sign-in found already live is verified, but opens no new walk window', async () => {
    const m = marker(minutesAgo(90));
    m.signedIn = minutesAgo(58); // its real start: the portal ends it in 2 minutes
    const h = harness({
      config: { walk: { maxFoldersPerRun: 3, maxRetries: 0 } },
      sessionMarker: m,
      autoSignIn: () => Promise.resolve({ status: 'authenticated', message: 'still live' }),
    });
    expect((await h.adapter.authenticate()).status).toBe('authenticated');
    expect(m.verified).toBe(NOW.toISOString());
    expect(m.signedIn).toBe(minutesAgo(58)); // not moved to now
    // So the sync lists one page only, not a 55-minute sweep.
    const run = await engineRun(h.adapter, { mode: 'initial' });
    expect(run.pages).toHaveLength(1);
    expect(h.client.listCalls).toHaveLength(3);
  });

  it('a manual sign-in records the sign-in time and tells the automatic sign-in (not a full reset)', async () => {
    const m = marker();
    let resets = 0;
    let manual = 0;
    const h = harness({
      sessionMarker: m,
      login: () => Promise.resolve({ status: 'authenticated', message: 'ok' }),
      resetAutoSignIn: () => void resets++,
      manualSignInSucceeded: () => void manual++,
    });
    expect((await h.adapter.login()).status).toBe('authenticated');
    expect(m.signedIn).toBe(NOW.toISOString());
    expect([manual, resets]).toEqual([1, 0]);
    h.adapter.credentialsChanged();
    expect([manual, resets]).toEqual([1, 1]);
  });

  it('a later page that finds the session gone (no saved password) keeps the earlier pages: no throw, cursor returned', async () => {
    const m = marker(minutesAgo(1));
    const h = harness({ config: { walk: { maxFoldersPerRun: 3, maxRetries: 0 } }, sessionMarker: m });
    const first = await h.adapter.sync({ mode: 'initial' });
    expect(first.hasMore).toBe(true);
    // The portal ends the session between two pages: withClient's sign-in check says auth.
    const opts = (h.adapter as unknown as { options: { withClient: unknown } }).options;
    opts.withClient = () => Promise.resolve({ auth: { status: 'auth_required', message: 'sign in' } });
    const second = await h.adapter.sync({ mode: 'initial', pageToken: first.nextPageToken!, ...(first.cursor ? { cursor: first.cursor } : {}) });
    expect(second.hasMore).toBeUndefined();
    expect(second.items).toEqual([]);
    expect(second.warnings?.join(' ')).toMatch(/session ended during the walk/);
    const extra = second.cursor?.extra as { roots: Record<string, { folders: Record<string, unknown>; frontier: string[] }> };
    expect(Object.keys(extra.roots['fs-share']!.folders)).toHaveLength(3);
    expect((await h.adapter.health()).state).toBe('auth_required');
  });

  it('a later page that throws (profile held by another process) keeps the earlier pages and rolls back its own', async () => {
    const m = marker(minutesAgo(1));
    const h = harness({ config: { walk: { maxFoldersPerRun: 3, maxRetries: 0 } }, sessionMarker: m });
    const first = await h.adapter.sync({ mode: 'initial' });
    const before = JSON.stringify(first.cursor?.extra);
    // The browser fails in the middle of page 2, after one folder was listed.
    let n = 0;
    const listDir = h.client.listDir.bind(h.client);
    h.client.listDir = (req) => {
      if (++n === 2) throw new Error('BrowserProfileInUseError: the browser profile is in use');
      return listDir(req);
    };
    const second = await h.adapter.sync({ mode: 'initial', pageToken: first.nextPageToken! });
    expect(second.hasMore).toBeUndefined();
    expect(second.warnings?.join(' ')).toMatch(/walk stopped/);
    // Exactly the state after page 1: the folder page 2 listed but never returned is not claimed.
    expect(JSON.stringify(second.cursor?.extra)).toBe(before);
  });
});

describe('downloads when the session is gone', () => {
  const req = (name: string) => ({
    externalId: `fs-share:class/x/${name}`,
    payload: {
      root: 'fs-share',
      parent: 'class/x',
      path: `class/x/${name}`,
      name,
      label: 'FS share / class / x',
      resourceId: 'r',
      bookmark: 'FS share',
      dir: 'class/x',
      version: 'v|1',
      listedAt: NOW.toISOString(),
      course: null,
      prefetch: false,
      sizeBytes: 3,
    },
    targetPath: `${process.env.TEMP ?? '/tmp'}/uc-vpn-dl-${Date.now()}-${name}`,
    maxBytes: 1000,
    extract: false,
  });

  it('a file not cached yet says clearly that a sign-in is needed (index still usable)', async () => {
    const h = harness({ authFail: true });
    await expect(h.adapter.downloadFiles([req('a.pdf')])).rejects.toThrow(
      /まだ UniContext に保存されていない[\s\S]*unicontext login shizuoka-vpn-files/,
    );
  });

  it('with saved credentials it signs in again and retries once', async () => {
    let calls = 0;
    const h = harness({
      autoSignIn: () => Promise.resolve({ status: 'authenticated', message: 'auto' }),
    });
    h.client.files['class/x\u0000a.pdf'] = new Uint8Array([1, 2, 3]);
    const stream = h.client.streamFile.bind(h.client);
    h.client.streamFile = (r, on) =>
      ++calls === 1 ? Promise.resolve({ ok: false, reason: 'session' }) : stream(r, on);
    const out = await h.adapter.downloadFiles([req('a.pdf')]);
    expect(out.results[0]?.status).toBe('downloaded');
    expect(calls).toBe(2);
  });
});

describe('prefetching the current year’s class folders (opt-in)', () => {
  it('marks files inside a course folder of the current academic year', () => {
    const cfg = ShizuokaVpnFilesConfigSchema.parse({ prefetchCurrentYear: true });
    expect(isPrefetchPath(cfg, 'class/2026年度データ処理演習/week01.pdf', 2026)).toBe(true);
    expect(isPrefetchPath(cfg, 'class/2026年度データ処理演習/資料/a.pdf', 2026)).toBe(true);
    expect(isPrefetchPath(cfg, 'class/2025Web演習/a.pdf', 2026)).toBe(false);
    // The course folder itself is not a file to fetch.
    expect(isPrefetchPath(cfg, 'class/2026年度データ処理演習', 2026)).toBe(false);
    const off = ShizuokaVpnFilesConfigSchema.parse({});
    expect(isPrefetchPath(off, 'class/2026年度データ処理演習/week01.pdf', 2026)).toBe(false);
  });

  it('the academic year turns in April (JST)', () => {
    expect(academicYear(new Date('2026-03-31T14:59:00Z'), 'Asia/Tokyo')).toBe(2025);
    expect(academicYear(new Date('2026-03-31T15:00:00Z'), 'Asia/Tokyo')).toBe(2026);
    expect(academicYear(new Date('2026-10-06T03:00:00Z'), 'Asia/Tokyo')).toBe(2026);
  });

  it('the walk writes the prefetch flag on this year’s files', async () => {
    const h = harness({ config: { prefetchCurrentYear: true }, clock: testClock(new Date('2026-10-06T03:00:00Z')) });
    const r = await h.adapter.sync({ mode: 'initial' });
    const file = r.items.find((i) => i.externalId === 'fs-share:class/2026年度データ処理演習/week01.pdf');
    expect((file?.payload as { prefetch: boolean }).prefetch).toBe(true);
    const old = r.items.find((i) => i.sourceType === 'szvpn.file' && i.externalId.includes('/2025'));
    expect((old?.payload as { prefetch: boolean } | undefined)?.prefetch ?? false).toBe(false);
  });
});
