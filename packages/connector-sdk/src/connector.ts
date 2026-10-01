import {
  type Clock,
  ConfigError,
  type FetchLike,
  type Logger,
  type SecretStore,
  silentLogger,
  systemClock,
  type UniversityProfile,
} from '@unicontext/core';
import type { z } from 'zod';
import type { SourceAdapter } from './adapter.js';
import type { ConnectorMetadata } from './metadata.js';
import type { Normalizer } from './normalizer.js';
import { RateLimiter, type RateLimiterOptions } from './rate-limiter.js';

/** Everything a connector gets from the host (daemon/CLI). */
export interface ConnectorContext<TConfig> {
  /** Source instance id (key under config `sources:`), e.g. "livecampusu". */
  sourceId: string;
  /** Source config validated by configSchema. */
  config: TConfig;
  /** OS keychain-backed secrets; the only place credentials may be stored (§32). */
  secrets: SecretStore;
  logger: Logger;
  clock: Clock;
  rateLimiter: RateLimiter;
  /** University deployment profile (§54); product settings are under profile.products[<product>]. */
  profile: UniversityProfile | undefined;
  /** Per-source cache directory (e.g. persisted browser session for adapter-browser). */
  cacheDir: string | undefined;
  fetch: FetchLike | undefined;
}

/**
 * What a connector package exports (default export or named `connector`). The host validates
 * config with configSchema, builds the adapter and registers the normalizer with the sync engine.
 */
export interface ConnectorModule<TConfig = Record<string, unknown>> {
  metadata: ConnectorMetadata;
  configSchema?: z.ZodType<TConfig>;
  createAdapter(ctx: ConnectorContext<TConfig>): SourceAdapter;
  createNormalizer(ctx: ConnectorContext<TConfig>): Normalizer;
}

export function defineConnector<TConfig>(
  module: ConnectorModule<TConfig>,
): ConnectorModule<TConfig> {
  return module;
}

export interface ConnectorContextInit {
  sourceId: string;
  /** Raw (unvalidated) source config, e.g. the entry under config.yaml `sources:`. */
  config: unknown;
  secrets: SecretStore;
  logger?: Logger;
  clock?: Clock;
  rateLimiter?: RateLimiter;
  rateLimit?: RateLimiterOptions;
  profile?: UniversityProfile;
  cacheDir?: string;
  fetch?: FetchLike;
}

export interface InstantiatedConnector<TConfig> {
  sourceId: string;
  metadata: ConnectorMetadata;
  adapter: SourceAdapter;
  normalizer: Normalizer;
  context: ConnectorContext<TConfig>;
}

/**
 * Validate config with the module's configSchema and build adapter + normalizer. The result can be
 * passed straight to SyncEngine.register().
 */
export function instantiateConnector<TConfig>(
  module: ConnectorModule<TConfig>,
  init: ConnectorContextInit,
): InstantiatedConnector<TConfig> {
  let config: TConfig;
  if (module.configSchema) {
    const parsed = module.configSchema.safeParse(init.config ?? {});
    if (!parsed.success) {
      throw new ConfigError(
        `Invalid config for source ${init.sourceId}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
    config = parsed.data;
  } else {
    config = (init.config ?? {}) as TConfig;
  }
  const clock = init.clock ?? systemClock;
  const context: ConnectorContext<TConfig> = {
    sourceId: init.sourceId,
    config,
    secrets: init.secrets,
    logger: (init.logger ?? silentLogger).child({ sourceId: init.sourceId }),
    clock,
    rateLimiter: init.rateLimiter ?? new RateLimiter({ clock, ...(init.rateLimit ?? {}) }),
    profile: init.profile,
    cacheDir: init.cacheDir,
    fetch: init.fetch,
  };
  return {
    sourceId: init.sourceId,
    metadata: module.metadata,
    adapter: module.createAdapter(context),
    normalizer: module.createNormalizer(context),
    context,
  };
}
