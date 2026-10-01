import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  collectExpressions,
  evalExpr,
  loadMappingFile,
  mappingMetadata,
  parseMappingSpec,
  renderTemplate,
  resolveMapping,
  stripCredentials,
  toIsoDateTime,
  toLocalDate,
  miniSchemaToZod,
  buildChildEnv,
  resolveSecretBindings,
} from '../src/index.js';
import { CANVAS_YAML_PATH, canvasYaml, MemorySecrets } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'uc-mapping-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const base = (): Record<string, unknown> => ({
  id: 'x',
  product: 'x',
  capabilities: ['courses'],
  resources: [{ name: 'a', sourceType: 'x.a', externalId: 'id' }],
});

describe('parseMappingSpec', () => {
  it('parses YAML text and applies defaults', () => {
    const spec = parseMappingSpec(canvasYaml());
    expect(spec.id).toBe('canvas');
    expect(spec.defaultAuthority).toBe('lms');
    expect(spec.resources.map((r) => r.name)).toEqual(['courses', 'assignments', 'announcements']);
    expect(spec.resources[0]?.select).toBe('$');
    expect(spec.resources[1]?.forEach).toEqual({ resource: 'courses', as: 'course' });
    expect(spec.version).toBe('1');
  });

  it('accepts an object and loads files', () => {
    expect(parseMappingSpec(base()).resources).toHaveLength(1);
    expect(loadMappingFile(CANVAS_YAML_PATH).product).toBe('canvas');
    expect(() => loadMappingFile(join(tmp, 'missing.yaml'))).toThrow(/Cannot read mapping file/);
  });

  it('rejects invalid YAML, unknown keys and missing fields', () => {
    expect(() => parseMappingSpec('a: [')).toThrow(/not valid YAML/);
    expect(() => parseMappingSpec({ ...base(), nope: 1 })).toThrow(/Invalid mapping/);
    expect(() => parseMappingSpec({ id: 'x' })).toThrow(/Invalid mapping/);
    expect(() => parseMappingSpec({ ...base(), capabilities: [] })).toThrow(/Invalid mapping/);
  });

  it('validates forEach order, duplicate names and dangling source types', () => {
    const r = { name: 'b', sourceType: 'x.b', externalId: 'id' };
    expect(() =>
      parseMappingSpec({ ...base(), resources: [{ ...r, forEach: { resource: 'zzz', as: 'p' } }] }),
    ).toThrow(/earlier resource/);
    expect(() =>
      parseMappingSpec({
        ...base(),
        resources: [r, { ...r, forEach: { resource: 'b', as: 'p' } }],
      }),
    ).toThrow(/duplicate resource name|earlier resource/);
    expect(() => parseMappingSpec({ ...base(), entities: { 'x.zzz': [] } })).toThrow(
      /no resource produces/,
    );
    expect(() => parseMappingSpec({ ...base(), drift: { 'x.zzz': {} } })).toThrow(/no resource/);
  });

  it('catches JSONata syntax errors, also inside templates', () => {
    expect(() =>
      parseMappingSpec({
        ...base(),
        resources: [{ name: 'a', sourceType: 'x.a', externalId: '$string(' }],
      }),
    ).toThrow(/Invalid JSONata/);
    expect(() =>
      parseMappingSpec({
        ...base(),
        resources: [
          { name: 'a', sourceType: 'x.a', externalId: 'id', call: { args: ['{{ a + }}'] } },
        ],
      }),
    ).toThrow(/Invalid JSONata/);
  });

  it('rejects unknown canonical fields and reserved ones', () => {
    const entities = (fields: Record<string, unknown>): Record<string, unknown> => ({
      ...base(),
      entities: { 'x.a': [{ kind: 'assignment', fields }] },
    });
    expect(() => parseMappingSpec(entities({ titel: 'name' }))).toThrow(/no field "titel"/);
    expect(() => parseMappingSpec(entities({ id: 'name' }))).toThrow(/set by the mapper/);
    expect(() => parseMappingSpec(entities({ title: 'name' }))).not.toThrow();
  });

  it('requires exactly one of key / keys in references', () => {
    const ent = (ref: Record<string, unknown>): Record<string, unknown> => ({
      ...base(),
      entities: { 'x.a': [{ kind: 'assignment', fields: { courseOfferingId: ref } }] },
    });
    expect(() => parseMappingSpec(ent({ ref: 'courseOffering' }))).toThrow();
    expect(() => parseMappingSpec(ent({ ref: 'courseOffering', key: 'a', keys: 'b' }))).toThrow();
    expect(() => parseMappingSpec(ent({ ref: 'courseOffering', key: 'a' }))).not.toThrow();
  });

  it('lists every expression with its path', () => {
    const exprs = collectExpressions(parseMappingSpec(canvasYaml()));
    const flat = exprs.map(([p, e]) => `${p.join('.')}=${e}`);
    expect(flat).toContain('resources.1.call.args.course_id=course.id');
    expect(flat).toContain('entities.canvas.assignment.0.ref.url=html_url');
  });

  it('derives connector metadata', () => {
    const md = mappingMetadata(parseMappingSpec(canvasYaml()), {
      name: '@unicontext/adapter-mcp',
      adapter: 'mcp',
    });
    expect(md.product).toBe('canvas');
    expect(md.apiStability).toBe('experimental');
    expect(md.risk).toBe('experimental');
    expect(md.rawTypes).toEqual(['canvas.course', 'canvas.assignment', 'canvas.announcement']);
    expect(md.defaultAuthority).toBe('lms');
  });
});

