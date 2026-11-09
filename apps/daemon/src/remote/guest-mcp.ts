import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { errorMessage, type Logger } from '@unicontext/core';
import { z } from 'zod';
import type { GuestCourse, GuestView } from './guest-view.js';
import type { GuestRole } from './guests.js';

/**
 * A guest's own MCP endpoint (`<publicUrl>/g/<token>/mcp`): the guest adds it to their ChatGPT or
 * Claude as a connector (no sign-in; the URL is the capability, like the page link) and asks their
 * own AI. It serves exactly what the guest's page shows (guest-view.ts), read-only.
 */

export interface GuestMcpDeps {
  role: GuestRole;
  guestName: string;
  version: string;
  /** The calendar week: 0 this week, 1 the next; `upcoming` adds the 14-day deadlines (family). */
  view(offsetWeeks: number, upcoming: boolean): GuestView;
  /** Every registered course with its weekly slots (guest-view.ts guestCourses). */
  courses(): GuestCourse[];
  logger?: Logger;
}

const ROLE_SCOPE: Record<GuestRole, string> = {
  friend: '時間割（授業・教室・休講）',
  family: '時間割（授業・教室・休講）と、締切・試験・提出状況',
};

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

export function createGuestMcpServer(deps: GuestMcpDeps): McpServer {
  const server = new McpServer(
    {
      name: 'unicontext-guest',
      title: 'UniContext（共有）',
      version: deps.version,
      description: '大学生が家族や友達に共有した時間割 / A student’s shared timetable',
    },
    {
      instructions: [
        `${deps.guestName}さんに学生本人が共有した${ROLE_SCOPE[deps.role]}だけを返します。`,
        '成績・出席・メール・お知らせの中身・居場所は共有されていません。データにないことは推測で断定しないでください。',
        '締切が載っていないことは締切が無いことを意味しません。日時は timezone（Asia/Tokyo）で読んでください。',
      ].join('\n'),
    },
  );

  server.registerTool(
    'get_schedule',
    {
      title: '時間割',
      description:
        '今週か来週の時間割（日ごとの授業・時限・教室・休講）。today が今日。 / The shared timetable for this or next week',
      inputSchema: {
        week: z.enum(['this', 'next']).optional().describe('this（今週・既定）か next（来週）'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ week }) => {
      const { deadlines: _d, exams: _e, ...view } = deps.view(week === 'next' ? 1 : 0, false);
      return json(view);
    },
  );

  server.registerTool(
    'get_courses',
    {
      title: '履修科目',
      description:
        '履修登録した科目の一覧（年度・学期・前半/後半・曜日と時限・教室）。週ごとでなく全体の時間割を一度に返す。 / Every registered course with its weekly slots',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => json({ courses: deps.courses() }),
  );

  if (deps.role === 'family')
    server.registerTool(
      'get_deadlines',
      {
        title: '締切・試験',
        description:
          '直近の課題の締切・試験と、提出済みかどうか（done）。overdue は期限を過ぎて提出を確認できていないもの。 / Upcoming deadlines and exams',
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      () => {
        const v = deps.view(0, true);
        return json({
          generatedAt: v.generatedAt,
          timezone: v.timezone,
          today: v.today,
          deadlines: v.deadlines ?? [],
          exams: v.exams ?? [],
        });
      },
    );

  return server;
}

function rpcError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/** Stateless streamable HTTP, one server per request (like the student's own endpoint). */
export async function handleGuestMcp(
  deps: GuestMcpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  body?: unknown,
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    rpcError(res, 405, 'Method not allowed: this MCP endpoint is stateless, use POST.');
    return;
  }
  const server = createGuestMcpServer(deps);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    deps.logger?.error('guest mcp request failed', { error: errorMessage(e) });
    rpcError(res, 500, 'Internal server error');
  }
}
