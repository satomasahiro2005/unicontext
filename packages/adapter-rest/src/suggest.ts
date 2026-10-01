import type { Capability } from '@unicontext/canonical-model';
import { stringify as stringifyYaml } from 'yaml';
import type { OperationInfo } from './openapi.js';

export interface SuggestOptions {
  /** Mapping id / product, e.g. "canvas". */
  id?: string;
  product?: string;
  sourceLabel?: string;
  defaultAuthority?: string;
}

export interface SuggestedMapping {
  /** A MappingSpec skeleton (resources only: add `entities` before syncing). */
  spec: Record<string, unknown>;
  /** GET operations that could not become a resource, with the reason. */
  skipped: { operationId: string; reason: string }[];
}

const CAPABILITY_HINTS: [RegExp, Capability][] = [
  [/course|class|lecture-?list/i, 'courses'],
  [/assignment|homework|task|coursework/i, 'assignments'],
  [/announce|news|notice/i, 'announcements'],
  [/submission/i, 'submissions'],
  [/grade|score|result/i, 'grades'],
  [/message|thread|post|comment|discussion|chat/i, 'messages'],
  [/material|file|document|resource|slide/i, 'materials'],
  [/exam|quiz|test/i, 'exams'],
  [/calendar|event|schedule/i, 'calendar'],
  [/enroll/i, 'enrollments'],
];

const ID_KEYS = ['id', 'uuid', 'key', 'code', 'identifier', 'slug'];

function snake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function itemSchemaOf(schema: Record<string, unknown> | undefined): {
  select: string;
  item: Record<string, unknown> | undefined;
} {
  if (!schema) return { select: '$', item: undefined };
  if (schema.type === 'array' || schema.items) return { select: '$', item: asObject(schema.items) };
  const props = asObject(schema.properties);
  if (props) {
    const arrays = Object.entries(props).filter(([, v]) => {
      const o = asObject(v);
      return o && (o.type === 'array' || o.items);
    });
    if (arrays.length === 1) {
      const [name, v] = arrays[0] as [string, unknown];
      return { select: name, item: asObject(asObject(v)?.items) };
    }
  }
  return { select: '$', item: schema };
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function idExpression(item: Record<string, unknown> | undefined): { expr: string; found: boolean } {
  const props = asObject(item?.properties);
  const key = props ? ID_KEYS.find((k) => k in props) : undefined;
  return key ? { expr: `$string(${key})`, found: true } : { expr: '$string(id)', found: false };
}

function guessCapabilities(ops: OperationInfo[]): Capability[] {
  const found = new Set<Capability>();
  for (const op of ops) {
    const text = `${op.path} ${op.operationId} ${op.tags.join(' ')}`;
    for (const [re, cap] of CAPABILITY_HINTS) if (re.test(text)) found.add(cap);
  }
  return found.size > 0 ? [...found] : ['courses'];
}

/**
 * Draft a MappingSpec skeleton from the operation catalog (the "tool candidates" of §30). Only GET
 * operations qualify. Operations without required parameters become top-level resources;
 * `GET /things/{thingId}/children` becomes a fan-out over the list resource of `/things`.
 * The result has no `entities`: it tells you what can be fetched, you decide what it means.
 */
export function suggestMapping(
  catalog: OperationInfo[],
  options: SuggestOptions = {},
): SuggestedMapping {
  const id = options.id ?? 'rest';
  const product = options.product ?? id;
  const skipped: SuggestedMapping['skipped'] = [];
  const gets = catalog.filter((o) => o.method === 'get' && !o.deprecated);
  const resources: Record<string, unknown>[] = [];
  const included: OperationInfo[] = [];
  const byPath = new Map<string, string>(); // path → resource name
  const used = new Set<string>();
  const nameFor = (op: OperationInfo): string => {
    let name = snake(op.operationId) || 'resource';
    for (let n = 2; used.has(name); n++) name = `${snake(op.operationId)}_${n}`;
    used.add(name);
    return name;
  };

  const requiredNonPath = (op: OperationInfo): string[] =>
    op.parameters.filter((p) => p.required && p.in !== 'path').map((p) => p.name);
  const pathParams = (op: OperationInfo): string[] =>
    op.parameters.filter((p) => p.in === 'path').map((p) => p.name);

  // 1. list operations (no path parameters)
  for (const op of gets.filter((o) => pathParams(o).length === 0)) {
    const req = requiredNonPath(op);
    if (req.length > 0) {
      skipped.push({
        operationId: op.operationId,
        reason: `required parameters: ${req.join(', ')}`,
      });
      continue;
    }
    const { select, item } = itemSchemaOf(op.responseSchema);
    const name = nameFor(op);
    byPath.set(op.path, name);
    included.push(op);
    resources.push({
      name,
      call: { operation: op.operationId },
      select,
      sourceType: `${id}.${snake(name)}`,
      externalId: idExpression(item).expr,
      complete: false,
    });
  }

  // 2. one-parameter children of a list resource: /things/{thingId}/children
  for (const op of gets.filter((o) => pathParams(o).length > 0)) {
    const params = pathParams(op);
    const first = op.path.indexOf('{');
    const prefix = op.path.slice(0, first).replace(/\/+$/, '');
    const parent = byPath.get(prefix);
    const segmentAfter = op.path.slice(first);
    const onlyOneParam = params.length === 1 && segmentAfter.startsWith(`{${params[0]}}`);
    const hasChild = segmentAfter.length > `{${params[0]}}`.length;
    const req = requiredNonPath(op);
    if (!parent || !onlyOneParam || !hasChild || req.length > 0) {
      skipped.push({
        operationId: op.operationId,
        reason: !parent
          ? 'no list operation for the parent collection'
          : req.length > 0
            ? `required parameters: ${req.join(', ')}`
            : 'not a one-level child of a list resource',
      });
      continue;
    }
    const { select, item } = itemSchemaOf(op.responseSchema);
    const name = nameFor(op);
    included.push(op);
    const as = snake(parent).replace(/s$/, '') || 'parent';
    resources.push({
      name,
      forEach: { resource: parent, as },
      call: { operation: op.operationId, params: { [params[0] as string]: `{{${as}.id}}` } },
      select,
      sourceType: `${id}.${snake(name)}`,
      externalId: idExpression(item).expr,
      attach: { parentId: `${as}.id` },
      complete: false,
    });
  }

  return {
    spec: {
      id,
      product,
      ...(options.sourceLabel ? { sourceLabel: options.sourceLabel } : {}),
      defaultAuthority: options.defaultAuthority ?? 'unknown',
      capabilities: guessCapabilities(included),
      resources,
      entities: {},
    },
    skipped,
  };
}

/** The suggestion as YAML text with a header explaining what is left to do. */
export function suggestMappingYaml(catalog: OperationInfo[], options: SuggestOptions = {}): string {
  const { spec, skipped } = suggestMapping(catalog, options);
  const header = [
    '# Draft generated from the OpenAPI operation catalog (unicontext adapter-rest).',
    '# Review every resource, then add `entities:` rules (raw item -> canonical entity) and set',
    '# `complete: true` on full listings. Only GET operations are ever executed.',
    ...skipped.map((s) => `# skipped ${s.operationId}: ${s.reason}`),
    '',
  ].join('\n');
  return header + stringifyYaml(spec);
}
