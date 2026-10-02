import { createReadStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import {
  ADDITIONS_SOURCE_ID,
  type CanonicalEntity,
  ChangeEventSchema,
  ConflictSchema,
  ENTITY_KINDS,
  FactSchema,
  IdentityLinkSchema,
  parseEntity,
  SourceReferenceSchema,
  TaskSchema,
} from '@unicontext/canonical-model';
import { type Clock, systemClock, ValidationError } from '@unicontext/core';
import { and, asc, eq, getTableName, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { UniContextDatabase } from './db.js';
import {
  conflictToRow,
  factToRow,
  linkToRow,
  rowToConflict,
  rowToFact,
  rowToLink,
  rowToTask,
  taskToRow,
} from './mappers.js';
import { currentSchemaVersion } from './migrate.js';
import { ENTITY_TABLES, sourceReferences } from './schema/entities.js';
import { conflicts, facts, identityLinks, tasks } from './schema/records.js';
import { AdditionStore } from './stores/addition-store.js';
import { ChangeEventStore } from './stores/change-event-store.js';
import { EntityStore } from './stores/entity-store.js';
import { RawStore } from './stores/raw-store.js';
import { SourceReferenceStore } from './stores/source-ref-store.js';
import {
  HealthStore,
  ProductVersionStore,
  SchemaDriftStore,
  SyncStateStore,
} from './stores/source-state-stores.js';

export const JSONL_FORMAT = 'unicontext-jsonl';
export const JSONL_VERSION = 1;

const HeaderSchema = z.object({
  type: z.literal('header'),
  format: z.literal(JSONL_FORMAT),
  version: z.number().int(),
  schemaVersion: z.number().int(),
  exportedAt: z.string(),
});

const LineSchema = z.discriminatedUnion('type', [
  HeaderSchema,
  z.object({
    type: z.literal('entity'),
    sourceId: z.string().nullable().optional(),
    deletedAt: z.string().nullable().optional(),
    data: z.unknown(),
  }),
  z.object({ type: z.literal('sourceReference'), data: SourceReferenceSchema }),
  z.object({ type: z.literal('fact'), data: FactSchema }),
  z.object({ type: z.literal('conflict'), data: ConflictSchema }),
  z.object({ type: z.literal('changeEvent'), data: ChangeEventSchema }),
  z.object({ type: z.literal('identityLink'), data: IdentityLinkSchema }),
  z.object({ type: z.literal('task'), data: TaskSchema }),
]);
export type JsonlLine = z.infer<typeof LineSchema>;

/** Stream the canonical model as JSONL lines (§68). Raw payloads and secrets are never exported. */
export function* exportJsonl(
  db: UniContextDatabase,
  options: { includeDeleted?: boolean; now?: Date } = {},
): Generator<string> {
  yield JSON.stringify({
    type: 'header',
    format: JSONL_FORMAT,
    version: JSONL_VERSION,
    schemaVersion: currentSchemaVersion(db.sqlite),
    exportedAt: (options.now ?? new Date()).toISOString(),
  });
  for (const kind of ENTITY_KINDS) {
    const name = getTableName(ENTITY_TABLES[kind]);
    const rows = db.sqlite
      .prepare(
        `SELECT data, source_id, deleted_at FROM ${name}${options.includeDeleted ? '' : ' WHERE deleted_at IS NULL'} ORDER BY id`,
      )
      .all() as { data: string; source_id: string | null; deleted_at: string | null }[];
    for (const r of rows) {
      yield JSON.stringify({
        type: 'entity',
        sourceId: r.source_id,
        ...(r.deleted_at ? { deletedAt: r.deleted_at } : {}),
        data: JSON.parse(r.data) as unknown,
      });
    }
  }
  const refs = new SourceReferenceStore(db);
  for (const r of db.orm
    .select({ id: sourceReferences.id })
    .from(sourceReferences)
    .orderBy(asc(sourceReferences.id))
    .all()) {
    const ref = refs.get(r.id);
    if (ref) yield JSON.stringify({ type: 'sourceReference', data: ref });
  }
  for (const r of db.orm.select().from(facts).orderBy(asc(facts.id)).all())
    yield JSON.stringify({ type: 'fact', data: rowToFact(r) });
  for (const r of db.orm.select().from(conflicts).orderBy(asc(conflicts.id)).all())
    yield JSON.stringify({ type: 'conflict', data: rowToConflict(r) });
  for (const e of new ChangeEventStore(db).list())
    yield JSON.stringify({ type: 'changeEvent', data: e });
  for (const r of db.orm.select().from(identityLinks).orderBy(asc(identityLinks.id)).all())
    yield JSON.stringify({ type: 'identityLink', data: rowToLink(r) });
  for (const r of db.orm.select().from(tasks).orderBy(asc(tasks.id)).all())
    yield JSON.stringify({ type: 'task', data: rowToTask(r) });
}

export function exportJsonlToFile(
  db: UniContextDatabase,
  file: string,
  options: { includeDeleted?: boolean; now?: Date } = {},
): number {
  mkdirSync(path.dirname(file), { recursive: true });
  let count = 0;
  const lines: string[] = [];
  for (const line of exportJsonl(db, options)) {
    lines.push(line);
    count++;
  }
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return count - 1;
}

export interface ImportReport {
  imported: Record<Exclude<JsonlLine['type'], 'header'>, number>;
  errors: { line: number; message: string }[];
}

/**
 * Import JSONL produced by exportJsonl (merge: rows are upserted by id). Invalid lines are
 * reported, not fatal, unless strict is set.
 */
export function importJsonl(
  db: UniContextDatabase,
  lines: Iterable<string>,
  options: { strict?: boolean; clock?: Clock } = {},
): ImportReport {
  const clock = options.clock ?? systemClock;
  const entities = new EntityStore(db, { clock });
  const refs = new SourceReferenceStore(db);
  const changes = new ChangeEventStore(db);
  const report: ImportReport = {
    imported: {
      entity: 0,
      sourceReference: 0,
      fact: 0,
      conflict: 0,
      changeEvent: 0,
      identityLink: 0,
      task: 0,
    },
    errors: [],
  };
  let n = 0;
  let sawHeader = false;
  db.transaction(() => {
    for (const raw of lines) {
      n++;
      const text = raw.trim();
      if (!text) continue;
      try {
        const parsed = LineSchema.parse(JSON.parse(text));
        const now = clock.now().toISOString();
        switch (parsed.type) {
          case 'header':
            if (parsed.version > JSONL_VERSION)
              throw new ValidationError(`Unsupported JSONL version ${parsed.version}`);
            sawHeader = true;
            break;
          case 'entity': {
            const entity: CanonicalEntity = parseEntity(parsed.data);
            entities.upsert(entity, { ...(parsed.sourceId ? { sourceId: parsed.sourceId } : {}) });
            if (parsed.deletedAt) entities.softDelete(entity.id, parsed.deletedAt);
            report.imported.entity++;
            break;
          }
          case 'sourceReference':
            refs.upsert(parsed.data);
            report.imported.sourceReference++;
            break;
          case 'fact': {
            const row = factToRow(parsed.data, now);
            db.orm
              .insert(facts)
              .values(row)
              .onConflictDoUpdate({ target: facts.id, set: row })
              .run();
            report.imported.fact++;
            break;
          }
          case 'conflict': {
            const row = conflictToRow(parsed.data, now);
            db.orm
              .delete(conflicts)
              .where(
                and(
                  eq(conflicts.subject, row.subject),
                  eq(conflicts.predicate, row.predicate),
                  ne(conflicts.id, row.id),
                ),
              )
              .run();
            db.orm
              .insert(conflicts)
              .values(row)
              .onConflictDoUpdate({ target: conflicts.id, set: row })
              .run();
            report.imported.conflict++;
            break;
          }
          case 'changeEvent':
            changes.append(parsed.data);
            report.imported.changeEvent++;
            break;
          case 'identityLink': {
            const row = linkToRow(parsed.data);
            db.orm
              .insert(identityLinks)
              .values(row)
              .onConflictDoUpdate({ target: identityLinks.id, set: row })
              .run();
            report.imported.identityLink++;
            break;
          }
          case 'task': {
            const row = taskToRow(parsed.data);
            db.orm
              .insert(tasks)
              .values(row)
              .onConflictDoUpdate({ target: tasks.id, set: row })
              .run();
            report.imported.task++;
            break;
          }
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (options.strict) throw new ValidationError(`JSONL line ${n}: ${message}`, { cause: e });
        report.errors.push({ line: n, message });
      }
    }
    if (!sawHeader && options.strict) throw new ValidationError('JSONL header missing');
  });
  return report;
}

export async function importJsonlFile(
  db: UniContextDatabase,
  file: string,
  options: { strict?: boolean; clock?: Clock } = {},
): Promise<ImportReport> {
  const lines: string[] = [];
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) lines.push(line);
  return importJsonl(db, lines, options);
}

export interface BackupResult {
  directory: string;
  databaseFile: string;
  mappingsFile: string;
  metadataFile: string;
}

/**
 * Backup (§62): consistent DB snapshot + identity mappings + metadata. Secrets live in the OS
 * keychain and are therefore never part of a backup.
 */
export async function backupDatabase(
  db: UniContextDatabase,
  destinationRoot: string,
  options: { now?: Date } = {},
): Promise<BackupResult> {
  const now = options.now ?? new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const directory = path.join(destinationRoot, `unicontext-backup-${stamp}`);
  mkdirSync(directory, { recursive: true });
  const databaseFile = path.join(directory, 'unicontext.db');
  await db.sqlite.backup(databaseFile);
  const mappingsFile = path.join(directory, 'mappings.json');
  const links = db.orm
    .select()
    .from(identityLinks)
    .orderBy(asc(identityLinks.id))
    .all()
    .map(rowToLink);
  writeFileSync(mappingsFile, `${JSON.stringify({ identityLinks: links }, null, 2)}\n`);
  const metadataFile = path.join(directory, 'metadata.json');
  const raw = new RawStore(db);
  writeFileSync(
    metadataFile,
    `${JSON.stringify(
      {
        createdAt: now.toISOString(),
        schemaVersion: currentSchemaVersion(db.sqlite),
        sources: raw.listSources(),
        entityCounts: new EntityStore(db).counts(),
        containsSecrets: false,
      },
      null,
      2,
    )}\n`,
  );
  return { directory, databaseFile, mappingsFile, metadataFile };
}

export interface PurgeReport {
  sourceId: string;
  rawItems: number;
  rawBlobs: number;
  sourceReferences: number;
  facts: number;
  entities: number;
  tasks: number;
  conflicts: number;
  identityLinks: number;
  changeEvents: number;
}

/** Delete everything that came from one source (§63), e.g. `unicontext purge source edstem`. */
export function purgeSource(db: UniContextDatabase, sourceId: string): PurgeReport {
  const raw = new RawStore(db);
  const entities = new EntityStore(db);
  const refs = new SourceReferenceStore(db);
  const report: PurgeReport = {
    sourceId,
    rawItems: 0,
    rawBlobs: 0,
    sourceReferences: 0,
    facts: 0,
    entities: 0,
    tasks: 0,
    conflicts: 0,
    identityLinks: 0,
    changeEvents: 0,
  };
  // Blob files are unlinked only after the transaction committed (a rollback keeps them).
  const blobFiles: string[] = [];
  db.transaction(() => {
    const refIds = refs.bySource(sourceId).map((r) => r.id);
    const purgedFactIds = new Set<string>();
    for (const refId of refIds) {
      for (const f of db.orm
        .select({ id: facts.id })
        .from(facts)
        .where(eq(facts.sourceReferenceId, refId))
        .all())
        purgedFactIds.add(f.id);
      report.facts += db.orm.delete(facts).where(eq(facts.sourceReferenceId, refId)).run().changes;
    }
    report.sourceReferences = refs.deleteBySource(sourceId);
    const entityIds = new Set(entities.idsBySource(sourceId));
    for (const id of entityIds) if (entities.hardDelete(id)) report.entities++;
    const del = (sqlText: string, ...params: string[]): number =>
      db.sqlite.prepare(sqlText).run(...params).changes;
    for (const t of db.orm.select().from(tasks).all()) {
      const factIds = JSON.parse(t.sourceFactIdsJson) as string[];
      const orphaned =
        (t.assignmentId && entityIds.has(t.assignmentId)) ||
        (t.examId && entityIds.has(t.examId)) ||
        (factIds.length > 0 && factIds.every((f) => purgedFactIds.has(f)));
      if (orphaned) report.tasks += del('DELETE FROM tasks WHERE id = ?', t.id);
    }
    for (const c of db.orm.select().from(conflicts).all()) {
      const cands = JSON.parse(c.candidatesJson) as { factId: string }[];
      if (entityIds.has(c.subject) || cands.some((x) => purgedFactIds.has(x.factId)))
        report.conflicts += del('DELETE FROM conflicts WHERE id = ?', c.id);
    }
    for (const l of db.orm.select().from(identityLinks).all()) {
      if (entityIds.has(l.leftId) || entityIds.has(l.rightId))
        report.identityLinks += del('DELETE FROM identity_links WHERE id = ?', l.id);
    }
    report.changeEvents += new ChangeEventStore(db).deleteBySource(sourceId);
    for (const id of entityIds) {
      report.changeEvents += del('DELETE FROM change_events WHERE entity_id = ?', id);
      del('DELETE FROM embeddings WHERE entity_id = ?', id);
    }
    report.rawBlobs = raw.deleteBlobsBySource(sourceId, (f) => blobFiles.push(f));
    report.rawItems = del('DELETE FROM raw_items WHERE source_id = ?', sourceId);
    new SyncStateStore(db).clear(sourceId);
    new HealthStore(db).delete(sourceId);
    new SchemaDriftStore(db).deleteBySource(sourceId);
    new ProductVersionStore(db).deleteBySource(sourceId);
    del('DELETE FROM raw_sources WHERE id = ?', sourceId);
    // The ledger of AI additions goes with the facts and entities they produced.
    if (sourceId === ADDITIONS_SOURCE_ID) new AdditionStore(db).deleteAll();
  });
  for (const f of blobFiles) rmSync(f, { force: true });
  return report;
}
