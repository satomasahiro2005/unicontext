import {
  type CanonicalEntity,
  type ChangeEvent,
  DEFAULT_FACT_FIELDS,
  type EntityId,
  type FactOrigin,
  type HealthState,
  type JsonValue,
  type SourceReference,
  stableId,
} from '@unicontext/canonical-model';
import {
  AuthRequiredError,
  type Clock,
  DEFAULT_TIMEZONE,
  errorMessage,
  type Logger,
  OfflineError,
  RateLimitedError,
  redact,
  silentLogger,
  systemClock,
  type UniversityProfile,
} from '@unicontext/core';
import {
  type ConnectorMetadata,
  createNormalizeContext,
  evaluateProductVersion,
  handlesType,
  type Normalizer,
  type NormalizeOutput,
  type RawItemView,
  type SourceAdapter,
  type SourceRefSpec,
  type SyncMode,
  type SyncResult,
} from '@unicontext/connector-sdk';
import {
  createStores,
  type HealthRecord,
  type RawItemRecord,
  type Stores,
  type UniContextDatabase,
} from '@unicontext/database';
import { factId, FactStore } from '@unicontext/provenance';
import { buildChangeEvent } from './change-events.js';
import {
  createSyncEventBus,
  type NormalizeReport,
  type SyncEventBus,
  type SyncRunReport,
} from './events.js';

export interface RegisteredSource {
  /** Source instance id (config key), e.g. "livecampusu". */
  sourceId: string;
  adapter: SourceAdapter;
  normalizer: Normalizer;
  metadata: ConnectorMetadata;
  /** Overrides metadata.sourceLabel for citations. */
  sourceLabel?: string;
}

/** Runs after normalization when entities changed: identity resolution, conflict detection, task derivation… */
export interface PostProcessor {
  name: string;
  run(input: { sourceId: string | undefined; changedEntityIds: string[] }): void | Promise<void>;
}

export interface SyncEngineOptions {
  db: UniContextDatabase;
  clock?: Clock;
  logger?: Logger;
  profile?: UniversityProfile;
  timezone?: string;
  bus?: SyncEventBus;
  postProcessors?: PostProcessor[];
  /** Force a full refresh when the last one is older than this (ms). Default 7 days. */
  fullRefreshIntervalMs?: number;
  /** Max pages per run (guards against adapters that never finish). Default 500. */
  maxPages?: number;
}

export interface IngestReport {
  inserted: number;
  updated: number;
  unchanged: number;
  restored: number;
  deleted: number;
}

const emptyNormalize = (): NormalizeReport => ({
  items: 0,
  failed: 0,
  entities: { created: 0, updated: 0, unchanged: 0, deleted: 0, restored: 0 },
  facts: { asserted: 0, retracted: 0 },
  changeEvents: 0,
  changedEntityIds: [],
});

/** Error text that is stored or broadcast (health, raw_items, sync events) never carries secrets. */
function safeMessage(error: unknown): string {
  return redact(errorMessage(error)) as string;
}

function classify(error: unknown): HealthState {
  if (error instanceof AuthRequiredError) return 'auth_required';
  if (error instanceof RateLimitedError) return 'rate_limited';
  if (error instanceof OfflineError) return 'offline';
  return 'failed';
}

/**
 * Raw-first sync pipeline (§6, §35): adapter → raw store (hash dedupe, deletions) → normalizer →
 * canonical entities + facts with provenance → ChangeEvents (§13) → post-processors.
 * Normalization only reads the raw store, so it can be re-run without refetching (reprocess()).
 */
export class SyncEngine {
  readonly bus: SyncEventBus;
  readonly stores: Stores;
  readonly facts: FactStore;
  private readonly db: UniContextDatabase;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly profile: UniversityProfile | undefined;
  private readonly tz: string;
  private readonly registry = new Map<string, RegisteredSource>();
  private readonly running = new Map<string, Promise<SyncRunReport>>();
  /** Per-source queue: sync runs, watcher ingests and reprocessing of one source never overlap. */
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly postProcessors: PostProcessor[];
  private readonly fullRefreshIntervalMs: number;
  private readonly maxPages: number;

