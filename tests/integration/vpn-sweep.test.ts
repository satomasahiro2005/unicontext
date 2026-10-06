import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ManualClock, silentLogger } from '@unicontext/core';
import type { AuthResult } from '@unicontext/connector-sdk';
import {
  browseVpnFiles,
  createUniContext,
  recentVpnFiles,
  searchVpnFiles,
  type UniContext,
} from '@unicontext/context-engine';
import {
  createShizuokaVpnFilesNormalizer,
  metadata,
  parseTimestamp,
  type SessionMarker,
  ShizuokaVpnFilesAdapter,
  ShizuokaVpnFilesConfigSchema,
  SHIZUOKA_VPN_DEPLOYMENT,
  sizeToBytes,
  VpnDeploymentSchema,
  type FbEntry,
  type ListResult,
  type VpnPortalClient,
} from '@unicontext/shizuoka-vpn-files';
import { afterEach, describe, expect, it } from 'vitest';

/*
 * Through the real SyncEngine: one sync right after a sign-in pages through the whole tree (each
 * page stored as it arrives), and an empty index says why instead of looking like an empty share.
 */
interface TreeFixture {
  forbidden: string[];
  listings: Record<string, { name: string; isFile: string; size?: string; timestamp?: string }[]>;
}
const tree = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../connectors/shizuoka-vpn-files/test/fixtures/tree.synthetic.json', import.meta.url),
    ),
    'utf8',
  ),
) as TreeFixture;

class FakeClient implements VpnPortalClient {
  calls = 0;
  listDir(req: { dir: string }): Promise<ListResult> {
    this.calls++;
    if (tree.forbidden.includes(req.dir))
      return Promise.resolve({ status: 'forbidden', httpStatus: 403, message: 'ファイル参照エラー' });
    const rows = tree.listings[req.dir] ?? [];
    const entries: FbEntry[] = rows.map((r) => ({
      name: r.name,
      isFile: /^y/i.test(r.isFile),
      sizeBytes: sizeToBytes(r.size),
      sizeText: r.size,
      modifiedAt: parseTimestamp(r.timestamp),
      modifiedText: r.timestamp,
    }));
    return Promise.resolve(
      entries.length ? { status: 'ok', httpStatus: 200, entries } : { status: 'empty', httpStatus: 200 },
    );
  }
  streamFile(): Promise<never> {
    throw new Error('not used');
  }
}

const SRC = 'shizuoka-vpn-files';
let uc: UniContext | undefined;
afterEach(async () => {
  await uc?.close();
  uc = undefined;
});

/** Thrown by BrowserSession.withPage when the CLI holds the profile (same name and message shape). */
class BrowserProfileInUseError extends Error {
  override name = 'BrowserProfileInUseError';
}

/** Lets a test replace the n-th withClient call (1-based) with a session drop or a thrown error. */
type PageFault = (call: number) => { auth: AuthResult } | Error | undefined;

function setup(
  signedInAt: string | undefined,
  signedOut = false,
  opts: { fault?: PageFault; autoSignIn?: () => Promise<AuthResult | undefined> } = {},
) {
  const clock = new ManualClock('2026-10-06T03:20:00Z');
  uc = createUniContext({ profile: 'shizuoka-university', clock });
  const config = ShizuokaVpnFilesConfigSchema.parse({
    walk: { requestDelayMs: 0, retryBaseMs: 0, maxRetries: 0, maxFoldersPerRun: 2 },
  });
  const client = new FakeClient();
  let withClientCalls = 0;
  let verified = signedInAt;
  let signedIn = signedInAt;
  const marker: SessionMarker = {
    read: () => verified,
    write: (v) => {
      verified = v;
      if (v === undefined) signedIn = undefined;
    },
    readSignedInAt: () => signedIn,
    writeSignedInAt: (v) => {
      verified = v;
      signedIn = v;
    },
  };
  const adapter = new ShizuokaVpnFilesAdapter({
    sourceId: SRC,
    config,
    deployment: VpnDeploymentSchema.parse(SHIZUOKA_VPN_DEPLOYMENT),
    clock,
    logger: silentLogger,
    timezone: 'Asia/Tokyo',
    profileExists: () => true,
    sessionMarker: marker,
    withClient: async (fn) => {
      const fault = opts.fault?.(++withClientCalls);
      if (fault instanceof Error) throw fault;
      if (fault) return fault;
      return signedOut
        ? { auth: { status: 'auth_required', message: 'SSL-VPN portal sign-in required' } }
        : { result: await fn(client) };
    },
    ...(opts.autoSignIn ? { autoSignIn: opts.autoSignIn } : {}),
    random: () => 0,
  });
  uc.sync.register({ sourceId: SRC, adapter, normalizer: createShizuokaVpnFilesNormalizer(), metadata });
  return { uc, client, clock };
}

