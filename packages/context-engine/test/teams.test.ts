import { stableId, type EntityKind } from '@unicontext/canonical-model';
import { ManualClock, NotFoundError, ValidationError } from '@unicontext/core';
import { EntityStore } from '@unicontext/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTEXT_VIEWS,
  createUniContext,
  getView,
  normalizeFolderPath,
  type UniContext,
} from '../src/index.js';

const clock = new ManualClock('2026-10-01T00:00:00Z');
const SRC = 'teams-web';
const id = <K extends EntityKind>(kind: K, n: string) => stableId(kind, SRC, n);
const acad = stableId('courseOffering', 'lcu', 'c1');
const team = id('courseOffering', 'team1');
const thread = id('thread', 'general');
const TEAMS = { platform: 'teams' };

let uc: UniContext;
let store: EntityStore;

const put = (input: Parameters<EntityStore['upsert']>[0]) => store.upsert(input, { sourceId: SRC });

beforeEach(() => {
  uc = createUniContext({ profile: 'shizuoka-university', clock });
  store = new EntityStore(uc.db, { clock });
  store.upsert(
    { id: acad, kind: 'courseOffering', title: 'データベース論', academicYear: 2026 },
    { sourceId: 'lcu' },
  );
  put({
    id: team,
    kind: 'courseOffering',
    title: 'データベース論',
    academicYear: 2026,
    extra: { ...TEAMS, teamName: 'データベース論 2026' },
  });
  uc.identity.link(acad, team, {
    status: 'confirmed',
    score: 1,
    method: 'test',
    decidedBy: 'user',
  });
  put({
    id: thread,
    kind: 'thread',
    title: '一般',
    platform: 'teams',
    url: 'https://teams.example.com/c/general',
    courseOfferingId: team,
    extra: { ...TEAMS, channelName: '一般' },
  });
  // 25 replies + 1 post + 1 announcement
  for (let i = 0; i < 25; i++)
    put({
      id: id('message', `m${i}`),
      kind: 'message',
      threadId: thread,
      courseOfferingId: team,
      authorName: `学生${i}`,
      body: `返信 ${i}`,
      sentAt: new Date(Date.UTC(2026, 8, 20, i)).toISOString(),
      extra: { ...TEAMS, channelName: '一般', isReply: true },
    });
  put({
    id: id('message', 'long'),
    kind: 'message',
    threadId: thread,
    courseOfferingId: team,
    authorName: '先生A',
    authorRole: 'instructor',
    body: 'あ'.repeat(500),
    sentAt: '2026-09-30T05:00:00Z',
    url: 'https://teams.example.com/m/long',
    isQuestion: false,
    extra: {
      ...TEAMS,
      subject: '第2回の資料',
      isReply: false,
      attachments: [{ name: 'week2.pdf', url: 'https://example.com/week2.pdf' }, { x: 1 }],
    },
  });
  put({
    id: id('announcement', 'a1'),
    kind: 'announcement',
    title: '来週は休講',
    body: '来週は休講です',
    publishedAt: '2026-09-29T01:00:00Z',
    authorName: '先生A',
    importance: 'high',
    scope: 'course',
    category: 'Teams',
    courseOfferingId: team,
    extra: { ...TEAMS, channelName: '一般' },
  });
  // a non-Teams announcement and a message without any platform are ignored
  store.upsert(
    {
      id: stableId('announcement', 'lcu', 'n1'),
      kind: 'announcement',
      title: '学務のお知らせ',
      body: '',
      publishedAt: '2026-09-30T01:00:00Z',
      scope: 'course',
      courseOfferingId: acad,
    },
    { sourceId: 'lcu' },
  );
  store.upsert(
    {
      id: stableId('message', 'lcu', 'x'),
      kind: 'message',
      courseOfferingId: acad,
      body: 'no platform, no thread',
      sentAt: '2026-09-30T02:00:00Z',
    },
    { sourceId: 'lcu' },
  );

  const doc = (
    n: string,
    title: string,
    path: string,
    folder: string | undefined,
    modifiedAt: string,
    extra: Record<string, unknown> = {},
  ) =>
    put({
      id: id('document', n),
      kind: 'document',
      title,
      mimeType: 'application/pdf',
      path,
      url: `https://sp.example.com${path}`,
      sizeBytes: 2048,
      modifiedAt,
      courseOfferingId: team,
      extra: {
        ...TEAMS,
        teamName: 'データベース論 2026',
        ...(folder !== undefined ? { folder } : {}),
        ...extra,
      },
    } as Parameters<EntityStore['upsert']>[0]);
  doc('d1', 'week2.pdf', '/00_講義資料/week2.pdf', '00_講義資料', '2026-09-30T00:00:00Z', {
    modifiedBy: '先生A',
  });
  doc('d2', 'week1.pdf', '/00_講義資料/week1.pdf', '00_講義資料', '2026-09-10T00:00:00Z');
  doc('d3', 'sample.sql', '/00_講義資料/sub/sample.sql', '00_講義資料/sub', '2026-09-28T00:00:00Z');
  doc('d4', 'syllabus.pdf', '/syllabus.pdf', '', '2026-04-01T00:00:00Z');
  doc('d5', 'derived.pdf', '/01_課題/derived.pdf', undefined, '2026-09-29T00:00:00Z');
  put({
    id: id('material', 'mat1'),
    kind: 'material',
    courseOfferingId: team,
    title: 'week1.pdf',
    materialKind: 'slides',
    documentId: id('document', 'd2'),
    extra: { ...TEAMS, folder: '00_講義資料' },
  });

  const assignment = (n: string, title: string, due: string | undefined, from?: string) =>
    put({
      id: id('assignment', n),
      kind: 'assignment',
      courseOfferingId: team,
      title,
      ...(due ? { dueAt: due } : {}),
      ...(from ? { availableFrom: from } : {}),
      points: 10,
      extra: { platform: 'teams-assignments', source: 'assignments-api', status: 'assigned' },
    });
  assignment('as1', 'レポート1', '2026-09-15T14:59:00Z', '2026-09-01T00:00:00Z');
  assignment('as2', 'レポート2', '2026-10-10T14:59:00Z', '2026-09-30T00:00:00Z');
  assignment('as3', '期限なし課題', undefined);
  put({
    id: id('submission', 'sub1'),
    kind: 'submission',
    assignmentId: id('assignment', 'as1'),
    status: 'returned',
    submittedAt: '2026-09-14T00:00:00Z',
    score: 8,
    extra: { platform: 'teams-assignments', teamsStatus: 'returned' },
  });
});
afterEach(async () => uc.close());