  constructor(options: SyncEngineOptions) {
    this.db = options.db;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? silentLogger;
    this.profile = options.profile;
    this.tz = options.timezone ?? options.profile?.academicCalendar.timezone ?? DEFAULT_TIMEZONE;
    this.bus =
      options.bus ??
      createSyncEventBus((e, ev) =>
        this.logger.error('event listener failed', { event: String(ev), error: errorMessage(e) }),
      );
    this.stores = createStores(this.db, this.clock);
    this.facts = new FactStore(this.db, this.clock);
    this.postProcessors = [...(options.postProcessors ?? [])];
    this.fullRefreshIntervalMs = options.fullRefreshIntervalMs ?? 7 * 86_400_000;
    this.maxPages = options.maxPages ?? 500;
  }

  register(source: RegisteredSource): void {
    this.registry.set(source.sourceId, source);
    this.ensureRawSource(source);
  }

  /**
   * (Re)create the raw_sources row. Also called before every write, since `unicontext purge source`
   * from another process deletes it under a running daemon (raw_items has a foreign key to it).
   */
  private ensureRawSource(source: RegisteredSource): void {
    this.stores.raw.ensureSource({
      id: source.sourceId,
      connector: source.metadata.name,
      adapter: source.metadata.adapter,
      ...((source.sourceLabel ?? source.metadata.sourceLabel)
        ? { displayName: source.sourceLabel ?? source.metadata.sourceLabel }
        : {}),
    });
  }

  async unregister(sourceId: string): Promise<void> {
    const s = this.registry.get(sourceId);
    this.registry.delete(sourceId);
    await s?.adapter.dispose();
  }

  sources(): RegisteredSource[] {
    return [...this.registry.values()];
  }

  getSource(sourceId: string): RegisteredSource {
    const s = this.registry.get(sourceId);
    if (!s) throw new Error(`Unknown source ${sourceId}`);
    return s;
  }

  addPostProcessor(p: PostProcessor): void {
    this.postProcessors.push(p);
  }

  /** Mode the next run would use: initial (never synced), full (stale), else incremental. */
  nextMode(sourceId: string): SyncMode {
    const st = this.stores.syncState.get(sourceId);
    if (!st) return 'initial';
    if (
      !st.lastFullSyncAt ||
      this.clock.now().getTime() - new Date(st.lastFullSyncAt).getTime() >
        this.fullRefreshIntervalMs
    )
      return 'full';
    return 'incremental';
  }

  /** Run one sync. Concurrent calls for the same source share the running promise. */
  sync(
    sourceId: string,
    options: { mode?: SyncMode; signal?: AbortSignal } = {},
  ): Promise<SyncRunReport> {
    const existing = this.running.get(sourceId);
    if (existing) return existing;
    const p = this.withSourceLock(sourceId, () => this.runSync(sourceId, options)).finally(() =>
      this.running.delete(sourceId),
    );
    this.running.set(sourceId, p);
    return p;
  }

