import { fileURLToPath } from 'node:url';
import { CAPABILITIES } from '@unicontext/canonical-model';
import {
  type ConnectorContext,
  type ConnectorMetadata,
  type ConnectorModule,
  defineConnector,
  defineMetadata,
} from '@unicontext/connector-sdk';
import {
  createMappedNormalizer,
  type MappingSpec,
  mappingMetadata,
  resolveMapping,
} from '@unicontext/mapping';
import { RESTSourceAdapter } from './adapter.js';
import { type RestConfig, RestConfigSchema } from './config.js';

/** Directory of mappings shipped with this package (none yet: `mapping:` takes a path or inline). */
export const MAPPINGS_DIR = fileURLToPath(new URL('../mappings/', import.meta.url));

export const REST_PACKAGE_NAME = '@unicontext/adapter-rest';

export interface RestConnectorOptions {
  /** Directory relative `mapping:` / `openapi:` paths are resolved against. */
  baseDir?: string;
}

/** Metadata of the generic connector (no mapping chosen yet): capabilities are the upper bound. */
export const restMetadata: ConnectorMetadata = defineMetadata({
  name: REST_PACKAGE_NAME,
  product: 'rest',
  version: '1.0.0',
  license: 'MIT',
  description:
    'Any REST API with an OpenAPI document, mapped to the canonical model via YAML (GET only)',
  capabilities: [...CAPABILITIES],
  adapter: 'rest',
  apiStability: 'experimental',
  risk: 'experimental',
  defaultAuthority: 'unknown',
  defaultSchedule: '15m',
  rawTypes: [],
});

/**
 * Build the connector module for REST APIs (§30). With a `spec` the metadata comes from the
 * mapping; without one the mapping is read from the source config (`mapping:`).
 */
export function createRestConnector(
  spec?: MappingSpec,
  options: RestConnectorOptions = {},
): ConnectorModule<RestConfig> {
  const cache = new WeakMap<object, MappingSpec>();
  const mappingFor = (ctx: ConnectorContext<RestConfig>): MappingSpec => {
    if (spec) return spec;
    const hit = cache.get(ctx);
    if (hit) return hit;
    const loaded = resolveMapping(ctx.config.mapping, {
      vars: (ctx.config as { mappingVars?: unknown }).mappingVars,
      builtinDir: MAPPINGS_DIR,
      ...(options.baseDir ? { baseDir: options.baseDir } : {}),
    });
    cache.set(ctx, loaded);
    return loaded;
  };
  return defineConnector<RestConfig>({
    metadata: spec
      ? mappingMetadata(spec, { name: `${REST_PACKAGE_NAME}:${spec.id}`, adapter: 'rest' })
      : restMetadata,
    configSchema: RestConfigSchema,
    createAdapter: (ctx) =>
      new RESTSourceAdapter({
        sourceId: ctx.sourceId,
        spec: mappingFor(ctx),
        config: ctx.config,
        secrets: ctx.secrets,
        logger: ctx.logger,
        fetch: ctx.fetch,
        rateLimiter: ctx.rateLimiter,
        clock: ctx.clock,
        ...(options.baseDir ? { baseDir: options.baseDir } : {}),
      }),
    createNormalizer: (ctx) => createMappedNormalizer(mappingFor(ctx)),
  });
}

/** Default module: the mapping is chosen per source in config.yaml. */
export const restConnector: ConnectorModule<RestConfig> = createRestConnector();