describe('course context: Teams sections', () => {
  it('returns discussion for every linked id, newest 20, with trimmed bodies', () => {
    const c = uc.context.course(acad);
    expect(c.discussion).toHaveLength(20);
    expect(c.discussion.map((d) => d.id).slice(0, 2)).toEqual([
      id('message', 'long'),
      id('announcement', 'a1'),
    ]);
    const [post, ann] = c.discussion;
    expect(post).toMatchObject({
      kind: 'message',
      title: '第2回の資料',
      author: '先生A',
      authorRole: 'instructor',
      channel: '一般',
      platform: 'teams',
      isReply: false,
      url: 'https://teams.example.com/m/long',
      attachments: [{ name: 'week2.pdf', url: 'https://example.com/week2.pdf' }],
    });
    expect(post?.body).toHaveLength(401);
    expect(post?.body.endsWith('…')).toBe(true);
    expect(ann).toMatchObject({ kind: 'announcement', title: '来週は休講', isReply: false });
    expect(c.discussion.slice(2).every((d) => d.isReply)).toBe(true);
    expect(c.discussion.some((d) => d.body.includes('no platform'))).toBe(false);
    // asking through the Teams offering id gives the same course
    expect(uc.context.course(team).discussion).toHaveLength(20);
  });

  it('lists files by folder then title with material kinds', () => {
    const c = uc.context.course(acad);
    expect(c.filesTotal).toBe(5);
    expect(c.files.map((f) => [f.folder, f.title])).toEqual([
      ['', 'syllabus.pdf'],
      ['00_講義資料', 'week1.pdf'],
      ['00_講義資料', 'week2.pdf'],
      ['00_講義資料/sub', 'sample.sql'],
      ['01_課題', 'derived.pdf'],
    ]);
    expect(c.files[1]).toMatchObject({
      materialKind: 'slides',
      sizeBytes: 2048,
      path: '/00_講義資料/week1.pdf',
      url: 'https://sp.example.com/00_講義資料/week1.pdf',
    });
    expect(c.files[2]).toMatchObject({ modifiedBy: '先生A', materialKind: undefined });
  });

  it('lists all assignments newest due first with the submission status', () => {
    const c = uc.context.course(acad);
    expect(c.assignments.map((a) => [a.title, a.status])).toEqual([
      ['レポート2', undefined],
      ['レポート1', 'returned'],
      ['期限なし課題', undefined],
    ]);
    expect(c.assignments[1]).toMatchObject({
      submittedAt: '2026-09-14T00:00:00Z',
      points: 10,
      sourceId: SRC,
    });
  });
});