  /**
   * Run fn after every earlier sync/ingest/reprocess of the same source has finished. Without this
   * a watcher ingest landing between the pages of a full refresh is marked deleted by that refresh
   * (its `seen` set never contained it), and two normalizations of one raw item race each other.
   */
  private withSourceLock<T>(sourceId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(sourceId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(sourceId, tail);
    void tail.then(() => {
      if (this.locks.get(sourceId) === tail) this.locks.delete(sourceId);
    });
    return run;
  }

  isRunning(sourceId: string): boolean {
    return this.running.has(sourceId);
  }

  private async runSync(
    sourceId: string,
    options: { mode?: SyncMode; signal?: AbortSignal },
  ): Promise<SyncRunReport> {
    const source = this.getSource(sourceId);
    const mode = options.mode ?? this.nextMode(sourceId);
    const startedAt = this.clock.now().toISOString();
    const hadPreviousSync = this.stores.raw.getSource(sourceId)?.lastSyncAt !== undefined;
    await this.bus.emit('sync:started', { sourceId, mode, at: startedAt });
    const raw: IngestReport = { inserted: 0, updated: 0, unchanged: 0, restored: 0, deleted: 0 };
    let pages = 0;
    try {
      this.ensureRawSource(source);
      const auth = await source.adapter.authenticate();
      if (auth.status === 'auth_required' || auth.status === 'failed')
        throw new AuthRequiredError(auth.message ?? 'Authentication required');
      const prev = this.stores.syncState.get(sourceId);
      const cursor =
        mode === 'incremental' && prev
          ? {
              ...(prev.cursor ? { cursor: prev.cursor } : {}),
              ...(prev.etag ? { etag: prev.etag } : {}),
              ...(prev.deltaToken ? { deltaToken: prev.deltaToken } : {}),
              ...(prev.lastModified ? { lastModified: prev.lastModified } : {}),
              ...(prev.extra ? { extra: prev.extra } : {}),
            }
          : undefined;
      const seen = new Set<string>();
      let pageToken: string | undefined;
      let last: SyncResult | undefined;
      const completeTypes = new Set<string>();
      let version: { product: string; version: string } | undefined;
      do {
        const result = await source.adapter.sync({
          mode,
          ...(cursor ? { cursor } : {}),
          ...(pageToken ? { pageToken } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        pages++;
        const r = this.ingestPage(sourceId, result, seen);
        for (const k of Object.keys(raw) as (keyof IngestReport)[]) raw[k] += r[k];
        for (const t of result.complete?.sourceTypes ?? []) completeTypes.add(t);
        if (result.productVersion) version = result.productVersion;
        for (const w of result.warnings ?? [])
          this.logger.warn('adapter warning', { sourceId, warning: w });
        last = result;
        pageToken = result.hasMore ? result.nextPageToken : undefined;
        if (result.hasMore && !pageToken)
          throw new Error('Adapter returned hasMore without nextPageToken');
        if (pages >= this.maxPages && pageToken)
          throw new Error(`Sync exceeded ${this.maxPages} pages`);
      } while (pageToken);

      if (completeTypes.size > 0)
        raw.deleted += this.stores.raw.markMissingDeleted(
          sourceId,
          [...completeTypes],
          seen,
        ).length;
      this.stores.syncState.set(sourceId, last?.cursor ?? {}, {
        mode,
        fullSync: mode !== 'incremental',
      });
      const normalized = await this.normalizePending(sourceId, { emitCreates: hadPreviousSync });
      this.stores.raw.touchSourceSync(sourceId, this.clock.now().toISOString());
      const health = await this.recordSuccess(source, version);
      const report: SyncRunReport = {
        sourceId,
        mode,
        startedAt,
        finishedAt: this.clock.now().toISOString(),
        ok: true,
        error: undefined,
        pages,
        raw,
        normalized,
        health,
      };
      await this.bus.emit('sync:completed', report);
      return report;
    } catch (e) {
      const health = await this.recordFailure(sourceId, e);
      const message = safeMessage(e);
      this.logger.warn('sync failed', { sourceId, error: message, health });
      await this.bus.emit('sync:failed', { sourceId, error: message, health });
      const report: SyncRunReport = {
        sourceId,
        mode,
        startedAt,
        finishedAt: this.clock.now().toISOString(),
        ok: false,
        error: message,
        pages,
        raw,
        normalized: emptyNormalize(),
        health,
      };
      await this.bus.emit('sync:completed', report);
      return report;
    }
  }

  private ingestPage(sourceId: string, result: SyncResult, seen: Set<string>): IngestReport {
    const report: IngestReport = { inserted: 0, updated: 0, unchanged: 0, restored: 0, deleted: 0 };
    this.db.transaction(() => {
      for (const item of result.items) {
        const { status, item: rec } = this.stores.raw.upsertItem(sourceId, {
          sourceType: item.sourceType,
          externalId: item.externalId,
          payload: item.payload,
          ...(item.sourceUpdatedAt ? { sourceUpdatedAt: item.sourceUpdatedAt } : {}),
        });
        seen.add(rec.id);
        report[status]++;
        for (const b of item.blobs ?? [])
          this.stores.raw.putBlob({
            sourceId,
            rawItemId: rec.id,
            data: b.data,
            ...(b.mimeType ? { mimeType: b.mimeType } : {}),
          });
      }
      for (const d of result.deletions ?? []) {
        if (this.stores.raw.markDeleted(sourceId, d.sourceType, d.externalId)) report.deleted++;
      }
    });
    return report;
  }

  /**
   * Store raw items pushed from outside the adapter loop (file watcher events, manual transcript
   * imports, §22/§23) and normalize them right away.
   */
  async ingest(
    sourceId: string,
    result: SyncResult,
  ): Promise<{ raw: IngestReport; normalized: NormalizeReport }> {
    const source = this.getSource(sourceId);
    return this.withSourceLock(sourceId, async () => {
      this.ensureRawSource(source);
      const seen = new Set<string>();
      const raw = this.ingestPage(sourceId, result, seen);
      if (result.complete?.sourceTypes.length)
        raw.deleted += this.stores.raw.markMissingDeleted(
          sourceId,
          result.complete.sourceTypes,
          seen,
        ).length;
      const normalized = await this.normalizePending(sourceId, { emitCreates: true });
      return { raw, normalized };
    });
  }

  /** Re-run normalization from the raw store without contacting the source (§6). */
  async reprocess(sourceId?: string): Promise<NormalizeReport> {
    const ids = sourceId
      ? [this.getSource(sourceId).sourceId]
      : this.sources().map((s) => s.sourceId);
    const total = emptyNormalize();
    for (const id of ids) {
      // Reset inside the source's lock so a running sync is not normalizing the same items.
      const r = await this.withSourceLock(id, () => {
        this.stores.raw.resetNormalization(id);
        return this.normalizePending(id, { emitCreates: true, runPostProcessors: false });
      });
      mergeReport(total, r);
    }
    await this.runPostProcessors(sourceId, total.changedEntityIds);
    return total;
  }

  /** Normalize raw items that are new, changed or deleted since their last normalization. */
  async normalizePending(
    sourceId: string,
    options: { emitCreates?: boolean; runPostProcessors?: boolean } = {},
  ): Promise<NormalizeReport> {
    const source = this.getSource(sourceId);
    const report = emptyNormalize();
    // A new normalizer version re-normalizes what the previous one produced (no refetch needed).
    const pending = this.stores.raw.list({
      sourceId,
      pendingOnly: true,
      normalizerVersion: source.normalizer.version,
    });
    // Events of this call only, committed per raw item once its transaction succeeded.
    const pendingEvents: ChangeEvent[] = [];
    for (const item of pending) {
      report.items++;
      const itemEvents: ChangeEvent[] = [];
      try {
        if (item.deletedAt) {
          this.db.transaction(() => this.applyDeletion(source, item, report, itemEvents));
        } else if (handlesType(source.normalizer, item.sourceType)) {
          const ctx = createNormalizeContext({
            sourceId,
            sourceSystem: source.metadata.product,
            ...((source.sourceLabel ?? source.metadata.sourceLabel)
              ? { sourceLabel: source.sourceLabel ?? source.metadata.sourceLabel }
              : {}),
            defaultAuthority: source.metadata.defaultAuthority,
            timezone: this.tz,
            ...(this.profile ? { profile: this.profile } : {}),
            now: this.clock.now(),
            logger: this.logger.child({ sourceId }),
            lookup: (id) => this.stores.entities.get(id),
          });
          const view: RawItemView = {
            id: item.id,
            sourceId,
            sourceType: item.sourceType,
            externalId: item.externalId,
            payload: item.payload,
            fetchedAt: item.fetchedAt,
            sourceUpdatedAt: item.sourceUpdatedAt,
            contentHash: item.contentHash,
          };
          const output = await source.normalizer.normalize(view, ctx);
          this.db.transaction(() =>
            this.applyOutput(source, item, output, report, options.emitCreates ?? true, itemEvents),
          );
          if (output.drift?.length) {
            const fresh = this.stores.drift.record(
              sourceId,
              item.sourceType,
              output.drift,
              item.id,
            );
            if (fresh.length) await this.bus.emit('drift', { sourceId, findings: fresh });
          }
          for (const w of output.warnings ?? [])
            this.logger.warn('normalizer warning', { sourceId, rawItemId: item.id, warning: w });
        }
        this.stores.raw.markNormalized(item.id, { version: source.normalizer.version });
        pendingEvents.push(...itemEvents);
      } catch (e) {
        report.failed++;
        this.logger.error('normalize failed', {
          sourceId,
          rawItemId: item.id,
          sourceType: item.sourceType,
          error: errorMessage(e),
        });
        this.stores.raw.markNormalized(item.id, {
          version: source.normalizer.version,
          error: safeMessage(e),
        });
      }
    }
    for (const ev of pendingEvents) await this.bus.emit('change', ev);
    if (options.runPostProcessors !== false)
      await this.runPostProcessors(sourceId, report.changedEntityIds);
    return report;
  }

  async runPostProcessors(sourceId: string | undefined, changedEntityIds: string[]): Promise<void> {
    for (const p of this.postProcessors) {
      try {
        await p.run({ sourceId, changedEntityIds });
      } catch (e) {
        this.logger.error('post-processor failed', { processor: p.name, error: errorMessage(e) });
      }
    }
  }

  private refFor(
    source: RegisteredSource,
    item: RawItemRecord,
    idParts: string[],
    spec: SourceRefSpec | undefined,
    entityId: string | undefined,
  ): SourceReference {
    return this.stores.sourceRefs.upsert({
      id: stableId('sourceReference', item.id, ...idParts),
      sourceSystem: source.metadata.product,
      sourceId: source.sourceId,
      ...((spec?.sourceLabel ?? source.sourceLabel ?? source.metadata.sourceLabel)
        ? { sourceLabel: spec?.sourceLabel ?? source.sourceLabel ?? source.metadata.sourceLabel }
        : {}),
      authority: spec?.authority ?? source.metadata.defaultAuthority,
      sourceItemId: spec?.sourceItemId ?? item.externalId,
      ...(spec?.url ? { url: spec.url } : {}),
      retrievedAt: item.fetchedAt,
      rawItemId: item.id,
      ...(spec?.location ? { location: spec.location } : {}),
      ...(entityId ? { entityId } : {}),
    });
  }

  private applyOutput(
    source: RegisteredSource,
    item: RawItemRecord,
    output: NormalizeOutput,
    report: NormalizeReport,
    emitCreates: boolean,
    events: ChangeEvent[],
  ): void {
    const now = this.clock.now().toISOString();
    const observedAt = item.sourceUpdatedAt ?? item.fetchedAt;
    // Unchanged raw content normalized again (a new normalizer version): the source did not
    // change, so updated entities are not reported as changes (no ChangeEvent / notification).
    const reinterpretation =
      item.normalizedHash !== undefined && item.normalizedHash === item.contentHash;
    const keptFacts = new Set<string>();
    const keptEntities = new Set<string>();
    const eventSource = {
      sourceId: source.sourceId,
      sourceSystem: source.metadata.product,
      rawItemId: item.id,
    };

    const assert = (
      subject: string,
      predicate: string,
      value: JsonValue,
      origin: Exclude<FactOrigin, 'user'>,
      ref: SourceReference,
      extra: {
        confidence?: number;
        observedAt?: string;
        validFrom?: string;
        validUntil?: string;
        evidence?: string;
        producer?: { type: 'connector' | 'ai' | 'rule' | 'user'; id: string };
      } = {},
    ): void => {
      const id = factId(ref.id, subject, predicate, value);
      keptFacts.add(id);
      const existing = this.facts.get(id);
      if (existing && !existing.retractedAt) return;
      this.facts.put({
        id,
        subject: subject as EntityId,
        predicate,
        value,
        origin,
        confidence: extra.confidence ?? (origin === 'authoritative' ? 1 : 0.8),
        observedAt: extra.observedAt ?? observedAt,
        ...(extra.validFrom ? { validFrom: extra.validFrom } : {}),
        ...(extra.validUntil ? { validUntil: extra.validUntil } : {}),
        sourceReferenceId: ref.id,
        producer: extra.producer ?? { type: 'connector', id: source.sourceId },
        ...(extra.evidence ? { evidence: extra.evidence } : {}),
      });
      report.facts.asserted++;
    };

    for (const ne of output.entities) {
      const res = this.stores.entities.upsert(ne.entity as CanonicalEntity, {
        sourceId: source.sourceId,
        at: now,
      });
      const entity = res.entity;
      keptEntities.add(entity.id);
      const ref = this.refFor(source, item, ['entity', entity.id], ne.ref, entity.id);
      report.entities[res.status]++;
      if (res.status !== 'unchanged') report.changedEntityIds.push(entity.id);
      if (
        (res.status === 'updated' && !reinterpretation) ||
        res.status === 'restored' ||
        (res.status === 'created' && emitCreates)
      ) {
        this.appendEvent(
          events,
          buildChangeEvent({
            type: res.status,
            entity,
            previous: res.previous,
            changedFields: res.changedFields,
            source: eventSource,
            occurredAt: observedAt,
            observedAt: now,
            timezone: this.tz,
          }),
        );
        report.changeEvents++;
      }
      if (ne.deriveFacts !== false) {
        const fields = DEFAULT_FACT_FIELDS[entity.kind] ?? {};
        const rec = entity as unknown as Record<string, JsonValue | undefined>;
        for (const [field, predicate] of Object.entries(fields)) {
          const v = rec[field];
          if (v !== undefined && v !== null)
            assert(entity.id, predicate, v, ne.origin ?? 'authoritative', ref);
        }
      }
    }

    for (const f of output.facts ?? []) {
      if ((f.origin as string) === 'user')
        throw new Error('Normalizers cannot emit origin "user" facts');
      const ref = this.refFor(source, item, ['fact', f.subject, f.predicate], f.ref, undefined);
      assert(f.subject, f.predicate, f.value, f.origin, ref, {
        ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
        ...(f.observedAt ? { observedAt: f.observedAt } : {}),
        ...(f.validFrom ? { validFrom: f.validFrom } : {}),
        ...(f.validUntil ? { validUntil: f.validUntil } : {}),
        ...(f.evidence ? { evidence: f.evidence } : {}),
        ...(f.producer ? { producer: f.producer } : {}),
      });
    }

    // Facts this raw item no longer supports are retracted (history is kept).
    const stale = this.facts.activeIdsForRawItem(item.id).filter((id) => !keptFacts.has(id));
    report.facts.retracted += this.facts.retract(stale, now);

    // Entities this raw item used to produce but no longer does (e.g. fewer chunks).
    for (const ref of this.stores.sourceRefs.byRawItem(item.id)) {
      if (!ref.entityId || keptEntities.has(ref.entityId)) continue;
      this.deleteIfOrphaned(ref.entityId, item.id, eventSource, now, report, events);
    }
  }

  private applyDeletion(
    source: RegisteredSource,
    item: RawItemRecord,
    report: NormalizeReport,
    events: ChangeEvent[],
  ): void {
    const now = this.clock.now().toISOString();
    const eventSource = {
      sourceId: source.sourceId,
      sourceSystem: source.metadata.product,
      rawItemId: item.id,
    };
    report.facts.retracted += this.facts.retract(this.facts.activeIdsForRawItem(item.id), now);
    for (const ref of this.stores.sourceRefs.byRawItem(item.id)) {
      if (ref.entityId)
        this.deleteIfOrphaned(ref.entityId, item.id, eventSource, now, report, events);
    }
  }

  /** Soft-delete an entity unless another live raw item still supports it. */
  private deleteIfOrphaned(
    entityId: string,
    rawItemId: string,
    eventSource: { sourceId: string; sourceSystem: string; rawItemId: string },
    now: string,
    report: NormalizeReport,
    events: ChangeEvent[],
  ): void {
    const others = this.stores.sourceRefs
      .forEntity(entityId)
      .filter((r) => r.rawItemId && r.rawItemId !== rawItemId);
    const stillSupported = others.some((r) => {
      const raw = r.rawItemId ? this.stores.raw.get(r.rawItemId) : undefined;
      return raw !== undefined && !raw.deletedAt;
    });
    if (stillSupported) return;
    const prev = this.stores.entities.softDelete(entityId, now);
    if (!prev) return;
    report.entities.deleted++;
    report.changedEntityIds.push(entityId);
    this.appendEvent(
      events,
      buildChangeEvent({
        type: 'deleted',
        entity: prev,
        previous: prev,
        changedFields: [],
        source: eventSource,
        occurredAt: now,
        observedAt: now,
        timezone: this.tz,
      }),
    );
    report.changeEvents++;
  }

  private appendEvent(events: ChangeEvent[], ev: ChangeEvent): void {
    this.stores.changes.append(ev);
    events.push(ev);
  }

  private async setHealth(
    sourceId: string,
    next: Parameters<Stores['health']['set']>[1],
  ): Promise<HealthRecord> {
    const prev = this.stores.health.get(sourceId);
    const rec = this.stores.health.set(sourceId, next);
    if (prev?.state !== rec.state)
      await this.bus.emit('health', { sourceId, previous: prev?.state, current: rec });
    return rec;
  }

  private async recordSuccess(
    source: RegisteredSource,
    version: { product: string; version: string } | undefined,
  ): Promise<HealthState> {
    const now = this.clock.now().toISOString();
    let state: HealthState = 'healthy';
    let message: string | undefined;
    let detected = version;
    if (
      !detected &&
      'detectProductVersion' in source.adapter &&
      typeof source.adapter.detectProductVersion === 'function'
    ) {
      try {
        detected =
          (await (
            source.adapter.detectProductVersion as () => Promise<
              { product: string; version: string } | undefined
            >
          )()) ?? undefined;
      } catch (e) {
        this.logger.warn('product version detection failed', {
          sourceId: source.sourceId,
          error: errorMessage(e),
        });
      }
    }
    if (detected) {
      const ev = evaluateProductVersion(source.metadata, detected.version);
      this.stores.versions.record(source.sourceId, detected.product, detected.version, ev.known);
      if (ev.state === 'degraded') {
        state = 'degraded';
        message = ev.message;
      }
    }
    const missing = this.stores.drift
      .list({ sourceId: source.sourceId, unresolvedOnly: true })
      .filter((d) => d.driftKind !== 'unknown');
    if (state === 'healthy' && missing.length > 0) {
      state = 'degraded';
      message = `Schema drift: ${missing
        .slice(0, 3)
        .map((d) => `${d.sourceType}.${d.fieldPath} (${d.driftKind})`)
        .join(', ')}`;
    }
    await this.setHealth(source.sourceId, {
      state,
      checkedAt: now,
      ...(message ? { message } : {}),
      lastSuccessAt: now,
      consecutiveFailures: 0,
      ...(detected ? { detectedVersion: detected.version } : {}),
    });
    return state;
  }

  private async recordFailure(sourceId: string, error: unknown): Promise<HealthState> {
    const now = this.clock.now();
    const prev = this.stores.health.get(sourceId);
    const failures = (prev?.consecutiveFailures ?? 0) + 1;
    let state = classify(error);
    if (state === 'failed' && failures < 3) state = 'degraded';
    const retryAfter =
      error instanceof RateLimitedError && error.retryAfterMs !== undefined
        ? new Date(now.getTime() + error.retryAfterMs).toISOString()
        : undefined;
    await this.setHealth(sourceId, {
      state,
      checkedAt: now.toISOString(),
      message: safeMessage(error),
      lastFailureAt: now.toISOString(),
      consecutiveFailures: failures,
      ...(retryAfter ? { retryAfter } : {}),
    });
    return state;
  }

  /** Ask the adapter for its own health and store it (e.g. `unicontext doctor`). */
  async checkHealth(sourceId: string): Promise<HealthRecord> {
    const source = this.getSource(sourceId);
    try {
      const h = await source.adapter.health();
      const prev = this.stores.health.get(sourceId);
      return await this.setHealth(sourceId, {
        ...h,
        ...(h.message ? { message: redact(h.message) as string } : {}),
        consecutiveFailures: prev?.consecutiveFailures ?? 0,
      });
    } catch (e) {
      await this.recordFailure(sourceId, e);
      const rec = this.stores.health.get(sourceId);
      if (!rec) throw e;
      return rec;
    }
  }

  health(sourceId: string): HealthRecord | undefined {
    return this.stores.health.get(sourceId);
  }

  healthAll(): HealthRecord[] {
    return this.stores.health.list();
  }

  /**
   * Wait (bounded) for in-flight syncs/ingests, then dispose adapters. Closing the database under a
   * running sync fails it halfway, and adapters must not be torn down while they are in use.
   */
  async dispose(options: { waitMs?: number } = {}): Promise<void> {
    const inFlight = [...this.running.values(), ...this.locks.values()];
    if (inFlight.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(inFlight),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, options.waitMs ?? 30_000);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    for (const s of this.registry.values()) await s.adapter.dispose();
    this.registry.clear();
  }
}

function mergeReport(into: NormalizeReport, r: NormalizeReport): void {
  into.items += r.items;
  into.failed += r.failed;
  for (const k of Object.keys(into.entities) as (keyof NormalizeReport['entities'])[])
    into.entities[k] += r.entities[k];
  into.facts.asserted += r.facts.asserted;
  into.facts.retracted += r.facts.retracted;
  into.changeEvents += r.changeEvents;
  into.changedEntityIds.push(...r.changedEntityIds);
}
