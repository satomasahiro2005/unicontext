import type { Capability, HealthStatus } from '@unicontext/canonical-model';
import { z } from 'zod';

export type { Capability, HealthStatus, HealthState } from '@unicontext/canonical-model';

export const AuthResultSchema = z.object({
  status: z.enum(['authenticated', 'not_required', 'auth_required', 'failed']),
  /** Display account (e.g. UPN). Never a token. */
  account: z.string().optional(),
  expiresAt: z.string().optional(),
  message: z.string().optional(),
});
export type AuthResult = z.infer<typeof AuthResultSchema>;

/** initial = first run, incremental = from stored cursor, full = relist everything (§35). */
export type SyncMode = 'initial' | 'incremental' | 'full';

/** Opaque incremental state persisted by the sync engine between runs (§35). */
export interface SyncCursor {
  cursor?: string;
  etag?: string;
  deltaToken?: string;
  lastModified?: string;
  extra?: Record<string, unknown>;
}

export interface SyncInput {
  mode: SyncMode;
  /** Cursor from the previous successful run (or previous page). */
  cursor?: SyncCursor;
  /** Page token returned by the previous page within the same run. */
  pageToken?: string;
  /** Limit the run to some capabilities (undefined = all). */
  capabilities?: Capability[];
  signal?: AbortSignal;
}

export interface RawBlobPayload {
  data: Uint8Array;
  mimeType?: string;
}

/** One item exactly as the source returned it (raw-first, §6). */
export interface RawItem {
  /** Item type in the source's vocabulary, e.g. "lcu.course". */
  sourceType: string;
  /** Stable id in the source system. */
  externalId: string;
  /** JSON-serializable payload, unmodified. Must not contain credentials. */
  payload: unknown;
  sourceUpdatedAt?: string;
  blobs?: RawBlobPayload[];
  /**
   * Old content seen for the first time (e.g. a channel read for the first time after the source's
   * initial run): stored and normalized as usual, but its new entities are not reported as
   * `created` changes, so a backfill spread over several runs does not look like news.
   */
  backfill?: boolean;
}

export interface RawDeletion {
  sourceType: string;
  externalId: string;
}

export interface SyncResult {
  items: RawItem[];
  /** Explicit deletions (e.g. Graph delta @removed). */
  deletions?: RawDeletion[];
  /** Cursor to persist when the run finishes (last page wins). */
  cursor?: SyncCursor;
  /** More pages follow; the engine calls sync again with pageToken. */
  hasMore?: boolean;
  nextPageToken?: string;
  /**
   * Declares that, across all pages of this run, every live item of these types was returned.
   * Items of these types not seen are marked deleted (full-listing sources without delete feeds).
   */
  complete?: { sourceTypes: string[] };
  /** Product version detected from the response (§72). */
  productVersion?: { product: string; version: string };
  warnings?: string[];
}

/** The adapter contract, exactly as specified in §5. */
export interface SourceAdapter {
  id: string;
  version: string;
  capabilities(): Promise<Capability[]>;
  authenticate(): Promise<AuthResult>;
  sync(input: SyncInput): Promise<SyncResult>;
  health(): Promise<HealthStatus>;
  dispose(): Promise<void>;
}

/** Optional extension: adapters of unofficial products can report the product version (§72). */
export interface VersionAwareAdapter extends SourceAdapter {
  detectProductVersion(): Promise<{ product: string; version: string } | undefined>;
}

export function isVersionAware(adapter: SourceAdapter): adapter is VersionAwareAdapter {
  return typeof (adapter as Partial<VersionAwareAdapter>).detectProductVersion === 'function';
}

/** Options for an interactive login started by a human (CLI `login <source>`, Web UI). */
export interface InteractiveLoginOptions {
  signal?: AbortSignal;
  /** Account hint (e.g. UPN) passed to the identity provider. */
  loginHint?: string;
  /** Override how URLs are opened (default: the system browser). */
  openBrowser?: (url: string) => Promise<void> | void;
  /** Max time to wait for the human, in ms. */
  timeoutMs?: number;
  /** Progress the human should see while nothing happens on screen (e.g. waiting for a lock). */
  notify?: (message: string) => void;
}

