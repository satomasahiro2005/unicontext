import {
  ADDITIONS_SOURCE_ID,
  type ChangeEvent,
  type Conflict,
  entityLabel,
  isEntityKind,
  kindOf,
  makeId,
} from '@unicontext/canonical-model';
import {
  type Clock,
  dataPathsFromRoot,
  ensureDataDirs,
  errorMessage,
  type Logger,
  loadProfile,
  type StudentScope,
  silentLogger,
  systemClock,
  type UniversityProfile,
} from '@unicontext/core';
import {
  EntityStore,
  openDatabase,
  type UniContextDatabase,
  ChangeEventStore,
} from '@unicontext/database';
import { IdentityResolver } from '@unicontext/identity';
import {
  type AuthorityRules,
  ConflictResolver,
  loadDefaultAuthorityRules,
  mergeAuthorityRules,
} from '@unicontext/provenance';
import { type EmbeddingIndex, SearchService } from '@unicontext/search';
import { type SyncEventBus, SyncEngine, SyncScheduler } from '@unicontext/sync-engine';
import { TaskEngine } from '@unicontext/task-engine';
import type { ConnectorMetadata } from '@unicontext/connector-sdk';
import { AdditionsService } from './additions.js';
import type { CoverageSourceInput } from './coverage.js';
import { ContextEngine } from './engine.js';

export interface UniContextOptions {
  /** Existing database, or open one under dataDir (or in memory when neither is given). */
  db?: UniContextDatabase;
  dataDir?: string;
  clock?: Clock;
  logger?: Logger;
  /** Profile object or id (e.g. "shizuoka-university"). */
  profile?: UniversityProfile | string;
  timezone?: string;
  authorityRules?: AuthorityRules;
  embeddings?: EmbeddingIndex;
  /** Per-source schedules for the scheduler (§36). */
  schedules?: Record<string, string>;
  /** Campus/faculty of the student (config.yaml `student:`) for scoped calendar exceptions. */
  student?: StudentScope;
  /** Sources turned off in config.yaml (`enabled: false`): left out of deadline coverage. */
  disabledSources?: readonly string[];
}

export interface PipelineReport {
  linked: number;
  suggested: number;
  conflictsOpened: number;
  conflictsResolved: number;
  tasks: { created: number; updated: number; cancelled: number };
}

/** Everything an app (daemon, MCP, REST, CLI) needs, wired together. */
export interface UniContext {
  db: UniContextDatabase;
  clock: Clock;
  profile: UniversityProfile | undefined;
  timezone: string;
  sync: SyncEngine;
  scheduler: SyncScheduler;
  bus: SyncEventBus;
  identity: IdentityResolver;
  resolver: ConflictResolver;
  tasks: TaskEngine;
  search: SearchService;
  context: ContextEngine;
  /** What AI clients wrote through the MCP write tools (lectures, deadlines, notes, tasks). */
  additions: AdditionsService;
  /** Identity resolution → conflict detection → task derivation. Runs automatically after each sync. */
  runPipeline(): Promise<PipelineReport>;
  close(): Promise<void>;
}

