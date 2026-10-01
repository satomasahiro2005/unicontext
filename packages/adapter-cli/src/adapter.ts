import type { ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { HealthStatus } from '@unicontext/canonical-model';
import type { AuthResult, VersionAwareAdapter } from '@unicontext/connector-sdk';
import {
  AuthRequiredError,
  type Clock,
  ConfigError,
  ConnectorError,
  type Logger,
  OfflineError,
  redact,
  type SecretStore,
  silentLogger,
  systemClock,
  ValidationError,
} from '@unicontext/core';
import {
  buildChildEnv,
  evalExpr,
  MappedSourceAdapter,
  type MappingSpec,
  type ResourceCaller,
  type ResourceRequest,
  type ResourceResponse,
  resolveSecretBindings,
  type RunOptions,
  TEMPLATE_RE,
} from '@unicontext/mapping';
import { type CliCall, CliCallSchema, type CliConfig } from './config.js';
import { parseOutput, runCommand, stderrSummary } from './exec.js';

const DEFAULT_AUTH_ERROR =
  /(not logged in|log ?in required|please log ?in|unauthori[sz]ed|authentication (failed|required)|invalid (api )?token|token (expired|invalid)|session expired)/i;

export interface CliAdapterOptions {
  id?: string;
  sourceId: string;
  spec: MappingSpec;
  config: CliConfig;
  secrets: SecretStore;
  logger?: Logger;
  clock?: Clock;
  runOptions?: RunOptions;
}

function errText(e: unknown): string {
  return String(redact(e instanceof Error ? e.message : String(e)));
}

/** Is `command` runnable? Absolute/relative paths are checked directly, bare names via PATH. */
export function commandExists(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const exts =
    process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  const candidates: string[] =
    isAbsolute(command) || command.includes('/') || command.includes('\\')
      ? [command]
      : (env.PATH ?? env.Path ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => join(dir, command));
  for (const base of candidates)
    for (const ext of exts) {
      try {
        accessSync(base + ext, constants.X_OK);
        return true;
      } catch {
        // try the next candidate
      }
    }
  return false;
}

/**
 * SourceAdapter for an external CLI that prints JSON (§29). Each mapping resource is one
 * invocation (`call.args`), spawned with `shell: false`, bounded by a timeout and an output cap.
 */
export class CliSourceAdapter extends MappedSourceAdapter implements VersionAwareAdapter {
  private readonly options: CliAdapterOptions;
  private readonly logger: Logger;
  private readonly running = new Set<ChildProcess>();
  private lastCallAt = 0;

  constructor(options: CliAdapterOptions) {
    super(options.id ?? `cli:${options.spec.id}`, options.spec, options.runOptions);
    this.options = options;
    this.logger = (options.logger ?? silentLogger).child({ adapter: 'cli' });
  }

  private get config(): CliConfig {
    return this.options.config;
  }

  private hasSecrets(): boolean {
    const b = this.config.envSecrets;
    return Array.isArray(b) ? b.length > 0 : !!b && Object.keys(b).length > 0;
  }

  /** Child environment: safe defaults + `env` + secrets read now from the SecretStore. */
  private async childEnv(): Promise<Record<string, string>> {
    const secretEnv = await resolveSecretBindings(
      this.options.secrets,
      this.options.sourceId,
      this.config.envSecrets,
    );
    return { ...buildChildEnv(this.config.env), ...secretEnv };
  }

  protected caller(): Promise<ResourceCaller> {
    return Promise.resolve({ call: (request) => this.callResource(request) });
  }

  /** Values substituted for a whole-argument placeholder must not look like options. */
  private checkArgs(request: ResourceRequest, rendered: string[]): void {
    const raw = request.resource.call.args;
    if (!Array.isArray(raw)) return;
    raw.forEach((template, i) => {
      if (typeof template !== 'string') return;
      const m = TEMPLATE_RE.exec(template);
      const value = rendered[i];
      if (m && m[0] === template.trim() && value !== undefined && value.startsWith('-'))
        throw new ValidationError(
          `Resource ${request.resource.name}: value for argument ${i + 1} starts with "-" and could be read as an option`,
        );
    });
  }

  private async callResource(request: ResourceRequest): Promise<ResourceResponse> {
    const parsed = CliCallSchema.safeParse(request.call);
    if (!parsed.success)
      throw new ConfigError(
        `Resource ${request.resource.name}: invalid CLI call (${parsed.error.issues.map((i) => i.message).join('; ')})`,
      );
    const call: CliCall = parsed.data;
    const callArgs = call.args;
    this.checkArgs(request, callArgs);
    await this.throttle(request.signal);
    const args = [...(this.config.args ?? []), ...callArgs];
    this.logger.debug('cli call', { command: this.config.command, args: redact(args) });

    const env = await this.childEnv();
    const result = await runCommand({
      command: this.config.command,
      args,
      cwd: this.config.cwd,
      env,
      stdin:
        call.stdin === undefined
          ? undefined
          : typeof call.stdin === 'string'
            ? call.stdin
            : JSON.stringify(call.stdin),
      timeoutMs: this.config.timeoutMs,
      maxOutputBytes: this.config.maxOutputBytes,
      signal: request.signal,
      track: this.running,
    });

    const ok = call.okExitCodes ?? [0];
    if (!ok.includes(result.code)) {
      const pattern = this.config.authErrorPattern
        ? new RegExp(this.config.authErrorPattern, 'i')
        : DEFAULT_AUTH_ERROR;
      if (pattern.test(result.stderr))
        throw new AuthRequiredError(
          `${this.config.command} needs authentication: ${stderrSummary(result.stderr, 200)}`,
        );
      throw new ConnectorError(
        `${this.config.command} exited with code ${result.code}${
          result.stderr.trim() ? `: ${stderrSummary(result.stderr)}` : ''
        }`,
        { details: { code: result.code, resource: request.resource.name } },
      );
    }

    const data = parseOutput(result.stdout, call.format, this.config.command);
    const response: ResourceResponse = { data };
    if (call.paginate) {
      const cursor = await evalExpr(call.paginate.nextCursor, data);
      if (cursor !== undefined && cursor !== null && cursor !== '') {
        const base = call.baseArgs ?? call.args;
        const extra = call.paginate.cursorArg.endsWith('=')
          ? [`${call.paginate.cursorArg}${String(cursor)}`]
          : [call.paginate.cursorArg, String(cursor)];
        response.next = { ...request.call, args: [...base, ...extra], baseArgs: base };
      }
    }
    return response;
  }

  private async throttle(signal?: AbortSignal): Promise<void> {
    const clock = this.options.clock ?? systemClock;
    const gap = this.config.minIntervalMs;
    if (gap > 0) {
      const wait = this.lastCallAt + gap - clock.now().getTime();
      if (wait > 0) await clock.sleep(wait, signal);
    }
    this.lastCallAt = clock.now().getTime();
  }

  authenticate(): Promise<AuthResult> {
    return resolveSecretBindings(
      this.options.secrets,
      this.options.sourceId,
      this.config.envSecrets,
    ).then(
      () => ({
        status: this.hasSecrets() ? ('authenticated' as const) : ('not_required' as const),
      }),
      (e: unknown) => ({
        status: e instanceof AuthRequiredError ? ('auth_required' as const) : ('failed' as const),
        message: errText(e),
      }),
    );
  }

  /** Runs `healthArgs` (when configured) and reports the version it prints. */
  private async probe(): Promise<{
    ok: boolean;
    version?: string;
    message?: string;
    offline?: boolean;
  }> {
    if (!commandExists(this.config.command))
      return { ok: false, offline: true, message: `command not found: ${this.config.command}` };
    const healthArgs = this.config.healthArgs;
    if (!healthArgs) return { ok: true };
    try {
      const res = await runCommand({
        command: this.config.command,
        args: [...(this.config.args ?? []), ...healthArgs],
        cwd: this.config.cwd,
        env: await this.childEnv(),
        timeoutMs: Math.min(this.config.timeoutMs, 15_000),
        maxOutputBytes: 64 * 1024,
        track: this.running,
      });
      const version = /\b\d+(?:\.\d+){1,3}(?:[-+][\w.]+)?\b/.exec(
        `${res.stdout}\n${res.stderr}`,
      )?.[0];
      if (res.code !== 0)
        return {
          ok: false,
          message: `${healthArgs.join(' ')} exited with code ${res.code}`,
          ...(version ? { version } : {}),
        };
      return { ok: true, ...(version ? { version } : {}) };
    } catch (e) {
      if (e instanceof AuthRequiredError) throw e;
      if (e instanceof OfflineError) return { ok: false, offline: true, message: errText(e) };
      return { ok: false, message: errText(e) };
    }
  }

  async health(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();
    try {
      const p = await this.probe();
      if (p.ok)
        return {
          state: 'healthy',
          checkedAt,
          ...(p.version ? { detectedVersion: p.version } : {}),
        };
      return {
        state: p.offline ? 'offline' : 'degraded',
        checkedAt,
        ...(p.message ? { message: p.message } : {}),
        ...(p.version ? { detectedVersion: p.version } : {}),
      };
    } catch (e) {
      if (e instanceof AuthRequiredError)
        return { state: 'auth_required', checkedAt, message: errText(e) };
      return { state: 'failed', checkedAt, message: errText(e) };
    }
  }

  async detectProductVersion(): Promise<{ product: string; version: string } | undefined> {
    if (!this.config.healthArgs) return undefined;
    try {
      const p = await this.probe();
      return p.version ? { product: this.spec.product, version: p.version } : undefined;
    } catch {
      return undefined;
    }
  }

  dispose(): Promise<void> {
    for (const child of this.running) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already exited
      }
    }
    this.running.clear();
    return Promise.resolve();
  }
}
