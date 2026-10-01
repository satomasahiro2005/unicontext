import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanonicalEntitySchema } from '@unicontext/canonical-model';
import {
  AuthRequiredError,
  ConfigError,
  ConnectorError,
  type FetchLike,
  OfflineError,
  PolicyViolationError,
  type SecretStore,
  ValidationError,
} from '@unicontext/core';
import {
  createNormalizeContext,
  instantiateConnector,
  RateLimiter,
  type RawItem,
  type RawItemView,
  type SourceAdapter,
  type SyncResult,
} from '@unicontext/connector-sdk';
import { testConnectorCompliance } from '@unicontext/connector-sdk/testing';
import { createMappedNormalizer, type MappingSpec, parseMappingSpec } from '@unicontext/mapping';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildOperationCatalog,
  buildRequest,
  createRestConnector,
  documentBaseUrl,
  joinUrl,
  parseLinkHeader,
  parseOpenApiText,
  RESTSourceAdapter,
  RestConfigSchema,
  type RestConfigInput,
  restConnector,
  restMetadata,
  suggestMapping,
  suggestMappingYaml,
  synthesizeOperationId,
} from '../src/index.js';
import restDefault from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = join(here, 'fixtures', 'lms-openapi.yaml');
const openapiText = (): string => readFileSync(OPENAPI_PATH, 'utf8');
const mappingText = (): string => readFileSync(join(here, 'fixtures', 'lms-mapping.yaml'), 'utf8');
const spec = (): MappingSpec => parseMappingSpec(mappingText());

