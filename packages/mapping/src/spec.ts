import { readFileSync } from 'node:fs';
import { CapabilitySchema, ENTITY_KINDS, JsonValueSchema } from '@unicontext/canonical-model';
import { ConfigError } from '@unicontext/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { fieldKind } from './coerce.js';
import { compileExpr, TEMPLATE_RE } from './expr.js';

/*
 * The declarative mapping (MappingSpec) shared by the MCP, CLI and REST adapters (§28-30).
 * Everything that is a "string expression" below is JSONata (https://jsonata.org).
 */

const Expr = z.string().min(1);
const EntityKindSchema = z.enum(ENTITY_KINDS);

/** A literal string or `{expr: <JSONata>}`. */
const StringOrExpr = z.union([z.string(), z.object({ expr: Expr }).strict()]);

export const FIELD_COERCIONS = [
  'string',
  'number',
  'boolean',
  'datetime',
  'date',
  'array',
] as const;

/**
 * How one entity field is produced:
 *  - string                      JSONata relative to the raw item
 *  - number | boolean            constant
 *  - { const }                   constant JSON value
 *  - { expr, as? }               JSONata with an explicit coercion
 *  - { ref, key | keys }         id of another mapped entity (ctx.id(ref, key))
 */
const FieldValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.object({ const: JsonValueSchema }).strict(),
  z.object({ expr: Expr, as: z.enum(FIELD_COERCIONS).optional() }).strict(),
  z
    .object({ ref: EntityKindSchema, key: Expr.optional(), keys: Expr.optional() })
    .strict()
    .refine((v) => (v.key === undefined) !== (v.keys === undefined), {
      message: 'a reference needs exactly one of "key" and "keys"',
    }),
]);
export type FieldValue = z.infer<typeof FieldValueSchema>;

const LocationSchema = z
  .object({
    page: Expr.optional(),
    timestamp: Expr.optional(),
    timestampMs: Expr.optional(),
    messageId: Expr.optional(),
    line: Expr.optional(),
    selector: Expr.optional(),
  })
  .strict();

/** Provenance of a mapped entity/fact (SourceRefSpec). */
const RefSpecSchema = z
  .object({
    url: Expr.optional(),
    /** Literal authority, or `{expr}` for per-item authority (instructor post vs. student post). */
    authority: StringOrExpr.optional(),
    sourceLabel: z.string().optional(),
    sourceItemId: Expr.optional(),
    location: LocationSchema.optional(),
  })
  .strict();
export type RefSpecInput = z.infer<typeof RefSpecSchema>;

const EntityRuleSchema = z
  .object({
    kind: EntityKindSchema,
    /** JSONata → string; ctx.id(kind, key). Default: the raw item's externalId. */
    key: Expr.optional(),
    /** JSONata filter: the rule only applies when this is truthy. */
    when: Expr.optional(),
    /** JSONata → array; one entity per element (the element becomes `$`, the payload `$root`). */
    forEach: Expr.optional(),
    fields: z.record(z.string(), FieldValueSchema).default({}),
    /** Connector-specific extras (entity.extra). */
    extra: z.record(z.string(), Expr).optional(),
    ref: RefSpecSchema.optional(),
    origin: z.enum(['authoritative', 'extracted', 'inferred']).optional(),
    deriveFacts: z.boolean().optional(),
  })
  .strict();
export type EntityRule = z.infer<typeof EntityRuleSchema>;

const FactRuleSchema = z
  .object({
    sourceType: z.string().min(1),
    when: Expr.optional(),
    forEach: Expr.optional(),
    subject: z.object({ ref: EntityKindSchema, key: Expr }).strict(),
    predicate: z.string().min(1),
    value: FieldValueSchema,
    origin: z.enum(['authoritative', 'extracted', 'inferred']).default('authoritative'),
    confidence: z.number().min(0).max(1).optional(),
    evidence: Expr.optional(),
    observedAt: Expr.optional(),
    validFrom: Expr.optional(),
    validUntil: Expr.optional(),
    ref: RefSpecSchema.optional(),
  })
  .strict();
export type FactRule = z.infer<typeof FactRuleSchema>;

const ResourceSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z_][\w-]*$/, 'resource names are identifiers'),
    /** Adapter-specific call block: MCP {tool,args}, CLI {args,format}, REST {operation,params}. */
    call: z.record(z.string(), z.unknown()).default({}),
    /** JSONata applied to the parsed call result → the array of items (default "$"). */
    select: Expr.default('$'),
    sourceType: z.string().min(1),
    /** JSONata relative to the item → stable external id. */
    externalId: Expr,
    updatedAt: Expr.optional(),
    /** The call lists everything: items of this type not returned are marked deleted (§35). */
    complete: z.boolean().default(false),
    /** Fan out: run the call once per item of an earlier resource; `{{<as>.field}}` in templates. */
    forEach: z
      .object({
        resource: z.string(),
        as: z.string().regex(/^[A-Za-z_]\w*$/),
        /** JSONata filter on the parent payload: only matching parents are fanned out. */
        where: Expr.optional(),
        /**
         * JSONata on each (kept) parent payload → the array of fan-out elements, e.g. the quiz
         * slides of a lesson: `($l := $; slides[type = "quiz"].{"id": id, "lesson": $l})`. Each
         * element becomes `<as>`. Default: the parent itself.
         */
        expand: Expr.optional(),
        /**
         * Politeness for detail fan-outs: a call already made for the same element within this
         * long (same adapter process) is skipped; its stored raw items stay as they are (the
         * resource must not be `complete`). Durations like "24h". Requests on demand
         * (`details`) always call.
         */
        refreshAfter: z
          .string()
          .regex(/^\s*\d+(?:\.\d+)?\s*(ms|s|m|h|d)\s*$/, 'a duration such as "24h"')
          .optional(),
        /** JSONata on the fan-out element: truthy = call on every run despite `refreshAfter`. */
        always: Expr.optional(),
      })
      .strict()
      .optional(),
    /** JSONata evaluated in the fan-out scope, stored under payload._parent. */
    attach: z.record(z.string(), Expr).optional(),
    /** Only fetched when this capability is requested (SyncInput.capabilities). */
    capability: CapabilitySchema.optional(),
    /** A failing call is a warning instead of an error (and the type is not "complete"). */
    optional: z.boolean().default(false),
    /** Never part of a sync: only run when a `details` request names it (on the user's request). */
    onRequest: z.boolean().default(false),
  })
  .strict();
export type ResourceSpec = z.infer<typeof ResourceSchema>;

/**
 * On-request detail fetch (DetailFetchAdapter): for a stored raw item of `sourceType` (a payload of
 * resource `resource`), run the resources in `run` for that one item — read-only calls, made only
 * when the user asks (e.g. one Ed lesson with its quiz questions and the student's saved answers).
 */
