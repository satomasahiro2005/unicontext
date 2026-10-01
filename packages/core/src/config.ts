import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ConfigError } from './errors.js';
import { expandHome } from './paths.js';

export const AdapterKindSchema = z.enum(['native', 'mcp', 'cli', 'rest', 'browser', 'filesystem']);
export type AdapterKind = z.infer<typeof AdapterKindSchema>;

/**
 * One entry under `sources:` (§53). Unknown keys are kept so each connector can validate its own
 * options with its configSchema.
 */
export const SourceConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Connector package short name; defaults to the source key. */
    connector: z.string().optional(),
    adapter: AdapterKindSchema.optional(),
    /** Interval like "15m", or "push" | "event" | "manual" (§36). */
    schedule: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    roots: z.array(z.string()).optional(),
  })
  .passthrough();
export type SourceConfig = z.infer<typeof SourceConfigSchema>;

export const AiProviderIdSchema = z.enum(['none', 'openai', 'anthropic', 'ollama']);
export type AiProviderId = z.infer<typeof AiProviderIdSchema>;

export const EmbeddingProviderIdSchema = z.enum(['none', 'openai', 'local', 'ollama', 'voyage']);
export type EmbeddingProviderId = z.infer<typeof EmbeddingProviderIdSchema>;

export const ConfigSchema = z.object({
  profile: z.string().optional(),
  timezone: z.string().optional(),
  /**
   * Who the student is, for campus/faculty-specific calendar exceptions in the profile (e.g. 静岡地区のみ
   * 休講). Free text matched against the profile's `noClassDays[].campus/faculty` (substring).
   */
  student: z.object({ campus: z.string().optional(), faculty: z.string().optional() }).optional(),
  sources: z
    .record(
      z.string(),
      SourceConfigSchema.nullable().transform((v) => v ?? SourceConfigSchema.parse({})),
    )
    .default({}),
  sync: z
    .object({
      background: z.boolean().default(true),
      defaultInterval: z.string().default('15m'),
      schedules: z.record(z.string(), z.string()).default({}),
    })
    .default({ background: true, defaultInterval: '15m', schedules: {} }),
  ai: z
    .object({
      provider: AiProviderIdSchema.default('none'),
      model: z.string().optional(),
      baseUrl: z.string().optional(),
      /** Key name in the SecretStore holding the API key. Never put the key itself here. */
      apiKeyRef: z.string().optional(),
    })
    .default({ provider: 'none' }),
  embeddings: z
    .object({
      provider: EmbeddingProviderIdSchema.default('none'),
      model: z.string().optional(),
      baseUrl: z.string().optional(),
      apiKeyRef: z.string().optional(),
    })
    .default({ provider: 'none' }),
  logging: z
    .object({ level: z.enum(['debug', 'info', 'warn', 'error']).default('info') })
    .default({ level: 'info' }),
  /** Local daemon (unicontextd, §34). It only ever binds to 127.0.0.1. */
  daemon: z
    .object({ port: z.number().int().min(1024).max(65535).default(17878) })
    .default({ port: 17878 }),
  /** Notification engine (§46). Webhook is off by default; its secret lives in the SecretStore. */
  notifications: z
    .object({
      enabled: z.boolean().default(true),
      minPriority: z.enum(['low', 'normal', 'high', 'critical']).default('low'),
      /** How long before a due date a "deadline approaching" notification fires. */
      deadlineLeadTimes: z.array(z.string()).default(['24h', '3h']),
      sinks: z
        .object({
          console: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
          desktop: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
          webhook: z
            .object({
              enabled: z.boolean().default(false),
              url: z.string().optional(),
              /** Key name in the SecretStore holding the HMAC secret. Never put the secret here. */
              secretRef: z.string().optional(),
              minPriority: z.enum(['low', 'normal', 'high', 'critical']).default('high'),
            })
            .default({ enabled: false, minPriority: 'high' }),
        })
        .default({
          console: { enabled: true },
          desktop: { enabled: true },
          webhook: { enabled: false, minPriority: 'high' },
        }),
    })
    .default({
      enabled: true,
      minPriority: 'low',
      deadlineLeadTimes: ['24h', '3h'],
      sinks: {
        console: { enabled: true },
        desktop: { enabled: true },
        webhook: { enabled: false, minPriority: 'high' },
      },
    }),
  /** §61: telemetry is off unless explicitly enabled. */
  telemetry: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
});
export type UniContextConfig = z.infer<typeof ConfigSchema>;

const SECRET_KEY_HINT = /(password|secret|token|cookie|api[-_]?key)$/i;

/** Parse YAML text into a validated config. Rejects inline secrets (§32). */
export function parseConfig(text: string, options: { home?: string } = {}): UniContextConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text) ?? {};
  } catch (e) {
    throw new ConfigError('config.yaml is not valid YAML', { cause: e });
  }
  const inline = findInlineSecrets(raw);
  if (inline.length > 0) {
    throw new ConfigError(
      `Secrets must not be stored in config.yaml (use the OS keychain): ${inline.join(', ')}`,
    );
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      `Invalid config: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const config = result.data;
  for (const source of Object.values(config.sources)) {
    if (source.roots) source.roots = source.roots.map((r) => expandHome(r, options.home));
  }
  return config;
}

function findInlineSecrets(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    const keyPath = prefix ? `${prefix}.${k}` : k;
    if (SECRET_KEY_HINT.test(k) && typeof v === 'string' && v.length > 0) out.push(keyPath);
    else out.push(...findInlineSecrets(v, keyPath));
  }
  return out;
}

/** Load config.yaml; a missing file yields defaults. */
export function loadConfig(file: string, options: { home?: string } = {}): UniContextConfig {
  if (!existsSync(file)) return ConfigSchema.parse({});
  return parseConfig(readFileSync(file, 'utf8'), options);
}

export function defaultConfig(): UniContextConfig {
  return ConfigSchema.parse({});
}
