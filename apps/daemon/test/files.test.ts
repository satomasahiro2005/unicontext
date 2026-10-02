import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadCourseFiles, removeOrphanTexts } from '@unicontext/context-engine';
import { createTeamsWebNormalizer, metadata, TeamsWebAdapter } from '@unicontext/teams-web';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness } from '../../../connectors/teams-web/test/helpers.js';
import type {
  DownloadFilesResponse,
  MirrorResponse,
  MirrorStatusResponse,
} from '../src/api-types.js';
import { bearer, createTestServer, type TestServer } from './helpers.js';

/*
 * Class files end to end: the teams-web adapter (scripted Teams client and SharePoint page) in a
 * dev runtime, on-demand downloads over REST, local copies, search over the extracted text, and
 * the mirror reconciling with the synced file list.
 */

let s: TestServer;
let mirrorRoot: string;
let h: ReturnType<typeof harness>;
const SRC = 'teams-web';
const host = { host: '127.0.0.1:17878' };
const json = <T>(res: { body: string }): T => JSON.parse(res.body) as T;
const docs = new Map<string, string>();
let courseTitle = '';

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
  mirrorRoot = mkdtempSync(path.join(tmpdir(), 'uc-mirror-'));
  const enc = (t: string) => new TextEncoder().encode(t);
  h = harness({
    config: { mirror: { enabled: true, root: mirrorRoot, courses: 'linked' } },
    extract: (data, ext) => {
      const text = new TextDecoder().decode(data);
      return Promise.resolve(ext === 'pptx' ? { text, pages: [{ page: 1, text }] } : { text });
    },
  });
  h.client.files['01FILEWEEK1'] = enc('第1回 関係モデルとリレーショナル代数の資料');
  h.client.files['01FILESLIDES'] = enc('スライド ER図と正規化の演習');
  h.client.files['01FILEROOT'] = enc('シラバス 成績評価は期末試験');
  h.client.files['01FILEWEEK2'] = enc('第2回 SQLの結合');
  const uc = s.runtime.uc;
  uc.sync.register({
    sourceId: SRC,
    adapter: h.adapter,
    normalizer: createTeamsWebNormalizer(),
    metadata,
  });
  const r = await uc.sync.sync(SRC);
  expect(r.ok, r.error).toBe(true);
  for (const d of uc.sync.stores.entities.list('document', { sourceId: SRC }))
    docs.set(d.title, d.id);
  // The class team is linked to the academic system's course ("linked" mirror filter).
  const teamOffering = uc.sync.stores.entities.getOfKind('document', docs.get('week1.pdf')!)
    ?.courseOfferingId as string;
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
  rmSync(mirrorRoot, { recursive: true, force: true });
});

describe('on-demand downloads', () => {
  it('needs the token or the Web UI CSRF pair', async () => {
    const res = await post('/api/v1/files/download', { ids: [docs.get('week1.pdf')] }, false);
    expect(res.statusCode).toBe(401);
  });

  it('downloads by id and by course path, keeps a local copy and indexes the text', async () => {
    const res = await post('/api/v1/files/download', {
      ids: [docs.get('第1回スライド.pptx'), 'データベース演習X/00_講義資料/week1.pdf'],
    });
    expect(res.statusCode, res.body).toBe(200);
    const r = json<DownloadFilesResponse>(res);
    expect(r.results.map((x) => [x.title, x.status])).toEqual([
      ['第1回スライド.pptx', 'downloaded'],
      ['week1.pdf', 'downloaded'],
    ]);
    for (const x of r.results) {
      expect(x.path?.startsWith(s.runtime.filesDir)).toBe(true);
      expect(existsSync(x.path!)).toBe(true);
      expect(x.text?.chunks).toBeGreaterThan(0);
      expect(x.course?.title).toBe(courseTitle);
    }
    expect(readFileSync(r.results[1]!.path!, 'utf8')).toBe(
      '第1回 関係モデルとリレーショナル代数の資料',
    );
    expect(h.sessions.at(-1)).toBe('https://example.sharepoint.com/sites/2026X_abc123');

    // searchable
    const hits = await get(`/api/v1/search?q=${encodeURIComponent('リレーショナル代数')}`);
    expect(hits.body).toContain(docs.get('week1.pdf'));

    // served from the local copy
    const content = await get(
      `/api/v1/files/${encodeURIComponent(docs.get('第1回スライド.pptx')!)}/content`,
    );
    expect(content.statusCode).toBe(200);
    expect(content.body).toBe('スライド ER図と正規化の演習');
    expect(content.headers['content-disposition']).toContain(
      `filename*=UTF-8''${encodeURIComponent('第1回スライド.pptx')}`,
    );
  });

  it('does not download a file again in the same version', async () => {
    const before = h.client.downloads.length;
    const r = json<DownloadFilesResponse>(
      await post('/api/v1/files/download', { ids: [docs.get('week1.pdf')] }),
    );
    expect(r.results[0]?.status).toBe('cached');
    expect(h.client.downloads.length).toBe(before);
  });

  it('reports unknown and unsupported files without failing the request', async () => {
    const other = s.runtime.uc.sync.stores.entities
      .list('document')
      .find((d) => !docs.has(d.title) || ![...docs.values()].includes(d.id));
    const r = json<DownloadFilesResponse>(
      await post('/api/v1/files/download', {
        ids: ['document:nope', ...(other ? [other.id] : [])],
      }),
    );
    expect(r.results[0]?.status).toBe('notFound');
    if (other) expect(r.results[1]?.status).toBe('unsupported');
    const missing = await get('/api/v1/files/document:nope/content');
    expect(missing.statusCode).toBe(404);
  });
});

