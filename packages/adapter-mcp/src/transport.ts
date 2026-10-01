import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type FetchLike, type Logger, redact, type SecretStore } from '@unicontext/core';
import { buildChildEnv, resolveSecretBindings } from '@unicontext/mapping';
import type { McpConfig } from './config.js';

/** Resolved connection parameters (secrets already injected; never logged). */
export type McpConnection =
  | { kind: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { kind: 'http'; url: string; headers: Record<string, string> };

export interface McpTransportContext {
  logger: Logger;
  fetch: FetchLike | undefined;
  /** Receives the child's stderr lines (stdio only); used for start-up diagnostics. */
  onStderr?: (chunk: string) => void;
}

/**
 * Creates the MCP transport for a connection. Tests inject one that returns the client end of an
 * InMemoryTransport pair; production uses stdio / streamable HTTP.
 */
export type McpTransportFactory = (
  connection: McpConnection,
  context: McpTransportContext,
) => Transport | Promise<Transport>;

/** Resolve config + secrets into a connection (secret values are read here, at connect time). */
export async function resolveConnection(
  config: McpConfig,
  secrets: SecretStore,
  sourceId: string,
): Promise<McpConnection> {
  if (config.url) {
    const secretHeaders = await resolveSecretBindings(secrets, sourceId, config.headerSecrets);
    return {
      kind: 'http',
      url: config.url,
      headers: { ...(config.headers ?? {}), ...secretHeaders },
    };
  }
  if (!config.command) throw new Error('MCP config needs "command" or "url"');
  const secretEnv = await resolveSecretBindings(secrets, sourceId, config.envSecrets);
  return {
    kind: 'stdio',
    command: config.command,
    args: config.args ?? [],
    env: { ...buildChildEnv(config.env), ...secretEnv },
    ...(config.cwd ? { cwd: config.cwd } : {}),
  };
}

/** Default factory: StdioClientTransport (no shell) or StreamableHTTPClientTransport. */
export const defaultTransportFactory: McpTransportFactory = (connection, context) => {
  if (connection.kind === 'http') {
    const fetchFn = context.fetch;
    return new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: { headers: connection.headers },
      ...(fetchFn
        ? { fetch: (url: string | URL, init?: RequestInit) => fetchFn(String(url), init) }
        : {}),
    });
  }
  const transport = new StdioClientTransport({
    command: connection.command,
    args: connection.args,
    env: connection.env,
    ...(connection.cwd ? { cwd: connection.cwd } : {}),
    stderr: 'pipe',
  });
  const stderr = transport.stderr;
  if (stderr) {
    stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      context.onStderr?.(text);
      context.logger.debug('mcp server stderr', { text: redact(text.slice(0, 500)) });
    });
  }
  return transport;
};
