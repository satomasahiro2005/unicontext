import type { ConnectorFactoryInput, ConnectorModule } from '@unicontext/connector-sdk';
import { resolveMapping } from '@unicontext/mapping';
import type { CliConfig } from './config.js';
import { createCliConnector, cliConnector, MAPPINGS_DIR } from './connector.js';

/**
 * Package entry for hosts (default / named `connector`): builds the module for one source from its
 * `mapping:` config so metadata (product, capabilities, authority) comes from the mapping. Without
 * a mapping the generic module is returned (its adapter then reports the missing mapping).
 */
export async function connector(input: ConnectorFactoryInput): Promise<ConnectorModule<CliConfig>> {
  const mapping = (input.config as { mapping?: unknown } | undefined)?.mapping;
  if (mapping === undefined || mapping === null) return cliConnector;
  return createCliConnector(resolveMapping(mapping, { builtinDir: MAPPINGS_DIR }));
}