const DetailRuleSchema = z
  .object({
    sourceType: z.string().min(1),
    resource: z.string().min(1),
    run: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type DetailRule = z.infer<typeof DetailRuleSchema>;

/**
 * Files a source hosts that UniContext may fetch on request (FileDownloadAdapter): a plain HTTPS
 * GET of a document's `url` against hosts the mapping names, no cookies, no tokens, no redirects
 * (a 3xx is a failure), streamed to disk under a byte cap. Hosts are `example.com` (exact) or
 * `*.example.com` (any subdomain).
 */
const FilesSpecSchema = z
  .object({
    hostAllowlist: z.array(z.string().regex(/^(\*\.)?[a-z0-9.-]+\.[a-z]{2,}$/i)).min(1),
    /** Only `none` exists: file requests never carry credentials. */
    credentials: z.literal('none').default('none'),
    /** Largest file fetched (bytes). */
    maxBytes: z
      .number()
      .int()
      .positive()
      .default(50 * 1024 * 1024),
  })
  .strict();
export type FilesSpec = z.infer<typeof FilesSpecSchema>;

/** Mini drift schema:`{field: "string" | "number?" | "string|null" | {nested} | [elem]}`. */
export type DriftTypeSpec = string | DriftTypeSpec[] | { [key: string]: DriftTypeSpec };
const DriftTypeSchema: z.ZodType<DriftTypeSpec> = z.lazy(() =>
  z.union([z.string(), z.array(DriftTypeSchema).length(1), z.record(z.string(), DriftTypeSchema)]),
);

export const MappingSpecSchema = z
  .object({
    id: z.string().min(1),
    product: z.string().min(1),
    sourceLabel: z.string().optional(),
    description: z.string().optional(),
    /** Bump when the mapping changes meaning; part of the normalizer version. */
    version: z.string().default('1'),
    defaultAuthority: z.string().default('unknown'),
    capabilities: z.array(CapabilitySchema).min(1),
    testedVersion: z.string().optional(),
    /**
     * Named constants for expressions (`$vars.<name>`), e.g. a web host or region that differs per
     * account. These are defaults: a source config overrides them with `mappingVars` (only names
     * declared here; see resolveMapping). Never credentials.
     */
    vars: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    resources: z.array(ResourceSchema).min(1),
    entities: z.record(z.string(), z.array(EntityRuleSchema)).default({}),
    facts: z.array(FactRuleSchema).default([]),
    /** On-request detail fetches (see DetailRuleSchema). */
    details: z.array(DetailRuleSchema).default([]),
    /** Hosts of files UniContext may download on request (see FilesSpecSchema). */
    files: FilesSpecSchema.optional(),
    drift: z.record(z.string(), z.record(z.string(), DriftTypeSchema)).optional(),
    /** Also report fields the mini drift schema does not list (default: only missing / changed). */
    strictDrift: z.boolean().default(false),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: 'custom', path, message });
    };
    const names = new Map<string, number>();
    spec.resources.forEach((r, i) => {
      if (names.has(r.name)) issue(['resources', i, 'name'], `duplicate resource name ${r.name}`);
      names.set(r.name, i);
      if (r.forEach) {
        const parent = names.get(r.forEach.resource);
        if (parent === undefined || parent >= i)
          issue(
            ['resources', i, 'forEach', 'resource'],
            `forEach must name an earlier resource (got ${r.forEach.resource})`,
          );
      }
    });
    const types = new Set(spec.resources.map((r) => r.sourceType));
    for (const t of Object.keys(spec.entities))
      if (!types.has(t)) issue(['entities', t], `no resource produces sourceType ${t}`);
    spec.facts.forEach((f, i) => {
      if (!types.has(f.sourceType))
        issue(['facts', i, 'sourceType'], `no resource produces sourceType ${f.sourceType}`);
    });
    for (const t of Object.keys(spec.drift ?? {}))
      if (!types.has(t)) issue(['drift', t], `no resource produces sourceType ${t}`);
    const byName = new Map(spec.resources.map((r) => [r.name, r] as const));
    spec.details.forEach((d, i) => {
      const root = byName.get(d.resource);
      if (!root) issue(['details', i, 'resource'], `unknown resource ${d.resource}`);
      else if (root.sourceType !== d.sourceType)
        issue(['details', i, 'sourceType'], `resource ${d.resource} produces ${root.sourceType}`);
      // Every resource run on request must fan out from the requested items or an earlier run.
      const available = new Set([d.resource]);
      d.run.forEach((name, j) => {
        const r = byName.get(name);
        if (!r) issue(['details', i, 'run', j], `unknown resource ${name}`);
        else if (!r.forEach || !available.has(r.forEach.resource))
          issue(
            ['details', i, 'run', j],
            `${name} must fan out from ${[...available].join(' or ')}`,
          );
        available.add(name);
      });
    });
    spec.resources.forEach((r, i) => {
      if (r.forEach?.always && !r.forEach.refreshAfter)
        issue(['resources', i, 'forEach', 'always'], '"always" needs "refreshAfter"');
      if (r.forEach?.refreshAfter && r.complete)
        issue(['resources', i, 'forEach', 'refreshAfter'], 'a skipped call cannot be "complete"');
      if (r.onRequest && !spec.details.some((d) => d.run.includes(r.name)))
        issue(['resources', i, 'onRequest'], `no details rule runs ${r.name}`);
    });
    for (const [type, rules] of Object.entries(spec.entities)) {
      rules.forEach((rule, i) => {
        for (const field of Object.keys(rule.fields)) {
          if (field === 'id' || field === 'kind' || field === 'extra')
            issue(['entities', type, i, 'fields', field], `"${field}" is set by the mapper`);
          else if (fieldKind(rule.kind, field) === undefined)
            issue(['entities', type, i, 'fields', field], `${rule.kind} has no field "${field}"`);
        }
      });
    }
    // Catch JSONata syntax errors when the mapping is loaded, not on the first sync.
    for (const [path, src] of collectExpressions(spec)) {
      try {
        compileExpr(src);
      } catch (e) {
        issue(path, e instanceof Error ? e.message : String(e));
      }
    }
  });

export type MappingSpec = z.infer<typeof MappingSpecSchema>;
export type MappingSpecInput = z.input<typeof MappingSpecSchema>;

function fieldExprs(
  prefix: (string | number)[],
  v: FieldValue,
  out: [(string | number)[], string][],
): void {
  if (typeof v === 'string') out.push([prefix, v]);
  else if (typeof v === 'object' && v !== null) {
    if ('expr' in v) out.push([prefix, v.expr]);
    if ('key' in v && v.key) out.push([prefix, v.key]);
    if ('keys' in v && v.keys) out.push([prefix, v.keys]);
  }
}

