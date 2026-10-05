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
import { CliSourceAdapter } from './adapter.js';
import { type CliConfig, CliConfigSchema } from './config.js';

/** Directory of the mappings shipped with this package (`mapping: edstem-cli`). */
export const MAPPINGS_DIR = fileURLToPath(new URL('../mappings/', import.meta.url));

export const CLI_PACKAGE_NAME = '@unicontext/adapter-cli';

export interface CliConnectorOptions {
  /** Directory relative `mapping:` paths are resolved against. */
  baseDir?: string;
}

/** Metadata of the generic connector (no mapping chosen yet): capabilities are the upper bound. */
export const cliMetadata: ConnectorMetadata = defineMetadata({
  name: CLI_PACKAGE_NAME,
  product: 'cli',
  version: '1.0.0',
  license: 'MIT',
  description: 'Any command line tool that prints JSON, mapped to the canonical model via YAML',
  capabilities: [...CAPABILITIES],
  adapter: 'cli',
  apiStability: 'experimental',
  risk: 'experimental',
  defaultAuthority: 'unknown',
  defaultSchedule: '15m',
  rawTypes: [],
});

/**
 * Build the connector module for external CLIs (§29). With a `spec` the metadata comes from the
 * mapping; without one the mapping is read from the source config (`mapping:`).
 */
export function createCliConnector(
  spec?: MappingSpec,
  options: CliConnectorOptions = {},
): ConnectorModule<CliConfig> {
  const cache = new WeakMap<object, MappingSpec>();
  const mappingFor = (ctx: ConnectorContext<CliConfig>): MappingSpec => {
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
  return defineConnector<CliConfig>({
    metadata: spec
      ? mappingMetadata(spec, { name: `${CLI_PACKAGE_NAME}:${spec.id}`, adapter: 'cli' })
      : cliMetadata,
    configSchema: CliConfigSchema,
    createAdapter: (ctx) =>
      new CliSourceAdapter({
        sourceId: ctx.sourceId,
        spec: mappingFor(ctx),
        config: ctx.config,
        secrets: ctx.secrets,
        logger: ctx.logger,
        clock: ctx.clock,
      }),
    createNormalizer: (ctx) => createMappedNormalizer(mappingFor(ctx)),
  });
}

/** Default module: the mapping is chosen per source in config.yaml. */
export const cliConnector: ConnectorModule<CliConfig> = createCliConnector();
