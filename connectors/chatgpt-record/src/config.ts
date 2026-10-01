import { homedir } from 'node:os';
import path from 'node:path';
import { expandHome } from '@unicontext/core';
import { z } from 'zod';

/**
 * Folders that name a term/year rather than a course (2026前期, 2026-1, R8後期 ...). Skipped while
 * inferring the course hint from `Records/<course>/<file>`.
 */
export const DEFAULT_TERM_FOLDER_PATTERN =
  '^(?:(?:(?:19|20)\\d{2}|[RrＲ令]和?\\s?\\d{1,2})\\s*年?度?[\\s_\\-]*' +
  '(?:前期|後期|前学期|後学期|通年|春学期|秋学期|spring|fall|autumn|summer|winter|[1-4]\\s*q|q\\s*[1-4]|[1-4])?' +
  '|前期|後期|前学期|後学期|通年)$';

export const ChatGptRecordConfigSchema = z.looseObject({
  /** Folder watched for transcript files. Default: ~/University/Records. */
  watchDir: z.string().min(1).optional(),
  /** Watch the folder for changes (WatchableAdapter.watch). */
  watch: z.boolean().default(true),
  /** File extensions treated as transcripts. */
  extensions: z.array(z.string()).default(['txt', 'md', 'vtt', 'srt', 'json']),
  /** Importer id stored on LectureTranscript.importer (e.g. "zoom" for a Zoom folder). */
  importer: z.string().min(1).default('chatgpt-record'),
  /** Larger files are skipped with a warning. */
  maxFileSizeMb: z.number().positive().default(20),
  /** Regex (case-insensitive) for term folders skipped when inferring the course folder. */
  termFolderPattern: z.string().default(DEFAULT_TERM_FOLDER_PATTERN),
  /** Items per sync page. */
  pageSize: z.number().int().min(1).default(50),
  /** Debounce before a watch batch is emitted (ms). */
  watchDebounceMs: z.number().int().min(0).default(1000),
  /** awaitWriteFinish stability threshold for the watcher (ms). */
  watchStabilityMs: z.number().int().min(0).default(500),
});

export type ChatGptRecordConfig = z.infer<typeof ChatGptRecordConfigSchema>;

/** Absolute watch directory (default ~/University/Records). */
export function resolveWatchDir(
  config: Pick<ChatGptRecordConfig, 'watchDir'>,
  home = homedir(),
): string {
  return path.resolve(
    expandHome(config.watchDir ?? path.join(home, 'University', 'Records'), home),
  );
}
