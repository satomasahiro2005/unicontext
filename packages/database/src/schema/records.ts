import {
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/** Facts (§9). value_json holds any JSON value. */
export const facts = sqliteTable(
  'facts',
  {
    id: text('id').primaryKey(),
    subject: text('subject').notNull(),
    predicate: text('predicate').notNull(),
    valueJson: text('value_json').notNull(),
    origin: text('origin').notNull(),
    confidence: real('confidence').notNull(),
    observedAt: text('observed_at').notNull(),
    validFrom: text('valid_from'),
    validUntil: text('valid_until'),
    sourceReferenceId: text('source_reference_id').notNull(),
    producerType: text('producer_type').notNull(),
    producerId: text('producer_id').notNull(),
    evidence: text('evidence'),
    retractedAt: text('retracted_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('facts_subject_predicate').on(t.subject, t.predicate),
    index('facts_source_ref').on(t.sourceReferenceId),
  ],
);

/** One row per (subject, predicate) disagreement (§12). */
export const conflicts = sqliteTable(
  'conflicts',
  {
    id: text('id').primaryKey(),
    subject: text('subject').notNull(),
    predicate: text('predicate').notNull(),
    status: text('status').notNull(),
    candidatesJson: text('candidates_json').notNull(),
    detectedAt: text('detected_at').notNull(),
    resolvedAt: text('resolved_at'),
    resolutionJson: text('resolution_json'),
    reason: text('reason'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('conflicts_subject_predicate').on(t.subject, t.predicate),
    index('conflicts_status').on(t.status),
  ],
);

/** Append-only change history (§13). */
export const changeEvents = sqliteTable(
  'change_events',
  {
    id: text('id').primaryKey(),
    entityId: text('entity_id').notNull(),
    entityKind: text('entity_kind').notNull(),
    type: text('type').notNull(),
    changedFieldsJson: text('changed_fields_json').notNull(),
    beforeJson: text('before_json'),
    afterJson: text('after_json'),
    sourceId: text('source_id'),
    sourceSystem: text('source_system'),
    rawItemId: text('raw_item_id'),
    occurredAt: text('occurred_at').notNull(),
    observedAt: text('observed_at').notNull(),
    courseOfferingId: text('course_offering_id'),
    summary: text('summary'),
  },
  (t) => [
    index('change_events_observed').on(t.observedAt),
    index('change_events_entity').on(t.entityId),
  ],
);

/** Identity resolution decisions (§14). left_id < right_id lexicographically. */
export const identityLinks = sqliteTable(
  'identity_links',
  {
    id: text('id').primaryKey(),
    entityKind: text('entity_kind').notNull(),
    leftId: text('left_id').notNull(),
    rightId: text('right_id').notNull(),
    status: text('status').notNull(),
    score: real('score').notNull(),
    method: text('method').notNull(),
    evidenceJson: text('evidence_json').notNull(),
    decidedBy: text('decided_by').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('identity_links_pair').on(t.leftId, t.rightId),
    index('identity_links_right').on(t.rightId),
  ],
);

/** Tasks (§19). */
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    courseOfferingId: text('course_offering_id'),
    assignmentId: text('assignment_id'),
    examId: text('exam_id'),
    sourceFactIdsJson: text('source_fact_ids_json').notNull(),
    dueAt: text('due_at'),
    status: text('status').notNull(),
    createdBy: text('created_by').notNull(),
    taskKind: text('task_kind').notNull(),
    origin: text('origin').notNull(),
    statusSetBy: text('status_set_by').notNull(),
    statusEvidenceFactId: text('status_evidence_fact_id'),
    evidence: text('evidence'),
    notes: text('notes'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('tasks_due').on(t.dueAt), index('tasks_status').on(t.status)],
);

/** Optional embedding vectors (§16). Empty unless an embedding provider is configured. */
export const embeddings = sqliteTable(
  'embeddings',
  {
    entityId: text('entity_id').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    dims: integer('dims').notNull(),
    vector: blob('vector', { mode: 'buffer' }).notNull(),
    contentHash: text('content_hash').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.entityId, t.provider, t.model] })],
);
