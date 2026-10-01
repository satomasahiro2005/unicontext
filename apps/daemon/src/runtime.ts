import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSecretStore, MemorySecretStore } from '@unicontext/auth';
import { instantiateConnector } from '@unicontext/connector-sdk';
import { createUniContext, type UniContext } from '@unicontext/context-engine';
import {
  type Clock,
  ConfigError,
  createLogger,
  dataPathsFromRoot,
  type DataPaths,
  ensureDataDirs,
  errorMessage,
  loadConfig,
  loadProfile,
  type Logger,
  resolveDataPaths,
  type SecretStore,
  type UniContextConfig,
  type UniversityProfile,
  defaultConfig,
  stderrSink,
  type LogSink,
  systemClock,
} from '@unicontext/core';
import { ProposalStore } from '@unicontext/mcp/proposals';
import type { SourceInfo } from './api-types.js';
import { OffsetClock, seedDevData } from './dev.js';
import {
  describeLoadError,
  loadConnectorModule,
  type ModuleImporter,
  resolveConnectorPackage,
} from './registry.js';

export interface RuntimeOptions {
  /** Data root; config.yaml is read from the same directory unless configFile is given. */
  dataDir?: string;
  configFile?: string;
  /** Synthetic seed data + fake connectors (no university access, nothing stored on the real data dir). */
  dev?: boolean;
  logger?: Logger;
  /** Extra log sink (the daemon passes a file sink). */
  logSink?: LogSink;
  secrets?: SecretStore;
  /** Use an in-process secret store instead of the OS keychain. */
  noKeychain?: boolean;
  config?: UniContextConfig;
  profile?: UniversityProfile;
  importer?: ModuleImporter;
  clock?: Clock;
}

export interface SourceRuntimeInfo {
  sourceId: string;
  connector: string | undefined;
  enabled: boolean;
  loaded: boolean;
  loadError: string | undefined;
  schedule: string | undefined;
}

/** Everything the daemon, the CLI and the MCP stdio server share: the wired UniContext plus config. */
export interface Runtime {
  uc: UniContext;
  config: UniContextConfig;
  profile: UniversityProfile | undefined;
  paths: DataPaths;
  secrets: SecretStore;
  logger: Logger;
  dev: boolean;
  proposals: ProposalStore;
  sourceInfo: Map<string, SourceRuntimeInfo>;
  /** Sources as shown by `GET /api/v1/sources` and `unicontext sources`. */
  describeSources(): SourceInfo[];
  close(): Promise<void>;
}

export function loginCommandFor(sourceId: string): string {
  return `unicontext login ${sourceId}`;
}

export function buildLogger(
  config: UniContextConfig,
  profile: UniversityProfile | undefined,
  sink: LogSink = stderrSink,
): Logger {
  const pattern = profile?.privacy.studentIdPattern;
  let extra: RegExp[] = [];
  if (pattern) {
    try {
      extra = [new RegExp(pattern, 'g')];
    } catch {
      extra = [];
    }
  }
  return createLogger({
    level: config.logging.level,
    sink,
    redaction: { extraValuePatterns: extra },
  });
}

function pathsFor(options: RuntimeOptions, tempRoot: string | undefined): DataPaths {
  const root = tempRoot ?? options.dataDir;
  if (!root) return resolveDataPaths();
  return dataPathsFromRoot(root, root);
}

