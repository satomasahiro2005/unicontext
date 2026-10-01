import type { RawItem, SyncResult } from '@unicontext/connector-sdk';
import { testConnectorCompliance } from '@unicontext/connector-sdk/testing';
import { AuthRequiredError, ConnectorError } from '@unicontext/core';
import { describe, expect, it } from 'vitest';
import {
  createMappedAdapter,
  createMappedNormalizer,
  mappingMetadata,
  parseMappingSpec,
  runMappedResources,
  type ResourceCaller,
} from '../src/index.js';
import { ANNOUNCEMENTS, ASSIGNMENTS, canvasCaller, canvasYaml, COURSES } from './helpers.js';

const spec = parseMappingSpec(canvasYaml());

/** Follow nextPageToken like the sync engine does. */
async function runAll(
  caller: ResourceCaller,
  options: Parameters<typeof runMappedResources>[3] = {},
  input: Parameters<typeof runMappedResources>[2] = { mode: 'initial' },
  mapping = spec,
): Promise<{ items: RawItem[]; pages: SyncResult[] }> {
  const pages: SyncResult[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 100; i++) {
    const res = await runMappedResources(
      mapping,
      caller,
      { ...input, ...(pageToken ? { pageToken } : {}) },
      options,
    );
    pages.push(res);
    if (!res.hasMore) break;
    pageToken = res.nextPageToken;
  }
  return { items: pages.flatMap((p) => p.items), pages };
}

const count = (items: RawItem[], type: string): number =>
  items.filter((i) => i.sourceType === type).length;