describe('resolveMapping', () => {
  it('resolves objects, inline YAML, paths and builtin names', () => {
    const dir = join(tmp, 'maps');
    const file = join(tmp, 'm.yaml');
    writeFileSync(file, canvasYaml());
    expect(resolveMapping(base()).id).toBe('x');
    expect(resolveMapping(canvasYaml()).id).toBe('canvas');
    expect(resolveMapping(file).id).toBe('canvas');
    expect(resolveMapping('m.yaml', { baseDir: tmp }).id).toBe('canvas');
    expect(resolveMapping('m', { builtinDir: tmp }).id).toBe('canvas');
    expect(() => resolveMapping('nope', { builtinDir: dir })).toThrow(/Mapping not found/);
    expect(() => resolveMapping(undefined)).toThrow(/needs a "mapping"/);
  });
});

describe('expressions and templates', () => {
  it('evaluates JSONata and returns plain arrays', async () => {
    expect(await evalExpr('$string(id)', { id: 7 })).toBe('7');
    expect(await evalExpr('$', [1, 2])).toEqual([1, 2]);
    expect(await evalExpr('missing', {})).toBeUndefined();
    const arr = await evalExpr('items.n', { items: [{ n: 1 }, { n: 2 }] });
    expect(Array.isArray(arr)).toBe(true);
    expect(Object.keys(arr as object)).toEqual(['0', '1']);
  });

  it('renders templates keeping types for whole-string placeholders', async () => {
    const scope = { course: { id: 5, name: 'DB' } };
    expect(await renderTemplate('{{course.id}}', scope)).toBe(5);
    expect(await renderTemplate('id-{{course.id}}/{{course.name}}', scope)).toBe('id-5/DB');
    expect(
      await renderTemplate({ a: ['{{course.name}}', 3], b: { c: '{{ course.id }}' } }, scope),
    ).toEqual({ a: ['DB', 3], b: { c: 5 } });
    expect(await renderTemplate('{{$string(course.id)}}', scope)).toBe('5');
  });

  it('refuses unresolved placeholders', async () => {
    await expect(renderTemplate('{{course.nope}}', { course: {} })).rejects.toThrow(
      /did not resolve/,
    );
    await expect(renderTemplate('x{{nope}}', {})).rejects.toThrow(/did not resolve/);
  });
});

