import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ManualClock, silentLogger } from '@unicontext/core';
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
  ShizuokaVpnFilesAdapter,
  ShizuokaVpnFilesConfigSchema,
  SHIZUOKA_VPN_DEPLOYMENT,
  sizeToBytes,
  VpnDeploymentSchema,
  type FbEntry,
  type ListResult,
  type VpnPortalClient,
} from '@unicontext/shizuoka-vpn-files';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * End to end: the connector walks a synthetic FS share into the raw/entity stores, then the
 * local-index browse/search/recent read it back (never touching a live portal).
 */
interface TreeFixture {
  forbidden: string[];
  listings: Record<string, { name: string; isFile: string; size?: string; timestamp?: string }[]>;
}
const tree: TreeFixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../connectors/shizuoka-vpn-files/test/fixtures/tree.synthetic.json', import.meta.url),
    ),
    'utf8',
  ),
) as TreeFixture;

class FakeClient implements VpnPortalClient {
  listDir(req: { dir: string }): Promise<ListResult> {
    if (tree.forbidden.includes(req.dir))
      return Promise.resolve({ status: 'forbidden', httpStatus: 403, message: 'ファイル参照エラー' });
    const rows = tree.listings[req.dir];
    if (!rows) return Promise.resolve({ status: 'error', httpStatus: 404, message: 'x' });
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

let uc: UniContext;
const SRC = 'vpn-files';

beforeAll(async () => {
  const clock = new ManualClock('2026-10-05T01:00:00Z');
  uc = createUniContext({ profile: 'shizuoka-university', clock });
  const config = ShizuokaVpnFilesConfigSchema.parse({ walk: { requestDelayMs: 0, retryBaseMs: 0, maxRetries: 1 } });
  const client = new FakeClient();
  const adapter = new ShizuokaVpnFilesAdapter({
    sourceId: SRC,
    config,
    deployment: VpnDeploymentSchema.parse(SHIZUOKA_VPN_DEPLOYMENT),
    clock,
    logger: silentLogger,
    timezone: 'Asia/Tokyo',
    profileExists: () => true,
    // The student has just signed in: a live portal session was verified a moment ago.
    sessionMarker: { read: () => clock.now().toISOString(), write: () => undefined },
    withClient: async (fn) => ({ result: await fn(client) }),
    random: () => 0,
  });
  uc.sync.register({ sourceId: SRC, adapter, normalizer: createShizuokaVpnFilesNormalizer(), metadata });
  // The small tree is walked in one run (maxFoldersPerRun default 60); a couple more are harmless.
  for (let i = 0; i < 3; i++) expect((await uc.sync.sync(SRC)).ok).toBe(true);
  await uc.runPipeline();
});

afterAll(async () => {
  await uc.close();
});

describe('vpn-files browse/search/recent (local index)', () => {
  it('browses the root into the share and then a folder', () => {
    const top = browseVpnFiles(uc);
    // One root: it steps straight into the share and shows class + the 403 roots.
    const names = top.folders.map((f) => f.name);
    expect(names).toContain('class');
    const report = top.folders.find((f) => f.name === 'report');
    expect(report?.status).toBe('forbidden');
  });

  it('shows each folder with its last-listed time and its files', () => {
    const cls = browseVpnFiles(uc, { root: 'fs-share', path: 'class' });
    expect(cls.status).toBe('ok');
    expect(cls.listedAt).toBeTruthy();
    const course = browseVpnFiles(uc, { root: 'fs-share', path: 'class/2026年度データ処理演習' });
    expect(course.files.map((f) => f.name).sort()).toEqual(['readme.txt', 'week01.pdf']);
    // The file id is a document id that download_course_file accepts.
    expect(course.files[0]?.id.startsWith('document:')).toBe(true);
  });

  it('searches by name/path substring across the whole tree', () => {
    const r = searchVpnFiles(uc, { query: 'kadai1' });
    expect(r.files.some((f) => f.path.endsWith('課題/kadai1.md'))).toBe(true);
    const byPath = searchVpnFiles(uc, { query: '資料' });
    expect(byPath.files.length + byPath.folders.length).toBeGreaterThan(0);
  });

  it('filters search by year', () => {
    const r = searchVpnFiles(uc, { query: '.pdf', year: 2024 });
    expect(r.files.every((f) => f.path.includes('2024'))).toBe(true);
    expect(r.files.length).toBeGreaterThan(0);
  });

  it('lists recent files newest first', () => {
    const r = recentVpnFiles(uc, { limit: 3 });
    expect(r.files.length).toBeGreaterThan(0);
    // The 2026 files are newer than the 2024/2025 ones.
    expect(r.files[0]?.modifiedAt?.startsWith('2026')).toBe(true);
  });

  it('proposes a best-effort course link the student can confirm (never a filter)', () => {
    const offerings = uc.sync.stores.entities.list('courseOffering');
    const candidate = offerings.find((o) => o.title === 'コンピュータ入門');
    expect(candidate).toBeTruthy();
    expect(candidate?.academicYear).toBe(2024);
  });
});