export function createUniContext(options: UniContextOptions = {}): UniContext {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? silentLogger;
  const profile =
    typeof options.profile === 'string' ? loadProfile(options.profile) : options.profile;
  const timezone = options.timezone ?? profile?.academicCalendar.timezone ?? 'Asia/Tokyo';
  let db = options.db;
  if (!db) {
    if (options.dataDir) {
      const paths = dataPathsFromRoot(options.dataDir);
      ensureDataDirs(paths);
      db = openDatabase({ path: paths.database, blobsDir: paths.blobs });
    } else db = openDatabase();
  }
  const database = db;

  const sync = new SyncEngine({
    db: database,
    clock,
    logger,
    timezone,
    ...(profile ? { profile } : {}),
  });
  const engine = sync;
  const sourcePriority = (sourceId: string | undefined): number => {
    if (!sourceId) return 2;
    try {
      return sync.getSource(sourceId).metadata.defaultAuthority === 'academic-system' ? 0 : 1;
    } catch {
      return 2;
    }
  };
  // Course codes of the academic system and the syllabus are registrar codes; every other source's
  // codes (Ed "db2026", an LMS course code) are that platform's own labels (§14).
  const codeScheme = (sourceId: string | undefined): 'registrar' | 'platform' | undefined => {
    if (!sourceId) return undefined;
    try {
      const authority = sync.getSource(sourceId).metadata.defaultAuthority;
      return authority === 'academic-system' || authority === 'syllabus' ? 'registrar' : 'platform';
    } catch {
      return undefined;
    }
  };
  const identity = new IdentityResolver(database, { clock, sourcePriority, codeScheme });
  const rules = mergeAuthorityRules(
    options.authorityRules ?? loadDefaultAuthorityRules(),
    profile?.authorityRules ? { predicates: profile.authorityRules } : undefined,
  );
  const resolver = new ConflictResolver(database, {
    clock,
    rules,
    expandSubject: (id) => identity.expand(id),
    canonicalSubject: (id) => identity.canonical(id),
  });
  const expandCourse = (id: string): string[] => identity.expand(id);
  const tasks = new TaskEngine({
    db: database,
    clock,
    timezone,
    resolver,
    expandCourse,
    canonicalCourse: (id) => identity.canonical(id),
    ...(profile ? { profile } : {}),
    ...(options.student ? { student: options.student } : {}),
  });
  const search = new SearchService({
    db: database,
    clock,
    timezone,
    expandCourse,
    ...(options.embeddings ? { embeddings: options.embeddings } : {}),
  });
  const context = new ContextEngine({
    db: database,
    clock,
    timezone,
    resolver,
    identity,
    tasks,
    search,
    isReferenceSource: (sourceId) => {
      try {
        return sync.getSource(sourceId).metadata.referenceOnly === true;
      } catch {
        return false;
      }
    },
    coverageSources: () => coverageSources(),
    ...(profile ? { profile } : {}),
  });
  // Deadline coverage (coverage.ts): every source known to the raw store, with the capabilities of
  // its loaded connector (none when it failed to load) and its health. A source counts as stale after
  // three missed scheduled runs (at least 6 h; 24 h without a schedule).
  const disabled = new Set(options.disabledSources ?? []);
  const coverageSources = (): CoverageSourceInput[] => {
    const stores = sync.stores;
    const intervals = new Map(scheduler.status().map((x) => [x.sourceId, x.intervalMs]));
    return stores.raw
      .listSources()
      .filter((s) => s.id !== ADDITIONS_SOURCE_ID && !disabled.has(s.id))
      .map((s) => {
        let meta: ConnectorMetadata | undefined;
        let label: string | undefined;
        try {
          const reg = sync.getSource(s.id);
          meta = reg.metadata;
          label = reg.sourceLabel ?? reg.metadata.sourceLabel;
        } catch {
          meta = undefined;
        }
        const h = stores.health.get(s.id);
        const interval = intervals.get(s.id);
        return {
          sourceId: s.id,
          label: label ?? s.displayName ?? s.id,
          capabilities: meta?.capabilities,
          authority: meta?.defaultAuthority,
          referenceOnly: meta?.referenceOnly === true,
          state: h?.state,
          lastSuccessAt: h?.lastSuccessAt,
          staleAfterMs: interval ? Math.max(3 * interval, 6 * 60 * 60 * 1000) : undefined,
          intervalMs: interval,
        };
      });
  };
  const entities = new EntityStore(database, { clock });
  const changes = new ChangeEventStore(database);

  const conflictEvent = async (
    type: 'conflict_detected' | 'conflict_resolved',
    c: Conflict,
  ): Promise<void> => {
    const kind = kindOf(c.subject);
    if (!isEntityKind(kind)) return;
    const subject = entities.get(c.subject, { includeDeleted: true });
    const label = subject ? entityLabel(subject) : c.subject;
    const values = c.candidates.map((x) => String(x.value)).join(' / ');
    const now = clock.now().toISOString();
    const course =
      subject?.kind === 'courseOffering'
        ? subject.id
        : (subject as { courseOfferingId?: string } | undefined)?.courseOfferingId;
    const ev: ChangeEvent = {
      id: makeId('changeEvent'),
      entityId: c.subject,
      entityKind: kind,
      type,
      changedFields: [c.predicate],
      before: null,
      after: {
        [c.predicate]: type === 'conflict_detected' ? values : (c.resolution?.factId ?? null),
      },
      source: {},
      occurredAt: now,
      observedAt: now,
      ...(course ? { courseOfferingId: course as ChangeEvent['courseOfferingId'] } : {}),
      summary:
        type === 'conflict_detected'
          ? `「${label}」の${c.predicate}で情報が食い違っています: ${values}`
          : `「${label}」の${c.predicate}の食い違いが解消しました`,
    };
    changes.append(ev);
    await engine.bus.emit('change', ev);
    await engine.bus.emit('conflict', {
      type: type === 'conflict_detected' ? 'opened' : 'resolved',
      conflict: c,
    });
  };

  const runPipeline = async (): Promise<PipelineReport> => {
    const ids = identity.resolveCourseOfferings();
    identity.invalidate();
    const { opened, resolved } = resolver.detectConflicts();
    for (const c of opened) await conflictEvent('conflict_detected', c);
    for (const c of resolved) await conflictEvent('conflict_resolved', c);
    const t = tasks.derive();
    // Earlier years' offerings of each current course (a derived pointer, never an identity link).
    context.deriveLineage();
    return {
      linked: ids.linked.length,
      suggested: ids.suggested.length,
      conflictsOpened: opened.length,
      conflictsResolved: resolved.length,
      tasks: { created: t.created, updated: t.updated, cancelled: t.cancelled },
    };
  };

  const additions = new AdditionsService({
    db: database,
    clock,
    timezone,
    resolver,
    identity,
    tasks,
    courseTitle: (id) => context.courseRef(id)?.title,
    runPipeline,
    sessionsOn: (date) => context.effectiveSessionsOn(date),
  });

  engine.addPostProcessor({
    name: 'pipeline',
    run: async () => {
      try {
        await runPipeline();
      } catch (e) {
        logger.error('pipeline failed', { error: errorMessage(e) });
        throw e;
      }
    },
  });

  const scheduler = new SyncScheduler(engine, {
    clock,
    ...(options.schedules ? { schedules: options.schedules } : {}),
  });

  return {
    db: database,
    clock,
    profile,
    timezone,
    sync: engine,
    scheduler,
    bus: engine.bus,
    identity,
    resolver,
    tasks,
    search,
    context,
    additions,
    runPipeline,
    async close() {
      scheduler.stop();
      await engine.dispose();
      if (!options.db) database.close();
    },
  };
}
