import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import type { McpTransportFactory } from '../../src/index.js';

/** Synthetic Canvas data (all fake). */
export const CANVAS_COURSES = [
  {
    id: 101,
    name: 'データベースシステム論',
    course_code: 'DB-101',
    term: { name: '2026年度 前期' },
    teachers: [{ display_name: '山田 太郎' }],
    html_url: 'https://canvas.example/courses/101',
  },
  {
    id: 102,
    name: 'Algorithms',
    course_code: 'CS-210',
    term: { name: '2026 Fall' },
    html_url: 'https://canvas.example/courses/102',
  },
];

export const CANVAS_ASSIGNMENTS: Record<number, unknown[]> = {
  101: [
    {
      id: 5001,
      name: '課題1: ER図',
      description: 'ER図を作成せよ',
      due_at: '2026-10-08T14:59:00Z',
      points_possible: 10,
      submission_types: ['online_upload'],
      html_url: 'https://canvas.example/courses/101/assignments/5001',
      updated_at: '2026-09-30T11:00:00Z',
    },
  ],
  102: [
    {
      id: 5002,
      name: 'Problem set 1',
      due_at: null,
      html_url: 'https://canvas.example/courses/102/assignments/5002',
    },
  ],
};

export const CANVAS_ANNOUNCEMENTS: Record<number, unknown[]> = {
  101: [
    {
      id: 9001,
      title: '教室変更',
      message: '<p>来週から11教室で行います</p>',
      posted_at: '2026-10-01T09:00:00+09:00',
      author: { display_name: '山田 太郎' },
      html_url: 'https://canvas.example/courses/101/discussion_topics/9001',
    },
  ],
  102: [],
};

export const CANVAS_SUBMISSIONS: Record<number, unknown[]> = {
  101: [
    {
      id: 7001,
      assignment_id: 5001,
      workflow_state: 'submitted',
      submitted_at: '2026-10-02T12:00:00Z',
      late: false,
    },
  ],
  102: [{ id: 7002, assignment_id: 5002, workflow_state: 'unsubmitted', late: false }],
};

/*
 * Synthetic Ed Discussion data shaped like the results of bunizao/edstem-cli's `edstem-mcp`
 * (v0.7.2): list_courses → array of projected courses, list_threads → array of compact summaries
 * (no body, no author), get_thread → summary + userId/document/users/answers/comments. All names,
 * ids and texts are fake.
 */
const DAY = 24 * 60 * 60 * 1000;
/** Ed timestamps carry the course's offset; the projection drops fractional seconds. */
const daysAgo = (n: number): string =>
  new Date(Date.now() - n * DAY).toISOString().replace(/\.\d+Z$/, '+00:00');

export const ED_COURSES = [
  {
    id: 55,
    code: 'CS101',
    name: 'Intro to CS',
    year: '2026',
    session: 'Fall',
    status: 'active',
    role: 'student',
  },
];

export const ED_THREADS = [
  {
    // announcement: always gets a detail call, however old
    id: 1001,
    number: 1,
    title: 'Midterm room',
    type: 'announcement',
    category: 'Announcements',
    courseId: 55,
    createdAt: '2026-04-10T09:00:00+09:00',
    updatedAt: '2026-04-10T09:00:00+09:00',
    metrics: { viewCount: 80, replyCount: 1 },
    flags: ['pinned'],
  },
  {
    id: 1002,
    number: 2,
    title: 'How do I submit lab 1?',
    type: 'question',
    category: 'Labs',
    subcategory: 'Lab 1',
    courseId: 55,
    createdAt: daysAgo(3),
    updatedAt: daysAgo(2),
    metrics: { viewCount: 12, replyCount: 3 },
    flags: ['answered', 'endorsed'],
  },
  {
    id: 1003,
    number: 3,
    title: 'Study group',
    type: 'post',
    category: 'General',
    courseId: 55,
    createdAt: daysAgo(1),
    flags: ['unseen'],
  },
  {
    // older than 30 days: listed as a thread, but no detail call
    id: 1004,
    number: 4,
    title: 'Old thread',
    type: 'post',
    category: 'General',
    courseId: 55,
    createdAt: daysAgo(90),
    updatedAt: daysAgo(80),
  },
];

