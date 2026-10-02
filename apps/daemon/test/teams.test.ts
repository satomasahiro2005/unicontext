import { stableId } from '@unicontext/canonical-model';
import { EntityStore } from '@unicontext/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CourseFilesResponse,
  CoursesResponse,
  TeamsActivityResponse,
} from '../src/api-types.js';
import { createTestServer, type TestServer } from './helpers.js';

let s: TestServer;
let courseId: string;
const json = <T>(res: { body: string }): T => JSON.parse(res.body) as T;
const get = (url: string) =>
  s.app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:17878' } });

beforeAll(async () => {
  s = await createTestServer();
  const { courses } = json<CoursesResponse>(await get('/api/v1/courses'));
  courseId = courses.find((c) => c.title.includes('データベース'))?.id ?? '';
  const store = new EntityStore(s.runtime.uc.db, { clock: s.runtime.uc.clock });
  const SRC = 'teams-web';
  const put = (input: Parameters<EntityStore['upsert']>[0]) =>
    store.upsert(input, { sourceId: SRC });
  put({
    id: stableId('message', SRC, 'p1'),
    kind: 'message',
    courseOfferingId: courseId as never,
    authorName: '先生A',
    body: '投稿の本文',
    sentAt: '2026-09-30T05:00:00Z',
    extra: { platform: 'teams', channelName: '一般', isReply: false },
  });
  put({
    id: stableId('document', SRC, 'f1'),
    kind: 'document',
    title: 'week1.pdf',
    path: '/00_講義資料/week1.pdf',
    modifiedAt: '2026-09-30T06:00:00Z',
    courseOfferingId: courseId as never,
    extra: { platform: 'teams', folder: '00_講義資料' },
  });
}, 60_000);
afterAll(async () => {
  await s.close();
});

describe('Teams endpoints', () => {
  it('GET /teams-activity returns posts and files, optionally for one course', async () => {
    const res = await get('/api/v1/teams-activity?since=2026-09-29');
    expect(res.statusCode).toBe(200);
    const a = json<TeamsActivityResponse>(res);
    expect(a.view).toBe('teams-activity');
    expect(a.posts.map((p) => p.body)).toEqual(['投稿の本文']);
    expect(a.files.map((f) => f.title)).toEqual(['week1.pdf']);
    const scoped = json<TeamsActivityResponse>(
      await get(`/api/v1/teams-activity?since=2026-09-29&course=${encodeURIComponent(courseId)}`),
    );
    expect(scoped.posts).toHaveLength(1);
    const other = json<TeamsActivityResponse>(
      await get('/api/v1/teams-activity?since=2026-09-29&course=courseOffering:none'),
    );
    expect(other.posts).toEqual([]);
    expect((await get('/api/v1/teams-activity?since=not-a-date')).statusCode).toBe(400);
    expect((await get('/api/v1/teams-activity?limit=abc')).statusCode).toBe(400);
  });

  it('GET /courses/:id/files lists folders and files of a path', async () => {
    const id = encodeURIComponent(courseId);
    const root = json<CourseFilesResponse>(await get(`/api/v1/courses/${id}/files`));
    expect(root).toMatchObject({ view: 'course-files', path: '' });
    expect(root.folders).toEqual([{ name: '00_講義資料', path: '00_講義資料', fileCount: 1 }]);
    const sub = json<CourseFilesResponse>(
      await get(`/api/v1/courses/${id}/files?path=${encodeURIComponent('00_講義資料')}`),
    );
    expect(sub.files.map((f) => f.title)).toEqual(['week1.pdf']);
    expect((await get('/api/v1/courses/courseOffering:nope/files')).statusCode).toBe(404);
  });
});
