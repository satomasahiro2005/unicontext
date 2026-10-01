import type { Capability, HealthStatus } from '@unicontext/canonical-model';
import type {
  AuthResult,
  ConnectorContext,
  InteractiveAuthAdapter,
  InteractiveLoginOptions,
  SyncInput,
  SyncResult,
  VersionAwareAdapter,
} from '@unicontext/connector-sdk';
import { AuthRequiredError, OfflineError, RateLimitedError, zonedParts } from '@unicontext/core';
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
import {
  type LcuCursorExtra,
  type NoticeCacheEntry,
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
export class LiveCampusUAdapter implements VersionAwareAdapter, InteractiveAuthAdapter {
  readonly id: string;
  readonly version = metadata.version;
  readonly deployment: LcuDeploymentProfile;
  readonly strategy: LcuAuthStrategy;
  readonly strategyKind: AuthStrategyKind;
  readonly session: LcuSession;
  private readonly timezone: string;
  private noticeCache = new Map<string, NoticeCacheEntry>();
  private versionState: VersionState | undefined;
  private lastHealth: HealthStatus | undefined;

  constructor(
    private readonly ctx: ConnectorContext<LiveCampusUConfig>,
    options: LiveCampusUAdapterOptions = {},
  ) {
    this.id = `livecampusu:${ctx.sourceId}`;
    this.deployment = options.deployment ?? deploymentFor(ctx, options.deployments);
    this.timezone = ctx.profile?.academicCalendar.timezone ?? 'Asia/Tokyo';
    const settings = productSettings(ctx);
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
    await this.strategy.logout();
  }

  /** Inside the deployment's nightly maintenance window (profile timezone)? */
  inMaintenance(now: Date = this.ctx.clock.now()): boolean {
    const p = zonedParts(now, this.timezone);
    return inMaintenanceWindow(this.deployment.maintenanceWindow, p.hour, p.minute);
  }

  async sync(input: SyncInput): Promise<SyncResult> {
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
    if (!this.versionState && extra?.version) this.versionState = extra.version;
    const cfg = this.ctx.config;
    try {
      const outcome = await runLcuSync(
        {
          session: this.session,
          deployment: this.deployment,
          options: {
            academicYear: cfg.academicYear ?? currentAcademicYear(now, this.timezone),
            semesters: cfg.semesters ?? this.deployment.semesters.map((s) => s.code),
            grades: cfg.grades,
            attendance: cfg.attendance,
            noticeDetails: cfg.noticeDetails,
            maxNoticeDetailsPerRun: cfg.maxNoticeDetailsPerRun,
          },
          clock: this.ctx.clock,
          timezone: this.timezone,
          logger: this.ctx.logger,
          product: PRODUCT,
          noticeCache: this.noticeCache,
          version: this.versionState,
        },
        input,
      );
      this.versionState = outcome.version;
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
