import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type ConnectorModule,
  isConnectorModule,
  resolveConnectorExport,
} from '@unicontext/connector-sdk';
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
  'wordpress-portal': '@unicontext/wordpress-portal',
  // One package, two modules: the public 休講 page is `module: public-cancellations` of syllabus.
  'lcu-public-cancellations': '@unicontext/syllabus',
};

/** Source config defaults implied by a product (merged under the user's config). */
const PRODUCT_DEFAULTS: Readonly<Record<string, Record<string, unknown>>> = {
  'lcu-public-cancellations': { module: 'public-cancellations' },
};

type ProfileSources = Pick<UniversityProfile, 'sources'>['sources'];

function profileEntryFor(
  sourceId: string,
  profileSources: ProfileSources,
): { role: string; product: string; settings: Record<string, unknown> } | undefined {
  const pick = (role: string) => {
    const entry = profileSources[role];
    if (!entry) return undefined;
    const { product, ...settings } = entry;
    return { role, product, settings };
  };
  // 1. same key as a profile role ("academic"), 2. same name as a role's product ("livecampusu").
  const byRole = pick(sourceId);
  if (byRole) return byRole;
  const byProduct = Object.keys(profileSources).find(
    (role) => profileSources[role]?.product === sourceId,
  );
  if (byProduct) return pick(byProduct);
  return undefined;
}

/**
 * The sources the runtime actually runs (§53, §54): every source of the university profile (keyed
 * by product name, e.g. `livecampusu`, `lcu-public-cancellations`) plus every source in
 * config.yaml. A config entry that names a profile role or product is merged over that profile
 * entry, so `sources.livecampusu: {}` keeps the profile's `connector`/`module`/`mapping` and a
 * profile source marked `enabled: false` (EdStem) is switched on by listing it in config.yaml.
 * Set `enabled: false` in config.yaml to turn a profile source off.
 */
export function effectiveSources(
  sources: Readonly<Record<string, SourceConfig>>,
  profile?: Pick<UniversityProfile, 'sources'>,
): Record<string, SourceConfig> {
  const profileSources: ProfileSources = profile?.sources ?? {};
  const out: Record<string, SourceConfig> = {};
  const usedRoles = new Set<string>();
  for (const [sourceId, src] of Object.entries(sources)) {
    const match = profileEntryFor(sourceId, profileSources);
    if (match) usedRoles.add(match.role);
    const product = match?.product ?? sourceId;
    out[sourceId] = {
      ...(PRODUCT_DEFAULTS[product] ?? {}),
      ...(match?.settings ?? {}),
      ...src,
    } as SourceConfig;
  }
  for (const [role, entry] of Object.entries(profileSources)) {
    if (usedRoles.has(role)) continue;
    const { product, ...settings } = entry;
    const sourceId = out[product] === undefined ? product : role;
    if (out[sourceId] !== undefined) continue;
    out[sourceId] = {
      enabled: true,
      ...(PRODUCT_DEFAULTS[product] ?? {}),
      ...settings,
    } as SourceConfig;
  }
  return out;
}

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

/** The export a package offers as its connector entry: `default`, then `connector` (§69). */
function connectorEntry(imported: unknown): unknown {
  const ns = (imported ?? {}) as Record<string, unknown>;
  const candidates: unknown[] = [ns.default, ns.connector, ns.createConnector, ns];
  // CommonJS packages arrive as `{ default: module.exports }`.
  const cjs = ns.default as Record<string, unknown> | undefined;
  if (cjs && typeof cjs === 'object') candidates.push(cjs.connector, cjs.default);
  return candidates.find((c) => isConnectorModule(c) || typeof c === 'function');
}

/**
 * Load the ConnectorModule for one source. A package exports a `ConnectorModule` or a
 * `ConnectorFactory` (`({sourceId, config, profile}) => Promise<ConnectorModule>`) as `default`
 * and/or named `connector`; `resolveConnectorExport` from the connector SDK turns either into the
 * module — the same function every host uses, so the daemon and the packages cannot drift apart.
 * Factories receive the effective source config (see `effectiveSources`): generic adapters and the
 * syllabus package pick their module from `mapping:` / `module:`.
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
  const entry = connectorEntry(imported);
  if (entry === undefined)
    throw new ConnectorLoadError(
      `コネクタ ${packageName} が ConnectorModule を export していません（default か connector に defineConnector() の結果かファクトリが必要です）`,
      packageName,
      'bad_export',
    );
  let module: ConnectorModule<unknown>;
  try {
    module = await resolveConnectorExport(entry, {
      sourceId,
      config,
      profile: options.profile,
    });
  } catch (e) {
    throw new ConnectorLoadError(
      isConnectorModule(entry)
        ? `コネクタ ${packageName} を読み込めません: ${errorMessage(e)}`
        : `コネクタ ${packageName} の初期化に失敗しました: ${errorMessage(e)}`,
      packageName,
      typeof entry === 'function' ? 'import_failed' : 'bad_export',
    );
  }
  return { module: module as ConnectorModule, packageName };
}

export function describeLoadError(e: unknown): string {
  return e instanceof ConnectorLoadError || e instanceof ConfigError ? e.message : errorMessage(e);
}
