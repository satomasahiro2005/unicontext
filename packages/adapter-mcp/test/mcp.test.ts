import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanonicalEntitySchema, type CanonicalEntity } from '@unicontext/canonical-model';
import {
  AuthRequiredError,
  ConfigError,
  ConnectorError,
  OfflineError,
  parseProfile,
  type SecretStore,
  silentLogger,
} from '@unicontext/core';
import {
  createNormalizeContext,
  instantiateConnector,
  type NormalizeOutput,
  type RawItem,
  type RawItemView,
  type SourceAdapter,
  type SyncResult,
} from '@unicontext/connector-sdk';
import { testConnectorCompliance } from '@unicontext/connector-sdk/testing';
import {
  createMappedNormalizer,
  loadMappingFile,
  type MappingSpec,
  parseMappingSpec,
} from '@unicontext/mapping';
import { describe, expect, it } from 'vitest';
import {
  createMcpConnector,
  MAPPINGS_DIR,
  mcpConnector,
  mcpMetadata,
  McpConfigSchema,
  McpSourceAdapter,
  parseToolResult,
  type McpConfigInput,
  type McpTransportFactory,
} from '../src/index.js';
import mcpDefault from '../src/index.js';
import {
  CANVAS_ANNOUNCEMENTS,
  createCanvasServer,
  createEdServer,
  ED_LESSONS,
  inMemoryFactory,
  type ServerOptions,
} from './fixtures/servers.js';

const here = dirname(fileURLToPath(import.meta.url));

class MemorySecrets implements SecretStore {
  readonly backend = 'memory';
  constructor(private readonly map = new Map<string, string>()) {}
  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.map.get(key));
  }
  set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.map.delete(key));
  }
}

const canvasSpec = (): MappingSpec => loadMappingFile(join(MAPPINGS_DIR, 'canvas-mcp.yaml'));
const edSpec = (): MappingSpec => loadMappingFile(join(MAPPINGS_DIR, 'edstem-mcp.yaml'));

function adapterFor(
  spec: MappingSpec,
  transportFactory: McpTransportFactory,
  config: McpConfigInput = { command: 'fake-mcp-server' },
  secrets: SecretStore = new MemorySecrets(),
): McpSourceAdapter {
  return new McpSourceAdapter({
    sourceId: 'src',
    spec,
    config: McpConfigSchema.parse(config),
    secrets,
    transportFactory,
  });
}

async function syncAll(adapter: SourceAdapter): Promise<{ items: RawItem[]; pages: SyncResult[] }> {
  const pages: SyncResult[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 100; i++) {
    const res = await adapter.sync({ mode: 'initial', ...(pageToken ? { pageToken } : {}) });
    pages.push(res);
    if (!res.hasMore) break;
    pageToken = res.nextPageToken;
  }
  return { items: pages.flatMap((p) => p.items), pages };
}

const ctx = createNormalizeContext({ sourceId: 'src', sourceSystem: 'x', timezone: 'Asia/Tokyo' });

async function normalizeAll(
  spec: MappingSpec,
  items: RawItem[],
): Promise<{
  entities: CanonicalEntity[];
  outputs: { item: RawItem; out: NormalizeOutput }[];
}> {
  const normalizer = createMappedNormalizer(spec);
  const outputs: { item: RawItem; out: NormalizeOutput }[] = [];
  const entities: CanonicalEntity[] = [];
  for (const item of items) {
    const view: RawItemView = {
      id: `raw:${item.sourceType}:${item.externalId}`,
      sourceId: 'src',
      sourceType: item.sourceType,
      externalId: item.externalId,
      payload: item.payload,
      fetchedAt: '2026-10-01T00:00:00.000Z',
      sourceUpdatedAt: item.sourceUpdatedAt,
      contentHash: 'h',
    };
    const out = await normalizer.normalize(view, ctx);
    outputs.push({ item, out });
    for (const e of out.entities) {
      const parsed = CanonicalEntitySchema.safeParse(e.entity);
      expect(
        parsed.success,
        `${item.sourceType}: ${parsed.success ? '' : parsed.error.message}`,
      ).toBe(true);
      entities.push(e.entity as CanonicalEntity);
    }
  }
  return { entities, outputs };
}

describe('parseToolResult', () => {
  it('prefers structuredContent, then JSON text, then wraps text', () => {
    expect(
      parseToolResult({ structuredContent: { a: 1 }, content: [{ type: 'text', text: '[]' }] }),
    ).toEqual({ a: 1 });
    expect(parseToolResult({ content: [{ type: 'text', text: '[{"id":1}]' }] })).toEqual([
      { id: 1 },
    ]);
    expect(parseToolResult({ content: [{ type: 'text', text: ' {"id":1} ' }] })).toEqual({ id: 1 });
    expect(parseToolResult({ content: [{ type: 'text', text: 'hello world' }] })).toEqual({
      text: 'hello world',
    });
    expect(
      parseToolResult({
        content: [
          { type: 'text', text: '[1,' },
          { type: 'text', text: '2]' },
        ],
      }),
    ).toEqual([1, 2]);
    expect(
      parseToolResult({
        content: [
          { type: 'text', text: '{"a":1}' },
          { type: 'text', text: '{"b":2}' },
        ],
      }),
    ).toEqual([{ a: 1 }, { b: 2 }]);
    expect(
      parseToolResult({
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      }),
    ).toEqual({ text: 'a\nb' });
    expect(
      parseToolResult({
        content: [{ type: 'resource', resource: { uri: 'x://y', text: '{"k":1}' } }],
      }),
    ).toEqual({ k: 1 });
    expect(parseToolResult({ content: [] })).toEqual({});
  });

  it('turns isError results into ConnectorError with a redacted message', () => {
    expect(() =>
      parseToolResult(
        { isError: true, content: [{ type: 'text', text: 'denied token=abc123' }] },
        'list_x',
      ),
    ).toThrow(ConnectorError);
    try {
      parseToolResult(
        { isError: true, content: [{ type: 'text', text: 'denied token=abc123' }] },
        'list_x',
      );
    } catch (e) {
      expect(String((e as Error).message)).toContain('list_x');
      expect(String((e as Error).message)).not.toContain('abc123');
    }
  });
});

