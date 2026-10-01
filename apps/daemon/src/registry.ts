import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ConnectorModule } from '@unicontext/connector-sdk';
import {
  ConfigError,
  errorMessage,
  type SourceConfig,
  type UniversityProfile,
} from '@unicontext/core';

/**
 * Maps a config source key (or `connector:` short name) to the package that provides it (§26, §69).
 * Connector packages are loaded dynamically so a missing or broken package degrades one source
 * instead of crashing the daemon.
 */
export const CONNECTOR_PACKAGES: Readonly<Record<string, string>> = {
  livecampusu: '@unicontext/livecampusu',
  microsoft365: '@unicontext/microsoft365',
  files: '@unicontext/local-files',
  'local-files': '@unicontext/local-files',
  syllabus: '@unicontext/syllabus',
  'chatgpt-record': '@unicontext/chatgpt-record',
  record: '@unicontext/chatgpt-record',
};

/** `adapter:` keys (§28-§31): generic adapters for services without a first-class connector. */
export const ADAPTER_PACKAGES: Readonly<Record<string, string>> = {
  mcp: '@unicontext/adapter-mcp',
  cli: '@unicontext/adapter-cli',
  rest: '@unicontext/adapter-rest',
  browser: '@unicontext/adapter-browser',
};

export type ConnectorLoadErrorCode = 'unmapped' | 'not_installed' | 'bad_export' | 'import_failed';

export class ConnectorLoadError extends Error {
  constructor(
    message: string,
    readonly packageName: string | undefined,
    readonly code: ConnectorLoadErrorCode,
  ) {
    super(message);
    this.name = 'ConnectorLoadError';
  }
}

export interface ConnectorResolution {
  /** npm package name, or undefined when nothing maps to the source. */
  packageName: string | undefined;
  via: 'explicit' | 'connector-alias' | 'profile' | 'adapter' | 'source-key' | 'none';
}

const looksLikePackage = (s: string): boolean => s.startsWith('@') || s.includes('/');

/** Decide which package serves a configured source. */
export function resolveConnectorPackage(
  sourceId: string,
  config: Pick<SourceConfig, 'connector' | 'adapter'>,
  profile?: Pick<UniversityProfile, 'sources'>,
): ConnectorResolution {
  if (config.connector) {
    if (looksLikePackage(config.connector))
      return { packageName: config.connector, via: 'explicit' };
    const alias = CONNECTOR_PACKAGES[config.connector];
    return { packageName: alias ?? `@unicontext/${config.connector}`, via: 'connector-alias' };
  }
  const direct = CONNECTOR_PACKAGES[sourceId];
  if (direct) return { packageName: direct, via: 'source-key' };
  const product = profile?.sources[sourceId]?.product;
  if (product) {
    const viaProfile = CONNECTOR_PACKAGES[product];
    if (viaProfile) return { packageName: viaProfile, via: 'profile' };
  }
  if (config.adapter === 'filesystem')
    return { packageName: CONNECTOR_PACKAGES['local-files'], via: 'adapter' };
  if (config.adapter && config.adapter !== 'native') {
    const pkg = ADAPTER_PACKAGES[config.adapter];
    if (pkg) return { packageName: pkg, via: 'adapter' };
  }
  return { packageName: undefined, via: 'none' };
}

export type ModuleImporter = (specifier: string) => Promise<unknown>;

export interface LoadConnectorOptions {
  sourceId: string;
  config: SourceConfig;
  profile?: UniversityProfile | undefined;
  /** Test seam; defaults to dynamic import with a fallback to the user's connector directories. */
  importer?: ModuleImporter;
  /** Extra directories to resolve third-party connector packages from (config dir, data dir). */
  searchDirs?: string[];
}

/** True when the failure is "the package itself is not installed" (not a broken dependency of it). */
function isNotFound(e: unknown, packageName: string): boolean {
  const err = e as { code?: string; message?: string } | undefined;
  if (!err) return false;
  if (err.code !== 'ERR_MODULE_NOT_FOUND' && err.code !== 'MODULE_NOT_FOUND') return false;
  return (err.message ?? '').includes(packageName);
}

export function createDefaultImporter(searchDirs: string[] = []): ModuleImporter {
  return async (specifier) => {
    try {
      return await import(specifier);
    } catch (e) {
      if (!isNotFound(e, specifier)) throw e;
      for (const dir of searchDirs) {
        try {
          const req = createRequire(path.join(dir, 'noop.js'));
          const resolved = req.resolve(specifier);
          return await import(pathToFileURL(resolved).href);
        } catch {
          // try the next directory
        }
      }
      throw e;
    }
  };
}

function looksLikeModule(v: unknown): v is ConnectorModule {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.metadata === 'object' &&
    m.metadata !== null &&
    typeof m.createAdapter === 'function' &&
    typeof m.createNormalizer === 'function'
  );
}

/**
 * Load the ConnectorModule for one source. A package may export the module as `default` or
 * `connector`, or export a (possibly async) factory `(init: {sourceId, config, profile}) =>
 * ConnectorModule` — the shape generic adapter packages use, because they need the source's
 * config (command, url, ...) to know what they connect to.
 */
export async function loadConnectorModule(options: LoadConnectorOptions): Promise<{
  module: ConnectorModule;
  packageName: string;
}> {
  const { sourceId, config } = options;
  const packageName = resolveConnectorPackage(sourceId, config, options.profile).packageName;
  if (!packageName)
    throw new ConnectorLoadError(
      `ソース ${sourceId} に対応するコネクタが見つかりません。config.yaml の sources.${sourceId} に connector: か adapter: を指定してください`,
      undefined,
      'unmapped',
    );
  const importer = options.importer ?? createDefaultImporter(options.searchDirs);
  let imported: unknown;
  try {
    imported = await importer(packageName);
  } catch (e) {
    if (isNotFound(e, packageName))
      throw new ConnectorLoadError(
        `コネクタ ${packageName} がインストールされていません（ソース ${sourceId}）。インストールするか、config.yaml で enabled: false にしてください`,
        packageName,
        'not_installed',
      );
    throw new ConnectorLoadError(
      `コネクタ ${packageName} を読み込めません: ${errorMessage(e)}`,
      packageName,
      'import_failed',
    );
  }
  const ns = (imported ?? {}) as Record<string, unknown>;
  const candidates = [ns.default, ns.connector, ns.createConnector, ns];
  for (const c of candidates) {
    if (looksLikeModule(c)) return { module: c, packageName };
    if (typeof c === 'function') {
      try {
        const made: unknown = await (c as (init: unknown) => unknown)({
          sourceId,
          config,
          profile: options.profile,
        });
        if (looksLikeModule(made)) return { module: made, packageName };
      } catch (e) {
        throw new ConnectorLoadError(
          `コネクタ ${packageName} の初期化に失敗しました: ${errorMessage(e)}`,
          packageName,
          'import_failed',
        );
      }
    }
  }
  throw new ConnectorLoadError(
    `コネクタ ${packageName} が ConnectorModule を export していません（default か connector に defineConnector() の結果が必要です）`,
    packageName,
    'bad_export',
  );
}

export function describeLoadError(e: unknown): string {
  return e instanceof ConnectorLoadError || e instanceof ConfigError ? e.message : errorMessage(e);
}
