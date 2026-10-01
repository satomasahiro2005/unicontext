import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Capability, HealthStatus } from '@unicontext/canonical-model';
import {
  type AuthResult,
  type ConnectorMetadata,
  defineMetadata,
  type SourceAdapter,
  type SyncInput,
  type SyncResult,
} from '@unicontext/connector-sdk';
import { ConfigError } from '@unicontext/core';
import { runMappedResources, type ResourceCaller, type RunOptions } from './runner.js';
import { loadMappingFile, type MappingSpec, parseMappingSpec } from './spec.js';

/**
 * Base class of the MCP / CLI / REST adapters: capabilities and sync() come from the mapping,
 * subclasses provide the transport (`caller()`), authentication, health and cleanup.
 */
export abstract class MappedSourceAdapter implements SourceAdapter {
  readonly version = '1.0.0';
  private readonly parentCache = new Map<string, unknown[]>();

  constructor(
    readonly id: string,
    readonly spec: MappingSpec,
    protected readonly runOptions: RunOptions = {},
  ) {}

  protected abstract caller(): Promise<ResourceCaller>;
  abstract authenticate(): Promise<AuthResult>;
  abstract health(): Promise<HealthStatus>;
  abstract dispose(): Promise<void>;

  capabilities(): Promise<Capability[]> {
    return Promise.resolve([...this.spec.capabilities]);
  }

  async sync(input: SyncInput): Promise<SyncResult> {
    const caller = await this.caller();
    return runMappedResources(this.spec, caller, input, {
      ...this.runOptions,
      parentCache: this.parentCache,
    });
  }
}

export interface MappedAdapterOptions {
  id: string;
  spec: MappingSpec;
  caller: ResourceCaller | (() => Promise<ResourceCaller>);
  authenticate?: () => Promise<AuthResult>;
  health?: () => Promise<HealthStatus>;
  dispose?: () => Promise<void>;
  runOptions?: RunOptions;
}

class FunctionMappedAdapter extends MappedSourceAdapter {
  constructor(private readonly options: MappedAdapterOptions) {
    super(options.id, options.spec, options.runOptions);
  }
  protected caller(): Promise<ResourceCaller> {
    const c = this.options.caller;
    return typeof c === 'function' ? c() : Promise.resolve(c);
  }
  authenticate(): Promise<AuthResult> {
    return this.options.authenticate?.() ?? Promise.resolve({ status: 'not_required' });
  }
  health(): Promise<HealthStatus> {
    return (
      this.options.health?.() ??
      Promise.resolve({ state: 'healthy', checkedAt: new Date().toISOString() })
    );
  }
  dispose(): Promise<void> {
    return this.options.dispose?.() ?? Promise.resolve();
  }
}

/** Build a SourceAdapter from a mapping and a ResourceCaller (tests, custom transports). */
export function createMappedAdapter(options: MappedAdapterOptions): SourceAdapter {
  return new FunctionMappedAdapter(options);
}

export interface MappingMetadataOptions {
  /** Package/connector name, e.g. "@unicontext/adapter-mcp". */
  name: string;
  adapter: 'mcp' | 'cli' | 'rest';
  version?: string;
  license?: string;
  defaultSchedule?: string;
}

/** ConnectorMetadata (§55, §27) derived from a mapping: generic adapters are experimental. */
export function mappingMetadata(
  spec: MappingSpec,
  options: MappingMetadataOptions,
): ConnectorMetadata {
  return defineMetadata({
    name: options.name,
    product: spec.product,
    version: options.version ?? '1.0.0',
    license: options.license ?? 'MIT',
    ...(spec.description ? { description: spec.description } : {}),
    capabilities: spec.capabilities,
    adapter: options.adapter,
    apiStability: 'experimental',
    risk: 'experimental',
    ...(spec.testedVersion ? { testedVersion: spec.testedVersion } : {}),
    defaultAuthority: spec.defaultAuthority,
    ...(spec.sourceLabel ? { sourceLabel: spec.sourceLabel } : {}),
    defaultSchedule: options.defaultSchedule ?? '15m',
    rawTypes: [...new Set(spec.resources.map((r) => r.sourceType))],
  });
}

export interface ResolveMappingOptions {
  /** Relative mapping paths are resolved against this directory (default: cwd). */
  baseDir?: string;
  /** Directory of shipped mappings; `mapping: canvas-mcp` finds `<builtinDir>/canvas-mcp.yaml`. */
  builtinDir?: string;
}

/**
 * Resolve the `mapping:` config key: an inline object, inline YAML text (contains a newline), a
 * file path, or the name of a shipped mapping.
 */
export function resolveMapping(ref: unknown, options: ResolveMappingOptions = {}): MappingSpec {
  if (ref === undefined || ref === null) throw new ConfigError('Source config needs a "mapping"');
  if (typeof ref !== 'string') return parseMappingSpec(ref);
  if (ref.includes('\n')) return parseMappingSpec(ref);
  const direct = isAbsolute(ref) ? ref : resolve(options.baseDir ?? process.cwd(), ref);
  if (existsSync(direct)) return loadMappingFile(direct);
  if (options.builtinDir) {
    for (const candidate of [
      join(options.builtinDir, ref),
      join(options.builtinDir, `${ref}.yaml`),
    ])
      if (existsSync(candidate)) return loadMappingFile(candidate);
  }
  throw new ConfigError(`Mapping not found: ${ref}`);
}