const tmp = mkdtempSync(join(tmpdir(), 'uc-rest-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

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

const withToken = async (): Promise<MemorySecrets> => {
  const s = new MemorySecrets();
  await s.set('src/lms-token', 'tok-123');
  return s;
};

interface Recorded {
  url: string;
  headers: Headers;
}

/** A mocked LMS API (no network). Requires `Authorization: Bearer tok-123` when `auth` is set. */
function fakeApi(options: { auth?: boolean; fail?: Record<string, number> } = {}): {
  fetch: FetchLike;
  requests: Recorded[];
} {
  const requests: Recorded[] = [];
  const json = (
    body: unknown,
    init: { status?: number; headers?: Record<string, string> } = {},
  ): Response =>
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  const fetchFn: FetchLike = (input, init) => {
    const url = new URL(input);
    const headers = new Headers(init?.headers);
    requests.push({ url: input, headers });
    if (url.pathname === '/openapi.yaml')
      return Promise.resolve(
        new Response(openapiText(), { headers: { 'content-type': 'application/yaml' } }),
      );
    if (options.auth && headers.get('authorization') !== 'Bearer tok-123')
      return Promise.resolve(json({ error: 'unauthorized' }, { status: 401 }));
    const failStatus = options.fail?.[url.pathname];
    if (failStatus) return Promise.resolve(json({ error: 'x' }, { status: failStatus }));
    const p = url.pathname.replace('/api/v1', '');
    if (p === '/courses') {
      const page = Number(url.searchParams.get('page') ?? '1');
      if (page === 1)
        return Promise.resolve(
          json(
            [
              { id: 101, name: 'データベースシステム論', code: 'DB-101', access_token: 'LEAK' },
              { id: 102, name: 'Algorithms', code: 'CS-210' },
            ],
            {
              headers: {
                link: '<https://lms.example/api/v1/courses?page=2&page_size=2>; rel="next", <https://lms.example/api/v1/courses?page=2&page_size=2>; rel="last"',
              },
            },
          ),
        );
      return Promise.resolve(json([{ id: 103, name: 'Networks', code: 'NW-300' }]));
    }
    const m = /^\/courses\/(\d+)\/assignments$/.exec(p);
    if (m) {
      const cursor = url.searchParams.get('cursor');
      if (m[1] === '101' && !cursor)
        return Promise.resolve(
          json({
            items: [{ id: 5001, title: '課題1', due: '2026-10-08T14:59:00Z' }],
            next_cursor: 'c2',
          }),
        );
      if (m[1] === '101' && cursor === 'c2')
        return Promise.resolve(
          json({
            items: [{ id: 5002, title: '課題2', due: '2026-10-15T14:59:00Z' }],
            next_cursor: null,
          }),
        );
      return Promise.resolve(json({ items: [], next_cursor: null }));
    }
    const a = /^\/courses\/(\d+)\/announcements$/.exec(p);
    if (a) return Promise.resolve(json([{ id: 1, title: 'hello' }]));
    if (p === '/me') return Promise.resolve(json({ id: 'u1', name: 'Me' }));
    return Promise.resolve(json({ error: 'not found' }, { status: 404 }));
  };
  return { fetch: fetchFn, requests };
}

function adapterFor(
  config: Partial<RestConfigInput> = {},
  fetchFn: FetchLike,
  mapping: MappingSpec = spec(),
  secrets: SecretStore = new MemorySecrets(),
): RESTSourceAdapter {
  return new RESTSourceAdapter({
    sourceId: 'src',
    spec: mapping,
    config: RestConfigSchema.parse({ openapi: OPENAPI_PATH, ...config }),
    secrets,
    fetch: fetchFn,
    rateLimiter: new RateLimiter({ maxRetries: 0, capacity: 1000, refillPerSecond: 1000 }),
  });
}

async function syncAll(adapter: SourceAdapter): Promise<{ items: RawItem[]; pages: SyncResult[] }> {
  const pages: SyncResult[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 50; i++) {
    const res = await adapter.sync({ mode: 'initial', ...(pageToken ? { pageToken } : {}) });
    pages.push(res);
    if (!res.hasMore) break;
    pageToken = res.nextPageToken;
  }
  return { items: pages.flatMap((p) => p.items), pages };
}

describe('operation catalog', () => {
  const catalog = buildOperationCatalog(parseOpenApiText(openapiText()));
  const byId = (id: string) => catalog.find((o) => o.operationId === id);

  it('lists every operation with method, path, tags and summary', () => {
    expect(catalog.map((o) => o.operationId)).toEqual([
      'listCourses',
      'deleteCourse',
      'listAssignments',
      'createAssignment',
      'getCoursesByCourseIdAnnouncements', // synthesized
      'getMe',
      'search',
    ]);
    expect(byId('listCourses')).toMatchObject({
      method: 'get',
      path: '/courses',
      summary: 'List my courses',
      tags: ['courses'],
      hasRequestBody: false,
    });
    expect(byId('createAssignment')).toMatchObject({ method: 'post', hasRequestBody: true });
    expect(byId('getCoursesByCourseIdAnnouncements')).toMatchObject({
      method: 'get',
      tags: ['announcements'],
    });
  });

  it('merges path-level parameters and resolves parameter $refs', () => {
    const params = byId('listAssignments')?.parameters ?? [];
    expect(params.map((p) => `${p.in}:${p.name}${p.required ? '*' : ''}`).sort()).toEqual([
      'header:X-Trace',
      'path:courseId*',
      'query:cursor',
    ]);
    const list = byId('listCourses')?.parameters ?? [];
    expect(list.find((p) => p.name === 'page_size')).toMatchObject({
      in: 'query',
      schema: { type: 'integer' },
    });
    expect(byId('search')?.parameters[0]).toMatchObject({ name: 'q', required: true });
  });

  it('resolves $refs in response schemas and cuts cycles', () => {
    const schema = byId('listCourses')?.responseSchema as {
      type: string;
      items: { properties: { id: unknown; parent: unknown } };
    };
    expect(schema.type).toBe('array');
    expect(schema.items.properties.id).toEqual({ type: 'integer' });
    expect(schema.items.properties.parent).toEqual({
      type: 'object',
      'x-circular': '#/components/schemas/Course',
    });
    const page = byId('listAssignments')?.responseSchema as {
      properties: { items: { items: { properties: { due: unknown } } } };
    };
    expect(page.properties.items.items.properties.due).toEqual({
      type: 'string',
      format: 'date-time',
    });
    expect(byId('search')?.responseSchema).toBeUndefined();
  });

  it('reads Swagger 2.0 minimally', () => {
    const doc = {
      swagger: '2.0',
      info: { title: 't', version: '1' },
      host: 'api.example.com',
      basePath: '/v2',
      schemes: ['https'],
      paths: {
        '/things/{id}': {
          get: {
            tags: ['things'],
            parameters: [
              { name: 'id', in: 'path', required: true, type: 'integer' },
              {
                name: 'fields',
                in: 'query',
                type: 'array',
                items: { type: 'string' },
                collectionFormat: 'csv',
              },
            ],
            responses: { '200': { description: 'ok', schema: { $ref: '#/definitions/Thing' } } },
          },
          put: {
            parameters: [{ name: 'body', in: 'body', schema: { $ref: '#/definitions/Thing' } }],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
      definitions: { Thing: { type: 'object', properties: { id: { type: 'integer' } } } },
    };
    const cat = buildOperationCatalog(doc);
    expect(cat.map((o) => `${o.method} ${o.operationId}`)).toEqual([
      'get getThingsById',
      'put putThingsById',
    ]);
    expect(cat[0]?.responseSchema).toEqual({
      type: 'object',
      properties: { id: { type: 'integer' } },
    });
    expect(cat[0]?.parameters.find((p) => p.name === 'fields')).toMatchObject({
      explode: false,
      schema: { type: 'array' },
    });
    expect(cat[1]?.hasRequestBody).toBe(true);
    expect(documentBaseUrl(doc)).toBe('https://api.example.com/v2');
  });

  it('rejects documents that are not OpenAPI and parses JSON text as well', () => {
    expect(() => buildOperationCatalog({ paths: {} })).toThrow(ConfigError);
    expect(() => buildOperationCatalog('x')).toThrow(ConfigError);
    expect(() => parseOpenApiText('[1,2]')).toThrow(/must be an object/);
    expect(
      buildOperationCatalog(
        parseOpenApiText('{"openapi":"3.1.0","paths":{"/a":{"get":{"responses":{}}}}}'),
      ),
    ).toHaveLength(1);
    expect(documentBaseUrl(parseOpenApiText(openapiText()))).toBe('https://lms.example/api/v1');
    expect(synthesizeOperationId('GET', '/a/{b}/c-d')).toBe('getAByBCD');
  });
});

describe('request building', () => {
  const op = buildOperationCatalog(parseOpenApiText(openapiText())).find(
    (o) => o.operationId === 'listAssignments',
  );
  const courses = buildOperationCatalog(parseOpenApiText(openapiText())).find(
    (o) => o.operationId === 'listCourses',
  );

  it('encodes path values, sends header params as headers and unknown names as query', () => {
    const r = buildRequest('https://x.example/api/v1/', op ?? never(), {
      courseId: 'a b/c',
      cursor: 'z',
      'X-Trace': 't1',
      extra: 1,
    });
    expect(r.url).toBe('https://x.example/api/v1/courses/a%20b%2Fc/assignments?cursor=z&extra=1');
    expect(r.headers).toEqual({ 'X-Trace': 't1' });
  });

  it('repeats array query values and requires path parameters', () => {
    const r = buildRequest('https://x.example', courses ?? never(), {
      state: ['a', 'b'],
      page_size: 5,
    });
    expect(r.url).toBe('https://x.example/courses?state=a&state=b&page_size=5');
    expect(() => buildRequest('https://x.example', op ?? never(), {})).toThrow(ValidationError);
    expect(() =>
      buildRequest('https://x.example', { operationId: 'x', path: '/a/{id}', parameters: [] }, {}),
    ).toThrow(/no value for path parameter "id"/);
    expect(joinUrl('https://x.example/v1/', '/a')).toBe('https://x.example/v1/a');
  });

  it('parses Link headers', () => {
    const h = '<https://x/a?page=2>; rel="next", <https://x/a?page=9>; rel="last"';
    expect(parseLinkHeader(h)).toBe('https://x/a?page=2');
    expect(parseLinkHeader(h, 'last')).toBe('https://x/a?page=9');
    expect(parseLinkHeader('<https://x/a>; rel=prev')).toBeUndefined();
    expect(parseLinkHeader(null)).toBeUndefined();
    expect(parseLinkHeader('<https://x/a?p=1>; title="x"; rel="next prefetch"')).toBe(
      'https://x/a?p=1',
    );
  });
});

function never(): never {
  throw new Error('operation missing from fixture');
}

describe('suggestMapping', () => {
  const catalog = buildOperationCatalog(parseOpenApiText(openapiText()));

  it('drafts resources for GET list operations and fan-outs, and reports what it skipped', () => {
    const { spec: draft, skipped } = suggestMapping(catalog, {
      id: 'lms',
      defaultAuthority: 'lms',
    });
    const resources = draft.resources as {
      name: string;
      call: { operation: string; params?: Record<string, string> };
      forEach?: { resource: string; as: string };
      select: string;
      sourceType: string;
      externalId: string;
    }[];
    expect(resources.map((r) => r.name)).toEqual([
      'list_courses',
      'get_me',
      'list_assignments',
      'get_courses_by_course_id_announcements',
    ]);
    expect(resources[0]).toMatchObject({
      select: '$',
      sourceType: 'lms.list_courses',
      externalId: '$string(id)',
    });
    expect(resources[2]).toMatchObject({
      forEach: { resource: 'list_courses', as: 'list_course' },
      call: { operation: 'listAssignments', params: { courseId: '{{list_course.id}}' } },
      select: 'items',
    });
    expect(skipped.map((s) => s.operationId)).toEqual(['search']);
    expect(draft.capabilities).toEqual(
      expect.arrayContaining(['courses', 'assignments', 'announcements']),
    );
    // the skeleton is a valid mapping
    expect(parseMappingSpec(draft).resources).toHaveLength(4);
  });

  it('renders YAML with a header comment and skip notes', () => {
    const yaml = suggestMappingYaml(catalog, { id: 'lms' });
    expect(yaml).toContain('# Draft generated from the OpenAPI operation catalog');
    expect(yaml).toContain('# skipped search: required parameters: q');
    expect(parseMappingSpec(yaml).id).toBe('lms');
  });
});

describe('RESTSourceAdapter sync', () => {
  it('follows Link-header and cursor pagination, fans out, and normalizes to canonical entities', async () => {
    const api = fakeApi({ auth: true });
    const secrets = await withToken();
    const adapter = adapterFor(
      { auth: { type: 'bearer', secret: 'lms-token' } },
      api.fetch,
      spec(),
      secrets,
    );
    expect(await adapter.capabilities()).toEqual(['courses', 'assignments']);
    expect((await adapter.authenticate()).status).toBe('authenticated');
    const { items, pages } = await syncAll(adapter);
    expect(items.map((i) => `${i.sourceType}:${i.externalId}`).sort()).toEqual([
      'lms.assignment:5001',
      'lms.assignment:5002',
      'lms.course:101',
      'lms.course:102',
      'lms.course:103',
    ]);
    expect(pages.at(-1)?.complete?.sourceTypes.sort()).toEqual(['lms.assignment', 'lms.course']);
    expect(pages[0]?.productVersion).toEqual({ product: 'fakelms', version: '2.4.1' });
    // credentials in payloads are stripped
    expect(JSON.stringify(items)).not.toContain('LEAK');

    const urls = api.requests.map((r) => r.url).filter((u) => !u.endsWith('openapi.yaml'));
    expect(urls).toEqual([
      'https://lms.example/api/v1/courses?state=active&state=invited&page_size=2',
      'https://lms.example/api/v1/courses?page=2&page_size=2',
      'https://lms.example/api/v1/courses/101/assignments',
      'https://lms.example/api/v1/courses/101/assignments?cursor=c2',
      'https://lms.example/api/v1/courses/102/assignments',
      'https://lms.example/api/v1/courses/103/assignments',
    ]);
    expect(api.requests.every((r) => r.headers.get('authorization') === 'Bearer tok-123')).toBe(
      true,
    );

    const normalizer = createMappedNormalizer(spec());
    const ctx = createNormalizeContext({
      sourceId: 'src',
      sourceSystem: 'fakelms',
      timezone: 'Asia/Tokyo',
    });
    let entities = 0;
    for (const item of items) {
      const view: RawItemView = {
        id: `raw:${item.externalId}`,
        sourceId: 'src',
        sourceType: item.sourceType,
        externalId: item.externalId,
        payload: item.payload,
        fetchedAt: '2026-10-01T00:00:00.000Z',
        sourceUpdatedAt: undefined,
        contentHash: 'h',
      };
      const out = await normalizer.normalize(view, ctx);
      expect(out.warnings).toEqual([]);
      for (const e of out.entities) {
        expect(CanonicalEntitySchema.safeParse(e.entity).success).toBe(true);
        entities++;
      }
    }
    expect(entities).toBe(5);
    await adapter.dispose();
  });

  it('supports page-number pagination and literal paths without an OpenAPI document', async () => {
    const calls: string[] = [];
    const fetchFn: FetchLike = (input) => {
      calls.push(input);
      const page = Number(new URL(input).searchParams.get('page'));
      const items = page === 1 ? [{ id: 1 }, { id: 2 }] : page === 2 ? [{ id: 3 }] : [];
      return Promise.resolve(
        new Response(JSON.stringify({ data: items }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    const s = parseMappingSpec({
      id: 'p',
      product: 'p',
      capabilities: ['courses'],
      resources: [
        {
          name: 'c',
          call: {
            path: '/things',
            params: { per: 2 },
            paginate: { type: 'page', param: 'page', size: 2, items: 'data' },
          },
          select: 'data',
          sourceType: 'p.thing',
          externalId: '$string(id)',
        },
      ],
    });
    const adapter = adapterFor({ openapi: undefined, url: 'https://api.example/v1' }, fetchFn, s);
    const { items } = await syncAll(adapter);
    expect(items.map((i) => i.externalId)).toEqual(['1', '2', '3']);
    expect(calls).toEqual([
      'https://api.example/v1/things?per=2&page=1',
      'https://api.example/v1/things?per=2&page=2',
    ]);
  });

  it('refuses to follow a next link to another origin', async () => {
    const fetchFn: FetchLike = () =>
      Promise.resolve(
        new Response('[{"id":1}]', {
          headers: { link: '<https://evil.example/steal>; rel="next"' },
        }),
      );
    const s = parseMappingSpec({
      id: 'p',
      product: 'p',
      capabilities: ['courses'],
      resources: [
        {
          name: 'c',
          call: { path: '/things', paginate: { type: 'link-header' } },
          sourceType: 'p.thing',
          externalId: '$string(id)',
        },
      ],
    });
    await expect(
      adapterFor({ openapi: undefined, url: 'https://api.example/v1' }, fetchFn, s).sync({
        mode: 'initial',
      }),
    ).rejects.toThrow(/another origin/);
  });

  it('refuses non-GET operations with a PolicyViolationError and flags them in health', async () => {
    const api = fakeApi();
    const bad = parseMappingSpec({
      id: 'w',
      product: 'w',
      capabilities: ['assignments'],
      resources: [
        {
          name: 'c',
          call: { operation: 'createAssignment', params: { courseId: 1 } },
          sourceType: 'w.a',
          externalId: '$string(id)',
        },
      ],
    });
    const adapter = adapterFor({}, api.fetch, bad);
    const err = await adapter.sync({ mode: 'initial' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyViolationError);
    expect((err as Error).message).toContain('only GET');
    expect(api.requests.filter((r) => !r.url.endsWith('openapi.yaml'))).toHaveLength(0);
    const h = await adapter.health();
    expect(h.state).toBe('degraded');
    expect(h.message).toContain('not GET');
    const del = parseMappingSpec({
      id: 'w',
      product: 'w',
      capabilities: ['courses'],
      resources: [
        {
          name: 'c',
          call: { operation: 'deleteCourse', params: { courseId: 1 } },
          sourceType: 'w.a',
          externalId: '$string(id)',
        },
      ],
    });
    await expect(adapterFor({}, api.fetch, del).sync({ mode: 'initial' })).rejects.toBeInstanceOf(
      PolicyViolationError,
    );
  });

  it('names available operations when the mapping calls an unknown one', async () => {
    const s = parseMappingSpec({
      id: 'u',
      product: 'u',
      capabilities: ['courses'],
      resources: [
        {
          name: 'c',
          call: { operation: 'listEverything' },
          sourceType: 'u.a',
          externalId: '$string(id)',
        },
      ],
    });
    const adapter = adapterFor({}, fakeApi().fetch, s);
    await expect(adapter.sync({ mode: 'initial' })).rejects.toThrow(
      /"listEverything" is not in the API catalog \(listCourses/,
    );
    expect((await adapter.health()).message).toContain('listEverything');
  });

  it('maps HTTP failures: 401 → auth_required, 404 → ConnectorError, offline → OfflineError', async () => {
    const secrets = await withToken();
    const unauthorized = adapterFor(
      { auth: { type: 'bearer', secret: 'lms-token' } },
      fakeApi({ auth: true }).fetch,
      spec(),
      new MemorySecrets(),
    );
    await expect(unauthorized.sync({ mode: 'initial' })).rejects.toBeInstanceOf(AuthRequiredError);
    expect((await unauthorized.authenticate()).status).toBe('auth_required');
    expect((await unauthorized.health()).state).toBe('auth_required');

    const wrongToken = new MemorySecrets();
    await wrongToken.set('src/lms-token', 'nope');
    const rejected = adapterFor(
      { auth: { type: 'bearer', secret: 'lms-token' } },
      fakeApi({ auth: true }).fetch,
      spec(),
      wrongToken,
    );
    await expect(rejected.sync({ mode: 'initial' })).rejects.toBeInstanceOf(AuthRequiredError);

    const missing = adapterFor(
      { auth: { type: 'bearer', secret: 'lms-token' } },
      fakeApi({ auth: true, fail: { '/api/v1/courses': 404 } }).fetch,
      spec(),
      secrets,
    );
    const e404 = await missing.sync({ mode: 'initial' }).catch((e: unknown) => e);
    expect(e404).toBeInstanceOf(ConnectorError);
    expect((e404 as Error).message).toContain('HTTP 404');

    const offline = adapterFor({}, () => Promise.reject(new TypeError('fetch failed')), spec());
    // the OpenAPI document is a local file; the API itself is unreachable
    await expect(offline.sync({ mode: 'initial' })).rejects.toBeInstanceOf(OfflineError);
    expect(
      (
        await adapterFor(
          { healthPath: '/me' },
          () => Promise.reject(new TypeError('fetch failed')),
          spec(),
        ).health()
      ).state,
    ).toBe('offline');
  });

  it('sends header / basic / bearer credentials from the SecretStore and nothing for auth none', async () => {
    const header = fakeApi();
    const s1 = new MemorySecrets();
    await s1.set('src/key', 'K1');
    await syncAll(
      adapterFor(
        { auth: { type: 'header', secret: 'key', header: 'X-Api-Key' } },
        header.fetch,
        spec(),
        s1,
      ),
    );
    expect(
      header.requests.filter((r) => !r.url.endsWith('.yaml'))[0]?.headers.get('x-api-key'),
    ).toBe('K1');

    const basic = fakeApi();
    const s2 = new MemorySecrets();
    await s2.set('src/up', 'alice:pw');
    await syncAll(adapterFor({ auth: { type: 'basic', secret: 'up' } }, basic.fetch, spec(), s2));
    expect(basic.requests[0]?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('alice:pw').toString('base64')}`,
    );

    const none = fakeApi();
    await syncAll(adapterFor({}, none.fetch, spec()));
    expect(none.requests.every((r) => !r.headers.has('authorization'))).toBe(true);
    expect(RestConfigSchema.safeParse({ openapi: 'x', auth: { type: 'bearer' } }).success).toBe(
      false,
    );
  });

  it('sends header parameters declared in the OpenAPI document', async () => {
    const api = fakeApi();
    const s = parseMappingSpec({
      id: 'h',
      product: 'h',
      capabilities: ['assignments'],
      resources: [
        {
          name: 'a',
          call: { operation: 'listAssignments', params: { courseId: 102, 'X-Trace': 'trace-9' } },
          select: 'items',
          sourceType: 'h.a',
          externalId: '$string(id)',
        },
      ],
    });
    await syncAll(adapterFor({}, api.fetch, s));
    expect(api.requests.find((r) => r.url.includes('/102/'))?.headers.get('x-trace')).toBe(
      'trace-9',
    );
  });
});

describe('OpenAPI sources and base URL', () => {
  it('loads the document from a URL (without credentials), inline text, an object or a file', async () => {
    const secrets = await withToken();
    const api = fakeApi({ auth: true });
    const fromUrl = adapterFor(
      {
        openapi: 'https://lms.example/openapi.yaml',
        auth: { type: 'bearer', secret: 'lms-token' },
      },
      api.fetch,
      spec(),
      secrets,
    );
    expect((await fromUrl.catalog()).length).toBe(7);
    const docRequest = api.requests.find((r) => r.url.endsWith('/openapi.yaml'));
    expect(docRequest?.headers.has('authorization')).toBe(false);

    const inlineText = adapterFor({ openapi: openapiText() }, fakeApi().fetch);
    expect((await inlineText.catalog()).length).toBe(7);
    const inlineObject = adapterFor({ openapi: parseOpenApiText(openapiText()) }, fakeApi().fetch);
    expect((await inlineObject.catalog()).length).toBe(7);

    const file = join(tmp, 'api.json');
    writeFileSync(file, JSON.stringify(parseOpenApiText(openapiText())));
    expect((await adapterFor({ openapi: file }, fakeApi().fetch).catalog()).length).toBe(7);
    const missing = adapterFor({ openapi: join(tmp, 'nope.yaml') }, fakeApi().fetch);
    await expect(missing.catalog()).rejects.toBeInstanceOf(ConfigError);
    expect(await missing.health()).toMatchObject({ state: 'failed' });
  });

  it('uses the configured url over servers[0], and needs one of them', async () => {
    const api = fakeApi();
    await syncAll(
      adapterFor(
        { url: 'https://mirror.example/api/v1' },
        api.fetch,
        parseMappingSpec({
          id: 'm',
          product: 'm',
          capabilities: ['courses'],
          resources: [
            { name: 'c', call: { operation: 'getMe' }, sourceType: 'm.me', externalId: 'id' },
          ],
        }),
      ),
    );
    expect(api.requests[0]?.url).toBe('https://mirror.example/api/v1/me');
    expect(RestConfigSchema.safeParse({}).success).toBe(false);
    expect(
      RestConfigSchema.safeParse({ openapi: 'a.yaml', headers: { Authorization: 'x' } }).success,
    ).toBe(false);
    const noServers = parseOpenApiText(
      'openapi: 3.0.0\npaths:\n  /a:\n    get:\n      operationId: a\n      responses: {}\n',
    );
    const adapter = adapterFor(
      { openapi: noServers },
      fakeApi().fetch,
      parseMappingSpec({
        id: 'n',
        product: 'n',
        capabilities: ['courses'],
        resources: [{ name: 'c', call: { operation: 'a' }, sourceType: 'n.a', externalId: 'id' }],
      }),
    );
    await expect(adapter.sync({ mode: 'initial' })).rejects.toThrow(/No base URL/);
  });

  it('health is healthy with a good catalog and reports the API version', async () => {
    const adapter = adapterFor({ healthPath: '/me' }, fakeApi().fetch);
    expect(await adapter.health()).toMatchObject({ state: 'healthy', detectedVersion: '2.4.1' });
    expect(await adapter.detectProductVersion()).toEqual({ product: 'fakelms', version: '2.4.1' });
    const bad = adapterFor({ healthPath: '/missing' }, fakeApi().fetch);
    expect((await bad.health()).state).toBe('degraded');
  });
});

describe('connector module', () => {
  it('default export and metadata describe a generic experimental REST connector', async () => {
    expect(typeof restDefault).toBe('function');
    await expect(restDefault({ sourceId: 's', config: {} })).resolves.toBe(restConnector);
    expect(restMetadata).toMatchObject({
      adapter: 'rest',
      apiStability: 'experimental',
      risk: 'experimental',
    });
    const mod = createRestConnector(spec());
    expect(mod.metadata).toMatchObject({
      product: 'fakelms',
      adapter: 'rest',
      defaultAuthority: 'lms',
    });
    expect(mod.metadata.rawTypes).toEqual(['lms.course', 'lms.assignment']);
  });

  it('instantiates from config with an inline mapping and mocked fetch', async () => {
    const api = fakeApi({ auth: true });
    const secrets = await withToken();
    const inst = instantiateConnector(restConnector, {
      sourceId: 'src',
      config: {
        adapter: 'rest',
        openapi: OPENAPI_PATH,
        auth: { type: 'bearer', secret: 'lms-token' },
        mapping: mappingText(),
      },
      secrets,
      fetch: api.fetch,
      rateLimit: { capacity: 100, refillPerSecond: 100 },
    });
    expect(inst.normalizer.id).toBe('mapped:lms');
    const { items } = await syncAll(inst.adapter);
    expect(items).toHaveLength(5);
    expect(() =>
      instantiateConnector(restConnector, { sourceId: 'x', config: {}, secrets }),
    ).toThrow(ConfigError);
    expect(() =>
      instantiateConnector(restConnector, {
        sourceId: 'x',
        config: { url: 'https://a.example' },
        secrets,
      }),
    ).toThrow(/needs a "mapping"/);
  });
});

// Compliance (§66): adapter + mapped normalizer against the mocked API.
testConnectorCompliance('adapter-rest (fake LMS)', {
  metadata: createRestConnector(spec()).metadata,
  normalizer: createMappedNormalizer(spec()),
  createAdapter: () => adapterFor({}, fakeApi().fetch),
  rawFixtures: [],
});
