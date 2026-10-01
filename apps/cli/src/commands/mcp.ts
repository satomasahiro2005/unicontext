import type { Command } from 'commander';
import { action, type Harness } from '../harness.js';
import { VERSION } from '../version.js';

/**
 * `unicontext mcp`: MCP server on stdio (§39). stdout carries only the protocol, so nothing in
 * this path may print there; runtime logs are forced to stderr (CliContext alwaysLog).
 */
export function registerMcp(program: Command, h: Harness): void {
  program
    .command('mcp')
    .description('MCPサーバーをstdioで起動する / Run the MCP server on stdio (for AI clients)')
    .action(
      action(
        h,
        async (ctx) => {
          const rt = await ctx.runtime();
          await ctx.deps.runStdioServer({
            uc: rt.uc,
            proposals: rt.proposals,
            logger: rt.logger,
            version: VERSION,
          });
        },
        { alwaysLog: true },
      ),
    );
}
