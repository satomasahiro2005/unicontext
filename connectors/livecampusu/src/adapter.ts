import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Capability, HealthStatus } from '@unicontext/canonical-model';
import type {
  AuthResult,
  ConnectorContext,
  DetailFetchAdapter,
  DetailFetchResult,
  InteractiveAuthAdapter,
  InteractiveLoginOptions,
  OpenAnnouncementsAdapter,
  OpenAnnouncementsResult,
  SyncInput,
  SyncResult,
  VersionAwareAdapter,
} from '@unicontext/connector-sdk';
import {
  AuthRequiredError,
  OfflineError,
  PolicyViolationError,
  RateLimitedError,
  zonedParts,
} from '@unicontext/core';
import { type AuthStrategyKind, createAuthStrategy, selectAuthStrategy } from './auth/index.js';
import type { BrowserSsoStrategyOptions } from './auth/browser-sso.js';
import type { LiveCampusUConfig } from './config.js';
import type { LcuAuthStrategy } from './core/auth.js';
import {
  inMaintenanceWindow,
  type LcuDeploymentProfile,
  type LcuDeploymentProfileInput,
  resolveDeployment,
} from './core/deployment.js';
import { LcuSession } from './core/session.js';
import { AssignmentPayloadSchema, NoticePayloadSchema, RAW_TYPES } from './core/schemas.js';
import {
  type LcuCursorExtra,
  type LcuSyncContext,
  type NoticeCacheEntry,
  openNoticesOnDemand,
  readAssignmentsOnDemand,
  runLcuSync,
  type VersionState,
} from './core/sync.js';
import { metadata, PRODUCT } from './metadata.js';
import { DEPLOYMENTS } from './profiles/index.js';

export interface LiveCampusUAdapterOptions {
  /** Pre-resolved deployment (default: resolved from config + profile). */
  deployment?: LcuDeploymentProfile;
  /** Extra/overriding deployment registry entries. */
  deployments?: Record<string, LcuDeploymentProfileInput>;
  /** Auth strategy override (tests, embedding). */
  strategy?: LcuAuthStrategy;
  /** adapter-browser overrides for the browser-sso strategy (tests). */
  browserDriver?: BrowserSsoStrategyOptions['driver'];
  createBrowserSession?: BrowserSsoStrategyOptions['createSession'];
}

function productSettings(
  ctx: ConnectorContext<LiveCampusUConfig>,
): Record<string, unknown> | undefined {
  return ctx.profile?.products[PRODUCT];
}

/** Resolve the deployment profile for a connector context (config wins over profile). */
export function deploymentFor(
  ctx: ConnectorContext<LiveCampusUConfig>,
  extra?: Record<string, LcuDeploymentProfileInput>,
): LcuDeploymentProfile {
  return resolveDeployment(
    { ...DEPLOYMENTS, ...(extra ?? {}) },
    {
      productSettings: productSettings(ctx),
      profileId: ctx.profile?.id,
      config: ctx.config as Record<string, unknown>,
    },
  );
}

/** Current academic year (April start) in the given timezone. */
export function currentAcademicYear(now: Date, tz: string): number {
  const p = zonedParts(now, tz);
  return p.month >= 4 ? p.year : p.year - 1;
}

/**
 * LiveCampusU SourceAdapter (§26): read-only plain-HTTP replay of a browser SSO session.
 * Implements VersionAwareAdapter (§72) and InteractiveAuthAdapter (login/logout via the strategy).
 */
