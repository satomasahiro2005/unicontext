import type { FakeConnectorOptions, FakeSourceAdapter } from './fake.js';

/*
 * Synthetic, Shizuoka-like seed data (情報学部, 1–5限) for demos and integration tests.
 * Entirely made up: no real course codes, people or rooms. "Today" is Thu 2026-10-01.
 *
 * Day 1 (sync at 2026-09-30): timetable, assignments, a past lecture transcript.
 * Day 2 (sync at 2026-10-01): 課題1's deadline moves 10/8 → 10/10, Lecture 3.pdf is added, and the
 * instructor posts on Teams that today's class moves to 11教室 while the academic system still
 * says 21教室 (a room conflict).
 */
export const SEED_TODAY = '2026-10-01';
export const SEED_DAY1_SYNC_AT = '2026-09-30T00:00:00.000Z';
export const SEED_DAY2_SYNC_AT = '2026-10-01T00:00:00.000Z';

export interface SeedSource {
  sourceId: string;
  options: FakeConnectorOptions;
}

export function createShizuokaSeed(): SeedSource[] {
  return [
    {
      sourceId: 'lcu',
      options: {
        product: 'livecampusu',
        sourceLabel: '学務情報システム',
        authority: 'academic-system',
        apiStability: 'unofficial',
        testedVersion: 'seed-1',
        productVersion: 'seed-1',
        capabilities: ['courses', 'timetable', 'rooms', 'exams', 'announcements'],
        dataset: {
          courses: [
            {
              id: 'J2401-2026-2',
              code: 'J2401',
              title: 'データベースシステム論',
              year: 2026,
              term: '後期',
              teacher: '山田 太郎',
              department: '情報学部',
              schedule: [{ day: 4, period: 2, room: '情報学部2号館21教室' }],
            },
            {
              id: 'J2105-2026-2',
              code: 'J2105',
              title: '線形代数学II',
              year: 2026,
              term: '後期',
              teacher: '佐藤 花子',
              department: '情報学部',
              schedule: [{ day: 4, period: 1, room: '共通教育A棟301' }],
            },
            {
              id: 'J2210-2026-2',
              code: 'J2210',
              title: 'プログラミング演習',
              year: 2026,
              term: '後期',
              teacher: '鈴木 一郎',
              department: '情報学部',
              schedule: [{ day: 4, period: 4, room: '情報学部1号館演習室' }],
            },
            {
              id: 'J2330-2026-2',
              code: 'J2330',
              title: '情報ネットワーク',
              year: 2026,
              term: '後期',
              teacher: '高橋 次郎',
              department: '情報学部',
              schedule: [{ day: 5, period: 3, room: '情報学部2号館11教室' }],
            },
          ],
          sessions: [
            {
              id: 'db-0924',
              courseId: 'J2401-2026-2',
              date: '2026-09-24',
              period: 2,
              room: '情報学部2号館21教室',
              number: 2,
            },
            {
              id: 'la-1001',
              courseId: 'J2105-2026-2',
              date: '2026-10-01',
              period: 1,
              room: '共通教育A棟301',
              number: 3,
            },
            {
              id: 'db-1001',
              courseId: 'J2401-2026-2',
              date: '2026-10-01',
              period: 2,
              room: '情報学部2号館21教室',
              number: 3,
            },
            {
              id: 'pr-1001',
              courseId: 'J2210-2026-2',
              date: '2026-10-01',
              period: 4,
              room: '情報学部1号館演習室',
              number: 3,
            },
            {
              id: 'nw-1002',
              courseId: 'J2330-2026-2',
              date: '2026-10-02',
              period: 3,
              room: '情報学部2号館11教室',
              number: 3,
            },
            {
              id: 'db-1008',
              courseId: 'J2401-2026-2',
              date: '2026-10-08',
              period: 2,
              room: '情報学部2号館21教室',
              number: 4,
            },
          ],
          exams: [
            {
              id: 'db-mid',
              courseId: 'J2401-2026-2',
              title: 'データベースシステム論 中間試験',
              kind: 'midterm',
              startsAt: '2026-10-22T10:20:00+09:00',
              room: '情報学部2号館21教室',
              scope: '第1回〜第6回（ER図・正規化）',
            },
          ],
          announcements: [
            {
              id: 'univ-0930',
              title: '後期履修登録の確認期間について',
              body: '後期の履修登録内容の確認は10月6日17時までに学務情報システムで行ってください。',
              publishedAt: '2026-09-30T03:00:00Z',
              importance: 'high',
              scope: 'university',
            },
          ],
        },
      },
    },
    {
      sourceId: 'teams',
      options: {
        product: 'microsoft365',
        sourceLabel: 'Microsoft Teams',
        authority: 'collaboration',
        capabilities: ['courses', 'announcements', 'messages'],
        dataset: {
          courses: [{ id: 'team-db', title: '2026 DB Systems', teacher: '山田太郎' }],
          messages: [
            {
              id: 'msg-3790',
              courseId: 'team-db',
              thread: '第2回',
              author: '山田太郎',
              authorRole: 'instructor',
              body: '第2回の復習課題は次回までに提出してください。',
              sentAt: '2026-09-24T03:00:00Z',
            },
          ],
        },
      },
    },
    {
      sourceId: 'lms',
      options: {
        product: 'moodle',
        sourceLabel: 'LMS',
        authority: 'submission-system',
        capabilities: ['courses', 'assignments', 'submissions', 'materials'],
        dataset: {
          courses: [
            {
              id: 'm-101',
              code: 'J2401',
              title: 'データベースシステム論 (2026後期)',
              year: 2026,
              term: '後期',
              teacher: '山田 太郎',
              schedule: [{ day: 4, period: 2 }],
            },
            {
              id: 'm-102',
              code: 'J2210',
              title: 'プログラミング演習 2026',
              year: 2026,
              term: '後期',
              teacher: '鈴木一郎',
            },
          ],
          assignments: [
            {
              id: 'a-1',
              courseId: 'm-101',
              title: '課題1: ER図の作成',
              due: '2026-10-08T23:59:00+09:00',
              updatedAt: '2026-09-20T00:00:00Z',
            },
            {
              id: 'a-2',
              courseId: 'm-101',
              title: '課題2: 正規化演習',
              due: '2026-10-15T23:59:00+09:00',
              updatedAt: '2026-09-20T00:00:00Z',
            },
            {
              id: 'a-3',
              courseId: 'm-102',
              title: '第2回 演習課題',
              due: '2026-10-01T23:59:00+09:00',
              updatedAt: '2026-09-20T00:00:00Z',
            },
          ],
          submissions: [
            {
              id: 's-3',
              assignmentId: 'a-3',
              status: 'submitted',
              submittedAt: '2026-09-29T12:00:00Z',
            },
          ],
          documents: [
            {
              id: 'doc-l2',
              courseId: 'm-101',
              title: 'Lecture 2.pdf',
              lectureDate: '2026-09-24',
              text: '第2回 ER モデル\n\nERモデルはエンティティと関連で実世界を表現する。\n\nカーディナリティの記法',
            },
          ],
        },
      },
    },
    {
      sourceId: 'record',
      options: {
        product: 'chatgpt-record',
        sourceLabel: 'ChatGPT Record',
        authority: 'transcript',
        capabilities: ['lectures'],
        dataset: {
          courses: [{ id: 'rec-db', title: 'DBSys' }],
          transcripts: [
            {
              id: 'rec-0924',
              courseId: 'rec-db',
              date: '2026-09-24',
              title: 'DBシステム論 第2回',
              segments: [
                {
                  start: '00:05:10',
                  text: '前回の復習から始めます。ERモデルの基本です。',
                  speaker: '山田',
                },
                {
                  start: '00:42:18',
                  text: '中間試験の範囲は正規化までです。第3正規形まで理解しておいてください。',
                  speaker: '山田',
                },
              ],
            },
          ],
        },
      },
    },
  ];
}

