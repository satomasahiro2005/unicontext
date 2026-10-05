import { fileURLToPath } from 'node:url';
import {
  defineMetadata,
  defineConnector,
  type ConnectorContext,
  type ConnectorModule,
  type ConnectorMetadata,
} from '@unicontext/connector-sdk';
import { CAPABILITIES } from '@unicontext/canonical-model';
import {
  createMappedNormalizer,
  type MappingSpec,
  mappingMetadata,
  resolveMapping,
} from '@unicontext/mapping';
import { McpSourceAdapter } from './adapter.js';
import { type McpConfig, McpConfigSchema } from './config.js';
import type { McpTransportFactory } from './transport.js';

/** Directory of the mappings shipped with this package (`mapping: canvas-mcp`). */
export const MAPPINGS_DIR = fileURLToPath(new URL('../mappings/', import.meta.url));

export const MCP_PACKAGE_NAME = '@unicontext/adapter-mcp';

export interface McpConnectorOptions {
  /** Replace the transport (tests). */
  transportFactory?: McpTransportFactory;
  /** Directory relative `mapping:` paths are resolved against. */
  baseDir?: string;
}

/** Metadata of the generic connector (no mapping chosen yet): capabilities are the upper bound. */
export const mcpMetadata: ConnectorMetadata = defineMetadata({
  name: MCP_PACKAGE_NAME,
  product: 'mcp',
  version: '1.0.0',
  license: 'MIT',
  description: 'Any MCP server (stdio / streamable HTTP) mapped to the canonical model via YAML',
  capabilities: [...CAPABILITIES],
  adapter: 'mcp',
  apiStability: 'experimental',
  risk: 'experimental',
  defaultAuthority: 'unknown',
  defaultSchedule: '15m',
  rawTypes: [],
});

/**
 * Build the connector module for external MCP servers (§28). With a `spec` the metadata (product,
 * capabilities, raw types, authority) comes from the mapping; without one the mapping is read
 * from the source config (`mapping:` path, shipped name or inline object).
 */
export function createMcpConnector(
  spec?: MappingSpec,
  options: McpConnectorOptions = {},
): ConnectorModule<McpConfig> {
  const cache = new WeakMap<object, MappingSpec>();
  const mappingFor = (ctx: ConnectorContext<McpConfig>): MappingSpec => {
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
  return defineConnector<McpConfig>({
    metadata: spec
      ? mappingMetadata(spec, { name: `${MCP_PACKAGE_NAME}:${spec.id}`, adapter: 'mcp' })
      : mcpMetadata,
    configSchema: McpConfigSchema,
    createAdapter: (ctx) =>
      new McpSourceAdapter({
        sourceId: ctx.sourceId,
        spec: mappingFor(ctx),
        config: ctx.config,
        secrets: ctx.secrets,
        logger: ctx.logger,
        fetch: ctx.fetch,
        clock: ctx.clock,
        ...(options.transportFactory ? { transportFactory: options.transportFactory } : {}),
      }),
    createNormalizer: (ctx) => createMappedNormalizer(mappingFor(ctx)),
  });
}

/** Default module: the mapping is chosen per source in config.yaml. */
export const mcpConnector: ConnectorModule<McpConfig> = createMcpConnector();
