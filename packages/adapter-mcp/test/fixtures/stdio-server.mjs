/* global process */
// Tiny stdio MCP server used by the adapter-mcp tests (spawned with process.execPath).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'stdio-fixture', version: '0.0.1' });

server.registerTool('echo_env', { description: 'returns selected environment variables' }, () => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify([
        {
          id: 'env',
          injected: process.env.UC_TEST_SECRET ?? null,
          literal: process.env.UC_TEST_LITERAL ?? null,
          hostOnly: process.env.UC_HOST_ONLY ?? null,
          cwd: process.cwd(),
        },
      ]),
    },
  ],
}));

await server.connect(new StdioServerTransport());