/** Open the database, load config + profile and register every enabled source. */
export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const dev = options.dev === true;
  const tempRoot =
    dev && !options.dataDir ? mkdtempSync(path.join(tmpdir(), 'unicontext-dev-')) : undefined;
  const paths = pathsFor(options, tempRoot);
  ensureDataDirs(paths);
  const configFile = options.configFile ?? paths.configFile;
  const config = options.config ?? (dev ? defaultConfig() : loadConfig(configFile));
  let profile = options.profile;
  const profileId = dev ? 'shizuoka-university' : config.profile;
  if (!profile && profileId) {
    try {
      profile = loadProfile(profileId, { searchPaths: [path.join(paths.configDir, 'profiles')] });
    } catch (e) {
      if (!options.logger)
        buildLogger(config, undefined).warn('profile not loaded', { error: errorMessage(e) });
      else options.logger.warn('profile not loaded', { error: errorMessage(e) });
      if (dev) throw e;
    }
  }
  const logger = options.logger ?? buildLogger(config, profile, options.logSink);
  const secrets =
    options.secrets ??
    (options.noKeychain || dev
      ? new MemorySecretStore()
      : await createSecretStore({
          backend: 'auto',
          onFallback: (reason) =>
            logger.warn('OS keychain unavailable, secrets are kept in memory only', {
              reason: errorMessage(reason),
            }),
        }));

  const devClock = dev ? new OffsetClock() : undefined;
  const clock = options.clock ?? devClock ?? systemClock;
  const uc = createUniContext({
    dataDir: paths.root,
    logger,
    clock,
    ...(profile ? { profile } : {}),
    ...(config.timezone ? { timezone: config.timezone } : {}),
    schedules: config.sync.schedules,
  });
  const proposals = new ProposalStore(path.join(paths.root, 'proposals'), { clock });
  const sourceInfo = new Map<string, SourceRuntimeInfo>();
  const importer = options.importer;

  if (dev && devClock) {
    const ids = await seedDevData(
      {
        register: (c) => uc.sync.register(c),
        sync: (id) => uc.sync.sync(id),
        sourceIds: () => uc.sync.sources().map((s) => s.sourceId),
      },
      devClock,
    );
    for (const id of ids)
      sourceInfo.set(id, {
        sourceId: id,
        connector: 'fake (dev seed)',
        enabled: true,
        loaded: true,
        loadError: undefined,
        schedule: undefined,
      });
  } else {
    for (const [sourceId, src] of Object.entries(config.sources)) {
      const info: SourceRuntimeInfo = {
        sourceId,
        connector: resolveConnectorPackage(sourceId, src, profile).packageName,
        enabled: src.enabled,
        loaded: false,
        loadError: undefined,
        schedule: src.schedule ?? config.sync.schedules[sourceId],
      };
      sourceInfo.set(sourceId, info);
      if (!src.enabled) continue;
      try {
        const { module, packageName } = await loadConnectorModule({
          sourceId,
          config: src,
          profile,
          ...(importer ? { importer } : {}),
          searchDirs: [paths.configDir, paths.root],
        });
        const connector = instantiateConnector(module, {
          sourceId,
          config: src,
          secrets,
          logger,
          clock,
          ...(profile ? { profile } : {}),
          cacheDir: path.join(paths.cache, sourceId),
        });
        uc.sync.register(connector);
        info.connector = packageName;
        info.loaded = true;
        if (src.schedule) {
          // per-source override from `sources.<id>.schedule` (config.sync.schedules also works)
          config.sync.schedules[sourceId] ??= src.schedule;
        }
      } catch (e) {
        const message = describeLoadError(e);
        info.loadError = message;
        logger.error('connector not loaded', { sourceId, error: message });
        // Show the source as failed instead of crashing (missing connector package, bad config).
        uc.sync.stores.raw.ensureSource({
          id: sourceId,
          connector: info.connector ?? 'unknown',
        });
        uc.sync.stores.health.set(sourceId, {
          state: 'failed',
          checkedAt: clock.now().toISOString(),
          message,
        });
      }
    }
  }

  const describeSources = (): SourceInfo[] => {
    const status = new Map(uc.context.admin().sources.map((s) => [s.sourceId, s]));
    const registered = new Map(uc.sync.sources().map((s) => [s.sourceId, s]));
    const scheduled = new Map(uc.scheduler.status().map((s) => [s.sourceId, s]));
    const ids = new Set<string>([...sourceInfo.keys(), ...status.keys()]);
    return [...ids].sort().map((sourceId) => {
      const info = sourceInfo.get(sourceId);
      const st = status.get(sourceId);
      const reg = registered.get(sourceId);
      return {
        sourceId,
        displayName: st?.displayName ?? reg?.metadata.sourceLabel,
        state: st?.state ?? 'unknown',
        message: st?.message ?? info?.loadError,
        lastSyncAt: st?.lastSyncAt,
        lastSuccessAt: st?.lastSuccessAt,
        detectedVersion: st?.detectedVersion,
        versionKnown: st?.versionKnown,
        openDrift: st?.openDrift ?? 0,
        connector: info?.connector ?? reg?.metadata.name,
        enabled: info?.enabled ?? true,
        loaded: info?.loaded ?? reg !== undefined,
        loadError: info?.loadError,
        schedule:
          scheduled.get(sourceId)?.schedule ?? info?.schedule ?? reg?.metadata.defaultSchedule,
        capabilities: reg?.metadata.capabilities ?? [],
        apiStability: reg?.metadata.apiStability,
        running: reg ? uc.sync.isRunning(sourceId) : false,
        loginCommand: loginCommandFor(sourceId),
      };
    });
  };

  return {
    uc,
    config,
    profile,
    paths,
    secrets,
    logger,
    dev,
    proposals,
    sourceInfo,
    describeSources,
    async close() {
      await uc.close();
      if (tempRoot) {
        try {
          rmSync(tempRoot, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    },
  };
}

export function requireSource(runtime: Runtime, sourceId: string): void {
  if (!runtime.uc.sync.sources().some((s) => s.sourceId === sourceId)) {
    const info = runtime.sourceInfo.get(sourceId);
    if (info?.loadError) throw new ConfigError(info.loadError);
    throw new ConfigError(
      `ソース ${sourceId} は登録されていません（config.yaml の sources を確認してください）`,
    );
  }
}
