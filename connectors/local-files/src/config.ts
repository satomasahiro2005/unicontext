import { homedir } from 'node:os';
import path from 'node:path';
import { expandHome } from '@unicontext/core';
import { z } from 'zod';

/** Default exclude patterns: dotfiles/folders, node_modules, Office lock files, temp files. */
export const DEFAULT_EXCLUDE: readonly string[] = [
  '.*',
  'node_modules',
  '~$*',
  '*.tmp',
  '*.crdownload',
  '*.part',
  'Thumbs.db',
  'desktop.ini',
];

/**
 * Folders that name a term/year rather than a course: 2026, 2026年度, 2026前期, 2026-1, 2026_後期,
 * R8後期, 令和8年度, 前期. Extend with `termFolderPattern` (case-insensitive regex).
 */
export const DEFAULT_TERM_FOLDER_PATTERN =
  '^(?:(?:(?:19|20)\\d{2}|[RrＲ令]和?\\s?\\d{1,2})\\s*年?度?[\\s_\\-]*' +
  '(?:前期|後期|前学期|後学期|通年|春学期|秋学期|spring|fall|autumn|summer|winter|[1-4]\\s*q|q\\s*[1-4]|[1-4])?' +
  '|前期|後期|前学期|後学期|通年)$';

export const LocalFilesConfigSchema = z.looseObject({
  /** Directories to scan (already `~`-expanded by core). Default: ~/University. */
  roots: z.array(z.string().min(1)).optional(),
  /** Simple globs (`*`, `**`, `?`); empty = everything. Patterns without `/` match the file name. */
  include: z.array(z.string()).default([]),
  /** Simple globs; patterns without `/` match any path segment (so `node_modules` prunes the folder). */
  exclude: z.array(z.string()).default([...DEFAULT_EXCLUDE]),
  /** Files above this size are listed as metadata only (no text extraction). */
  maxFileSizeMb: z.number().positive().default(50),
  /** Target chunk size in characters. */
  chunkSize: z.number().int().min(100).default(1200),
  /** Overlap between consecutive chunks of one text run. */
  chunkOverlap: z.number().int().min(0).default(120),
  /** Which non-term folder below the root is the course folder (1 = the first one). */
  courseFolderDepth: z.number().int().min(1).default(1),
  /** Regex (case-insensitive) for term folders skipped while inferring the course folder. */
  termFolderPattern: z.string().default(DEFAULT_TERM_FOLDER_PATTERN),
  /** Watch the roots for changes (WatchableAdapter.watch). */
  watch: z.boolean().default(true),
  /** Items per sync page. */
  pageSize: z.number().int().min(1).default(50),
  /** Debounce before a watch batch is emitted (ms). */
  watchDebounceMs: z.number().int().min(0).default(1000),
  /** awaitWriteFinish stability threshold for the watcher (ms). */
  watchStabilityMs: z.number().int().min(0).default(500),
});

export type LocalFilesConfig = z.infer<typeof LocalFilesConfigSchema>;

/** Roots as absolute paths; falls back to ~/University. */
export function resolveRoots(config: Pick<LocalFilesConfig, 'roots'>, home = homedir()): string[] {
  const roots =
    config.roots && config.roots.length > 0 ? config.roots : [path.join(home, 'University')];
  return [...new Set(roots.map((r) => path.resolve(expandHome(r, home))))];
}
