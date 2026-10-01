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