const USERS = {
  '7': { id: 7, name: 'Prof Smith', courseRole: 'admin', role: 'user' },
  '8': { id: 8, name: 'TA Jones', courseRole: 'tutor', role: 'user' },
  '9': { id: 9, name: 'Student A', courseRole: 'student', role: 'user' },
  '10': { id: 10, name: 'Student B', courseRole: 'student', role: 'user' },
};

export const ED_THREAD_DETAILS: Record<number, unknown> = {
  1001: {
    ...ED_THREADS[0],
    userId: 7,
    document: 'The midterm will be in Room 11.',
    users: { '7': USERS['7'], '9': USERS['9'] },
    comments: [
      { id: 5001, userId: 9, document: 'Is it open book?', createdAt: '2026-04-10T10:00:00+09:00' },
    ],
  },
  1002: {
    ...ED_THREADS[1],
    userId: 9,
    document: 'Where do I submit lab 1?',
    endorsement: { endorsedAnswerIds: [5101], staffReplyCount: 1, hasStaffAnswer: true },
    users: { '8': USERS['8'], '9': USERS['9'], '10': USERS['10'] },
    answers: [
      {
        id: 5101,
        userId: 8,
        document: 'Upload it on Canvas before Friday.',
        createdAt: daysAgo(2),
        endorsed: true,
        byStaff: true,
        comments: [
          { id: 5102, userId: 9, document: 'Thanks!', createdAt: daysAgo(2) },
        ],
      },
    ],
    comments: [
      { id: 5103, userId: 10, document: 'Same question here.', createdAt: daysAgo(2) },
    ],
  },
  1003: {
    ...ED_THREADS[2],
    userId: 10,
    document: 'Anyone up for a study group?',
    users: { '10': USERS['10'] },
  },
};

const text = (data: unknown): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
});

const anyId = z.union([z.number(), z.string()]);

export interface ServerOptions {
  /** Tools to leave out (simulates a server with different tool names). */
  omit?: string[];
  /** Tools that return an MCP error result. */
  failing?: string[];
  calls?: { tool: string; args: unknown }[];
  /** Every tool answers like edstem-mcp does for a rejected Ed token. */
  authFailing?: boolean;
}

type Handler = (args: Record<string, unknown>) => unknown;

function build(name: string, handlers: Record<string, Handler>, options: ServerOptions): McpServer {
  const server = new McpServer({ name, version: '9.9.9' });
  for (const [tool, handler] of Object.entries(handlers)) {
    if (options.omit?.includes(tool)) continue;
    server.registerTool(
      tool,
      {
        description: `fake ${tool}`,
        inputSchema: {
          course_id: anyId.optional(),
          thread_id: anyId.optional(),
          cursor: z.string().optional(),
          // edstem-mcp argument names
          courseId: anyId.optional(),
          threadId: z.number().optional(),
          lessonId: z.number().optional(),
          slideId: z.number().optional(),
          includeArchived: z.boolean().optional(),
          limit: z.number().optional(),
          sort: z.string().optional(),
        },
      },
      (args: Record<string, unknown>) => {
        options.calls?.push({ tool, args });
        if (options.authFailing)
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: {
                    message: 'Authentication failed (HTTP 400). Check your Ed API token.',
                    type: 'EDSTEM_REAUTH_REQUIRED',
                  },
                }),
              },
            ],
            isError: true,
          };
        if (options.failing?.includes(tool))
          return {
            content: [{ type: 'text' as const, text: 'upstream exploded with token=abc123' }],
            isError: true,
          };
        return handler(args) as never;
      },
    );
  }
  return server;
}

export function createCanvasServer(options: ServerOptions = {}): McpServer {
  const byCourse =
    (data: Record<number, unknown[]>): Handler =>
    (args) =>
      text(data[Number(args.course_id)] ?? []);
  return build(
    'fake-canvas',
    {
      list_courses: () => text(CANVAS_COURSES),
      list_assignments: byCourse(CANVAS_ASSIGNMENTS),
      list_announcements: byCourse(CANVAS_ANNOUNCEMENTS),
      list_submissions: byCourse(CANVAS_SUBMISSIONS),
    },
    options,
  );
}

