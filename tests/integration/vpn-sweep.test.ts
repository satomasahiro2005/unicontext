import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ManualClock, silentLogger } from '@unicontext/core';
import { browseVpnFiles, createUniContext, searchVpnFiles, type UniContext } from '@unicontext/context-engine';
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

function setup(signedInAt: string | undefined, signedOut = false) {
  const clock = new ManualClock('2026-10-06T03:20:00Z');
  uc = createUniContext({ profile: 'shizuoka-university', clock });
  const config = ShizuokaVpnFilesConfigSchema.parse({
    walk: { requestDelayMs: 0, retryBaseMs: 0, maxRetries: 0, maxFoldersPerRun: 2 },
  });
  const client = new FakeClient();
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
    withClient: async (fn) =>
      signedOut
        ? { auth: { status: 'auth_required', message: 'SSL-VPN portal sign-in required' } }
        : { result: await fn(client) },
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
});
