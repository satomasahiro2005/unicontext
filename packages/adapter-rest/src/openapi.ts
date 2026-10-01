import { ConfigError } from '@unicontext/core';
import { parse as parseYaml } from 'yaml';

export const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface OperationParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  description?: string;
  schema?: Record<string, unknown>;
  /** How arrays are serialized in the query: repeated keys (default) or comma separated. */
  explode?: boolean;
}

/** One entry of the operation catalog (§30): what the API offers, in a form tools can use. */
export interface OperationInfo {
  /** `operationId`, or a name synthesized from method + path. */
  operationId: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  parameters: OperationParameter[];
  /** JSON schema of the first 2xx application/json response, local `$ref`s resolved. */
  responseSchema?: Record<string, unknown>;
  /** The operation takes a request body (never sent: only GET is executed). */
  hasRequestBody: boolean;
  deprecated: boolean;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse an OpenAPI / Swagger document given as JSON or YAML text. */
export function parseOpenApiText(text: string): Json {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw new ConfigError(
      `OpenAPI document is neither valid JSON nor YAML: ${e instanceof Error ? e.message : String(e)}`,
      {
        cause: e,
      },
    );
  }
  if (!isObject(doc)) throw new ConfigError('OpenAPI document must be an object');
  return doc;
}

function decodePointerToken(t: string): string {
  return decodeURIComponent(t).replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Resolve a local `#/a/b` pointer. */
function resolvePointer(root: Json, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let cur: unknown = root;
  for (const token of ref.slice(2).split('/').map(decodePointerToken)) {
    if (!isObject(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[token];
  }
  return cur;
}

/**
 * Deep-copy `value` with every local `$ref` replaced by its target. Circular references are cut
 * (`{type: "object", "x-circular": "#/..."}`); external refs stay as they are.
 */
export function resolveRefs(root: Json, value: unknown, maxDepth = 24): unknown {
  const walk = (v: unknown, stack: string[], depth: number): unknown => {
    if (depth > maxDepth) return { 'x-truncated': true };
    if (Array.isArray(v)) return v.map((x) => walk(x, stack, depth + 1));
    if (!isObject(v)) return v;
    const ref = v.$ref;
    if (typeof ref === 'string') {
      if (!ref.startsWith('#/')) return { ...v };
      if (stack.includes(ref)) return { type: 'object', 'x-circular': ref };
      const target = resolvePointer(root, ref);
      if (target === undefined) return { 'x-unresolved': ref };
      return walk(target, [...stack, ref], depth + 1);
    }
    const out: Json = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, stack, depth + 1);
    return out;
  };
  return walk(value, [], 0);
}

function pascal(segment: string): string {
  return segment
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/** `GET /courses/{courseId}/assignments` → `getCoursesByCourseIdAssignments`. */
export function synthesizeOperationId(method: string, path: string): string {
  const parts = path
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      const m = /^\{(.+)\}$/.exec(seg);
      return m ? `By${pascal(m[1] ?? '')}` : pascal(seg);
    });
  return `${method.toLowerCase()}${parts.join('')}` || method.toLowerCase();
}

function paramFrom(root: Json, raw: unknown, swagger2: boolean): OperationParameter | undefined {
  const p = resolveRefs(root, raw);
  if (!isObject(p) || typeof p.name !== 'string') return undefined;
  const where = p.in;
  if (where !== 'path' && where !== 'query' && where !== 'header' && where !== 'cookie')
    return undefined;
  const schemaSource: Json | undefined = isObject(p.schema)
    ? p.schema
    : swagger2
      ? Object.fromEntries(
          Object.entries(p).filter(([k]) => !['name', 'in', 'required', 'description'].includes(k)),
        )
      : undefined;
  const style = typeof p.style === 'string' ? p.style : undefined;
  const explodeFlag =
    typeof p.explode === 'boolean'
      ? p.explode
      : swagger2 && typeof p.collectionFormat === 'string'
        ? p.collectionFormat === 'multi'
        : style === 'form' || style === undefined;
  return {
    name: p.name,
    in: where,
    required: where === 'path' ? true : p.required === true,
    ...(typeof p.description === 'string' ? { description: p.description } : {}),
    ...(schemaSource && Object.keys(schemaSource).length > 0 ? { schema: schemaSource } : {}),
    explode: explodeFlag,
  };
}

function responseSchemaOf(root: Json, op: Json, swagger2: boolean): Json | undefined {
  const responses = op.responses;
  if (!isObject(responses)) return undefined;
  const codes = Object.keys(responses)
    .filter((c) => /^2\d\d$/.test(c) || c === '2XX' || c === 'default')
    .sort();
  for (const code of codes) {
    const resp = resolveRefs(root, responses[code]);
    if (!isObject(resp)) continue;
    if (swagger2) {
      if (isObject(resp.schema)) return resp.schema;
    } else if (isObject(resp.content)) {
      const content = resp.content;
      const key = Object.keys(content).find((k) => /json/i.test(k));
      const media = key ? content[key] : undefined;
      if (isObject(media) && isObject(media.schema)) return media.schema;
    }
  }
  return undefined;
}

/**
 * Operation catalog of an OpenAPI 3.x or Swagger 2.0 document: every method of every path, with
 * parameters (path-level ones merged), tags and the resolved 2xx response schema. Operations are
 * returned in document order; duplicate operationIds get a numeric suffix.
 */
export function buildOperationCatalog(doc: unknown): OperationInfo[] {
  if (!isObject(doc)) throw new ConfigError('OpenAPI document must be an object');
  const swagger2 = typeof doc.swagger === 'string' && doc.swagger.startsWith('2');
  const openapi3 = typeof doc.openapi === 'string' && doc.openapi.startsWith('3');
  if (!swagger2 && !openapi3)
    throw new ConfigError(
      'Not an OpenAPI 3.x or Swagger 2.0 document (missing "openapi"/"swagger")',
    );
  const paths = doc.paths;
  if (!isObject(paths)) return [];
  const out: OperationInfo[] = [];
  const used = new Set<string>();
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = resolveRefs(doc, rawItem);
    if (!isObject(item)) continue;
    const pathParams = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;
      const params = new Map<string, OperationParameter>();
      let swaggerBody = false;
      for (const raw of [...pathParams, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const resolved = resolveRefs(doc, raw);
        if (isObject(resolved) && (resolved.in === 'body' || resolved.in === 'formData'))
          swaggerBody = true;
        const p = paramFrom(doc, raw, swagger2);
        if (p) params.set(`${p.in}:${p.name}`, p); // operation-level overrides path-level
      }
      let id =
        typeof op.operationId === 'string' && op.operationId
          ? op.operationId
          : synthesizeOperationId(method, path);
      for (let n = 2; used.has(id); n++) id = `${id}_${n}`;
      used.add(id);
      const response = responseSchemaOf(doc, op, swagger2);
      out.push({
        operationId: id,
        method,
        path,
        ...(typeof op.summary === 'string' ? { summary: op.summary } : {}),
        ...(typeof op.description === 'string' ? { description: op.description } : {}),
        tags: Array.isArray(op.tags)
          ? op.tags.filter((t): t is string => typeof t === 'string')
          : [],
        parameters: [...params.values()],
        ...(response
          ? { responseSchema: resolveRefs(doc, response) as Record<string, unknown> }
          : {}),
        hasRequestBody: isObject(op.requestBody) || swaggerBody,
        deprecated: op.deprecated === true,
      });
    }
  }
  return out;
}

/** Base URL declared by the document (OpenAPI `servers[0]` / Swagger `schemes+host+basePath`). */
export function documentBaseUrl(doc: unknown): string | undefined {
  if (!isObject(doc)) return undefined;
  if (Array.isArray(doc.servers)) {
    const first: unknown = doc.servers[0];
    if (isObject(first) && typeof first.url === 'string' && /^https?:\/\//i.test(first.url))
      return first.url.replace(/\/+$/, '');
  }
  if (typeof doc.host === 'string') {
    const schemes = Array.isArray(doc.schemes) ? doc.schemes : [];
    const scheme = schemes.includes('https') ? 'https' : (schemes[0] ?? 'https');
    const basePath = typeof doc.basePath === 'string' ? doc.basePath : '';
    return `${String(scheme)}://${doc.host}${basePath}`.replace(/\/+$/, '');
  }
  return undefined;
}

/** `info.version` of the document (the API version, §72). */
export function documentVersion(doc: unknown): string | undefined {
  if (!isObject(doc) || !isObject(doc.info)) return undefined;
  return typeof doc.info.version === 'string' ? doc.info.version : undefined;
}
