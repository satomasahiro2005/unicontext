import type { IncomingMessage, ServerResponse } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createLogger, errorMessage } from '@unicontext/core';
import { createMcpServer, type McpDeps } from './server.js';

/**
 * stdio transport (`unicontext mcp`). stdout carries only the MCP protocol; logs go to stderr.
 * Resolves when the client closes the connection (stdin ends) so the caller can shut down cleanly.
 */
export async function runStdioServer(deps: McpDeps): Promise<void> {
  const logger = deps.logger ?? createLogger({ level: 'info', fields: { app: 'mcp' } });
  const server = createMcpServer({ ...deps, logger });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.once('end', () => resolve());
  });
  await server.connect(transport);
  logger.info('mcp stdio server ready');
  await closed;
  await server.close().catch(() => undefined);
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/**
 * Stateless streamable HTTP (§39): a fresh server + transport per request, closed with the
 * response. The daemon hijacks its Fastify reply and passes the raw req/res (and the parsed body).
 * Binding to loopback and host/origin checks are the caller's job.
 */
export async function handleMcpHttp(
  deps: McpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody?: unknown,
): Promise<void> {
  const logger = deps.logger;
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    jsonRpcError(res, 405, -32000, 'Method not allowed: this MCP endpoint is stateless, use POST.');
    return;
  }
  const server = createMcpServer(deps);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  };
  res.on('close', cleanup);
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (e) {
    logger?.error('mcp http request failed', { error: errorMessage(e) });
    jsonRpcError(res, 500, -32603, 'Internal server error');
    cleanup();
  }
}
