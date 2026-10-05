import { z } from 'zod';
import { VpnRootSchema } from './deployment.js';

/**
 * Source config (`sources.shizuoka-vpn-files` in config.yaml, merged over the profile entry).
 * Everything here keeps the walk polite and bounded; the whole accessible tree is indexed
 * metadata-only (the crawl is NOT filtered by enrolled courses — course links are best-effort).
 */
export const ShizuokaVpnFilesConfigSchema = z.looseObject({
  /** Per-root enable/disable by `key`, plus extra roots to also walk (explicit include list). */
  roots: z
    .object({
      /** Keys of built-in roots to turn off (e.g. a 403 root). */
      disable: z.array(z.string()).default([]),
      /** Additional bookmarks/dirs to walk (same shape as a deployment root). */
      include: z.array(VpnRootSchema).default([]),
    })
    .prefault({}),
  walk: z
    .object({
      /** Folders listed per sync run (the rest resume on later runs). */
      maxFoldersPerRun: z.number().int().positive().max(2000).default(60),
      /** Maximum depth below each root (root = depth 0). */
      maxDepth: z.number().int().positive().max(32).default(10),
      /** Ignore folders with more entries than this (defensive against a pathological share). */
      maxEntriesPerFolder: z.number().int().positive().max(100_000).default(5000),
      /** Total files indexed across the whole tree (safety cap). */
      maxFilesTotal: z.number().int().positive().max(1_000_000).default(200_000),
      /** Pause between two list requests (ms), plus up to 50% jitter. */
      requestDelayMs: z.number().int().nonnegative().default(3000),
      /** Attempts per folder within one run before giving up (flaky 403 / empty 200). */
      maxRetries: z.number().int().nonnegative().max(10).default(3),
      /** Base backoff between retries (ms); exponential with jitter. */
      retryBaseMs: z.number().int().nonnegative().default(4000),
      /** Re-list a folder that is already indexed only if this many hours have passed. */
      refreshFolderAfterHours: z.number().int().positive().default(24),
      /** Re-seed the whole tree from the roots this many hours after the last full sweep. */
      rewalkAfterHours: z.number().int().positive().default(72),
    })
    .prefault({}),
  /**
   * Best-effort folder → course hints (never a filter). A folder whose path starts with `path`
   * is attributed to `course` (a course offering id or a course title). Unmatched folders stay
   * visible and browsable.
   */
  courseMap: z
    .array(
      z.object({
        path: z.string().min(1),
        /** Walk root key the path is relative to (default: the first enabled root). */
        root: z.string().optional(),
        course: z.string().min(1),
      }),
    )
    .default([]),
  /** Path prefixes (within a root) whose small files are prefetched into the mirror. */
  prefetch: z.array(z.string()).default([]),
  files: z
    .object({
      extractText: z.boolean().default(false),
      maxExtractBytes: z
        .number()
        .int()
        .positive()
        .default(50 * 1024 * 1024),
      extractExtensions: z.array(z.string()).default(['pdf', 'docx', 'pptx', 'txt', 'md']),
      maxDownloadMB: z.number().positive().max(4096).default(200),
      /** Pause between two downloads (ms), plus up to 50% jitter. */
      downloadDelayMs: z.number().int().nonnegative().default(2000),
      /** Attempts per download before failing (the portal is flaky). */
      maxRetries: z.number().int().nonnegative().max(10).default(3),
    })
    .prefault({}),
  mirror: z
    .object({
      enabled: z.boolean().default(false),
      root: z.string().min(1).default('~/University/VPN'),
      /** `linked`: only folders linked to a course offering; `all`: also prefetch-marked roots. */
      courses: z.enum(['all', 'linked']).default('linked'),
      maxFileMB: z.number().positive().max(4096).default(50),
      maxFilesPerPass: z.number().int().positive().max(1000).default(20),
      trashRetentionDays: z.number().int().nonnegative().default(30),
    })
    .prefault({}),
  browser: z
    .object({
      profileDir: z.string().optional(),
      channel: z.string().optional(),
      executablePath: z.string().optional(),
      bootTimeoutMs: z.number().int().positive().default(90_000),
      loginTimeoutMs: z.number().int().positive().optional(),
    })
    .prefault({}),
});
export type ShizuokaVpnFilesConfig = z.infer<typeof ShizuokaVpnFilesConfigSchema>;
