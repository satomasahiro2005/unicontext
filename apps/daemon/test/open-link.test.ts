import { existsSync, readFileSync } from 'node:fs';
import { openLink, type OpenLinkReport } from '@unicontext/context-engine';
import { createTeamsWebNormalizer, metadata } from '@unicontext/teams-web';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLASS_GROUP, harness, SITE } from '../../../connectors/teams-web/test/helpers.js';
import {
  driveItem,
  FakeLinkClient,
  ORIGIN,
  OTHER_DRIVE,
  PERSONAL,
  shareChildrenPath,
  shareItemPath,
} from '../../../connectors/teams-web/test/link-helpers.js';
import type { DownloadFilesResponse } from '../src/api-types.js';
import { bearer, createTestServer, type TestServer } from './helpers.js';

/*
 * open_link end to end: the teams-web adapter (scripted Teams client and SharePoint) in a dev
 * runtime; a link resolved through the session, stored as the source's file, downloaded and
 * text-indexed by the ordinary download; folders listed with document ids; clear reasons.
 */

let s: TestServer;
let h: ReturnType<typeof harness>;
let client: FakeLinkClient;
const SRC = 'teams-web';
const host = { host: '127.0.0.1:17878' };
const json = <T>(res: { body: string }): T => JSON.parse(res.body) as T;
let courseTitle = '';

const SLIDO = `${ORIGIN}/:b:/s/2026X_abc123/ESlidoTOKEN?e=1`;
const WEEK1 = `${SITE}/Shared%20Documents/00_%E8%AC%9B%E7%BE%A9%E8%B3%87%E6%96%99/week1.pdf`;
const FOLDER = `https://example-my.sharepoint.com/:f:/g/personal/teacher_example_ac_jp/IgFolder?e=2`;

const post = (url: string, payload: unknown, auth = true) =>
  s.app.inject({
    method: 'POST',
    url,
    headers: { ...host, 'content-type': 'application/json', ...(auth ? bearer : {}) },
    payload: JSON.stringify(payload),
  });
const get = (url: string) => s.app.inject({ method: 'GET', url, headers: host });

beforeAll(async () => {
  s = await createTestServer();
  client = new FakeLinkClient();
  h = harness({
    client,
    extract: (data) => Promise.resolve({ text: new TextDecoder().decode(data) }),
  });
  const enc = (t: string) => new TextEncoder().encode(t);
  client.files['01FILEWEEK1'] = enc('第1回 関係モデルとリレーショナル代数の資料');
  client.files['01SLIDO'] = enc('slidoコメント ポスター発表の講評');
  client.files['01P1'] = enc('第2回 複素平面とガウス平面');
  client.answer = (url, redeem) => {
    if (url.startsWith(shareItemPath(SLIDO)))
      return {
        status: 200,
        body: driveItem('01SLIDO', 'slidoコメント.pdf', { driveId: OTHER_DRIVE, path: '/08' }),
      };
    if (url.startsWith(shareItemPath(WEEK1)))
      return {
        status: 200,
        body: {
          ...driveItem('01FILEWEEK1', 'week1.pdf', { path: '/00_講義資料' }),
          eTag: '"{5B6C7D8E-9F0A-4B1C-8D2E-3F4A5B6C7D8E},3"',
        },
      };
    if (url.startsWith(shareItemPath(FOLDER)))
      return redeem
        ? {
            status: 200,
            body: driveItem('01PFOLDER', '応用数学', { folder: 3, siteUrl: PERSONAL }),
          }
        : { status: 403, body: { error: { code: 'accessDenied' } } };
    if (url.startsWith(shareChildrenPath(FOLDER)))
      return {
        status: 200,
        body: {
          value: [
            driveItem('01P1', '02.pdf', { siteUrl: PERSONAL, path: '/応用数学' }),
            driveItem('01P2', '03.m4a', { siteUrl: PERSONAL, path: '/応用数学' }),
            { ...driveItem('01P3', '解答', { folder: 1, siteUrl: PERSONAL }), webUrl: 'x' },
          ],
        },
      };
    return { status: 404, body: { error: { code: 'itemNotFound' } } };
  };
  const uc = s.runtime.uc;
  uc.sync.register({
    sourceId: SRC,
    adapter: h.adapter,
    normalizer: createTeamsWebNormalizer(),
    metadata,
  });
  const r = await uc.sync.sync(SRC);
  expect(r.ok, r.error).toBe(true);
  const week1 = uc.sync.stores.entities
    .list('document', { sourceId: SRC })
    .find((d) => d.title === 'week1.pdf')!;
  const teamOffering = week1.courseOfferingId!;
  const acad = uc.sync.stores.entities
    .list('courseOffering')
    .find((o) => o.title.includes('データベース') && o.id !== teamOffering)!;
  courseTitle = acad.title;
  uc.identity.link(acad.id, teamOffering, {
    status: 'confirmed',
    score: 1,
    method: 'test',
    decidedBy: 'user',
  });
}, 60_000);