describe('McpConfigSchema', () => {
  it('needs exactly one of command / url and keeps credentials out of headers/env', () => {
    expect(McpConfigSchema.safeParse({}).success).toBe(false);
    expect(McpConfigSchema.safeParse({ command: 'x', url: 'https://x.example/mcp' }).success).toBe(
      false,
    );
    expect(McpConfigSchema.safeParse({ command: 'npx', args: ['canvas-mcp'] }).success).toBe(true);
    expect(
      McpConfigSchema.safeParse({
        url: 'https://x.example/mcp',
        headers: { Authorization: 'Bearer abc' },
      }).success,
    ).toBe(false);
    expect(McpConfigSchema.safeParse({ command: 'x', env: { API_TOKEN: 'abc' } }).success).toBe(
      false,
    );
    expect(
      McpConfigSchema.safeParse({
        command: 'x',
        env: ['PATH'],
        envSecrets: [{ name: 'API_TOKEN', secret: 't' }],
      }).success,
    ).toBe(true);
    expect(McpConfigSchema.parse({ command: 'x' }).timeoutMs).toBe(60000);
  });
});

describe('shipped mappings', () => {
  it('parse and declare canvas / edstem', () => {
    expect(canvasSpec()).toMatchObject({ id: 'canvas', defaultAuthority: 'lms' });
    expect(canvasSpec().capabilities).toEqual([
      'courses',
      'assignments',
      'announcements',
      'submissions',
    ]);
    expect(edSpec()).toMatchObject({ id: 'edstem', defaultAuthority: 'discussion' });
  });
});

