import type { ConnectorFactoryInput, ConnectorModule } from '@unicontext/connector-sdk';
import { resolveMapping } from '@unicontext/mapping';
import type { RestConfig } from './config.js';
import { createRestConnector, restConnector } from './connector.js';

/**
 * Package entry for hosts (default / named `connector`): builds the module for one source from its
 * `mapping:` config so metadata (product, capabilities, authority) comes from the mapping. Without
 * a mapping the generic module is returned (its adapter then reports the missing mapping).
 */
export async function connector(
  input: ConnectorFactoryInput,
): Promise<ConnectorModule<RestConfig>> {
  const mapping = (input.config as { mapping?: unknown } | undefined)?.mapping;
  if (mapping === undefined || mapping === null) return restConnector;
  return createRestConnector(resolveMapping(mapping));
}
