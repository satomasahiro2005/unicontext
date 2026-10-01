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

export const ED_COURSES = {
  courses: [
    {
      course: { id: 55, code: 'CS101', name: 'Intro to CS', year: '2026', session: 'Fall' },
      role: { role: 'student' },
    },
  ],
};

export const ED_THREADS = {
  threads: [
    {
      id: 1,
      course_id: 55,
      title: 'Midterm room',
      document: 'The midterm will be in Room 11.',
      type: 'announcement',
      category: 'Announcements',
      pinned: true,
      created_at: '2026-10-01T09:00:00+09:00',
      updated_at: '2026-10-01T09:00:00+09:00',
      comment_count: 0,
      answer_count: 0,
      user: { name: 'Prof Smith', role: 'admin' },
    },
    {
      id: 2,
      course_id: 55,
      title: 'How do I submit lab 1?',
      document: 'Where do I submit lab 1?',
      type: 'question',
      category: 'Labs',
      created_at: '2026-10-02T10:00:00+09:00',
      comment_count: 1,
      answer_count: 1,
      user: { name: 'Student A', role: 'student' },
    },
    {
      id: 3,
      course_id: 55,
      title: 'Study group',
      content: '<document><paragraph>Anyone up for a study group?</paragraph></document>',
      type: 'post',
      category: 'General',
      created_at: '2026-10-03T10:00:00+09:00',
      comment_count: 0,
      answer_count: 0,
      user: { name: 'Student B', role: 'student' },
    },
  ],
};

export const ED_THREAD_DETAIL = {
  thread: {
    id: 2,
    course_id: 55,
    title: 'How do I submit lab 1?',
    created_at: '2026-10-02T10:00:00+09:00',
    answers: [
      {
        id: 21,
        document: 'Upload it on Canvas before Friday.',
        created_at: '2026-10-02T11:00:00+09:00',
        user: { name: 'TA Jones', role: 'staff' },
      },
    ],
    comments: [
      {
        id: 22,
        document: 'Thanks!',
        created_at: '2026-10-02T12:00:00+09:00',
        user: { name: 'Student A', role: 'student' },
      },
    ],
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
        },
      },
      (args: Record<string, unknown>) => {
        options.calls?.push({ tool, args });
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

export function createEdServer(options: ServerOptions = {}): McpServer {
  return build(
    'fake-edstem',
    {
      // structuredContent preferred over text
      list_courses: () => ({
        structuredContent: ED_COURSES,
        content: [{ type: 'text', text: 'ignored text' }],
      }),
      list_threads: () => text(ED_THREADS),
      get_thread: (args) =>
        text(
          Number(args.thread_id) === 2
            ? ED_THREAD_DETAIL
            : { thread: { id: Number(args.thread_id), course_id: 55 } },
        ),
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