describe('Canvas-like MCP server', () => {
  it('syncs through the MCP client and normalizes to canonical entities', async () => {
    const calls: ServerOptions['calls'] = [];
    const adapter = adapterFor(
      canvasSpec(),
      inMemoryFactory(() => createCanvasServer({ calls })),
    );
    expect(await adapter.capabilities()).toEqual([
      'courses',
      'assignments',
      'announcements',
      'submissions',
    ]);
    expect((await adapter.authenticate()).status).toBe('not_required');
    const { items, pages } = await syncAll(adapter);
    const count = (t: string): number => items.filter((i) => i.sourceType === t).length;
    expect(count('canvas.course')).toBe(2);
    expect(count('canvas.assignment')).toBe(2);
    expect(count('canvas.announcement')).toBe(1);
    expect(count('canvas.submission')).toBe(2);
    expect(pages.at(-1)?.complete?.sourceTypes.sort()).toEqual([
      'canvas.assignment',
      'canvas.course',
      'canvas.submission',
    ]);
    expect(pages[0]?.productVersion).toEqual({ product: 'canvas', version: '9.9.9' });
    // numeric ids are passed to the tool as numbers (template type preserved)
    expect(calls.filter((c) => c.tool === 'list_assignments').map((c) => c.args)).toEqual([
      { course_id: 101 },
      { course_id: 102 },
    ]);

    const { entities, outputs } = await normalizeAll(canvasSpec(), items);
    const kinds = entities.map((e) => e.kind).sort();
    expect(kinds).toEqual([
      'announcement',
      'assignment',
      'assignment',
      'courseOffering',
      'courseOffering',
      'submission',
      'submission',
    ]);
    const assignment = entities.find((e) => e.kind === 'assignment' && e.title === '課題1: ER図');
    expect(assignment).toMatchObject({ dueAt: '2026-10-08T14:59:00Z', points: 10 });
    const offering = entities.find((e) => e.kind === 'courseOffering' && e.courseCode === 'DB-101');
    expect(offering).toMatchObject({ academicYear: 2026, instructorNames: ['山田 太郎'] });
    expect(entities.find((e) => e.kind === 'announcement')).toMatchObject({
      body: ' 来週から11教室で行います ',
      scope: 'course',
    });
    const submissions = entities
      .filter((e) => e.kind === 'submission')
      .map((e) => (e as { status: string }).status)
      .sort();
    expect(submissions).toEqual(['not_submitted', 'submitted']);
    // authorities: assignments + submissions come from the submission system
    const refs = outputs.flatMap(({ item, out }) =>
      out.entities.map((e) => [item.sourceType, e.ref?.authority]),
    );
    expect(refs).toContainEqual(['canvas.assignment', 'submission-system']);
    expect(refs).toContainEqual(['canvas.submission', 'submission-system']);
    expect(refs).toContainEqual(['canvas.announcement', 'instructor-announcement']);
    expect(outputs.every(({ out }) => (out.warnings ?? []).length === 0)).toBe(true);
    await adapter.dispose();
  });

  it('discovers the tool catalog', async () => {
    const adapter = adapterFor(
      canvasSpec(),
      inMemoryFactory(() => createCanvasServer()),
    );
    const tools = await adapter.discover();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'list_announcements',
      'list_assignments',
      'list_courses',
      'list_submissions',
    ]);
    expect(tools[0]).toMatchObject({
      description: expect.stringContaining('fake'),
      inputSchema: { type: 'object' },
    });
    expect(adapter.mappedTools().sort()).toEqual(tools.map((t) => t.name).sort());
    await adapter.dispose();
  });

  it('reports health: healthy, degraded for a missing mapped tool, offline when the server cannot start', async () => {
    const healthy = adapterFor(
      canvasSpec(),
      inMemoryFactory(() => createCanvasServer()),
    );
    expect(await healthy.health()).toMatchObject({ state: 'healthy', detectedVersion: '9.9.9' });
    await healthy.dispose();

    const degraded = adapterFor(
      canvasSpec(),
      inMemoryFactory(() => createCanvasServer({ omit: ['list_submissions'] })),
    );
    const h = await degraded.health();
    expect(h.state).toBe('degraded');
    expect(h.message).toContain('list_submissions');
    await degraded.dispose();

    const offline = adapterFor(canvasSpec(), () => {
      throw new Error('spawn ENOENT');
    });
    const o = await offline.health();
    expect(o.state).toBe('offline');
    expect(o.message).toContain('ENOENT');
    expect((await offline.authenticate()).status).toBe('failed');
    await expect(offline.sync({ mode: 'initial' })).rejects.toBeInstanceOf(OfflineError);
  });

  it('fails a sync that needs a tool the server does not offer, naming the available tools', async () => {
    const adapter = adapterFor(
      canvasSpec(),
      inMemoryFactory(() => createCanvasServer({ omit: ['list_courses'] })),
    );
    await expect(adapter.sync({ mode: 'initial' })).rejects.toThrow(
      /list_courses.*not offered.*list_assignments/s,
    );
    await adapter.dispose();
  });

  it('turns an MCP error result into a ConnectorError (redacted) that fails the required resource', async () => {
    const adapter = adapterFor(
      canvasSpec(),
      inMemoryFactory(() => createCanvasServer({ failing: ['list_courses'] })),
    );
    const err = await adapter.sync({ mode: 'initial' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as Error).message).toContain('list_courses');
    expect((err as Error).message).not.toContain('abc123');
    await adapter.dispose();
  });

  it('degrades a failing per-course tool to a warning and withholds "complete"', async () => {
    const adapter = adapterFor(
      canvasSpec(),
      inMemoryFactory(() => createCanvasServer({ failing: ['list_announcements'] })),
    );
    const { items, pages } = await syncAll(adapter);
    expect(items.filter((i) => i.sourceType === 'canvas.announcement')).toHaveLength(0);
    expect(items.filter((i) => i.sourceType === 'canvas.assignment')).toHaveLength(2);
    expect(pages.at(-1)?.warnings?.some((w) => /announcements/.test(w))).toBe(true);
    await adapter.dispose();
  });

  it('runs with a small call budget (nextPageToken) and still returns everything', async () => {
    const adapter = new McpSourceAdapter({
      sourceId: 'src',
      spec: canvasSpec(),
      config: McpConfigSchema.parse({ command: 'x' }),
      secrets: new MemorySecrets(),
      transportFactory: inMemoryFactory(() => createCanvasServer()),
      runOptions: { maxCallsPerPage: 3 },
    });
    const { items, pages } = await syncAll(adapter);
    expect(pages.length).toBeGreaterThan(1);
    expect(items).toHaveLength(7);
    await adapter.dispose();
  });

  it('follows cursor pagination declared in call.paginate', async () => {
    const spec = parseMappingSpec({
      id: 'p',
      product: 'p',
      capabilities: ['courses'],
      resources: [
        {
          name: 'courses',
          call: {
            tool: 'list_courses',
            args: {},
            paginate: { cursorArg: 'cursor', nextCursor: 'next' },
          },
          select: 'items',
          sourceType: 'p.course',
          externalId: '$string(id)',
        },
      ],
    });
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { z } = await import('zod');
    const make = (): InstanceType<typeof McpServer> => {
      const s = new McpServer({ name: 'pg', version: '1.0.0' });
      s.registerTool(
        'list_courses',
        { inputSchema: { cursor: z.string().optional() } },
        ({ cursor }) => ({
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                cursor === 'c2'
                  ? { items: [{ id: 3 }] }
                  : cursor === 'c1'
                    ? { items: [{ id: 2 }], next: 'c2' }
                    : { items: [{ id: 1 }], next: 'c1' },
              ),
            },
          ],
        }),
      );
      return s;
    };
    const adapter = adapterFor(spec, inMemoryFactory(make));
    const { items } = await syncAll(adapter);
    expect(items.map((i) => i.externalId)).toEqual(['1', '2', '3']);
    await adapter.dispose();
  });

  it('never puts credential-like keys into raw payloads', async () => {
    const spec = canvasSpec();
    const adapter = adapterFor(
      spec,
      inMemoryFactory(() => createCanvasServer()),
    );
    const { items } = await syncAll(adapter);
    expect(JSON.stringify(items)).not.toMatch(/access_token|password/i);
    await adapter.dispose();
  });

  it('requires secrets named in envSecrets (auth_required) and reads them from the SecretStore', async () => {
    const seen: Record<string, string>[] = [];
    const factory: McpTransportFactory = async (conn) => {
      if (conn.kind === 'stdio') seen.push(conn.env);
      return inMemoryFactory(() => createCanvasServer())(conn, {
        logger: silentLogger,
        fetch: undefined,
      });
    };
    const cfg: McpConfigInput = {
      command: 'x',
      env: { LITERAL: 'yes' },
      envSecrets: [{ name: 'CANVAS_API_TOKEN', secret: 'canvas-token' }],
    };
    const noSecret = adapterFor(canvasSpec(), factory, cfg);
    expect((await noSecret.authenticate()).status).toBe('auth_required');
    expect((await noSecret.health()).state).toBe('auth_required');
    await expect(noSecret.sync({ mode: 'initial' })).rejects.toBeInstanceOf(AuthRequiredError);

    const secrets = new MemorySecrets();
    await secrets.set('src/canvas-token', 'S3CRET');
    const ok = adapterFor(canvasSpec(), factory, cfg, secrets);
    expect((await ok.authenticate()).status).toBe('authenticated');
    expect(seen.at(-1)).toMatchObject({ CANVAS_API_TOKEN: 'S3CRET', LITERAL: 'yes' });
    await ok.dispose();
  });
});

