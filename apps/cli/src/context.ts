import path from 'node:path';
import type { LogRecord, SecretStore } from '@unicontext/core';
import { dataPathsFromRoot, type DataPaths, redact, resolveDataPaths } from '@unicontext/core';
import type { DaemonClient, Runtime, RuntimeOptions } from '@unicontext/daemon/lib';
import type { CliDeps } from './deps.js';
import { UsageError } from './errors.js';
import { colorEnabled, createStyle, type Style } from './format/style.js';
import { sanitizeText } from './format/table.js';

/** Max wait for a running daemon that does not answer yet (its start-up can take a minute). */
const DAEMON_WAIT_MS = 120_000;

/** Options shared by every command (spec §42 / task: global options). */
export interface GlobalOptions {
  json?: boolean;
  dataDir?: string;
  config?: string;
  dev?: boolean;
  /** `--no-keychain` sets this to false. */
  keychain?: boolean;
  verbose?: boolean;
}

/** One command invocation: lazily opens the runtime, the secret store and the daemon client. */
export class CliContext {
  readonly style: Style;
  private rt: Promise<Runtime> | undefined;
  private secretStore: Promise<SecretStore> | undefined;
  private daemonClient: Promise<DaemonClient | undefined> | undefined;

  constructor(
    readonly deps: CliDeps,
    readonly opts: GlobalOptions,
    /** Log to stderr even without --verbose (the MCP server must be diagnosable). */
    readonly alwaysLog: boolean = false,
  ) {
    this.style = createStyle(colorEnabled(deps.isTTY, deps.env));
  }

  get json(): boolean {
    return this.opts.json === true;
  }

  get dev(): boolean {
    return this.opts.dev === true;
  }

  get verbose(): boolean {
    return this.opts.verbose === true;
  }

  get noKeychain(): boolean {
    return this.opts.keychain === false || this.dev;
  }

  /** Write a line to stdout. */
  out(text = ''): void {
    this.deps.stdout(`${text}\n`);
  }

  /** Write a line to stderr. */
  err(text = ''): void {
    this.deps.stderr(`${text}\n`);
  }

  /**
   * Print the machine-readable form with secrets and token-like values redacted. `local: true`
   * is for output that only contains local paths and counts (backup, export): the profile's
   * student-ID pattern is skipped there because it would also hit dates in file names.
   */
  printJson(data: unknown, options: { local?: boolean } = {}): void {
    const value = options.local ? redact(data) : this.redactValue(data);
    this.out(JSON.stringify(value, null, 2));
  }

  redactValue(data: unknown): unknown {
    return redact(data, { extraValuePatterns: this.extraPatterns() });
  }

  /** Source-derived text for a terminal: redacted and stripped of control characters. */
  text(value: string | undefined | null): string {
    if (!value) return '';
    return sanitizeText(redact(value, { extraValuePatterns: this.extraPatterns() }) as string);
  }

  private extraPatterns(): RegExp[] {
    const pattern = this.runtimeIfOpen()?.profile?.privacy.studentIdPattern;
    if (!pattern) return [];
    try {
      return [new RegExp(pattern, 'g')];
    } catch {
      return [];
    }
  }

  private opened: Runtime | undefined;
  private runtimeIfOpen(): Runtime | undefined {
    return this.opened;
  }

  /** Data paths without opening anything (not meaningful for --dev, which uses a temp dir). */
  paths(): DataPaths {
    if (this.opts.dataDir) {
      const root = path.resolve(this.opts.dataDir);
      return dataPathsFromRoot(root, root);
    }
    return resolveDataPaths({ env: this.deps.env });
  }

  configFile(): string {
    return this.opts.config ? path.resolve(this.opts.config) : this.paths().configFile;
  }

  /** True when the data dir comes from a flag or UNICONTEXT_DATA_DIR rather than the OS default. */
  private hasDataDirOverride(): boolean {
    return Boolean(this.opts.dataDir) || Boolean(this.deps.env.UNICONTEXT_DATA_DIR);
  }

  secrets(): Promise<SecretStore> {
    this.secretStore ??= this.deps.secretStore({
      noKeychain: this.noKeychain,
      onFallback: (reason) => {
        if (this.verbose)
          this.err(
            `警告: OSキーチェーンを使えないため秘密情報はメモリ上にだけ保持します（${
              reason instanceof Error ? reason.message : String(reason)
            }）`,
          );
      },
    });
    return this.secretStore;
  }

  /** Runtime logs go to stderr only (stdout is reserved for results and the MCP protocol). */
  private logSink(): (record: LogRecord) => void {
    if (this.verbose || this.alwaysLog) {
      return (record) => this.deps.stderr(`${JSON.stringify(record)}\n`);
    }
    return () => undefined;
  }

  runtimeOptions(extra: Partial<RuntimeOptions> = {}): Promise<RuntimeOptions> {
    return (async () => {
      const logSink = this.logSink();
      if (this.dev) {
        return {
          dev: true,
          noKeychain: true,
          logSink,
          ...(this.opts.dataDir ? { dataDir: path.resolve(this.opts.dataDir) } : {}),
          ...extra,
        };
      }
      return {
        configFile: this.configFile(),
        ...(this.hasDataDirOverride() ? { dataDir: this.paths().root } : {}),
        secrets: await this.secrets(),
        noKeychain: this.noKeychain,
        logSink,
        ...extra,
      };
    })();
  }

  /** The wired runtime (database, sources, search...). Opened once and closed by close(). */
  runtime(extra: Partial<RuntimeOptions> = {}): Promise<Runtime> {
    this.rt ??= this.runtimeOptions(extra)
      .then((options) => this.deps.createRuntime(options))
      .then((rt) => {
        this.opened = rt;
        return rt;
      });
    return this.rt;
  }

  /** A reachable daemon, or undefined. */
  daemon(): Promise<DaemonClient | undefined> {
    this.daemonClient ??= (async () =>
      this.deps.daemonClient({
        paths: this.paths(),
        secrets: await this.secrets(),
        dev: this.dev,
        // A daemon that is still starting (or busy) must not be mistaken for none: commands would
        // then do in process what the daemon is doing (e.g. two browsers on one profile).
        waitMs: DAEMON_WAIT_MS,
        onWait: (pid) =>
          this.err(
            `デーモン（pid ${pid}）は起動中か処理中で、まだ応答しません。応答を待っています… / Waiting for the running daemon to answer…`,
          ),
      }))();
    return this.daemonClient;
  }

  /** "Now" in the data's own timeline (the dev seed runs at 2026-10-01 09:30 JST). */
  now(): Date {
    return this.opened ? this.opened.uc.clock.now() : this.deps.now();
  }

  canPrompt(): boolean {
    return this.deps.interactive ?? this.deps.isTTY;
  }

  /** Fail early (exit code 2) when a confirmation is needed but nobody can answer it. */
  assertCanConfirm(yes: boolean | undefined): void {
    if (yes || this.canPrompt()) return;
    throw new UsageError(
      '対話できない環境では確認できません',
      '内容を確認したうえで「--yes」を付けて再実行してください',
    );
  }

  /** y/N confirmation. Without a terminal the caller must pass --yes (exit code 2). */
  async confirmAction(question: string, yes: boolean | undefined): Promise<boolean> {
    if (yes) return true;
    this.assertCanConfirm(yes);
    const answer = (await this.deps.prompt(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  }

  async close(): Promise<void> {
    if (this.rt) {
      try {
        const rt = await this.rt;
        await rt.close();
      } catch {
        // creation failed earlier; nothing to close
      }
    }
  }
}
