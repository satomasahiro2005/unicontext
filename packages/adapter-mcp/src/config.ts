import { DEFAULT_SENSITIVE_KEY_PATTERN } from '@unicontext/core';
import { EnvConfigSchema, SecretBindingsSchema } from '@unicontext/mapping';
import { z } from 'zod';

/**
 * `sources.<id>` for an external MCP server (§28). stdio: `command` (+ args/env/envSecrets/cwd);
 * streamable HTTP: `url` (+ headers/headerSecrets). Credentials are never written here: name the
 * secret in `envSecrets` / `headerSecrets` and the adapter reads its value from the SecretStore
 * (`<sourceId>/<secretName>`) when it spawns / connects.
 */
export const McpConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    connector: z.string().optional(),
    adapter: z.string().optional(),
    schedule: z.string().optional(),
    /** stdio transport. */
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    /** Names to inherit from the host environment, or literal non-secret values. */
    env: EnvConfigSchema.optional(),
    /** `{ENV_NAME: secretName}` or `[{name, secret, prefix?}]`; values come from ctx.secrets. */
    envSecrets: SecretBindingsSchema.optional(),
    cwd: z.string().optional(),
    /** Streamable HTTP transport. */
    url: z.url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    headerSecrets: SecretBindingsSchema.optional(),
    /** Path to a YAML mapping, the name of a shipped mapping, or an inline mapping object. */
    mapping: z.union([z.string().min(1), z.record(z.string(), z.unknown())]).optional(),
    /** Connect and per-call timeout in ms. */
    timeoutMs: z.number().int().positive().default(60_000),
    /** Minimum pause between two tool calls (be gentle with the wrapped service, §37). */
    minIntervalMs: z.number().int().nonnegative().default(0),
  })
  .passthrough()
  .superRefine((cfg, ctx) => {
    if ((cfg.command === undefined) === (cfg.url === undefined))
      ctx.addIssue({
        code: 'custom',
        message: 'set exactly one of "command" (stdio) and "url" (HTTP)',
      });
    for (const name of Object.keys(cfg.headers ?? {}))
      if (DEFAULT_SENSITIVE_KEY_PATTERN.test(name))
        ctx.addIssue({
          code: 'custom',
          path: ['headers', name],
          message: 'credential headers belong in "headerSecrets", not "headers"',
        });
    if (cfg.env && !Array.isArray(cfg.env))
      for (const name of Object.keys(cfg.env))
        if (DEFAULT_SENSITIVE_KEY_PATTERN.test(name))
          ctx.addIssue({
            code: 'custom',
            path: ['env', name],
            message: 'credential variables belong in "envSecrets", not "env"',
          });
  });

export type McpConfig = z.infer<typeof McpConfigSchema>;
export type McpConfigInput = z.input<typeof McpConfigSchema>;

/** The `call` block of a mapping resource for this adapter. */
export const McpCallSchema = z
  .object({
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()).optional(),
    /**
     * Cursor pagination of tools that return a next-cursor in their result:
     * `{ cursorArg: cursor, nextCursor: "meta.next" }` (JSONata on the parsed result).
     */
    paginate: z
      .object({ cursorArg: z.string().min(1), nextCursor: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();
export type McpCall = z.infer<typeof McpCallSchema>;