afterAll(async () => {
  await s.close();
});

describe('POST /api/v1/files/open-link', () => {
  it('needs the token', async () => {
    expect((await post('/api/v1/files/open-link', { url: SLIDO }, false)).statusCode).toBe(401);
  });

  it('a file in another library of a class team: stored, downloaded, searchable, in the course', async () => {
    const res = await post('/api/v1/files/open-link', { url: SLIDO });
    expect(res.statusCode, res.body).toBe(200);
    const r = json<OpenLinkReport>(res);
    expect(r.status).toBe('file');
    expect(r.file).toMatchObject({
      title: 'slidoコメント.pdf',
      status: 'downloaded',
      course: { title: courseTitle },
      text: { chunks: 1 },
    });
    expect(r.file!.id).toMatch(/^document:/);
    expect(existsSync(r.file!.path!)).toBe(true);
    expect(readFileSync(r.file!.path!, 'utf8')).toBe('slidoコメント ポスター発表の講評');
    // The session started on the team site; the download went through the site too.
    expect(h.sessions.filter((x) => x === `${ORIGIN}/sites/2026X_abc123`).length).toBe(2);
    const hits = await get(`/api/v1/search?q=${encodeURIComponent('ポスター発表の講評')}`);
    expect(hits.body).toContain(r.file!.id);
    // download_course_file takes the same id (now from the cache).
    const again = json<DownloadFilesResponse>(
      await post('/api/v1/files/download', { ids: [r.file!.id] }),
    );
    expect(again.results[0]).toMatchObject({ id: r.file!.id, status: 'cached' });
    // Stored as a link item, never in the class library's file list of the mirror.
    const raw = s.runtime.uc.sync.stores.raw.list({
      sourceId: SRC,
      sourceTypes: ['teamsweb.linkItem'],
    });
    expect(raw.map((x) => x.externalId)).toEqual([`${CLASS_GROUP}/01SLIDO`]);
  });

  it('a synced file: the same document, nothing stored twice', async () => {
    const uc = s.runtime.uc;
    const before = uc.sync.stores.raw.list({ sourceId: SRC }).length;
    const r = json<OpenLinkReport>(await post('/api/v1/files/open-link', { url: WEEK1 }));
    expect(r.status).toBe('file');
    const week1 = uc.sync.stores.entities
      .list('document', { sourceId: SRC })
      .find((d) => d.title === 'week1.pdf')!;
    expect(r.file).toMatchObject({ id: week1.id, course: { title: courseTitle } });
    // Only the extracted text is new.
    expect(uc.sync.stores.raw.list({ sourceId: SRC }).length).toBe(before + 1);
  });

  it('a personal OneDrive folder: files with document ids, subfolders, redeemed once', async () => {
    const r = json<OpenLinkReport>(await post('/api/v1/files/open-link', { url: FOLDER }));
    expect(r.status).toBe('folder');
    expect(r.folder).toMatchObject({ name: '応用数学', childCount: 3 });
    expect(r.folder?.course).toBeUndefined();
    expect(r.files?.map((f) => f.name)).toEqual(['02.pdf', '03.m4a']);
    expect(r.folders?.map((f) => f.name)).toEqual(['解答']);
    const id = r.files![0]!.id;
    const dl = json<DownloadFilesResponse>(await post('/api/v1/files/download', { ids: [id] }));
    expect(dl.results[0]).toMatchObject({ status: 'downloaded', title: '02.pdf' });
    expect(dl.results[0]?.course).toBeUndefined();
    expect(client.requests.filter((x) => x.redeem).length).toBeGreaterThan(0);
  });

  it('answers with a reason for links it cannot open', async () => {
    const gone = json<OpenLinkReport>(
      await post('/api/v1/files/open-link', { url: `${ORIGIN}/:b:/s/2026X_abc123/Egone?e=1` }),
    );
    expect(gone).toMatchObject({ status: 'notFound' });
    expect(gone.reason).toContain('見つかりません');
    const consumer = json<OpenLinkReport>(
      await post('/api/v1/files/open-link', { url: 'https://1drv.ms/b/s!abc' }),
    );
    expect(consumer).toMatchObject({ status: 'unsupported' });
    const other = json<OpenLinkReport>(
      await post('/api/v1/files/open-link', { url: 'https://example.com/a.pdf' }),
    );
    expect(other).toMatchObject({ status: 'unsupported' });
    expect((await post('/api/v1/files/open-link', {})).statusCode).toBe(400);
  });
});

describe('openLink without a source', () => {
  it('says that no source can open links', async () => {
    const bare = await createTestServer();
    try {
      const r = await openLink(bare.runtime.uc, 'https://example.sharepoint.com/:b:/s/x/E', {
        filesDir: bare.runtime.filesDir,
      });
      expect(r).toMatchObject({ status: 'unsupported' });
      expect(r.reason).toContain('teams-web');
    } finally {
      await bare.close();
    }
  });
});
