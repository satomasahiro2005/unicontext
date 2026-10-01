import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { HealthStatus } from '@unicontext/canonical-model';
import type { AuthResult, VersionAwareAdapter } from '@unicontext/connector-sdk';
import {
  AuthRequiredError,
  ConfigError,
  ConnectorError,
  type FetchLike,
  type Clock,
  type Logger,
  OfflineError,
  redact,
  type SecretStore,
  silentLogger,
  systemClock,
} from '@unicontext/core';
import {
  evalExpr,
  type MappingSpec,
  type RunOptions,
  MappedSourceAdapter,
  type ResourceCaller,
  type ResourceRequest,
  type ResourceResponse,
} from '@unicontext/mapping';
import { type McpCall, McpCallSchema, type McpConfig } from './config.js';
import { parseToolResult, type ToolResultLike } from './result.js';
import {
  defaultTransportFactory,
  resolveConnection,
  type McpTransportFactory,
} from './transport.js';

/** One tool of the server's catalog (`tools/list`), the "external schema" of §28. */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface McpAdapterOptions {
  /** Adapter id, e.g. `mcp:canvas`. */
  id?: string;
  sourceId: string;
  spec: MappingSpec;
  config: McpConfig;
  secrets: SecretStore;
  logger?: Logger;
  fetch?: FetchLike | undefined;
  clock?: Clock;
  /** Sync tuning, e.g. `maxCallsPerPage`. */
  runOptions?: RunOptions;
  /** Replace the transport (tests: InMemoryTransport). */
  transportFactory?: McpTransportFactory;
}

const CLIENT_INFO = { name: 'unicontext', version: '1.0.0' };

function errText(e: unknown): string {
  return String(redact(e instanceof Error ? e.message : String(e)));
}

/**
 * SourceAdapter for an external MCP server (§28): tool discovery → catalog, declarative mapping →
 * raw items, using the official SDK client over stdio or streamable HTTP.
 */
export class McpSourceAdapter extends MappedSourceAdapter implements VersionAwareAdapter {
  private readonly options: McpAdapterOptions;
  private readonly logger: Logger;
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;
  private catalog: McpToolInfo[] | undefined;
  private stderrTail = '';
  private lastCallAt = 0;

  constructor(options: McpAdapterOptions) {
    super(options.id ?? `mcp:${options.spec.id}`, options.spec, options.runOptions);
    this.options = options;
    this.logger = (options.logger ?? silentLogger).child({ adapter: 'mcp' });
  }

  private get timeoutMs(): number {
    return this.options.config.timeoutMs;
  }

  private hasSecrets(): boolean {
    const c = this.options.config;
    const n = (b: unknown): number =>
      Array.isArray(b) ? b.length : b && typeof b === 'object' ? Object.keys(b).length : 0;
    return n(c.envSecrets) + n(c.headerSecrets) > 0;
  }

  /** Lazily start/connect the server; the connection is shared by all calls of this adapter. */
  private connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= this.openClient().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async openClient(): Promise<Client> {
    const { config, secrets, sourceId } = this.options;
    const connection = await resolveConnection(config, secrets, sourceId);
    const factory = this.options.transportFactory ?? defaultTransportFactory;
    this.stderrTail = '';
    let client: Client | undefined;
    try {
      const transport = await factory(connection, {
        logger: this.logger,
        fetch: this.options.fetch,
        onStderr: (chunk) => {
          this.stderrTail = (this.stderrTail + chunk).slice(-1000);
        },
      });
      client = new Client(CLIENT_INFO);
      const c = client;
      c.onclose = () => {
        if (this.client === c) {
          this.client = undefined;
          this.catalog = undefined;
        }
      };
      await c.connect(transport, { timeout: this.timeoutMs });
      this.client = c;
      return c;
    } catch (e) {
      try {
        await client?.close();
      } catch {
        // ignore
      }
      throw this.connectError(e);
    }
  }

  private connectError(e: unknown): Error {
    if (e instanceof AuthRequiredError || e instanceof ConfigError) return e;
    if (
      e instanceof UnauthorizedError ||
      (e instanceof StreamableHTTPError && (e.code === 401 || e.code === 403))
    )
      return new AuthRequiredError('MCP server rejected the credentials', { cause: e });
    const tail = this.stderrTail.trim();
    return new OfflineError(
      `MCP server unavailable: ${errText(e)}${tail ? ` (stderr: ${errText(tail.slice(-300))})` : ''}`,
      { cause: e },
    );
  }

  /** `tools/list` (all pages), cached per connection. */
  async discover(options: { refresh?: boolean } = {}): Promise<McpToolInfo[]> {
    const client = await this.connect();
    if (this.catalog && !options.refresh) return this.catalog;
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const res = await client.listTools(cursor ? { cursor } : undefined, {
        timeout: this.timeoutMs,
      });
      for (const t of res.tools)
        tools.push({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          inputSchema: t.inputSchema as Record<string, unknown>,
          ...(t.outputSchema ? { outputSchema: t.outputSchema as Record<string, unknown> } : {}),
        });
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    this.catalog = tools;
    return tools;
  }

  /** Tool names the mapping calls. */
  mappedTools(): string[] {
    const names = new Set<string>();
    for (const r of this.spec.resources) {
      const call = McpCallSchema.safeParse(r.call);
      if (call.success) names.add(call.data.tool);
    }
    return [...names];
  }

  protected caller(): Promise<ResourceCaller> {
    return Promise.resolve({ call: (request) => this.callResource(request) });
  }