/**
 * Optional extension: adapters whose authentication needs a human (OAuth consent, SSO + MFA in a
 * browser). `authenticate()` must stay non-interactive and return `auth_required`; the host calls
 * `login()` only on an explicit user action.
 */
export interface InteractiveAuthAdapter extends SourceAdapter {
  login(options?: InteractiveLoginOptions): Promise<AuthResult>;
  /** Forget stored credentials/sessions for this source. */
  logout?(): Promise<void>;
}

export function supportsInteractiveLogin(
  adapter: SourceAdapter,
): adapter is InteractiveAuthAdapter {
  return typeof (adapter as Partial<InteractiveAuthAdapter>).login === 'function';
}

/** Listener for pushed changes (filesystem events, watched import folders). */
export interface WatchListener {
  /** Hand the result to SyncEngine.ingest(sourceId, result). */
  onResult(result: SyncResult): void | Promise<void>;
  onError?(error: unknown): void;
}

export interface WatchHandle {
  close(): Promise<void>;
}

/**
 * Optional extension: event-driven sources (§23, §22). The daemon calls `watch()` once and feeds
 * every result into `SyncEngine.ingest`. Scheduled/explicit `sync()` must still work without it.
 */
export interface WatchableAdapter extends SourceAdapter {
  watch(listener: WatchListener): Promise<WatchHandle>;
}

export function isWatchable(adapter: SourceAdapter): adapter is WatchableAdapter {
  return typeof (adapter as Partial<WatchableAdapter>).watch === 'function';
}

/**
 * Fetch announcement bodies the user explicitly asked for, even when that changes state at the
 * source (LiveCampusU marks an opened notice read and cannot set it back). Never part of a sync:
 * only the CLI / REST / Web UI / MCP "open" actions call it, and adapters serialize it with sync().
 */
export interface OpenAnnouncementsAdapter extends SourceAdapter {
  openAnnouncements(
    requests: readonly { externalId: string; previousPayload?: unknown }[],
    options: { acceptMarksRead: true; signal?: AbortSignal },
  ): Promise<OpenAnnouncementsResult>;
}

export interface OpenAnnouncementsResult {
  /** The announcements' raw items with their bodies (ingest them with SyncEngine.ingest). */
  items: RawItem[];
  results: {
    externalId: string;
    status: 'opened' | 'notFound' | 'failed';
    /** It was unread at the source before (opening it marked it read there). */
    wasUnread?: boolean;
    error?: string;
  }[];
  warnings: string[];
}

export function supportsOpenAnnouncements(
  adapter: SourceAdapter,
): adapter is OpenAnnouncementsAdapter {
  return typeof (adapter as Partial<OpenAnnouncementsAdapter>).openAnnouncements === 'function';
}

/**
 * Optional extension: fetch, on the user's request, the full version of items a sync stored only
 * partially (e.g. a syllabus list row whose detail page the budgeted sync has not opened yet).
 * Read-only at the source; the adapter paces it with its sync through the same HTTP session and
 * rate limiter. The caller ingests the returned items with SyncEngine.ingest.
 */
export interface DetailFetchAdapter extends SourceAdapter {
  fetchDetails(
    requests: readonly { externalId: string; sourceType?: string; previousPayload?: unknown }[],
    options?: { signal?: AbortSignal },
  ): Promise<DetailFetchResult>;
}

export interface DetailFetchResult {
  /** Raw items with their details (ingest them with SyncEngine.ingest). */
  items: RawItem[];
  results: {
    externalId: string;
    /**
     * fetched = read now; alreadyFetched = a fresh copy was already there (returned as an item);
     * queued = could not be read now, the next sync reads it first; notFound = the source no
     * longer lists it; failed = could not be read and was not queued.
     */
    status: 'fetched' | 'alreadyFetched' | 'queued' | 'notFound' | 'failed';
    error?: string;
  }[];
  warnings: string[];
}