describe('EdStem through edstem-mcp (bunizao/edstem-cli)', () => {
  it('maps courses, threads, announcements, answers and nested comments with authorities', async () => {
    const calls: { tool: string; args: unknown }[] = [];
    const adapter = adapterFor(
      edSpec(),
      inMemoryFactory(() => createEdServer({ calls })),
    );
    const syncTools = [
      'get_lesson',
      'get_thread',
      'list_courses',
      'list_lessons',
      'list_slide_questions',
      'list_threads',
    ];
    // + two read tools only called on the student's request (get_assignment)
    expect(adapter.mappedTools().sort()).toEqual(
      [...syncTools, 'list_lesson_files', 'list_slide_responses'].sort(),
    );
    expect((await adapter.health()).state).toBe('healthy');
    const { items, pages } = await syncAll(adapter);
    // only read tools; the server's write tools are never touched
    expect([...new Set(calls.map((c) => c.tool))].sort()).toEqual(syncTools);
    expect(calls.find((c) => c.tool === 'list_courses')?.args).toEqual({ includeArchived: false });
    expect(calls.find((c) => c.tool === 'list_threads')?.args).toEqual({
      courseId: 55,
      limit: 50,
      sort: 'new',
    });
    // numbers stay numbers through the template (the server's threadId is z.number())
    expect(calls.filter((c) => c.tool === 'get_thread').map((c) => c.args)).toEqual([
      { threadId: 1001 },
      { threadId: 1002 },
      { threadId: 1003 },
    ]);
    expect(pages.flatMap((p) => p.warnings ?? [])).toEqual([]);
    const types = items.map((i) => `${i.sourceType}:${i.externalId}`).sort();
    expect(types).toEqual([
      'edstem.course:55',
      'edstem.lesson:2001',
      'edstem.lesson:2002',
      'edstem.lesson:2003',
      'edstem.lesson:2004',
      // every lesson's text (the first sync reads all of them)
      'edstem.lesson_detail:2001',
      'edstem.lesson_detail:2002',
      'edstem.lesson_detail:2003',
      'edstem.lesson_detail:2004',
      // the questions of every quiz slide
      'edstem.slide_question:404981',
      'edstem.slide_question:423710',
      'edstem.slide_question:5001',
      'edstem.slide_question:5002',
      'edstem.thread:1001',
      'edstem.thread:1002',
      'edstem.thread:1003',
      'edstem.thread:1004',
      // announcements always, other threads only when active in the last 30 days
      'edstem.thread_detail:1001',
      'edstem.thread_detail:1002',
      'edstem.thread_detail:1003',
    ]);
    // archived courses / threads beyond the page are kept, never retired
    expect(pages.at(-1)?.complete).toBeUndefined();

    const { entities, outputs } = await normalizeAll(edSpec(), items);
    expect(outputs.flatMap(({ out }) => out.warnings ?? [])).toEqual([]);

    const course = entities.find((e) => e.kind === 'courseOffering');
    expect(course).toMatchObject({
      title: 'Intro to CS',
      courseCode: 'CS101',
      academicYear: 2026,
      term: 'Fall',
      url: 'https://edstem.org/au/courses/55',
    });

    const announcements = entities.filter((e) => e.kind === 'announcement');
    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toMatchObject({
      title: 'Midterm room',
      body: 'The midterm will be in Room 11.',
      authorName: 'Prof Smith',
      importance: 'high',
      scope: 'course',
      category: 'Announcements',
      url: 'https://edstem.org/au/courses/55/discussion/1001',
      courseOfferingId: course?.id,
    });
    const threads = entities.filter((e) => e.kind === 'thread') as unknown as {
      id: string;
      title: string;
    }[];
    expect(threads.map((t) => t.title).sort()).toEqual([
      'How do I submit lab 1?',
      'Old thread',
      'Study group',
    ]);
    const messages = entities.filter((e) => e.kind === 'message') as unknown as {
      authorName?: string;
      authorRole: string;
      isQuestion?: boolean;
      body: string;
      threadId?: string;
    }[];
    // 2 opening posts + answer + reply to the answer + comment + comment on the announcement
    expect(messages).toHaveLength(6);
    const byBody = Object.fromEntries(messages.map((m) => [m.body, m]));
    expect(byBody['Where do I submit lab 1?']).toMatchObject({
      authorName: 'Student A',
      authorRole: 'student',
      isQuestion: true,
    });
    expect(byBody['Upload it on Canvas before Friday.']).toMatchObject({
      authorName: 'TA Jones',
      authorRole: 'ta',
      isQuestion: false,
    });
    expect(byBody['Thanks!']).toMatchObject({ authorName: 'Student A', authorRole: 'student' });
    expect(byBody['Same question here.']?.authorName).toBe('Student B');
    expect(byBody['Anyone up for a study group?']?.isQuestion).toBe(false);
    const lab = threads.find((t) => t.title === 'How do I submit lab 1?');
    expect(byBody['Thanks!']?.threadId).toBe(lab?.id);
    // a comment under an announcement has no thread entity to point at
    expect(byBody['Is it open book?']).toMatchObject({ authorName: 'Student A' });
    expect(byBody['Is it open book?']?.threadId).toBeUndefined();

    const authorities = (id: string): Record<string, string | undefined> =>
      Object.fromEntries(
        (
          outputs.find(
            (o) => o.item.sourceType === 'edstem.thread_detail' && o.item.externalId === id,
          )?.out.entities ?? []
        ).map((e) => [(e.entity as { body?: string }).body ?? e.entity.kind, e.ref?.authority]),
      );
    expect(authorities('1001')).toEqual({
      'The midterm will be in Room 11.': 'instructor-announcement',
      'Is it open book?': 'discussion',
    });
    expect(authorities('1002')).toEqual({
      'Where do I submit lab 1?': 'discussion',
      'Upload it on Canvas before Friday.': 'instructor-announcement',
      'Thanks!': 'discussion',
      'Same question here.': 'discussion',
    });
    await adapter.dispose();
  });

  it('maps lessons to assignments with Ed or lesson-text due dates and progress', async () => {
    const adapter = adapterFor(
      edSpec(),
      inMemoryFactory(() => createEdServer()),
    );
    const { items } = await syncAll(adapter);
    await adapter.dispose();
    const { entities, outputs } = await normalizeAll(edSpec(), items);
    expect(outputs.flatMap(({ out }) => out.warnings ?? [])).toEqual([]);
    const assignments = entities.filter((e) => e.kind === 'assignment') as unknown as {
      id: string;
      title: string;
      dueAt?: string;
      availableFrom?: string;
      url: string;
      courseOfferingId: string;
    }[];
    // lecture material is not an assignment; 期限不明 work is kept
    expect(assignments.map((a) => a.title).sort()).toEqual([
      'Quiz 2',
      '当日課題 (小レポート1)',
      '課題 (小レポート2)',
    ]);
    const course = entities.find((e) => e.kind === 'courseOffering');
    const quiz = assignments.find((a) => a.title === 'Quiz 2');
    // Ed's dueAt is an absolute timestamp (AU offset), kept as the same instant
    expect(new Date(quiz?.dueAt ?? '').toISOString()).toBe('2026-10-14T12:59:00.000Z');
    expect(new Date(quiz?.availableFrom ?? '').toISOString()).toBe('2026-10-06T22:00:00.000Z');
    const report = assignments.find((a) => a.title === '当日課題 (小レポート1)');
    expect(report).toMatchObject({
      url: 'https://edstem.org/au/courses/55/lessons/2002',
      courseOfferingId: course?.id,
    });
    expect(report?.dueAt).toBeUndefined();

    // 「提出期限: 10月6日 17:00PM」 → 17:00 JST, an extracted fact with the sentence as evidence
    const facts = outputs.flatMap(({ out }) => out.facts ?? []);
    const due = facts.filter((f) => f.predicate === 'assignment_due');
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      subject: report?.id,
      value: '2026-10-06T08:00:00.000Z', // 17:00 JST
      origin: 'extracted',
      evidence: '提出期限: 10月6日 17:00PM',
      ref: { authority: 'submission-system' },
    });

    // progress → submission state, Ed as the submission system
    const subs = outputs.flatMap(({ out }) =>
      out.entities.filter((e) => e.entity.kind === 'submission'),
    );
    expect(
      subs.map((e) => [(e.entity as { status: string }).status, e.ref?.authority]).sort(),
    ).toEqual([
      ['not_submitted', 'submission-system'],
      ['not_submitted', 'submission-system'],
      ['submitted', 'submission-system'],
    ]);
  });

  it('makes every lesson, quiz question and slide file a searchable document of the course', async () => {
    const adapter = adapterFor(
      edSpec(),
      inMemoryFactory(() => createEdServer()),
    );
    const { items } = await syncAll(adapter);
    await adapter.dispose();
    const { entities, outputs } = await normalizeAll(edSpec(), items);
    expect(outputs.flatMap(({ out }) => out.warnings ?? [])).toEqual([]);
    const course = entities.find((e) => e.kind === 'courseOffering');
    const docs = entities.filter((e) => e.kind === 'document') as unknown as {
      title: string;
      text?: string;
      url?: string;
      path?: string;
      mimeType?: string;
      courseOfferingId?: string;
      extra?: Record<string, unknown>;
    }[];
    const byTitle = Object.fromEntries(docs.map((d) => [d.title, d]));
    // 質問1 / 質問2 in Ed's order (index 1, 2 here; the listing came back out of order)
    expect(byTitle['当日課題 (小レポート1) 質問1']).toMatchObject({
      text: '画像形式のファイルを貼り付けて提出すること\nビデオレンタル店のデータベースの概念モデルを設計し、ER図を提出しなさい。',
      url: 'https://edstem.org/au/courses/55/lessons/2002/slides/821141',
      path: '/Ed Lessons/第1回: ガイダンス・導入 (10／1)/当日課題 (小レポート1)/質問1',
      courseOfferingId: course?.id,
      extra: { edKind: 'question', lessonId: 2002, slideId: 821141, questionNumber: 1 },
    });
    expect(byTitle['当日課題 (小レポート1) 質問2']?.text).toBe(
      '授業の感想をDiscussionのスレッドに投稿し、そのスレッド番号を記載してください',
    );
    // several quiz slides: the slide title tells them apart; 0-based index still numbers from 1;
    // choices are listed, the answer key (solution / explanation) never
    expect(byTitle['Quiz 2 前半 質問1']?.text).toBe(
      '主キーの性質はどれか\n選択肢:\n1. 一意である\n2. NULL を許す',
    );
    expect(byTitle['Quiz 2 後半 質問1']?.text).toBe('第2正規形を説明せよ');
    expect(JSON.stringify(docs)).not.toContain('SECRET-ANSWER-KEY');
    // the lesson text, slide by slide
    expect(byTitle['当日の講義資料']).toMatchObject({
      text: '[講義資料]\n(ファイル: https://static.edusercontent.com/files/AAAA)\n\n[まとめ]\n正規化は第3回で扱う',
      url: 'https://edstem.org/au/courses/55/lessons/2001',
      extra: { edKind: 'lesson', lessonId: 2001 },
    });
    expect(byTitle['当日課題 (小レポート1)']?.text).toBe(
      '[課題 (小レポート1)]\n提出期限: 10月6日 17:00PM\n(クイズ: 設問は「当日課題 (小レポート1) 質問…」)',
    );
    // an Ed-hosted slide file, with its link
    expect(byTitle['講義資料.pdf']).toMatchObject({
      url: 'https://static.edusercontent.com/files/AAAA',
      mimeType: 'application/pdf',
      courseOfferingId: course?.id,
    });
    const refs = outputs
      .filter((o) => o.item.sourceType === 'edstem.slide_question')
      .flatMap((o) => o.out.entities.map((e) => e.ref));
    expect(refs[0]).toMatchObject({ authority: 'lms' });
  });

  it('maps files written into lesson text as attachment documents, and labels lessons "Ed Lessons"', async () => {
    const adapter = adapterFor(
      edSpec(),
      inMemoryFactory(() => createEdServer()),
    );
    const { items } = await syncAll(adapter);
    await adapter.dispose();
    const { entities, outputs } = await normalizeAll(edSpec(), items);
    expect(outputs.flatMap(({ out }) => out.warnings ?? [])).toEqual([]);
    const course = entities.find((e) => e.kind === 'courseOffering');
    const docs = entities.filter((e) => e.kind === 'document') as unknown as {
      title: string;
      url?: string;
      path?: string;
      mimeType?: string;
      courseOfferingId?: string;
      extra?: Record<string, unknown>;
    }[];
    const attachment = docs.find((d) => d.title === 'ER図の例.png');
    expect(attachment).toMatchObject({
      url: 'https://static.edusercontent.com/files/DDDD',
      mimeType: 'image/png',
      path: '/Ed Lessons/課題 (小レポート2)/ER図の例.png',
      courseOfferingId: course?.id,
      extra: { edKind: 'attachment', lessonId: 2004, slideId: 9 },
    });
    // every lesson / question / lesson-file ref says "Ed Lessons"; threads keep the source label
    const lessonRefs = outputs
      .filter((o) =>
        ['edstem.lesson', 'edstem.lesson_detail', 'edstem.slide_question'].includes(
          o.item.sourceType,
        ),
      )
      .flatMap((o) => [...o.out.entities.map((e) => e.ref), ...(o.out.facts ?? []).map((f) => f.ref)]);
    expect(lessonRefs.length).toBeGreaterThan(8);
    expect(new Set(lessonRefs.map((r) => r?.sourceLabel))).toEqual(new Set(['Ed Lessons']));
    const threadRefs = outputs
      .filter((o) => o.item.sourceType === 'edstem.thread_detail')
      .flatMap((o) => o.out.entities.map((e) => e.ref));
    expect(threadRefs.every((r) => r?.sourceLabel === undefined)).toBe(true);
  });

  it('maps files written into thread posts and replies (once each)', async () => {
    const adapter = adapterFor(
      edSpec(),
      inMemoryFactory(() => createEdServer()),
    );
    const thread = {
      id: 1002,
      number: 2,
      courseId: 55,
      title: 'How do I submit lab 1?',
      type: 'question',
      userId: 9,
      document:
        '<document><paragraph>See the sheet</paragraph><file url="https://static.edusercontent.com/files/EEEE?a=1&amp;b=2" filename="lab1-spec.pdf"/></document>',
      users: {},
      answers: [
        {
          id: 1,
          userId: 8,
          document:
            '<document><file url="https://static.edusercontent.com/files/FFFF" filename="answer.png"/></document>',
          comments: [
            {
              id: 2,
              userId: 9,
              document:
                '<document><file url="https://static.edusercontent.com/files/FFFF" filename="answer.png"/></document>',
            },
          ],
        },
      ],
    };
    const { entities } = await normalizeAll(edSpec(), [
      { sourceType: 'edstem.thread_detail', externalId: '1002', payload: thread },
    ]);
    const docs = entities.filter((e) => e.kind === 'document') as unknown as {
      title: string;
      url: string;
      path: string;
      mimeType: string;
    }[];
    expect(docs.map((d) => d.title).sort()).toEqual(['answer.png', 'lab1-spec.pdf']);
    expect(docs.find((d) => d.title === 'lab1-spec.pdf')).toMatchObject({
      url: 'https://static.edusercontent.com/files/EEEE?a=1&b=2',
      mimeType: 'application/pdf',
      path: '/Ed Discussion/#2 How do I submit lab 1?/lab1-spec.pdf',
    });
    await adapter.dispose();
  });

  it('reads unchanged lessons at most once a day and the full lesson on request, read-only', async () => {
    const calls: { tool: string; args: unknown }[] = [];
    let now = Date.parse('2026-10-06T00:00:00Z');
    const adapter = new McpSourceAdapter({
      sourceId: 'src',
      spec: edSpec(),
      config: McpConfigSchema.parse({ command: 'fake-mcp-server' }),
      secrets: new MemorySecrets(),
      transportFactory: inMemoryFactory(() => createEdServer({ calls })),
      runOptions: { now: () => now },
    });
    await syncAll(adapter);
    const first = calls.length;
    now += 30 * 60_000;
    const { items } = await syncAll(adapter);
    const again = calls.slice(first);
    // 30 minutes later: only the unfinished assignment lessons are read again; quiz questions wait
    expect(again.filter((c) => c.tool === 'get_lesson').map((c) => c.args)).toEqual([
      { lessonId: 2002 },
      { lessonId: 2004 },
    ]);
    expect(again.some((c) => c.tool === 'list_slide_questions')).toBe(false);
    // stored items of skipped calls are not retired
    expect(items.some((i) => i.sourceType === 'edstem.lesson_detail')).toBe(true);
    expect((await syncAll(adapter)).pages.at(-1)?.complete).toBeUndefined();
    now += 24 * 3_600_000;
    const before = calls.length;
    await syncAll(adapter);
    expect(calls.slice(before).filter((c) => c.tool === 'get_lesson')).toHaveLength(4);

    // on request: one lesson in full, with the student's saved answers and its files
    expect(typeof adapter.fetchDetails).toBe('function');
    const lesson = ED_LESSONS[1];
    const start = calls.length;
    const res = await adapter.fetchDetails!([
      { externalId: '2002', sourceType: 'edstem.lesson', previousPayload: lesson },
    ]);
    expect(res.results).toEqual([{ externalId: '2002', status: 'fetched' }]);
    expect(res.warnings).toEqual([]);
    expect(calls.slice(start).map((c) => c.tool)).toEqual([
      'get_lesson',
      'list_slide_questions',
      'list_slide_responses',
      'list_lesson_files',
    ]);
    expect(res.items.map((i) => `${i.sourceType}:${i.externalId}`).sort()).toEqual([
      'edstem.lesson_detail:2002',
      'edstem.slide_question:404981',
      'edstem.slide_question:423710',
      'edstem.slide_response:404981',
    ]);
    const response = res.items.find((i) => i.sourceType === 'edstem.slide_response');
    expect(response?.payload).toMatchObject({
      questionId: 404981,
      _parent: { lessonId: 2002, slideId: 821141, lessonTitle: '当日課題 (小レポート1)' },
    });
    // a request never moves the sync cursor or completes a listing, and refuses unknown types
    const other = await adapter.fetchDetails!([
      { externalId: '1001', sourceType: 'edstem.thread', previousPayload: { id: 1001 } },
    ]);
    expect(other.results[0]).toMatchObject({ status: 'failed' });
    // no write tool was ever called
    expect(
      calls.filter((c) => /^(create|reply|submit|mark)_/.test(c.tool)).map((c) => c.tool),
    ).toEqual([]);
    await adapter.dispose();
  });

  it('maps Ed sessions onto the profile terms and links into the account region', async () => {
    const profile = parseProfile(`
id: sample
academicCalendar:
  timezone: Asia/Tokyo
  terms:
    - { id: '2026-1', name: '2026年度 前期', termCode: 前期, year: 2026, start: '2026-04-01', end: '2026-09-30' }
    - { id: '2026-2', name: '2026年度 後期', termCode: 後期, year: 2026, start: '2026-10-01', end: '2027-03-31' }
`);
    const course = async (
      payload: Record<string, unknown>,
      spec: MappingSpec = edSpec(),
    ): Promise<Record<string, unknown> | undefined> => {
      const out = await createMappedNormalizer(spec).normalize(
        {
          id: 'raw:c',
          sourceId: 'src',
          sourceType: 'edstem.course',
          externalId: String(payload.id),
          payload,
          fetchedAt: '2026-10-05T00:00:00.000Z',
          sourceUpdatedAt: undefined,
          contentHash: 'h',
        },
        createNormalizeContext({ sourceId: 'src', sourceSystem: 'edstem', profile }),
      );
      expect(out.warnings).toEqual([]);
      return out.entities[0]?.entity as Record<string, unknown> | undefined;
    };
    // the live payloads of a Shizuoka student's two Ed courses (AU region)
    expect(
      await course({
        id: 41566,
        code: 'db2026',
        name: 'データベースシステム論',
        year: '2026',
        session: 'Semester 2',
        status: 'active',
        role: 'student',
      }),
    ).toMatchObject({
      academicYear: 2026,
      term: '後期',
      courseCode: 'db2026',
      url: 'https://edstem.org/au/courses/41566',
      extra: { session: 'Semester 2' },
    });
    // "X" is a placeholder, not a term: no term rather than a wrong one
    const past = await course({
      id: 28169,
      code: 'db2025',
      name: 'データベースシステム論',
      year: '2025',
      session: 'X',
    });
    expect(past).toMatchObject({ academicYear: 2025, extra: { session: 'X' } });
    expect(past?.term).toBeUndefined();
    // a year the calendar does not cover still maps through the term layout
    expect((await course({ id: 1, code: 'c', name: 'n', year: '2025', session: 'S1' }))?.term).toBe(
      '前期',
    );

    // a US account: mappingVars from the source config
    const us = await mcpDefault({
      sourceId: 'src',
      config: { mapping: 'edstem-mcp', mappingVars: { region: 'us' } },
    });
    const usSpec = (us.createNormalizer({} as never) as unknown as { spec: MappingSpec }).spec;
    expect(usSpec.vars).toEqual({ region: 'us' });
    expect((await course({ id: 7, name: 'x', year: '2026', session: 'Fall' }, usSpec))?.url).toBe(
      'https://edstem.org/us/courses/7',
    );
    await expect(
      mcpDefault({
        sourceId: 'src',
        config: { mapping: 'edstem-mcp', mappingVars: { regoin: 'us' } },
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('turns the server\'s "re-authenticate" error into auth_required', async () => {
    const adapter = adapterFor(
      edSpec(),
      inMemoryFactory(() => createEdServer({ authFailing: true })),
    );
    await expect(adapter.sync({ mode: 'initial' })).rejects.toBeInstanceOf(AuthRequiredError);
    await adapter.dispose();
    expect(() =>
      parseToolResult({
        content: [{ type: 'text', text: '{"error":{"message":"401 Unauthorized"}}' }],
        isError: true,
      }),
    ).toThrow(AuthRequiredError);
    expect(() =>
      parseToolResult({ content: [{ type: 'text', text: 'rate limited' }], isError: true }),
    ).toThrow(ConnectorError);
  });
});

describe('connector module', () => {
  it('default export / metadata describe a generic experimental MCP connector', async () => {
    expect(typeof mcpDefault).toBe('function');
    await expect(mcpDefault({ sourceId: 's', config: {} })).resolves.toBe(mcpConnector);
    const fromMapping = await mcpDefault({ sourceId: 's', config: { mapping: 'canvas-mcp' } });
    expect(fromMapping.metadata.product).not.toBe(mcpConnector.metadata.product);
    expect(mcpMetadata).toMatchObject({
      adapter: 'mcp',
      apiStability: 'experimental',
      risk: 'experimental',
      product: 'mcp',
    });
    const mod = createMcpConnector(canvasSpec());
    expect(mod.metadata).toMatchObject({
      product: 'canvas',
      defaultAuthority: 'lms',
      adapter: 'mcp',
      apiStability: 'experimental',
    });
    expect(mod.metadata.rawTypes).toContain('canvas.submission');
  });

  it('instantiates from config with a shipped mapping name, inline mapping, or fails clearly', async () => {
    const secrets = new MemorySecrets();
    const named = instantiateConnector(
      createMcpConnector(undefined, {
        transportFactory: inMemoryFactory(() => createCanvasServer()),
      }),
      {
        sourceId: 'canvas',
        config: { adapter: 'mcp', command: 'canvas-mcp', mapping: 'canvas-mcp' },
        secrets,
      },
    );
    expect(named.normalizer.id).toBe('mapped:canvas');
    const res = await named.adapter.sync({ mode: 'initial' });
    expect(res.items.length).toBeGreaterThan(0);
    await named.adapter.dispose();

    const inline = instantiateConnector(
      createMcpConnector(undefined, {
        transportFactory: inMemoryFactory(() => createCanvasServer()),
      }),
      {
        sourceId: 'inline',
        config: {
          command: 'x',
          mapping: {
            id: 'mini',
            product: 'mini',
            capabilities: ['courses'],
            resources: [
              {
                name: 'c',
                call: { tool: 'list_courses' },
                sourceType: 'mini.course',
                externalId: '$string(id)',
              },
            ],
            entities: { 'mini.course': [{ kind: 'courseOffering', fields: { title: 'name' } }] },
          },
        },
        secrets,
      },
    );
    expect((await inline.adapter.sync({ mode: 'initial' })).items).toHaveLength(2);
    await inline.adapter.dispose();

    expect(() =>
      instantiateConnector(mcpConnector, { sourceId: 'x', config: { command: 'x' }, secrets }),
    ).toThrow(ConfigError);
    expect(() =>
      instantiateConnector(mcpConnector, { sourceId: 'x', config: {}, secrets }),
    ).toThrow(/exactly one/);
  });

  it('maps a 401 from an HTTP server to auth_required (default transport, mocked fetch)', async () => {
    const mod = createMcpConnector(canvasSpec());
    const inst = instantiateConnector(mod, {
      sourceId: 'http',
      config: {
        url: 'https://mcp.example/mcp',
        headerSecrets: [{ name: 'Authorization', secret: 'tok', prefix: 'Bearer ' }],
      },
      secrets: await (async () => {
        const s = new MemorySecrets();
        await s.set('http/tok', 'abc');
        return s;
      })(),
      fetch: (_url, init) => {
        const auth = new Headers(init?.headers).get('authorization');
        return Promise.resolve(
          new Response(JSON.stringify({ error: auth === 'Bearer abc' ? 'bad token' : 'no auth' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    });
    const res = await inst.adapter.authenticate();
    expect(res.status).toBe('auth_required');
    expect(JSON.stringify(res)).not.toContain('abc');
    await inst.adapter.dispose();
  });
});

describe('stdio transport (real child process)', () => {
  const script = join(here, 'fixtures', 'stdio-server.mjs');
  const spec = parseMappingSpec({
    id: 'stdio',
    product: 'stdio',
    capabilities: ['courses'],
    resources: [
      { name: 'env', call: { tool: 'echo_env' }, sourceType: 'stdio.env', externalId: 'id' },
    ],
  });

  it('spawns the command without a shell, injects envSecrets and a minimal environment', async () => {
    process.env.UC_HOST_ONLY = 'must-not-leak';
    const secrets = new MemorySecrets();
    await secrets.set('s/token-name', 'injected-secret');
    const adapter = new McpSourceAdapter({
      sourceId: 's',
      spec,
      config: McpConfigSchema.parse({
        command: process.execPath,
        args: [script],
        cwd: here,
        env: { UC_TEST_LITERAL: 'literal' },
        envSecrets: [{ name: 'UC_TEST_SECRET', secret: 'token-name' }],
        timeoutMs: 20000,
      }),
      secrets,
    });
    try {
      expect((await adapter.health()).state).toBe('healthy');
      const { items } = await syncAll(adapter);
      expect(items).toHaveLength(1);
      expect(items[0]?.payload).toMatchObject({
        injected: 'injected-secret',
        literal: 'literal',
        hostOnly: null,
      });
      expect((items[0]?.payload as { cwd: string }).cwd.toLowerCase()).toBe(here.toLowerCase());
    } finally {
      delete process.env.UC_HOST_ONLY;
      await adapter.dispose();
    }
  }, 30000);

  it('reports offline when the command does not exist', async () => {
    const adapter = new McpSourceAdapter({
      sourceId: 's',
      spec,
      config: McpConfigSchema.parse({
        command: 'definitely-not-a-real-binary-xyz',
        timeoutMs: 5000,
      }),
      secrets: new MemorySecrets(),
    });
    const h = await adapter.health();
    expect(h.state).toBe('offline');
    await adapter.dispose();
  }, 15000);
});

// Compliance suites (§66): the adapter + mapped normalizer against fake servers.
const canvasMeta = createMcpConnector(canvasSpec()).metadata;
testConnectorCompliance('adapter-mcp (canvas-mcp mapping)', {
  metadata: canvasMeta,
  normalizer: createMappedNormalizer(canvasSpec()),
  createAdapter: () =>
    adapterFor(
      canvasSpec(),
      inMemoryFactory(() => createCanvasServer()),
    ),
  rawFixtures: [],
});
const edMeta = createMcpConnector(edSpec()).metadata;
testConnectorCompliance('adapter-mcp (edstem-mcp mapping)', {
  metadata: edMeta,
  normalizer: createMappedNormalizer(edSpec()),
  createAdapter: () =>
    adapterFor(
      edSpec(),
      inMemoryFactory(() => createEdServer()),
    ),
  rawFixtures: [],
});

it('fixture sanity: canvas announcement fixture is HTML', () => {
  expect(JSON.stringify(CANVAS_ANNOUNCEMENTS[101])).toContain('<p>');
});