  private async callResource(request: ResourceRequest): Promise<ResourceResponse> {
    const parsed = McpCallSchema.safeParse(request.call);
    if (!parsed.success)
      throw new ConfigError(
        `Resource ${request.resource.name}: invalid MCP call (${parsed.error.issues.map((i) => i.message).join('; ')})`,
      );
    const call: McpCall = parsed.data;
    const client = await this.connect();
    await this.assertToolKnown(call.tool);
    await this.throttle(request.signal);
    this.logger.debug('mcp call', { tool: call.tool, args: redact(call.args ?? {}) });
    let result: ToolResultLike;
    try {
      result = (await client.callTool({ name: call.tool, arguments: call.args ?? {} }, undefined, {
        timeout: this.timeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
      })) as ToolResultLike;
    } catch (e) {
      throw this.callError(e, call.tool);
    }
    const data = parseToolResult(result, call.tool);
    const response: ResourceResponse = { data };
    const server = client.getServerVersion();
    if (server?.version)
      response.productVersion = { product: this.spec.product, version: server.version };
    if (call.paginate) {
      const cursor = await evalExpr(call.paginate.nextCursor, data);
      if (cursor !== undefined && cursor !== null && cursor !== '')
        response.next = {
          ...request.call,
          args: { ...(call.args ?? {}), [call.paginate.cursorArg]: cursor },
        };
    }
    return response;
  }

  /** Honour `minIntervalMs` between calls. */
  private async throttle(signal?: AbortSignal): Promise<void> {
    const clock = this.options.clock ?? systemClock;
    const gap = this.options.config.minIntervalMs;
    if (gap > 0) {
      const wait = this.lastCallAt + gap - clock.now().getTime();
      if (wait > 0) await clock.sleep(wait, signal);
    }
    this.lastCallAt = clock.now().getTime();
  }

  private async assertToolKnown(tool: string): Promise<void> {
    let catalog = this.catalog;
    if (!catalog) {
      try {
        catalog = await this.discover();
      } catch {
        return; // servers without tools/list: let the call fail on its own
      }
    }
    if (!catalog.some((t) => t.name === tool))
      throw new ConnectorError(
        `MCP tool "${tool}" is not offered by the server; adapt "call.tool" to discover() output (${catalog
          .slice(0, 12)
          .map((t) => t.name)
          .join(', ')}${catalog.length > 12 ? ', ...' : ''})`,
        { details: { tool } },
      );
  }

  private callError(e: unknown, tool: string): Error {
    if (e instanceof ConnectorError || e instanceof AuthRequiredError) return e;
    if (e instanceof Error && e.name === 'AbortError') return e;
    if (e instanceof McpError) {
      if (e.code === ErrorCode.RequestTimeout)
        return new ConnectorError(`MCP tool ${tool} timed out after ${this.timeoutMs} ms`, {
          cause: e,
          details: { tool },
        });
      if (e.code === ErrorCode.ConnectionClosed) {
        this.client = undefined;
        this.catalog = undefined;
        return new OfflineError(`MCP server closed the connection during ${tool}`, { cause: e });
      }
      return new ConnectorError(`MCP tool ${tool} failed: ${errText(e)}`, {
        cause: e,
        details: { tool, code: e.code },
      });
    }
    if (e instanceof UnauthorizedError)
      return new AuthRequiredError('MCP server rejected the credentials', { cause: e });
    return new ConnectorError(`MCP tool ${tool} failed: ${errText(e)}`, {
      cause: e,
      details: { tool },
    });
  }

  async authenticate(): Promise<AuthResult> {
    try {
      await this.connect();
      return { status: this.hasSecrets() ? 'authenticated' : 'not_required' };
    } catch (e) {
      if (e instanceof AuthRequiredError) return { status: 'auth_required', message: errText(e) };
      return { status: 'failed', message: errText(e) };
    }
  }

  async health(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();
    let client: Client;
    try {
      client = await this.connect();
    } catch (e) {
      if (e instanceof AuthRequiredError)
        return { state: 'auth_required', checkedAt, message: errText(e) };
      return { state: 'offline', checkedAt, message: errText(e) };
    }
    const detectedVersion = client.getServerVersion()?.version;
    let tools: McpToolInfo[];
    try {
      tools = await this.discover({ refresh: true });
    } catch (e) {
      return {
        state: 'degraded',
        checkedAt,
        message: `tools/list failed: ${errText(e)}`,
        ...(detectedVersion ? { detectedVersion } : {}),
      };
    }
    const known = new Set(tools.map((t) => t.name));
    const missing = this.mappedTools().filter((t) => !known.has(t));
    return {
      state: missing.length > 0 ? 'degraded' : 'healthy',
      checkedAt,
      ...(missing.length > 0
        ? { message: `mapped tools missing from the server: ${missing.join(', ')}` }
        : {}),
      ...(detectedVersion ? { detectedVersion } : {}),
    };
  }

  async detectProductVersion(): Promise<{ product: string; version: string } | undefined> {
    try {
      const client = await this.connect();
      const version = client.getServerVersion()?.version;
      return version ? { product: this.spec.product, version } : undefined;
    } catch {
      return undefined;
    }
  }

  async dispose(): Promise<void> {
    const client = this.client ?? (await this.connecting?.catch(() => undefined));
    this.client = undefined;
    this.catalog = undefined;
    try {
      await client?.close();
    } catch {
      // closing a dead connection is not an error
    }
  }
}