function refExprs(
  prefix: (string | number)[],
  ref: RefSpecInput | undefined,
  out: [(string | number)[], string][],
): void {
  if (!ref) return;
  for (const k of ['url', 'sourceItemId'] as const) {
    const e = ref[k];
    if (e) out.push([[...prefix, k], e]);
  }
  if (typeof ref.authority === 'object') out.push([[...prefix, 'authority'], ref.authority.expr]);
  for (const [k, e] of Object.entries(ref.location ?? {}))
    if (e) out.push([[...prefix, 'location', k], e]);
}

/** Every JSONata expression of a mapping with its path (for syntax validation and docs). */
export function collectExpressions(spec: MappingSpec): [(string | number)[], string][] {
  const out: [(string | number)[], string][] = [];
  spec.resources.forEach((r, i) => {
    const p: (string | number)[] = ['resources', i];
    out.push([[...p, 'select'], r.select], [[...p, 'externalId'], r.externalId]);
    if (r.updatedAt) out.push([[...p, 'updatedAt'], r.updatedAt]);
    for (const [k, e] of Object.entries(r.attach ?? {})) out.push([[...p, 'attach', k], e]);
    if (r.forEach?.where) out.push([[...p, 'forEach', 'where'], r.forEach.where]);
    if (r.forEach?.expand) out.push([[...p, 'forEach', 'expand'], r.forEach.expand]);
    if (r.forEach?.always) out.push([[...p, 'forEach', 'always'], r.forEach.always]);
    const walk = (v: unknown, path: (string | number)[]): void => {
      if (typeof v === 'string') {
        for (const m of v.matchAll(new RegExp(TEMPLATE_RE.source, 'g')))
          if (m[1]) out.push([path, m[1]]);
      } else if (Array.isArray(v)) v.forEach((x, j) => walk(x, [...path, j]));
      else if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
    };
    walk(r.call, [...p, 'call']);
  });
  for (const [type, rules] of Object.entries(spec.entities)) {
    rules.forEach((rule, i) => {
      const p: (string | number)[] = ['entities', type, i];
      if (rule.key) out.push([[...p, 'key'], rule.key]);
      if (rule.when) out.push([[...p, 'when'], rule.when]);
      if (rule.forEach) out.push([[...p, 'forEach'], rule.forEach]);
      for (const [k, v] of Object.entries(rule.fields)) fieldExprs([...p, 'fields', k], v, out);
      for (const [k, e] of Object.entries(rule.extra ?? {})) out.push([[...p, 'extra', k], e]);
      refExprs([...p, 'ref'], rule.ref, out);
    });
  }
  spec.facts.forEach((f, i) => {
    const p: (string | number)[] = ['facts', i];
    out.push([[...p, 'subject'], f.subject.key]);
    if (f.when) out.push([[...p, 'when'], f.when]);
    if (f.forEach) out.push([[...p, 'forEach'], f.forEach]);
    fieldExprs([...p, 'value'], f.value, out);
    for (const k of ['evidence', 'observedAt', 'validFrom', 'validUntil'] as const) {
      const e = f[k];
      if (e) out.push([[...p, k], e]);
    }
    refExprs([...p, 'ref'], f.ref, out);
  });
  return out;
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

/** Parse + validate a mapping given as YAML text or an already parsed object. */
export function parseMappingSpec(yamlOrObject: string | unknown): MappingSpec {
  let raw: unknown = yamlOrObject;
  if (typeof yamlOrObject === 'string') {
    try {
      raw = parseYaml(yamlOrObject);
    } catch (e) {
      throw new ConfigError(
        `Mapping is not valid YAML: ${e instanceof Error ? e.message : String(e)}`,
        {
          cause: e,
        },
      );
    }
  }
  const parsed = MappingSpecSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`Invalid mapping: ${formatIssues(parsed.error)}`);
  return parsed.data;
}

/** Read and validate a YAML mapping file (synchronous: connector factories are synchronous). */
export function loadMappingFile(path: string): MappingSpec {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(
      `Cannot read mapping file ${path}: ${e instanceof Error ? e.message : String(e)}`,
      {
        cause: e,
      },
    );
  }
  try {
    return parseMappingSpec(text);
  } catch (e) {
    if (e instanceof ConfigError) throw new ConfigError(`${path}: ${e.message}`, { cause: e });
    throw e;
  }
}
