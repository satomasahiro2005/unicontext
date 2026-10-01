import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/** One row per configured source instance (§6). */
export const rawSources = sqliteTable('raw_sources', {
  id: text('id').primaryKey(),
  connector: text('connector').notNull(),
  adapter: text('adapter'),
  displayName: text('display_name'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastSyncAt: text('last_sync_at'),
});

/** Raw payloads exactly as fetched (§6). Normalization reads from here, never from the network. */
export const rawItems = sqliteTable(
  'raw_items',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => rawSources.id),
    sourceType: text('source_type').notNull(),
    externalId: text('external_id').notNull(),
    payloadJson: text('payload_json').notNull(),
    fetchedAt: text('fetched_at').notNull(),
    sourceUpdatedAt: text('source_updated_at'),
    contentHash: text('content_hash').notNull(),
    deletedAt: text('deleted_at'),
    normalizedAt: text('normalized_at'),
    normalizedHash: text('normalized_hash'),
    normalizerVersion: text('normalizer_version'),
    normalizeError: text('normalize_error'),
  },
  (t) => [
    uniqueIndex('raw_items_source_key').on(t.sourceId, t.sourceType, t.externalId),
    index('raw_items_pending').on(t.sourceId, t.normalizedAt),
  ],
);

/** Binary attachments (PDF, slides, audio). Stored under <data>/blobs or inline when no dir is configured. */
export const rawBlobs = sqliteTable(
  'raw_blobs',
  {
    id: text('id').primaryKey(),
    sha256: text('sha256').notNull(),
    sourceId: text('source_id').notNull(),
    rawItemId: text('raw_item_id'),
    mimeType: text('mime_type'),
    size: integer('size').notNull(),
    storage: text('storage').notNull(),
    path: text('path'),
    data: blob('data', { mode: 'buffer' }),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('raw_blobs_source').on(t.sourceId), index('raw_blobs_item').on(t.rawItemId)],
);

/** Incremental sync state (§35). scope allows several cursors per source (e.g. per Graph resource). */
export const syncState = sqliteTable(
  'sync_state',
  {
    sourceId: text('source_id').notNull(),
    scope: text('scope').notNull().default(''),
    cursor: text('cursor'),
    etag: text('etag'),
    deltaToken: text('delta_token'),
    lastModified: text('last_modified'),
    extraJson: text('extra_json'),
    lastMode: text('last_mode'),
    lastFullSyncAt: text('last_full_sync_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.scope] })],
);

/** Latest health per source (§38). */
export const connectorHealth = sqliteTable('connector_health', {
  sourceId: text('source_id').primaryKey(),
  state: text('state').notNull(),
  message: text('message'),
  checkedAt: text('checked_at').notNull(),
  lastSuccessAt: text('last_success_at'),
  lastFailureAt: text('last_failure_at'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  retryAfter: text('retry_after'),
  detectedVersion: text('detected_version'),
});

/** Unknown/missing fields seen in API payloads (§73). */
export const schemaDrift = sqliteTable(
  'schema_drift',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id').notNull(),
    sourceType: text('source_type').notNull(),
    fieldPath: text('field_path').notNull(),
    driftKind: text('drift_kind').notNull(),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    occurrences: integer('occurrences').notNull().default(1),
    sampleRawItemId: text('sample_raw_item_id'),
    resolvedAt: text('resolved_at'),
  },
  (t) => [uniqueIndex('schema_drift_key').on(t.sourceId, t.sourceType, t.fieldPath, t.driftKind)],
);

/** Detected product versions for unofficial APIs (§72). */
export const productVersions = sqliteTable(
  'product_versions',
  {
    sourceId: text('source_id').notNull(),
    product: text('product').notNull(),
    version: text('version').notNull(),
    known: integer('known', { mode: 'boolean' }).notNull(),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.product, t.version] })],
);