describe('index-first walk through the sync engine', () => {
  it('one sync right after a sign-in indexes the whole tree (pages of maxFoldersPerRun)', async () => {
    const { uc, client } = setup('2026-10-06T03:19:00Z');
    const report = await uc.sync.sync(SRC);
    expect(report.ok, report.error).toBe(true);
    expect(report.pages).toBeGreaterThan(3);
    expect(client.calls).toBe(12);
    await uc.runPipeline();
    const course = browseVpnFiles(uc, { root: 'fs-share', path: 'class/2026年度データ処理演習' });
    expect(course.status).toBe('ok');
    expect(course.files.map((f) => f.name).sort()).toEqual(['readme.txt', 'week01.pdf']);
    expect(searchVpnFiles(uc, { query: 'kadai1' }).files).toHaveLength(1);
    // The progress is in the cursor: the next sync lists nothing new.
    const again = await uc.sync.sync(SRC);
    expect(again.ok).toBe(true);
    expect(client.calls).toBe(12);
  });

  it('never verified and no saved credentials: auth_required, nothing listed', async () => {
    const { uc, client } = setup(undefined);
    const report = await uc.sync.sync(SRC);
    expect(report.ok).toBe(false); // never verified → sign-in required (no credentials saved)
    expect(client.calls).toBe(0);
  });

  it('an empty index says why (sign-in needed), not "the share is empty"', async () => {
    const { uc } = setup(undefined, true);
    const before = browseVpnFiles(uc);
    expect(before.status).toBe('roots');
    expect(before.folders).toEqual([]);
    expect(before.index?.empty).toBe(true);
    expect(before.index?.sources[0]?.health).toBe('never_synced');
    const report = await uc.sync.sync(SRC);
    expect(report.ok).toBe(false);
    const after = browseVpnFiles(uc);
    expect(after.index?.sources[0]).toMatchObject({ source: SRC, health: 'auth_required' });
    expect(after.index?.note).toMatch(/サインインが必要/);
  });

  it('an empty index says why from browse with a root, search and recent too', async () => {
    const { uc } = setup(undefined, true);
    expect((await uc.sync.sync(SRC)).ok).toBe(false);
    const inRoot = browseVpnFiles(uc, { root: 'fs-share' });
    expect(inRoot.status).toBe('unlisted');
    expect(inRoot.index?.sources[0]).toMatchObject({ source: SRC, health: 'auth_required' });
    const deep = browseVpnFiles(uc, { root: 'fs-share', path: 'class' });
    expect(deep.index?.empty).toBe(true);
    const found = searchVpnFiles(uc, { query: 'kadai1' });
    expect(found.files).toEqual([]);
    expect(found.index?.note).toMatch(/「共有が空」という意味ではありません/);
    const recent = recentVpnFiles(uc);
    expect(recent.files).toEqual([]);
    expect(recent.index?.empty).toBe(true);
  });

  it('a non-empty index carries no empty-index note', async () => {
    const { uc } = setup('2026-10-06T03:19:00Z');
    expect((await uc.sync.sync(SRC)).ok).toBe(true);
    await uc.runPipeline();
    expect(browseVpnFiles(uc, { root: 'fs-share' }).index).toBeUndefined();
    expect(browseVpnFiles(uc, { root: 'fs-share', path: 'no/such' }).index).toBeUndefined();
    expect(searchVpnFiles(uc, { query: 'zzz-nothing' }).index).toBeUndefined();
    expect(recentVpnFiles(uc).index).toBeUndefined();
  });
});

describe('a sweep that stops on a later page keeps the earlier pages (real engine, cursor saved)', () => {
  const savedFolders = (uc: UniContext): string[] => {
    const extra = uc.sync.stores.syncState.get(SRC)?.extra as
      | { roots: Record<string, { folders: Record<string, unknown> }> }
      | undefined;
    return Object.keys(extra?.roots['fs-share']?.folders ?? {}).sort();
  };

  it('page 2 finds the session gone (no saved password): page 1 is stored and the next sync resumes', async () => {
    const { uc, client } = setup('2026-10-06T03:19:00Z', false, {
      fault: (call) =>
        call === 2 ? { auth: { status: 'auth_required', message: 'SSL-VPN portal sign-in required' } } : undefined,
    });
    const report = await uc.sync.sync(SRC);
    expect(report.ok, report.error).toBe(true);
    expect(report.pages).toBe(2);
    expect(client.calls).toBe(2);
    expect(savedFolders(uc)).toHaveLength(2);
    // The next sign-in continues from there: the folders of page 1 are not listed again.
    const calls = client.calls;
    expect((await uc.sync.sync(SRC)).ok).toBe(false); // session forgotten → auth_required
    expect(client.calls).toBe(calls);
  });

  it('page 2: a saved password the rate limit refuses (signed in < 10 min ago) still keeps page 1', async () => {
    let autos = 0;
    const { uc } = setup('2026-10-06T03:19:00Z', false, {
      fault: (call) =>
        call === 2 ? { auth: { status: 'auth_required', message: 'SSL-VPN portal sign-in required' } } : undefined,
      autoSignIn: () => {
        autos++;
        return Promise.resolve({ status: 'auth_required', message: '自動サインインは10分に1回までです' });
      },
    });
    const report = await uc.sync.sync(SRC);
    expect(report.ok, report.error).toBe(true);
    expect(autos).toBe(1);
    expect(savedFolders(uc)).toHaveLength(2);
  });

  it('page 2 throws BrowserProfileInUseError (the CLI holds the profile): page 1 is stored', async () => {
    const { uc } = setup('2026-10-06T03:19:00Z', false, {
      fault: (call) =>
        call === 2 ? new BrowserProfileInUseError('the browser profile is in use by another process') : undefined,
    });
    const report = await uc.sync.sync(SRC);
    expect(report.ok, report.error).toBe(true);
    expect(report.pages).toBe(2);
    expect(savedFolders(uc)).toHaveLength(2);
    await uc.runPipeline();
    expect(browseVpnFiles(uc, { root: 'fs-share' }).status).toBe('ok');
  });
});