/** Apply the day-2 changes to the adapters created from createShizuokaSeed(). */
export function applySeedDay2(adapters: Record<string, FakeSourceAdapter>): void {
  const lms = adapters.lms;
  const teams = adapters.teams;
  if (lms) {
    lms.dataset.assignments = (lms.dataset.assignments ?? []).map((a) =>
      a.id === 'a-1'
        ? { ...a, due: '2026-10-10T23:59:00+09:00', updatedAt: '2026-09-30T22:00:00Z' }
        : a,
    );
    lms.dataset.documents = [
      ...(lms.dataset.documents ?? []),
      {
        id: 'doc-l3',
        courseId: 'm-101',
        title: 'Lecture 3.pdf',
        lectureDate: '2026-10-01',
        text: '第3回 正規化\n\n関数従属性と第1〜第3正規形。\n\n正規化の手順と例題',
        updatedAt: '2026-09-30T23:00:00Z',
      },
    ];
  }
  if (teams) {
    teams.dataset.announcements = [
      ...(teams.dataset.announcements ?? []),
      {
        id: 'msg-3812',
        courseId: 'team-db',
        title: '本日の教室変更',
        body: '本日10月1日の2限は情報学部2号館11教室で行います。',
        author: '山田太郎',
        importance: 'high',
        publishedAt: '2026-09-30T23:50:00Z',
        url: 'https://teams.example.invalid/l/message/3812',
        roomChange: { room: '情報学部2号館11教室', date: '2026-10-01' },
        updatedAt: '2026-09-30T23:50:00Z',
      },
    ];
  }
}
