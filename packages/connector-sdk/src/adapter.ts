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