/** Ed lessons, shaped like a Shizuoka course's real list_lessons / get_lesson results. */
export const ED_LESSONS = [
  {
    id: 2001,
    courseId: 55,
    moduleId: 1,
    title: '当日の講義資料',
    moduleName: '第1回: ガイダンス・導入 (10/1)',
    type: 'general',
    kind: 'content',
    state: 'active',
    status: 'attempted',
    slideCount: 3,
  },
  {
    // the deadline is only in the slide text
    id: 2002,
    courseId: 55,
    moduleId: 1,
    title: '当日課題 (小レポート1)',
    moduleName: '第1回: ガイダンス・導入 (10/1)',
    type: 'general',
    kind: 'content',
    state: 'active',
    status: 'unattempted',
    slideCount: 1,
  },
  {
    // Ed's own due date (absolute, AU offset)
    id: 2003,
    courseId: 55,
    moduleId: 2,
    title: 'Quiz 2',
    state: 'active',
    status: 'completed',
    availableAt: '2026-10-07T09:00:00+11:00',
    dueAt: '2026-10-14T23:59:00+11:00',
  },
  {
    // work to hand in with no date anywhere: kept as 期限不明
    id: 2004,
    courseId: 55,
    moduleId: 2,
    title: '課題 (小レポート2)',
    state: 'active',
    status: 'unattempted',
  },
];

export const ED_LESSON_DETAILS: Record<number, unknown> = {
  2001: {
    ...ED_LESSONS[0],
    createdAt: '2026-09-24T13:21:00+10:00',
    slides: [
      {
        id: 821138,
        index: 3,
        title: '講義資料',
        type: 'pdf',
        status: 'completed',
        fileUrl: 'https://static.edusercontent.com/files/AAAA',
      },
      {
        id: 821139,
        index: 5,
        title: 'まとめ',
        type: 'document',
        status: 'completed',
        content: '<document version="2.0"><paragraph>正規化は第3回で扱う</paragraph></document>',
      },
    ],
  },
  2003: {
    ...ED_LESSONS[2],
    createdAt: '2026-10-01T10:00:00+11:00',
    slides: [
      { id: 7001, index: 0, title: '前半', type: 'quiz', status: 'completed' },
      { id: 7002, index: 1, title: '後半', type: 'quiz', status: 'completed' },
    ],
  },
  2002: {
    ...ED_LESSONS[1],
    createdAt: '2026-09-24T13:21:00+10:00',
    slides: [
      {
        id: 821141,
        index: 1,
        title: '課題 (小レポート1)',
        type: 'quiz',
        status: 'seen',
        content:
          '<document version="2.0"><paragraph>提出期限: 10月6日 17:00PM  </paragraph></document>',
      },
    ],
  },
  2004: {
    ...ED_LESSONS[3],
    createdAt: '2026-10-01T10:00:00+10:00',
    slides: [
      {
        id: 9,
        index: 1,
        type: 'document',
        // a file written into the slide text (<file url filename/>), next to a plain paragraph
        content:
          '<document><paragraph>ER図を描く</paragraph><file url="https://static.edusercontent.com/files/DDDD" filename="ER図の例.png"/></document>',
      },
    ],
  },
};

/**
 * Quiz questions per slide, shaped like list_slide_questions (a Shizuoka 小レポート: free-text
 * questions with 1-based `index`; another course: multiple choice with 0-based `index`, listed out
 * of order). `solution` / `explanation` are the answer key and must never be mapped.
 */