export class LiveCampusUAdapter
  implements
    VersionAwareAdapter,
    InteractiveAuthAdapter,
    OpenAnnouncementsAdapter,
    DetailFetchAdapter
{
  readonly id: string;
  readonly version = metadata.version;
  readonly deployment: LcuDeploymentProfile;
  readonly strategy: LcuAuthStrategy;
  readonly strategyKind: AuthStrategyKind;
  readonly session: LcuSession;
  private readonly timezone: string;
  /** Resolved `openUnreadNotices` (source config, else the profile's product setting, else true). */
  readonly openUnreadNotices: boolean;
  private noticeCache = new Map<string, NoticeCacheEntry>();
  private noticeCheckpointLoaded = false;
  private versionState: VersionState | undefined;
  private lastHealth: HealthStatus | undefined;
  /** sync() and openAnnouncements() share one LCU session (one current screen): never interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  constructor(
    private readonly ctx: ConnectorContext<LiveCampusUConfig>,
    options: LiveCampusUAdapterOptions = {},
  ) {
    this.id = `livecampusu:${ctx.sourceId}`;
    this.deployment = options.deployment ?? deploymentFor(ctx, options.deployments);
    this.timezone = ctx.profile?.academicCalendar.timezone ?? 'Asia/Tokyo';
    const settings = productSettings(ctx);
    this.openUnreadNotices =
      ctx.config.openUnreadNotices ??
      (typeof settings?.openUnreadNotices === 'boolean' ? settings.openUnreadNotices : true);
    this.strategyKind = selectAuthStrategy(ctx.config.auth, settings);
    const allowLocal =
      this.strategyKind === 'local-account' &&
      (ctx.config.allowLocalAccount === true || settings?.allowLocalAccount === true);
    this.strategy =
      options.strategy ??
      createAuthStrategy({
        sourceId: ctx.sourceId,
        deployment: this.deployment,
        secrets: ctx.secrets,
        logger: ctx.logger,
        clock: ctx.clock,
        cacheDir: ctx.cacheDir,
        configAuth: ctx.config.auth,
        productSettings: settings,
        allowLocalAccount: allowLocal,
        browser: ctx.config.browser,
        driver: options.browserDriver,
        createSession: options.createBrowserSession,
      });
    this.session = new LcuSession({
      deployment: this.deployment,
      auth: this.strategy,
      fetch: ctx.fetch,
      rateLimiter: ctx.rateLimiter,
      clock: ctx.clock,
      logger: ctx.logger,
      minRequestIntervalMs: ctx.config.minRequestIntervalMs,
      gradesEnabled: ctx.config.grades,
      openUnreadNoticesInSync: this.openUnreadNotices,
    });
  }

  capabilities(): Promise<Capability[]> {
    return Promise.resolve(
      metadata.capabilities.filter((c) => c !== 'grades' || this.ctx.config.grades),
    );
  }

  authenticate(): Promise<AuthResult> {
    return this.strategy.authenticate();
  }

  login(options?: InteractiveLoginOptions): Promise<AuthResult> {
    return this.strategy.login(options);
  }

  async logout(): Promise<void> {
    this.session.reset();
    this.noticeCache.clear();
    const file = this.noticeCheckpointFile();
    if (file) rmSync(file, { force: true });
    await this.strategy.logout();
  }

  /**
   * Notice details are checkpointed to `<cacheDir>/notice-details.json` after every fetched detail,
   * so a backfill that is cut off (daemon stop, crash, session loss) resumes where it stopped
   * instead of waiting for the cursor, which is only saved at the end of a successful run.
   */
  private noticeCheckpointFile(): string | undefined {
    return this.ctx.cacheDir ? path.join(this.ctx.cacheDir, 'notice-details.json') : undefined;
  }

  private loadNoticeCheckpoint(): void {
    if (this.noticeCheckpointLoaded) return;
    this.noticeCheckpointLoaded = true;
    const file = this.noticeCheckpointFile();
    if (!file) return;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as {
        version?: number;
        notices?: Record<string, NoticeCacheEntry>;
      };
      if (data.version !== 1 || !data.notices || typeof data.notices !== 'object') return;
      for (const [k, v] of Object.entries(data.notices)) {
        if (!v || typeof v.rowHash !== 'string' || !v.detail) continue;
        if (!this.noticeCache.get(k)?.detail) this.noticeCache.set(k, v);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        this.ctx.logger.warn('notice detail checkpoint unreadable', {
          error: e instanceof Error ? e.message : String(e),
        });
    }
  }

  private saveNoticeCheckpoint(): void {
    const file = this.noticeCheckpointFile();
    if (!file) return;
    const notices: Record<string, NoticeCacheEntry> = {};
    for (const [k, v] of this.noticeCache) if (v.detail) notices[k] = v;
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, notices }), { mode: 0o600 });
    renameSync(tmp, file);
  }

  /** Inside the deployment's nightly maintenance window (profile timezone)? */
  inMaintenance(now: Date = this.ctx.clock.now()): boolean {
    const p = zonedParts(now, this.timezone);
    return inMaintenanceWindow(this.deployment.maintenanceWindow, p.hour, p.minute);
  }

  sync(input: SyncInput): Promise<SyncResult> {
    return this.exclusive(() => this.syncNow(input));
  }

  /**
   * Fetch the bodies of notices the user explicitly asked for (`unicontext announcements open`,
   * REST, Web UI, MCP open_announcement). Unread notices are opened too — LCU marks them read and
   * cannot set them back, which the caller confirms with `acceptMarksRead`. Serialized with sync().
   */
  openAnnouncements(
    requests: readonly { externalId: string; previousPayload?: unknown }[],
    options: { acceptMarksRead: true; signal?: AbortSignal },
  ): Promise<OpenAnnouncementsResult> {
    if (options.acceptMarksRead !== true)
      throw new PolicyViolationError(
        'Opening LiveCampusU notices marks unread ones read; the caller must accept that',
      );
    return this.exclusive(async () => {
      if (this.inMaintenance())
        throw new OfflineError(
          `LiveCampusU nightly maintenance window (${this.deployment.maintenanceWindow ?? ''})`,
        );
      this.loadNoticeCheckpoint();
      const outcome = await openNoticesOnDemand(
        this.syncContext(this.ctx.clock.now()),
        requests.map((r) => {
          const prev = NoticePayloadSchema.safeParse(r.previousPayload);
          return { key: r.externalId, ...(prev.success ? { previous: prev.data } : {}) };
        }),
        options.signal,
      );
      try {
        this.saveNoticeCheckpoint();
      } catch (e) {
        this.ctx.logger.warn('notice detail checkpoint not written', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      this.ctx.logger.info('LiveCampusU notices opened on request', {
        opened: outcome.results.filter((r) => r.status === 'opened').length,
        markedRead: outcome.results.filter((r) => r.wasUnread).length,
      });
      return {
        items: outcome.items,
        results: outcome.results.map((r) => ({
          externalId: r.key,
          status: r.status,
          ...(r.wasUnread !== undefined ? { wasUnread: r.wasUnread } : {}),
          ...(r.error ? { error: r.error } : {}),
        })),
        warnings: outcome.warnings,
      };
    });
  }

  /**
   * Re-read the submission state (提出済 / 未提出) of single assignments on the student's request
   * (verify_submission). Only `lcu.assignment` items: the 課題・アンケートリスト is read again and the
   * requested rows are returned. Serialized with sync(); never opens the 課題提出 screen and never
   * downloads anything.
   */
  fetchDetails(
    requests: readonly { externalId: string; sourceType?: string; previousPayload?: unknown }[],
    options: { signal?: AbortSignal } = {},
  ): Promise<DetailFetchResult> {
    return this.exclusive(async () => {
      const out: DetailFetchResult = { items: [], results: [], warnings: [] };
      const wanted = requests.filter((r) => {
        if (r.sourceType === undefined || r.sourceType === RAW_TYPES.assignment) return true;
        out.results.push({
          externalId: r.externalId,
          status: 'failed',
          error: `no on-request read for ${r.sourceType}`,
        });
        return false;
      });
      if (wanted.length === 0) return out;
      if (this.inMaintenance())
        throw new OfflineError(
          `LiveCampusU nightly maintenance window (${this.deployment.maintenanceWindow ?? ''})`,
        );
      const outcome = await readAssignmentsOnDemand(
        this.syncContext(this.ctx.clock.now()),
        wanted.map((r) => {
          const prev = AssignmentPayloadSchema.safeParse(r.previousPayload);
          return { submissionSeq: r.externalId, ...(prev.success ? { previous: prev.data } : {}) };
        }),
        options.signal,
      );
      out.items.push(...outcome.items);
      for (const r of outcome.results)
        out.results.push({ externalId: r.submissionSeq, status: r.status });
      return out;
    });
  }

  private syncContext(now: Date): LcuSyncContext {
    const cfg = this.ctx.config;
    return {
      session: this.session,
      deployment: this.deployment,
      options: {
        academicYear: cfg.academicYear ?? currentAcademicYear(now, this.timezone),
        semesters: cfg.semesters ?? this.deployment.semesters.map((s) => s.code),
        grades: cfg.grades,
        attendance: cfg.attendance,
        noticeDetails: cfg.noticeDetails,
        maxNoticeDetailsPerRun: cfg.maxNoticeDetailsPerRun,
        openUnreadNotices: this.openUnreadNotices,
        maxUnreadNoticesPerRun: cfg.maxUnreadNoticesPerRun,
      },
      clock: this.ctx.clock,
      timezone: this.timezone,
      logger: this.ctx.logger,
      product: PRODUCT,
      noticeCache: this.noticeCache,
      onNoticeDetail: () => this.saveNoticeCheckpoint(),
      version: this.versionState,
    };
  }

  private async syncNow(input: SyncInput): Promise<SyncResult> {
    const now = this.ctx.clock.now();
    if (this.inMaintenance(now)) {
      const message = `LiveCampusU nightly maintenance window (${this.deployment.maintenanceWindow ?? ''}); sync skipped`;
      this.lastHealth = { state: 'offline', checkedAt: now.toISOString(), message };
      throw new OfflineError(message);
    }
    const extra = (input.mode === 'incremental' ? input.cursor?.extra : undefined) as
      LcuCursorExtra | undefined;
    if (extra?.notices && this.noticeCache.size === 0)
      for (const [k, v] of Object.entries(extra.notices)) this.noticeCache.set(k, v);
    this.loadNoticeCheckpoint();
    if (!this.versionState && extra?.version) this.versionState = extra.version;
    try {
      const outcome = await runLcuSync(this.syncContext(now), input);
      this.versionState = outcome.version;
      const nd = outcome.stats.noticeDetails;
      this.ctx.logger.info('LiveCampusU notice bodies', { ...nd });
      try {
        this.saveNoticeCheckpoint(); // also drops notices that left the list
      } catch (e) {
        this.ctx.logger.warn('notice detail checkpoint not written', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      this.lastHealth = {
        state: 'healthy',
        checkedAt: this.ctx.clock.now().toISOString(),
        lastSuccessAt: this.ctx.clock.now().toISOString(),
        ...(outcome.version ? { detectedVersion: outcome.version.version } : {}),
      };
      return outcome.result;
    } catch (e) {
      const checkedAt = this.ctx.clock.now().toISOString();
      const message = e instanceof Error ? e.message : String(e);
      this.lastHealth =
        e instanceof AuthRequiredError
          ? { state: 'auth_required', checkedAt, message }
          : e instanceof RateLimitedError
            ? { state: 'rate_limited', checkedAt, message }
            : e instanceof OfflineError
              ? { state: 'offline', checkedAt, message }
              : { state: 'degraded', checkedAt, message };
      throw e;
    }
  }

  health(): Promise<HealthStatus> {
    const now = this.ctx.clock.now();
    if (this.inMaintenance(now))
      return Promise.resolve({
        state: 'offline',
        checkedAt: now.toISOString(),
        message: `LiveCampusU nightly maintenance window (${this.deployment.maintenanceWindow ?? ''})`,
      });
    return Promise.resolve(
      this.lastHealth ?? {
        state: 'healthy',
        checkedAt: now.toISOString(),
        ...(this.versionState ? { detectedVersion: this.versionState.version } : {}),
      },
    );
  }

  detectProductVersion(): Promise<{ product: string; version: string } | undefined> {
    return Promise.resolve(
      this.versionState ? { product: PRODUCT, version: this.versionState.version } : undefined,
    );
  }

  async dispose(): Promise<void> {
    await this.strategy.dispose();
  }
}
