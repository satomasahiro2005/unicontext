import { z } from 'zod';

/**
 * Raw item types stored for the VPN file share. Two of them describe the tree (folders and files,
 * both metadata-only), and one holds text extracted from a downloaded file.
 */
export const RAW_TYPES = ['szvpn.folder', 'szvpn.file', 'szvpn.fileText'] as const;
export type RawType = (typeof RAW_TYPES)[number];

export function isRawType(t: string): t is RawType {
  return (RAW_TYPES as readonly string[]).includes(t);
}

/** Best-effort course attribution stored on a file/folder (see courses.ts). */
export const CourseHintSchema = z.object({
  coursePath: z.string(),
  title: z.string(),
  year: z.number().int().optional(),
  teacher: z.string().optional(),
  explicitCourse: z.string().optional(),
});

/**
 * One entry of the Ivanti `GET /api/v1/fb/list` response (a file or folder). The list wraps these
 * in `{ files: [...], ui_vars: {...} }`. `.` and `..` appear first and are dropped. Used for schema
 * drift only; sizes/timestamps are the human-formatted strings the appliance returns.
 */
export const FbEntrySchema = z.looseObject({
  name: z.string(),
  isFile: z.string(),
  size: z.union([z.string(), z.number()]).optional(),
  timestamp: z.string().optional(),
  attrs: z.string().optional(),
});

export const FbListResponseSchema = z.looseObject({
  files: z.array(FbEntrySchema).optional(),
  sharePath: z.string().optional(),
  DirEntries: z.array(z.unknown()).optional(),
  ui_vars: z.looseObject({}).optional(),
});
export type FbListResponse = z.infer<typeof FbListResponseSchema>;

/**
 * A folder of the share, stored metadata-only. `listedAt`/`status` are only written when the
 * listing succeeded, so the last good listing survives a later flaky failure (the research doc
 * §3.4, §5.4). Folders are kept in the raw store but produce no canonical entity (there is no
 * folder entity kind); the context engine reads them for the browse tree.
 */
export const FolderPayloadSchema = z.object({
  /** The walk root this folder belongs to (profile `roots[].key`), e.g. "fs-share-class". */
  root: z.string(),
  /** Path relative to the root ('' = the root itself), '/'-separated. */
  path: z.string(),
  /** Display name (last path segment), '' for the root. */
  name: z.string(),
  /** Parent folder path within the root (undefined for the root). */
  parent: z.string().optional(),
  /** Full human-facing path, e.g. "FS share / class / 2026...". */
  label: z.string(),
  /** The Ivanti resource id and bookmark needed to list/download under this folder. */
  resourceId: z.string(),
  bookmark: z.string(),
  /** Share-relative directory passed to the fb API as `dir`. */
  dir: z.string(),
  /** Last time this folder was listed (ISO): for `ok`, the last successful listing. */
  listedAt: z.string(),
  /**
   * `ok` = listed successfully at `listedAt`. `forbidden` = only ever answered 403/empty (a known
   * but unreadable folder, e.g. report/student/submit). A folder that was once `ok` is never
   * downgraded to `forbidden` on a later flaky failure (research §3.4, §5.4).
   */
  status: z.enum(['ok', 'forbidden']),
  /** The appliance message for a forbidden folder (e.g. "ファイル参照エラー"). */
  accessError: z.string().optional(),
  childFileCount: z.number().int().nonnegative(),
  childFolderCount: z.number().int().nonnegative(),
  depth: z.number().int().nonnegative(),
  /**
   * Direct children from the last successful listing, so the browse tree can be rendered from the
   * folder record alone (subfolders show even before they are listed themselves). Files also exist
   * as their own `szvpn.file` items (for search / download / recent); this is the folder view.
   */
  children: z
    .array(
      z.object({
        name: z.string(),
        isFile: z.boolean(),
        /** Path relative to the root. */
        path: z.string(),
        sizeBytes: z.number().int().nonnegative().optional(),
        modifiedAt: z.string().optional(),
      }),
    )
    .default([]),
  /** Best-effort course attribution of this folder (never a filter). */
  course: CourseHintSchema.nullable().default(null),
});
export type FolderPayload = z.infer<typeof FolderPayloadSchema>;

/** A file of the share, stored metadata-only; the bytes are fetched on request. */
export const FilePayloadSchema = z.object({
  root: z.string(),
  /** Parent folder path within the root. */
  parent: z.string(),
  /** Path relative to the root, '/'-separated, including the file name. */
  path: z.string(),
  name: z.string(),
  /** Full human-facing path for display. */
  label: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
  /** The size string exactly as the appliance returned it (e.g. "14.00 KB"). */
  sizeText: z.string().optional(),
  /** Modified time as an ISO instant when it could be parsed. */
  modifiedAt: z.string().optional(),
  /** The timestamp string exactly as the appliance returned it. */
  modifiedText: z.string().optional(),
  mimeType: z.string().optional(),
  /** Ivanti resource id / bookmark / share-relative dir + file, for `wfd.cgi`. */
  resourceId: z.string(),
  bookmark: z.string(),
  dir: z.string(),
  /** Version = timestamp text + size (SMB has no cTag), for change detection. */
  version: z.string(),
  listedAt: z.string(),
  /** Best-effort course attribution (never a filter). Null when none was inferred. */
  course: CourseHintSchema.nullable().default(null),
  /** The file sits under a configured prefetch prefix (opt-in mirror). */
  prefetch: z.boolean().default(false),
});
export type FilePayload = z.infer<typeof FilePayloadSchema>;

export const FileTextPayloadSchema = z.object({
  externalId: z.string(),
  path: z.string(),
  name: z.string(),
  version: z.string(),
  text: z.string(),
  pages: z.array(z.object({ page: z.number().int(), text: z.string() })).optional(),
});
export type FileTextPayload = z.infer<typeof FileTextPayloadSchema>;

export const SCHEMAS = {
  'szvpn.folder': FolderPayloadSchema,
  'szvpn.file': FilePayloadSchema,
  'szvpn.fileText': FileTextPayloadSchema,
} as const satisfies Record<RawType, z.ZodType>;
