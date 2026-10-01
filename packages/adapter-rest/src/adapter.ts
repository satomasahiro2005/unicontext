import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { HealthStatus } from '@unicontext/canonical-model';
import {
  type AuthResult,
  createHttpClient,
  type HttpClient,
  RateLimiter,
  type VersionAwareAdapter,
} from '@unicontext/connector-sdk';
import {
  AuthRequiredError,
  type Clock,
  ConfigError,
  ConnectorError,
  type FetchLike,
  type Logger,
  OfflineError,
  PolicyViolationError,
  redact,
  type SecretStore,
  secretKey,
  silentLogger,
  systemClock,
} from '@unicontext/core';
import {
  evalExpr,
  MappedSourceAdapter,
  type MappingSpec,
  type ResourceCaller,
  type ResourceRequest,
  type ResourceResponse,
  type RunOptions,
} from '@unicontext/mapping';
import { type RestCall, RestCallSchema, type RestConfig } from './config.js';
import { buildRequest, joinUrl, parseLinkHeader } from './http.js';
import {
  buildOperationCatalog,
  documentBaseUrl,
  documentVersion,
  type OperationInfo,
  parseOpenApiText,
} from './openapi.js';

export interface RestAdapterOptions {
  id?: string;
  sourceId: string;
  spec: MappingSpec;
  config: RestConfig;
  secrets: SecretStore;
  logger?: Logger;
  fetch?: FetchLike | undefined;
  rateLimiter?: RateLimiter;
  clock?: Clock;
  /** Relative `openapi:` file paths are resolved against this directory (default: cwd). */
  baseDir?: string;
  runOptions?: RunOptions;
}

function errText(e: unknown): string {
  return String(redact(e instanceof Error ? e.message : String(e)));
}

/**
 * SourceAdapter for REST APIs (§30): OpenAPI → operation catalog, declarative mapping → raw items.
 * Read-only by construction (§50): only GET operations are executed; anything else is refused
 * with a PolicyViolationError.
 */
export class RESTSourceAdapter extends MappedSourceAdapter implements VersionAwareAdapter {
  private readonly options: RestAdapterOptions;
  private readonly logger: Logger;
  private readonly http: HttpClient;
  /** Fetches the OpenAPI document by URL; deliberately without the API credentials. */
  private readonly docHttp: HttpClient;
  private documentPromise: Promise<Record<string, unknown> | undefined> | undefined;
  private catalogCache: OperationInfo[] | undefined;

  constructor(options: RestAdapterOptions) {
    super(options.id ?? `rest:${options.spec.id}`, options.spec, options.runOptions);
    this.options = options;
    this.logger = (options.logger ?? silentLogger).child({ adapter: 'rest' });
    const clock = options.clock ?? systemClock;
    const rateLimiter = options.rateLimiter ?? new RateLimiter({ clock });
    this.http = createHttpClient({
      ...(options.fetch ? { fetch: options.fetch } : {}),
      rateLimiter,
      clock,
      headers: () => this.requestHeaders(),
    });
    this.docHttp = createHttpClient({
      ...(options.fetch ? { fetch: options.fetch } : {}),
      rateLimiter,
      clock,
    });
  }

  private get config(): RestConfig {
    return this.options.config;
  }

