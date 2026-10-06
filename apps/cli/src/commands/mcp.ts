import {
  type DetailFetchReport,
  downloadCourseFiles,
  type DownloadFilesReport,
  fetchDetailsOnRequest,
  openAnnouncements,
  type OpenAnnouncementsReport,
} from '@unicontext/context-engine';
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
            // The daemon holds the LiveCampusU session and serializes this with its sync.
            openAnnouncements: async (ids) => {
              const daemon = await ctx.daemon();
              return daemon
                ? daemon.post<OpenAnnouncementsReport>(
                    '/api/v1/announcements/open',
                    { ids },
                    { timeoutMs: 15 * 60_000 },
                  )
                : openAnnouncements(rt.uc, ids);
            },
            // The daemon's syllabus connector paces on-demand detail reads with its sync.
            fetchDetails: async (ids) => {
              const daemon = await ctx.daemon();
              return daemon
                ? daemon.post<DetailFetchReport>(
                    '/api/v1/details/fetch',
                    { ids },
                    { timeoutMs: 5 * 60_000 },
                  )
                : fetchDetailsOnRequest(rt.uc, ids);
            },
            // The daemon holds the browser profile and serializes downloads with its sync.
            filesDir: rt.filesDir,
            downloadFiles: async (refs, o) => {
              const daemon = await ctx.daemon();
              return daemon
                ? daemon.post<DownloadFilesReport>(
                    '/api/v1/files/download',
                    { ids: refs, extract: o.extract },
                    { timeoutMs: 30 * 60_000 },
                  )
                : downloadCourseFiles(rt.uc, refs, { filesDir: rt.filesDir, extract: o.extract });
            },
          });
        },
        { alwaysLog: true },
      ),
    );
}
