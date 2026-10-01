import { DEFAULT_SENSITIVE_KEY_PATTERN } from '@unicontext/core';
import { z } from 'zod';

/**
 * `auth:` of a REST source. The secret itself lives in the SecretStore under
 * `<sourceId>/<secret>`; config only names it.
 *  - bearer: `Authorization: Bearer <secret>`
 *  - header: `<header>: <prefix><secret>` (default header `X-API-Key`)
 *  - basic : the secret holds `user:password`; sent as `Authorization: Basic base64(...)`
 */
export const RestAuthSchema = z
  .object({
    type: z.enum(['none', 'bearer', 'header', 'basic']).default('none'),
    secret: z.string().min(1).optional(),
    header: z.string().min(1).optional(),
    prefix: z.string().optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.type !== 'none' && !a.secret)
      ctx.addIssue({
        code: 'custom',
        path: ['secret'],
        message: `auth type "${a.type}" needs "secret" (a secret name)`,
      });
  });
export type RestAuth = z.infer<typeof RestAuthSchema>;

/**
 * `sources.<id>` for a REST API (§30). `openapi` may be a file path, an http(s) URL, inline
 * JSON/YAML text or an inline object; `url` is the base URL (default: the document's `servers[0]`).
 */
export const RestConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    connector: z.string().optional(),
    adapter: z.string().optional(),
    schedule: z.string().optional(),
    url: z.url().optional(),
    openapi: z.union([z.string().min(1), z.record(z.string(), z.unknown())]).optional(),
    auth: RestAuthSchema.default({ type: 'none' }),
    /** Extra literal, non-secret request headers. */
    headers: z.record(z.string(), z.string()).optional(),
    /** Path (relative to the base URL) requested by health(); default: only the catalog is checked. */
    healthPath: z.string().optional(),
    /** Path to a YAML mapping, the name of a shipped mapping, or an inline mapping object. */
    mapping: z.union([z.string().min(1), z.record(z.string(), z.unknown())]).optional(),
    timeoutMs: z.number().int().positive().default(30_000),
  })
  .passthrough()
  .superRefine((cfg, ctx) => {
    if (!cfg.url && !cfg.openapi)
      ctx.addIssue({ code: 'custom', message: 'set "url" (base URL) and/or "openapi" (document)' });
    for (const name of Object.keys(cfg.headers ?? {}))
      if (DEFAULT_SENSITIVE_KEY_PATTERN.test(name))
        ctx.addIssue({
          code: 'custom',
          path: ['headers', name],
          message: 'credential headers belong in "auth", not "headers"',
        });
  });
export type RestConfig = z.infer<typeof RestConfigSchema>;
export type RestConfigInput = z.input<typeof RestConfigSchema>;

const PaginateSchema = z.discriminatedUnion('type', [
  /** Follow `Link: <...>; rel="next"` response headers. */
  z.object({ type: z.literal('link-header'), rel: z.string().default('next') }).strict(),
  /** Next cursor read from the JSON body (JSONata) and sent as query parameter `param`. */
  z
    .object({ type: z.literal('cursor'), param: z.string().min(1), next: z.string().min(1) })
    .strict(),
  /** `param` counts pages (from `start`); stops at an empty page or one shorter than `size`. */
  z
    .object({
      type: z.literal('page'),
      param: z.string().min(1),
      start: z.number().int().default(1),
      size: z.number().int().positive().optional(),
      /** JSONata → the page's items (default `$`), used to detect the last page. */
      items: z.string().min(1).default('$'),
    })
    .strict(),
]);
export type RestPagination = z.infer<typeof PaginateSchema>;

/** The `call` block of a mapping resource for this adapter. */
export const RestCallSchema = z
  .object({
    /** operationId (or the synthesized id) from the catalog. */
    operation: z.string().min(1).optional(),
    /** Alternative to `operation`: a literal GET path (no OpenAPI document needed). */
    path: z.string().startsWith('/').optional(),
    /** Path / query / header values (templated); undeclared names are sent as query parameters. */
    params: z.record(z.string(), z.unknown()).default({}),
    paginate: PaginateSchema.optional(),
    /** Internal: absolute URL of the next page (Link header), same origin as the base URL only. */
    url: z.string().optional(),
  })
  .strict()
  .refine((c) => (c.operation === undefined) !== (c.path === undefined), {
    message: 'set exactly one of "operation" and "path"',
  });
export type RestCall = z.infer<typeof RestCallSchema>;
