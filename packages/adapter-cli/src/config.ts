import { DEFAULT_SENSITIVE_KEY_PATTERN } from '@unicontext/core';
import { EnvConfigSchema, SecretBindingsSchema } from '@unicontext/mapping';
import { z } from 'zod';
import { DEFAULT_MAX_OUTPUT_BYTES } from './exec.js';

/**
 * `sources.<id>` for an external CLI (§29): `command` is spawned without a shell; `args` are put
 * in front of every resource's own `call.args`. Credentials are never written here: name them in
 * `envSecrets` and the adapter injects the SecretStore values into the child's environment.
 */
export const CliConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    connector: z.string().optional(),
    adapter: z.string().optional(),
    schedule: z.string().optional(),
    command: z.string().min(1),
    /** Arguments placed before every call's own arguments. */
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    /** Names to inherit from the host environment, or literal non-secret values. */
    env: EnvConfigSchema.optional(),
    /** `{ENV_NAME: secretName}` or `[{name, secret, prefix?}]`; values come from ctx.secrets. */
    envSecrets: SecretBindingsSchema.optional(),
    /** Per-invocation timeout; the process is killed when it expires. */
    timeoutMs: z.number().int().positive().default(60_000),
    /** stdout larger than this kills the process and fails the call. */
    maxOutputBytes: z.number().int().positive().default(DEFAULT_MAX_OUTPUT_BYTES),
    /** Minimum pause between two invocations (be gentle with the wrapped service, §37). */
    minIntervalMs: z.number().int().nonnegative().default(0),
    /** Harmless invocation that proves the tool works and prints its version (e.g. ["--version"]). */
    healthArgs: z.array(z.string()).optional(),
    /** stderr matching this regex marks a failure as auth_required (default: common phrases). */
    authErrorPattern: z.string().optional(),
    /** Path to a YAML mapping, the name of a shipped mapping, or an inline mapping object. */
    mapping: z.union([z.string().min(1), z.record(z.string(), z.unknown())]).optional(),
  })
  .passthrough()
  .superRefine((cfg, ctx) => {
    if (cfg.env && !Array.isArray(cfg.env))
      for (const name of Object.keys(cfg.env))
        if (DEFAULT_SENSITIVE_KEY_PATTERN.test(name))
          ctx.addIssue({
            code: 'custom',
            path: ['env', name],
            message: 'credential variables belong in "envSecrets", not "env"',
          });
    if (cfg.authErrorPattern) {
      try {
        new RegExp(cfg.authErrorPattern);
      } catch {
        ctx.addIssue({ code: 'custom', path: ['authErrorPattern'], message: 'not a valid regex' });
      }
    }
  });

export type CliConfig = z.infer<typeof CliConfigSchema>;
export type CliConfigInput = z.input<typeof CliConfigSchema>;

const argValue = z
  .unknown()
  .transform((v) =>
    typeof v === 'string' ? v : v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v),
  );

/** The `call` block of a mapping resource for this adapter. */
export const CliCallSchema = z
  .object({
    /** Arguments (after config `args`). Every `{{...}}` value becomes its own argv entry. */
    args: z.array(argValue).default([]),
    /** Written to stdin (strings as-is, other values as JSON). */
    stdin: z.unknown().optional(),
    format: z.enum(['json', 'jsonl']).default('json'),
    /** Exit codes that count as success (default [0]). */
    okExitCodes: z.array(z.number().int()).optional(),
    /**
     * Cursor pagination: `{cursorArg: "--cursor", nextCursor: "meta.next"}` runs the command again
     * with `--cursor <value>` appended until `nextCursor` (JSONata on the result) is empty. A
     * `cursorArg` ending in "=" is joined to the value (`--cursor=<value>`).
     */
    paginate: z
      .object({ cursorArg: z.string().min(1), nextCursor: z.string().min(1) })
      .strict()
      .optional(),
    /** Internal: arguments before the cursor, kept on continuation calls. */
    baseArgs: z.array(argValue).optional(),
  })
  .strict();
export type CliCall = z.infer<typeof CliCallSchema>;