describe('runMappedResources', () => {
  it('runs resources with fan-out and templating, preserving template types', async () => {
    const caller = canvasCaller();
    const { items, pages } = await runAll(caller);
    expect(pages).toHaveLength(1);
    expect(count(items, 'canvas.course')).toBe(2);
    expect(count(items, 'canvas.assignment')).toBe(3);
    expect(count(items, 'canvas.announcement')).toBe(1);
    const assignCalls = caller.requests.filter((r) => r.call.tool === 'list_assignments');
    expect(assignCalls.map((r) => (r.call.args as Record<string, unknown>).course_id)).toEqual([
      101, 102,
    ]);
    expect(caller.requests.find((r) => r.call.tool === 'list_courses')?.call).toEqual({
      tool: 'list_courses',
      args: { enrollment_state: 'active' },
    });
  });

  it('produces externalId, sourceUpdatedAt, _parent and a cursor', async () => {
    const { items, pages } = await runAll(canvasCaller());
    const course = items.find((i) => i.externalId === '101');
    expect(course?.sourceType).toBe('canvas.course');
    expect(course?.sourceUpdatedAt).toBe('2026-09-30T10:00:00Z');
    const assignment = items.find((i) => i.externalId === '5002');
    expect((assignment?.payload as Record<string, unknown>)._parent).toEqual({ courseId: 102 });
    expect(items.find((i) => i.externalId === '9001')?.sourceUpdatedAt).toBeUndefined();
    expect(pages[0]?.cursor).toEqual({ lastModified: '2026-09-30T12:00:00Z' });
  });

  it('strips credential-like keys from payloads and warns', async () => {
    const { items, pages } = await runAll(canvasCaller());
    const course = items.find((i) => i.externalId === '101');
    expect(JSON.stringify(course?.payload)).not.toContain('STRIPPED');
    expect(course?.payload).not.toHaveProperty('access_token');
    expect(pages[0]?.warnings?.some((w) => /credential-like keys/.test(w))).toBe(true);
  });

  it('marks resources complete only for full listings that finished', async () => {
    const { pages } = await runAll(canvasCaller());
    expect(pages[0]?.complete?.sourceTypes.sort()).toEqual(['canvas.assignment', 'canvas.course']);
  });

  it('honours the capability filter', async () => {
    const caller = canvasCaller();
    const { items, pages } = await runAll(
      caller,
      {},
      { mode: 'initial', capabilities: ['courses'] },
    );
    expect(count(items, 'canvas.assignment')).toBe(0);
    expect(count(items, 'canvas.announcement')).toBe(0);
    expect(pages[0]?.complete?.sourceTypes).toEqual(['canvas.course']);
    expect(caller.requests.map((r) => r.call.tool)).toEqual(['list_courses']);
  });

  it('follows pagination hooks (response.next) and exposes the rendered next call', async () => {
    const caller = canvasCaller({
      list_courses: (req) => {
        const page = Number((req.call.args as Record<string, unknown>).page ?? 1);
        return {
          data: [COURSES[page - 1]],
          ...(page < 2 ? { next: { tool: 'list_courses', args: { page: page + 1 } } } : {}),
        };
      },
    });
    const { items } = await runAll(caller);
    expect(count(items, 'canvas.course')).toBe(2);
    expect(caller.requests.filter((r) => r.call.tool === 'list_courses')).toHaveLength(2);
  });

  it('spreads calls over pages with a JSON page token and gives the same result', async () => {
    const unpaged = await runAll(canvasCaller());
    const caller = canvasCaller();
    const { items, pages } = await runAll(caller, { maxCallsPerPage: 2, parentCache: new Map() });
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages.slice(0, -1)) {
      expect(p.hasMore).toBe(true);
      expect(() => JSON.parse(p.nextPageToken ?? '')).not.toThrow();
    }
    expect(pages.at(-1)?.hasMore).toBe(false);
    expect(pages.at(-1)?.complete?.sourceTypes.sort()).toEqual([
      'canvas.assignment',
      'canvas.course',
    ]);
    const key = (i: RawItem): string => `${i.sourceType}/${i.externalId}`;
    expect(items.map(key).sort()).toEqual(unpaged.items.map(key).sort());
    expect(caller.requests).toHaveLength(4);
  });

  it('resumes after a restart (no parent cache) by fetching parents again', async () => {
    const caller = canvasCaller();
    const first = await runMappedResources(
      spec,
      caller,
      { mode: 'initial' },
      { maxCallsPerPage: 2 },
    );
    expect(first.hasMore).toBe(true);
    // new process: empty cache
    const rest: RawItem[] = [];
    let token = first.nextPageToken;
    for (let i = 0; i < 10 && token; i++) {
      const last = await runMappedResources(
        spec,
        caller,
        { mode: 'initial', pageToken: token },
        { maxCallsPerPage: 2, parentCache: new Map() },
      );
      rest.push(...last.items);
      token = last.hasMore ? last.nextPageToken : undefined;
    }
    const all = [...first.items, ...rest];
    expect(count(all, 'canvas.course')).toBe(2);
    expect(count(all, 'canvas.assignment')).toBe(3);
    expect(count(all, 'canvas.announcement')).toBe(1);
  });

  it('degrades a failing fan-out child to a warning and withholds "complete"', async () => {
    const caller = canvasCaller({
      list_assignments: (req) => {
        if ((req.call.args as Record<string, unknown>).course_id === 101)
          throw new ConnectorError('boom');
        return { data: ASSIGNMENTS[102] ?? [] };
      },
    });
    const { items, pages } = await runAll(caller);
    expect(count(items, 'canvas.assignment')).toBe(2);
    expect(pages[0]?.warnings?.some((w) => /assignments \[0\]: boom/.test(w))).toBe(true);
    expect(pages[0]?.complete?.sourceTypes).toEqual(['canvas.course']);
  });

  it('propagates auth / failures of required resources and honours `optional`', async () => {
    await expect(
      runAll(
        canvasCaller({
          list_courses: () => {
            throw new ConnectorError('down');
          },
        }),
      ),
    ).rejects.toThrow(/down/);
    await expect(
      runAll(
        canvasCaller({
          list_assignments: () => {
            throw new AuthRequiredError('login');
          },
        }),
      ),
    ).rejects.toBeInstanceOf(AuthRequiredError);

    const optional = parseMappingSpec(
      canvasYaml().replace(
        'capability: announcements',
        'capability: announcements\n    optional: true',
      ),
    );
    const { items, pages } = await runAll(
      canvasCaller({
        list_announcements: () => {
          throw new ConnectorError('nope');
        },
      }),
      {},
      { mode: 'initial' },
      optional,
    );
    expect(count(items, 'canvas.announcement')).toBe(0);
    expect(pages[0]?.warnings?.some((w) => /announcements: nope/.test(w))).toBe(true);
  });

  it('does not mark fan-out children complete when their parent list is incomplete', async () => {
    const optionalCourses = parseMappingSpec(
      canvasYaml().replace(
        /(updatedAt: updated_at\r?\n {4}complete: true)(\r?\n {2}- name: assignments)/,
        '$1\n    optional: true$2',
      ),
    );
    const failed = await runAll(
      canvasCaller({
        list_courses: () => {
          throw new ConnectorError('down');
        },
      }),
      {},
      { mode: 'initial' },
      optionalCourses,
    );
    expect(optionalCourses.resources[0]?.optional).toBe(true);
    expect(count(failed.items, 'canvas.assignment')).toBe(0);
    expect(failed.pages.at(-1)?.complete?.sourceTypes ?? []).not.toContain('canvas.assignment');

    // Parent pagination cut by maxPagesPerCall: children of the unseen parents were not listed.
    const cut = await runAll(
      canvasCaller({
        list_courses: (req) => ({ data: COURSES.slice(0, 1), next: { ...req.call } }),
      }),
      { maxPagesPerCall: 1 },
    );
    expect(cut.pages.at(-1)?.complete?.sourceTypes ?? []).not.toContain('canvas.assignment');
  });

  it('skips items without an externalId, dedupes and validates the page token', async () => {
    const caller = canvasCaller({
      list_courses: () => ({ data: [COURSES[0], COURSES[0], { name: 'no id' }] }),
      list_assignments: () => ({ data: [] }),
    });
    const { items, pages } = await runAll(caller);
    expect(count(items, 'canvas.course')).toBe(1);
    expect(pages[0]?.warnings?.some((w) => /without externalId/.test(w))).toBe(true);
    await expect(
      runMappedResources(spec, caller, { mode: 'initial', pageToken: 'not-json' }),
    ).rejects.toThrow(/Invalid mapping page token/);
  });

  it('lets grandchildren see the attached parent context (3-level fan-out)', async () => {
    const three = parseMappingSpec({
      ...parseMappingSpec(canvasYaml()),
      resources: [
        ...parseMappingSpec(canvasYaml()).resources.slice(0, 2),
        {
          name: 'submissions',
          forEach: { resource: 'assignments', as: 'assignment' },
          call: {
            tool: 'get_submission',
            args: {
              course_id: '{{assignment._parent.courseId}}',
              assignment_id: '{{assignment.id}}',
            },
          },
          sourceType: 'canvas.submission',
          externalId: '$string(id)',
        },
      ],
      entities: {},
      facts: [],
      drift: undefined,
    });
    const caller = canvasCaller({
      get_submission: (req) => ({
        data: [{ id: ((req.call.args as Record<string, number>).assignment_id ?? 0) * 10 }],
      }),
    });
    const { items } = await runAll(
      caller,
      { maxCallsPerPage: 3, parentCache: new Map() },
      { mode: 'initial' },
      three,
    );
    const subs = caller.requests
      .filter((r) => r.call.tool === 'get_submission')
      .map((r) => r.call.args);
    expect(subs).toEqual([
      { course_id: 101, assignment_id: 5001 },
      { course_id: 102, assignment_id: 5002 },
      { course_id: 102, assignment_id: 5003 },
    ]);
    expect(count(items, 'canvas.submission')).toBe(3);
  });

  it('filters fan-out parents with forEach.where', async () => {
    const filtered = parseMappingSpec(
      canvasYaml().replace(
        'forEach: { resource: courses, as: course }',
        'forEach: { resource: courses, as: course, where: "id = 102" }',
      ),
    );
    const caller = canvasCaller();
    const { items } = await runAll(caller, {}, { mode: 'initial' }, filtered);
    expect(caller.requests.filter((r) => r.call.tool === 'list_assignments')).toHaveLength(1);
    expect(count(items, 'canvas.assignment')).toBe(2);
  });

  it('reports the product version returned by the caller', async () => {
    const caller = canvasCaller({
      list_courses: () => ({ data: [], productVersion: { product: 'canvas', version: '2026.1' } }),
    });
    const { pages } = await runAll(caller, {}, { mode: 'initial', capabilities: ['courses'] });
    expect(pages[0]?.productVersion).toEqual({ product: 'canvas', version: '2026.1' });
  });

  it('fails on unresolved template variables', async () => {
    const bad = parseMappingSpec(canvasYaml().replace('{{course.id}}', '{{course.nope}}'));
    // child failures are warnings; the template error shows up there
    const { pages } = await runAll(canvasCaller(), {}, { mode: 'initial' }, bad);
    expect(pages[0]?.warnings?.some((w) => /did not resolve/.test(w))).toBe(true);
  });
});

describe('createMappedAdapter + compliance', () => {
  const metadata = mappingMetadata(spec, { name: '@unicontext/mapping-test', adapter: 'mcp' });
  const normalizer = createMappedNormalizer(spec);
  testConnectorCompliance('mapping (canvas fixture)', {
    metadata,
    normalizer,
    createAdapter: () =>
      createMappedAdapter({ id: 'mapping:canvas', spec, caller: canvasCaller() }),
    rawFixtures: [],
  });

  it('normalizes a full sync to canonical entities', async () => {
    const adapter = createMappedAdapter({ id: 'mapping:canvas', spec, caller: canvasCaller() });
    expect(await adapter.capabilities()).toEqual(['courses', 'assignments', 'announcements']);
    const res = await adapter.sync({ mode: 'initial' });
    expect(res.items).toHaveLength(6);
    expect(ANNOUNCEMENTS.items).toHaveLength(1);
  });
});