  /** Auth + configured literal headers; the secret is read from the SecretStore per request. */
  private async requestHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(this.config.headers ?? {}),
    };
    const auth = this.config.auth;
    if (auth.type === 'none') return headers;
    const value = await this.options.secrets.get(
      secretKey(this.options.sourceId, auth.secret ?? ''),
    );
    if (value === undefined || value === '')
      throw new AuthRequiredError(
        `Secret "${auth.secret}" is not set (source ${this.options.sourceId})`,
      );
    if (auth.type === 'bearer') headers.authorization = `${auth.prefix ?? 'Bearer '}${value}`;
    else if (auth.type === 'basic')
      headers.authorization = `${auth.prefix ?? 'Basic '}${Buffer.from(value, 'utf8').toString('base64')}`;
    else headers[auth.header ?? 'X-API-Key'] = `${auth.prefix ?? ''}${value}`;
    return headers;
  }

  /** The OpenAPI document (loaded once): file path, http(s) URL, inline text or object. */
  document(): Promise<Record<string, unknown> | undefined> {
    this.documentPromise ??= this.loadDocument().catch((e: unknown) => {
      this.documentPromise = undefined; // a failed load may be retried later
      throw e;
    });
    return this.documentPromise;
  }

  private async loadDocument(): Promise<Record<string, unknown> | undefined> {
    const source = this.config.openapi;
    if (source === undefined) return undefined;
    if (typeof source !== 'string') return source;
    const trimmed = source.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      const res = await this.docHttp.request(trimmed, {
        method: 'GET',
        headers: { accept: 'application/json, application/yaml, */*' },
      });
      if (!res.ok) throw new ConnectorError(`OpenAPI document request failed: HTTP ${res.status}`);
      return parseOpenApiText(await res.text());
    }
    if (trimmed.includes('\n') || trimmed.startsWith('{')) return parseOpenApiText(trimmed);
    const file = isAbsolute(trimmed)
      ? trimmed
      : resolvePath(this.options.baseDir ?? process.cwd(), trimmed);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (e) {
      throw new ConfigError(`Cannot read OpenAPI file ${file}: ${errText(e)}`, { cause: e });
    }
    return parseOpenApiText(text);
  }

  /** The operation catalog (§30): `[{operationId, method, path, summary, parameters, responseSchema, tags}]`. */
  async catalog(): Promise<OperationInfo[]> {
    if (this.catalogCache) return this.catalogCache;
    const doc = await this.document();
    if (!doc) return [];
    this.catalogCache = buildOperationCatalog(doc);
    return this.catalogCache;
  }

  private async baseUrl(): Promise<string> {
    if (this.config.url) return this.config.url.replace(/\/+$/, '');
    const fromDoc = documentBaseUrl(await this.document());
    if (!fromDoc)
      throw new ConfigError(
        'No base URL: set "url" in the source config (the OpenAPI document has no absolute servers[0].url)',
      );
    return fromDoc;
  }

  /** operationIds the mapping calls. */
  mappedOperations(): string[] {
    const ids = new Set<string>();
    for (const r of this.spec.resources) {
      const op = (r.call as { operation?: unknown }).operation;
      if (typeof op === 'string') ids.add(op);
    }
    return [...ids];
  }

  protected caller(): Promise<ResourceCaller> {
    return Promise.resolve({ call: (request) => this.callResource(request) });
  }

  private async findOperation(call: RestCall, resourceName: string): Promise<OperationInfo> {
    if (call.path) {
      return {
        operationId: `GET ${call.path}`,
        method: 'get',
        path: call.path,
        tags: [],
        parameters: [],
        hasRequestBody: false,
        deprecated: false,
      };
    }
    const catalog = await this.catalog();
    const op = catalog.find((o) => o.operationId === call.operation);
    if (!op)
      throw new ConnectorError(
        `Resource ${resourceName}: operation "${call.operation}" is not in the API catalog (${catalog
          .slice(0, 12)
          .map((o) => o.operationId)
          .join(', ')}${catalog.length > 12 ? ', ...' : ''})`,
      );
    return op;
  }

  private async callResource(request: ResourceRequest): Promise<ResourceResponse> {
    const parsed = RestCallSchema.safeParse(request.call);
    if (!parsed.success)
      throw new ConfigError(
        `Resource ${request.resource.name}: invalid REST call (${parsed.error.issues.map((i) => i.message).join('; ')})`,
      );
    const call = parsed.data;
    const operation = await this.findOperation(call, request.resource.name);
    if (operation.method !== 'get')
      throw new PolicyViolationError(
        `Operation ${operation.operationId} is ${operation.method.toUpperCase()}; only GET is executed (read-only default, §50)`,
        { details: { operation: operation.operationId, method: operation.method } },
      );

    const base = await this.baseUrl();
    const paginate = call.paginate;
    const params = { ...call.params };
    if (paginate?.type === 'page' && params[paginate.param] === undefined)
      params[paginate.param] = paginate.start;

    let url: string;
    let extraHeaders: Record<string, string> = {};
    if (call.url) {
      if (new URL(call.url).origin !== new URL(base).origin)
        throw new ConnectorError(
          `Refusing to follow a next link to another origin: ${new URL(call.url).origin}`,
        );
      url = call.url;
    } else {
      const built = buildRequest(base, operation, params);
      url = built.url;
      extraHeaders = built.headers;
    }

    const signals = [AbortSignal.timeout(this.config.timeoutMs)];
    if (request.signal) signals.push(request.signal);
    this.logger.debug('rest call', { operation: operation.operationId, url: String(redact(url)) });
    const res = await this.http.request(url, {
      method: 'GET',
      headers: extraHeaders,
      signal: AbortSignal.any(signals),
    });
    if (!res.ok)
      throw new ConnectorError(`GET ${operation.operationId} failed: HTTP ${res.status}`, {
        details: { status: res.status, operation: operation.operationId },
      });
    const text = await res.text();
    let data: unknown = [];
    if (res.status !== 204 && text.trim() !== '') {
      try {
        data = JSON.parse(text) as unknown;
      } catch (e) {
        throw new ConnectorError(`GET ${operation.operationId} returned invalid JSON`, {
          cause: e,
        });
      }
    }

    const response: ResourceResponse = { data };
    const version = documentVersion(await this.document().catch(() => undefined));
    if (version) response.productVersion = { product: this.spec.product, version };

    if (paginate?.type === 'link-header') {
      const link = parseLinkHeader(res.headers.get('link'), paginate.rel);
      if (link) response.next = { ...request.call, url: new URL(link, url).toString() };
    } else if (paginate?.type === 'cursor') {
      const cursor = await evalExpr(paginate.next, data);
      if (cursor !== undefined && cursor !== null && cursor !== '')
        response.next = { ...request.call, params: { ...call.params, [paginate.param]: cursor } };
    } else if (paginate?.type === 'page') {
      const items = await evalExpr(paginate.items, data);
      const count = Array.isArray(items)
        ? items.length
        : items === undefined || items === null
          ? 0
          : 1;
      const current = Number(params[paginate.param]);
      if (count > 0 && (paginate.size === undefined || count >= paginate.size))
        response.next = {
          ...request.call,
          params: { ...call.params, [paginate.param]: current + 1 },
        };
    }
    return response;
  }

  async authenticate(): Promise<AuthResult> {
    if (this.config.auth.type === 'none') return { status: 'not_required' };
    try {
      await this.requestHeaders();
      return { status: 'authenticated' };
    } catch (e) {
      return {
        status: e instanceof AuthRequiredError ? 'auth_required' : 'failed',
        message: errText(e),
      };
    }
  }

  async health(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();
    const warnings: string[] = [];
    let version: string | undefined;
    try {
      if (this.config.auth.type !== 'none') await this.requestHeaders(); // secret present?
      const doc = await this.document();
      version = documentVersion(doc);
      if (doc) {
        const known = new Set((await this.catalog()).map((o) => o.operationId));
        const missing = this.mappedOperations().filter((o) => !known.has(o));
        if (missing.length > 0)
          warnings.push(`mapped operations missing from the API catalog: ${missing.join(', ')}`);
        const unsafe = (await this.catalog())
          .filter((o) => this.mappedOperations().includes(o.operationId) && o.method !== 'get')
          .map((o) => o.operationId);
        if (unsafe.length > 0)
          warnings.push(`mapped operations are not GET (will be refused): ${unsafe.join(', ')}`);
      }
      if (this.config.healthPath) {
        const res = await this.http.request(joinUrl(await this.baseUrl(), this.config.healthPath), {
          method: 'GET',
        });
        if (!res.ok) warnings.push(`health path returned HTTP ${res.status}`);
      }
    } catch (e) {
      if (e instanceof AuthRequiredError)
        return { state: 'auth_required', checkedAt, message: errText(e) };
      if (e instanceof OfflineError) return { state: 'offline', checkedAt, message: errText(e) };
      return { state: 'failed', checkedAt, message: errText(e) };
    }
    return {
      state: warnings.length > 0 ? 'degraded' : 'healthy',
      checkedAt,
      ...(warnings.length > 0 ? { message: warnings.join('; ') } : {}),
      ...(version ? { detectedVersion: version } : {}),
    };
  }

  async detectProductVersion(): Promise<{ product: string; version: string } | undefined> {
    const version = documentVersion(await this.document().catch(() => undefined));
    return version ? { product: this.spec.product, version } : undefined;
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

export { RESTSourceAdapter as RestSourceAdapter };