describe('mirror', () => {
  const inMirror = (...parts: string[]) => path.join(mirrorRoot, courseTitle, ...parts);

  it('copies the linked class team files under <course>/<channel folder>/<path>', async () => {
    const res = await post('/api/v1/files/mirror', {});
    expect(res.statusCode, res.body).toBe(200);
    const m = json<MirrorResponse>(res).sources.find((x) => x.sourceId === SRC)!;
    expect(m).toMatchObject({ enabled: true, wanted: 3, downloaded: 3, present: 3, failed: 0 });
    expect(readFileSync(inMirror('00_講義資料', 'week1.pdf'), 'utf8')).toContain('第1回');
    expect(existsSync(inMirror('00_講義資料', 'スライド', '第1回スライド.pptx'))).toBe(true);
    expect(existsSync(inMirror('シラバス.docx'))).toBe(true);
    // the lab team (not a class team) is not mirrored
    expect(readdirSync(mirrorRoot).filter((n) => n !== '.trash')).toEqual([courseTitle]);
    const status = json<MirrorStatusResponse>(await get('/api/v1/files/mirror'));
    expect(status.sources.find((x) => x.sourceId === SRC)).toMatchObject({ files: 3 });

    // an on-demand request now answers from the mirror
    const r = json<DownloadFilesResponse>(
      await post('/api/v1/files/download', { ids: [docs.get('シラバス.docx')] }),
    );
    expect(r.results[0]).toMatchObject({ status: 'cached', mirrored: true });
    expect(r.results[0]?.path).toBe(inMirror('シラバス.docx'));
  });

  it('follows the delta: new files are downloaded, deleted ones go to the trash', async () => {
    const uc = s.runtime.uc;
    const r = await uc.sync.sync(SRC); // incremental: シラバス.docx deleted, week2.pdf added
    expect(r.ok, r.error).toBe(true);
    const m = json<MirrorResponse>(await post('/api/v1/files/mirror', {})).sources.find(
      (x) => x.sourceId === SRC,
    )!;
    expect(m).toMatchObject({ downloaded: 1, trashed: 1, present: 3 });
    expect(existsSync(inMirror('シラバス.docx'))).toBe(false);
    expect(existsSync(inMirror('00_講義資料', 'week2.pdf'))).toBe(true);
    const trash = path.join(mirrorRoot, '.trash');
    const day = readdirSync(trash)[0]!;
    expect(existsSync(path.join(trash, day, courseTitle, 'シラバス.docx'))).toBe(true);
    // its extracted text went with it (sync deletion); nothing left to clean up
    expect(
      uc.sync.stores.raw
        .list({ sourceId: SRC, sourceTypes: ['teamsweb.fileText'] })
        .map((x) => x.externalId.split('/')[1]),
    ).not.toContain('01FILEROOT');
    expect(
      await removeOrphanTexts(uc, SRC, uc.sync.getSource(SRC).adapter as TeamsWebAdapter),
    ).toBe(0);
  });

  it('is a no-op when nothing changed', async () => {
    const before = h.client.downloads.length;
    const m = json<MirrorResponse>(await post('/api/v1/files/mirror', {})).sources.find(
      (x) => x.sourceId === SRC,
    )!;
    expect(m).toMatchObject({ downloaded: 0, trashed: 0, renamed: 0, remaining: 0 });
    expect(h.client.downloads.length).toBe(before);
  });
});

describe('in-process API', () => {
  it('rejects too many files per request', async () => {
    await expect(
      downloadCourseFiles(
        s.runtime.uc,
        Array.from({ length: 21 }, (_, i) => `document:x${i}`),
        { filesDir: s.runtime.filesDir },
      ),
    ).rejects.toThrow('at most 20');
  });
});