describe('date coercion', () => {
  it('keeps offsets, interprets bare local datetimes in the timezone', () => {
    expect(toIsoDateTime('2026-10-08T23:59:00+09:00', 'Asia/Tokyo')).toBe(
      '2026-10-08T23:59:00+09:00',
    );
    expect(toIsoDateTime('2026-10-08T14:59:00Z', 'Asia/Tokyo')).toBe('2026-10-08T14:59:00Z');
    expect(toIsoDateTime('2026-10-08T23:59:00', 'Asia/Tokyo')).toBe('2026-10-08T23:59:00+09:00');
    expect(toIsoDateTime('2026-10-08 23:59', 'America/New_York')).toBe('2026-10-08T23:59:00-04:00');
    expect(toIsoDateTime('2026-10-08T23:59:00+0900', 'UTC')).toBe('2026-10-08T23:59:00+09:00');
    expect(toIsoDateTime('2026-10-08', 'Asia/Tokyo')).toBe('2026-10-08T00:00:00+09:00');
    expect(toIsoDateTime(1790000000, 'Asia/Tokyo')).toBe('2026-09-21T23:13:20+09:00');
    expect(toIsoDateTime('1790000000000', 'UTC')).toBe('2026-09-21T14:13:20+00:00');
    expect(toIsoDateTime('Thu, 08 Oct 2026 14:59:00 GMT', 'Asia/Tokyo')).toBe(
      '2026-10-08T23:59:00+09:00',
    );
    expect(toIsoDateTime('not a date', 'Asia/Tokyo')).toBeUndefined();
    expect(toIsoDateTime('', 'Asia/Tokyo')).toBeUndefined();
    expect(toIsoDateTime({}, 'Asia/Tokyo')).toBeUndefined();
  });

  it('coerces local dates', () => {
    expect(toLocalDate('2026-10-08', 'Asia/Tokyo')).toBe('2026-10-08');
    expect(toLocalDate('2026-10-08T20:00:00Z', 'Asia/Tokyo')).toBe('2026-10-09');
    expect(toLocalDate('x', 'Asia/Tokyo')).toBeUndefined();
  });
});

describe('credential guard', () => {
  it('strips credential-like keys, deeply, without mutating the input', () => {
    const input = {
      id: 1,
      access_token: 'abc',
      nested: { password: 'p', ok: 'yes', list: [{ cookie: 'c', keep: 1 }] },
      has_token: false,
      api_key: '',
      session_id: 12345,
    };
    const { value, removed } = stripCredentials(input);
    expect(value).toEqual({
      id: 1,
      nested: { ok: 'yes', list: [{ keep: 1 }] },
      has_token: false,
      api_key: '',
    });
    expect(removed.sort()).toEqual([
      'access_token',
      'nested.list[0].cookie',
      'nested.password',
      'session_id',
    ]);
    expect(input.access_token).toBe('abc');
  });
});

describe('drift mini-schema', () => {
  it('converts the mini language to zod', () => {
    const s = miniSchemaToZod({
      id: 'number',
      'name?': 'string',
      n: 'string|null',
      tags: ['string'],
      t: { a: 'any' },
    });
    expect(s.safeParse({ id: 1, n: null, tags: ['a'], t: { a: 1 } }).success).toBe(true);
    expect(s.safeParse({ id: '1', n: null, tags: [], t: {} }).success).toBe(false);
    expect(() => miniSchemaToZod('bogus')).toThrow(/Unknown drift type/);
  });
});

describe('secrets and env helpers', () => {
  it('resolves secret bindings (record and list forms)', async () => {
    const store = new MemorySecrets();
    await store.set('src/tok', 'S3CRET');
    expect(await resolveSecretBindings(store, 'src', { CANVAS_TOKEN: 'tok' })).toEqual({
      CANVAS_TOKEN: 'S3CRET',
    });
    expect(
      await resolveSecretBindings(store, 'src', [
        { name: 'Authorization', secret: 'tok', prefix: 'Bearer ' },
      ]),
    ).toEqual({
      Authorization: 'Bearer S3CRET',
    });
    await expect(resolveSecretBindings(store, 'src', { X: 'missing' })).rejects.toThrow(/not set/);
    expect(await resolveSecretBindings(store, 'src', undefined)).toEqual({});
  });

  it('builds a minimal child environment', () => {
    const env = buildChildEnv(['KEEP'], { PATH: '/bin', KEEP: '1', LEAK: 'x', HOME: '/h' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', KEEP: '1' });
    expect(buildChildEnv({ A: 'b' }, { PATH: '/bin' })).toEqual({ PATH: '/bin', A: 'b' });
  });
});

describe('YAML round trip', () => {
  it('the shipped fixture is plain YAML', () => {
    expect(parseYaml(canvasYaml())).toMatchObject({ id: 'canvas' });
  });
});