describe('teams-activity view', () => {
  it('defaults to the last seven days and only Teams entities', () => {
    const t = uc.context.teamsActivity();
    expect(t.view).toBe('teams-activity');
    expect(t.since).toBe('2026-09-23T15:00:00.000Z'); // 7 days before 09-30 00:00 JST
    expect(t.posts.map((p) => p.id)).toEqual([id('message', 'long'), id('announcement', 'a1')]);
    expect(t.files.map((f) => f.title)).toEqual(['week2.pdf', 'derived.pdf', 'sample.sql']);
    expect(t.assignments.map((a) => a.title)).toEqual(['レポート2']);
  });

  it('honours since, limit and the course filter', () => {
    const wide = uc.context.teamsActivity({
      since: '2026-09-01',
      courseOfferingId: acad,
      limit: 3,
    });
    expect(wide.posts).toHaveLength(3);
    expect(wide.assignments.map((a) => a.title)).toEqual(['レポート2', 'レポート1']);
    const none = uc.context.teamsActivity({ courseOfferingId: id('courseOffering', 'other') });
    expect(none.posts).toEqual([]);
    expect(none.files).toEqual([]);
    expect(() => uc.context.teamsActivity({ since: 'yesterday-ish' })).toThrow(ValidationError);
  });

  it('is served by getView', () => {
    expect(CONTEXT_VIEWS.map((v) => v.name)).toEqual(
      expect.arrayContaining(['teams-activity', 'course-files']),
    );
    expect(getView(uc.context, 'teams-activity', { limit: 1 }).posts).toHaveLength(1);
    expect(() => getView(uc.context, 'teams-activity', { nope: 1 })).toThrow(ValidationError);
  });
});

describe('course-files view', () => {
  it('shows the root with its subfolders', () => {
    const r = uc.context.courseFiles({ courseOfferingId: acad });
    expect(r).toMatchObject({ view: 'course-files', path: '' });
    expect(r.course.linkedIds).toEqual(expect.arrayContaining([acad, team]));
    expect(r.files.map((f) => f.title)).toEqual(['syllabus.pdf']);
    expect(r.folders).toEqual([
      { name: '00_講義資料', path: '00_講義資料', fileCount: 3 },
      { name: '01_課題', path: '01_課題', fileCount: 1 },
    ]);
  });

  it('descends into a normalized path', () => {
    const r = uc.context.courseFiles({ courseOfferingId: team, path: '/00_講義資料/' });
    expect(r.path).toBe('00_講義資料');
    expect(r.files.map((f) => f.title)).toEqual(['week1.pdf', 'week2.pdf']);
    expect(r.folders).toEqual([{ name: 'sub', path: '00_講義資料/sub', fileCount: 1 }]);
    const leaf = getView(uc.context, 'course-files', {
      courseOfferingId: acad,
      path: '00_講義資料\\sub',
    });
    expect(leaf.files.map((f) => f.title)).toEqual(['sample.sql']);
    expect(leaf.folders).toEqual([]);
    expect(uc.context.courseFiles({ courseOfferingId: acad, path: 'missing' }).files).toEqual([]);
  });

  it('rejects unknown courses and bad params', () => {
    expect(() => uc.context.courseFiles({ courseOfferingId: 'courseOffering:nope' })).toThrow(
      NotFoundError,
    );
    expect(() => getView(uc.context, 'course-files', {})).toThrow(ValidationError);
    expect(normalizeFolderPath('//a\\b/./c/')).toBe('a/b/c');
  });
});