export const ED_SLIDE_QUESTIONS: Record<number, unknown[]> = {
  821141: [
    {
      id: 423710,
      slideId: 821141,
      index: 2,
      type: 'general',
      content:
        '<document version="2.0"><paragraph>授業の感想をDiscussionのスレッドに投稿し、そのスレッド番号を記載してください</paragraph></document>',
      answers: [],
      explanation: '<document version="2.0"><paragraph/></document>',
      formatted: true,
    },
    {
      id: 404981,
      slideId: 821141,
      index: 1,
      type: 'general',
      content:
        '<document version="2.0"><paragraph>画像形式のファイルを貼り付けて提出すること</paragraph><heading level="3">ビデオレンタル店のデータベースの概念モデルを設計し、ER図を提出しなさい。</heading></document>',
      answers: [],
      formatted: true,
    },
  ],
  7001: [
    {
      id: 5001,
      slideId: 7001,
      index: 0,
      type: 'multiple-choice',
      content: '<document version="2.0"><paragraph>主キーの性質はどれか</paragraph></document>',
      answers: ['一意である', 'NULL を許す'],
      solution: [0],
      explanation: '<document version="2.0"><paragraph>SECRET-ANSWER-KEY</paragraph></document>',
    },
  ],
  7002: [
    {
      id: 5002,
      slideId: 7002,
      index: 0,
      type: 'general',
      content: '<document version="2.0"><paragraph>第2正規形を説明せよ</paragraph></document>',
      answers: [],
    },
  ],
};

/** The student's own saved answers per slide (list_slide_responses). */
export const ED_SLIDE_RESPONSES: Record<number, unknown[]> = {
  821141: [
    {
      questionId: 404981,
      userId: 7,
      createdAt: '2026-10-05T20:00:00+11:00',
      // the student pasted their ER diagram and attached a note (Ed answer document)
      data: {
        content:
          '<document version="2.0"><paragraph>下書き: 会員・DVD・貸出</paragraph><figure><image src="https://static.edusercontent.com/files/ERIMG1" width="640" height="480"/></figure><file url="https://static.edusercontent.com/files/NOTE2" filename="ER図の説明.txt"/></document>',
      },
    },
  ],
  7001: [{ questionId: 5001, userId: 7, correct: true, data: { choices: [0] } }],
};

export function createEdServer(options: ServerOptions = {}): McpServer {
  const refuse: Handler = () => {
    throw new Error('write tool called');
  };
  return build(
    'fake-edstem',
    {
      list_courses: () => text(ED_COURSES),
      list_threads: (args) => text(ED_THREADS.filter((t) => t.courseId === Number(args.courseId))),
      get_thread: (args) => {
        const detail = ED_THREAD_DETAILS[Number(args.threadId)];
        if (!detail)
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: { message: 'Ed API error (HTTP 404)', type: 'EDSTEM_API_ERROR' },
                }),
              },
            ],
            isError: true,
          };
        return text(detail);
      },
      list_lessons: (args) => text(ED_LESSONS.filter((l) => l.courseId === Number(args.courseId))),
      get_lesson: (args) => text(ED_LESSON_DETAILS[Number(args.lessonId)] ?? {}),
      list_slide_questions: (args) => text(ED_SLIDE_QUESTIONS[Number(args.slideId)] ?? []),
      list_slide_responses: (args) => text(ED_SLIDE_RESPONSES[Number(args.slideId)] ?? []),
      list_lesson_files: (args) =>
        text(
          Object.values(ED_LESSON_DETAILS)
            .filter((l) => (l as { id: number }).id === Number(args.lessonId))
            .flatMap((l) =>
              (l as { slides: { id: number; title?: string; fileUrl?: string }[] }).slides
                .filter((sl) => sl.fileUrl)
                .map((sl) => ({
                  filename: `${sl.title ?? ''}.pdf`,
                  lessonId: Number(args.lessonId),
                  mediaType: 'application/pdf',
                  slideId: sl.id,
                  slideTitle: sl.title,
                  source: 'slide',
                  url: sl.fileUrl,
                })),
            ),
        ),
      // write tools the real server also offers: the mapping must never call them
      create_thread: refuse,
      reply_thread: refuse,
      mark_lessons_read: refuse,
      submit_slide_answer: refuse,
      submit_slide: refuse,
    },
    options,
  );
}

/** Transport factory that connects the adapter to an in-process server (no child process). */
export function inMemoryFactory(createServer: () => McpServer): McpTransportFactory {
  return async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    return clientSide;
  };
}