export function supportsDetailFetch(adapter: SourceAdapter): adapter is DetailFetchAdapter {
  return typeof (adapter as Partial<DetailFetchAdapter>).fetchDetails === 'function';
}

/**
 * A file a source can download on request (a document in a class team's library). Described by
 * the adapter from its raw item, so the caller can name, place and version it without knowing the
 * source's payload shapes.
 */
export interface DownloadableFile {
  externalId: string;
  /** File name as shown at the source. */
  name: string;
  /** Team / site the file belongs to (display name) and its stable id. */
  container: string;
  containerId: string;
  /** The container is a class (course) team. */
  isClass: boolean;
  /** Folder inside the container's library: '' = root, '/'-separated, no leading slash. */
  folder: string;
  /** Changes whenever the content changes (SharePoint cTag / eTag). */
  version: string;
  sizeBytes: number | undefined;
  modifiedAt: string | undefined;
  mimeType: string | undefined;
}

export interface FileDownloadRequest {
  externalId: string;
  /** The file's current raw payload (as stored by the last sync). */
  payload: unknown;
  /** Where to write the file (directories are created; written to `<path>.part`, then renamed). */
  targetPath: string;
  /** Refuse files larger than this (bytes). */
  maxBytes: number;
  /** Extract text (supported formats only) and return it as a raw item to ingest. */
  extract: boolean;
  /** The file is already at targetPath in this version: only extract its text, do not download. */
  extractOnly?: boolean;
}

export interface FileDownloadOutcome {
  externalId: string;
  status: 'downloaded' | 'extracted' | 'tooLarge' | 'notFound' | 'failed';
  bytes?: number;
  contentType?: string;
  /** Version that was written (from the payload). */
  version?: string;
  /** Characters / pages of the extracted text (undefined when nothing was extracted). */
  text?: { chars: number; pages: number };
  error?: string;
}

export interface FileDownloadSettings {
  /** Largest file an on-demand download accepts (bytes). */
  maxDownloadBytes: number;
  /** Local mirror of the source's files (off unless configured). */
  mirror?: FileMirrorSettings;
}

export interface FileMirrorSettings {
  enabled: boolean;
  /** Absolute directory (a leading ~ is already expanded). */
  root: string;
  /** `linked`: only class teams linked to an offering of the academic system. */
  courses: 'all' | 'linked';
  maxFileBytes: number;
  /** Downloads per pass (the rest follow on later passes). */
  maxFilesPerPass: number;
  /** Days files moved to `<root>/.trash` are kept. */
  trashRetentionDays: number;
}

/**
 * Optional extension: download files the source lists (read-only at the source). Only on-demand
 * requests (CLI / REST / Web UI / MCP) and the opt-in mirror call it; adapters serialize it with
 * sync() when they share a session.
 */
export interface FileDownloadAdapter extends SourceAdapter {
  /** Raw source types whose items are files (`describeFile` understands them). */
  readonly fileSourceTypes: readonly string[];
  /** Raw source types holding text extracted from those files (same external ids). */
  readonly fileTextSourceTypes: readonly string[];
  fileSettings(): FileDownloadSettings;
  describeFile(item: {
    sourceType: string;
    externalId: string;
    payload: unknown;
  }): DownloadableFile | undefined;
  downloadFiles(
    requests: readonly FileDownloadRequest[],
    options?: { signal?: AbortSignal },
  ): Promise<{ results: FileDownloadOutcome[]; items: RawItem[]; warnings: string[] }>;
}

export function supportsFileDownloads(adapter: SourceAdapter): adapter is FileDownloadAdapter {
  const a = adapter as Partial<FileDownloadAdapter>;
  return typeof a.downloadFiles === 'function' && typeof a.describeFile === 'function';
}
