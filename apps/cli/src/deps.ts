import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createSecretStore, MemorySecretStore } from '@unicontext/auth';
import type { DataPaths, SecretStore } from '@unicontext/core';
import {
  createRuntime,
  DaemonClient,
  type Runtime,
  type RuntimeOptions,
  type ServiceDeps,
  type ServicePlatform,
} from '@unicontext/daemon/lib';
import type { DaemonOptions, RunningDaemon } from '@unicontext/daemon';
import type { McpDeps } from '@unicontext/mcp';
import { createDesktopSink } from '@unicontext/notifications';
import { VERSION } from './version.js';

export type Writer = (text: string) => void;

/** Result of one environment probe used by `unicontext doctor`. */
export interface ProbeResult {
  ok: boolean;
  /** What was found (version, backend) or why it failed. */
  detail?: string;
}

/**
 * Environment probes for `doctor`. Injected so tests are deterministic and never touch the real
 * OS keychain, Playwright or desktop notification module.
 */
export interface DoctorProbes {
  nodeVersion(): string;
  platform(): NodeJS.Platform;
  /** set/get/delete round trip of a probe key through the OS keychain. */
  keychain(): Promise<ProbeResult>;
  playwright(): Promise<ProbeResult>;
  desktopNotifications(): Promise<ProbeResult>;
}

export interface DaemonTarget {
  paths: DataPaths;
  secrets: SecretStore;
  dev: boolean;
}

export interface SecretStoreRequest {
  /** Keep secrets in memory only (--no-keychain, --dev). */
  noKeychain: boolean;
  onFallback?: (reason: unknown) => void;
}

/** Everything the CLI needs from the outside world; tests replace the parts they care about. */
export interface CliDeps {
  stdout: Writer;
  stderr: Writer;
  env: Record<string, string | undefined>;
  /** stdout is a terminal (colours allowed). */
  isTTY: boolean;
  /** The user can answer prompts (stdin and stderr are terminals). Defaults to isTTY. */
  interactive?: boolean;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  createRuntime: (options: RuntimeOptions) => Promise<Runtime>;
  /** Finds a running daemon (lock file + /api/v1/health), or undefined. */
  daemonClient: (target: DaemonTarget) => Promise<DaemonClient | undefined>;
  secretStore: (request: SecretStoreRequest) => Promise<SecretStore>;
  /** Asks one question on the terminal and returns the answer line. */
  prompt: (question: string) => Promise<string>;
  /** Like prompt, but the typed answer is not echoed (passphrases). Falls back to prompt. */
  promptSecret?: (question: string) => Promise<string>;
  probes: DoctorProbes;
  /** Run the daemon in this process (`daemon start --foreground`). */
  startDaemon: (options: DaemonOptions) => Promise<RunningDaemon>;
  /** Spawn the daemon detached (`daemon start`). */
  spawnDaemon: (script: string, args: string[]) => void;
  killProcess: (pid: number) => void;
  runStdioServer: (deps: McpDeps) => Promise<void>;
  /** Absolute path of @unicontext/daemon's dist/bin.js. */
  daemonScript: () => string;
  execPath: string;
  /** Overrides for the service helpers (tests). Defaults to the real platform. */
  service?: { deps?: ServiceDeps; platform?: ServicePlatform };
  /** How long doctor waits for one source health check. */
  healthTimeoutMs?: number;
  /** How long `daemon start` waits for the daemon to answer. */
  daemonStartTimeoutMs?: number;
}

export function resolveDaemonScript(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('@unicontext/daemon/package.json');
  return path.join(path.dirname(pkg), 'dist', 'bin.js');
}

async function tryImport(specifier: string): Promise<boolean> {
  try {
    await import(specifier);
    return true;
  } catch {
    return false;
  }
}

export function defaultProbes(): DoctorProbes {
  return {
    nodeVersion: () => process.versions.node,
    platform: () => process.platform,
    async keychain() {
      let store: SecretStore;
      try {
        store = await createSecretStore({ backend: 'keyring' });
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
      const key = `doctor/probe-${Date.now().toString(36)}`;
      try {
        await store.set(key, 'unicontext-doctor');
        const back = await store.get(key);
        await store.delete(key);
        if (back !== 'unicontext-doctor')
          return { ok: false, detail: '書き込んだ値を読み戻せませんでした' };
        return { ok: true, detail: store.backend };
      } catch (e) {
        try {
          await store.delete(key);
        } catch {
          // best effort cleanup
        }
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    },
    async playwright() {
      // dynamic specifiers: playwright is an optional dependency of the browser adapter only
      for (const spec of ['playwright', 'playwright-core']) {
        if (await tryImport(spec)) return { ok: true, detail: spec };
      }
      return { ok: false, detail: 'playwrightもplaywright-coreも見つかりません' };
    },
    async desktopNotifications() {
      const sink = await createDesktopSink();
      return sink
        ? { ok: true, detail: 'node-notifier' }
        : { ok: false, detail: 'node-notifierを読み込めません' };
    },
  };
}

export function defaultPrompt(question: string): Promise<string> {
  // the prompt goes to stderr so stdout stays clean for pipes
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
    rl.once('close', () => resolve(''));
  });
}

/** Read one line from the terminal without echoing it. */
export function defaultPromptSecret(question: string): Promise<string> {
  const input = process.stdin;
  const output = process.stderr;
  output.write(question);
  if (!input.isTTY) return readLine(input);
  // Raw mode reads keystrokes directly; readline with a muted output stream returned '' on Windows.
  return new Promise((resolve) => {
    let buf = '';
    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          output.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          output.write('\n');
          process.exit(130);
        }
        if (ch === '\u0008' || ch === '\u007f') {
          buf = [...buf].slice(0, -1).join('');
          continue;
        }
        if (ch >= ' ') buf += ch;
      }
    };
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

function readLine(input: NodeJS.ReadStream): Promise<string> {
  const rl = createInterface({ input, terminal: false });
  return new Promise((resolve) => {
    let done = false;
    rl.once('line', (line) => {
      done = true;
      rl.close();
      resolve(line);
    });
    rl.once('close', () => {
      if (!done) resolve('');
    });
  });
}

export function defaultDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  const deps: CliDeps = {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    env: process.env,
    isTTY: process.stdout.isTTY === true,
    interactive: process.stdin.isTTY === true && process.stderr.isTTY === true,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    createRuntime,
    daemonClient: async ({ paths, secrets, dev }) =>
      dev ? undefined : DaemonClient.discover(paths, secrets),
    secretStore: async ({ noKeychain, onFallback }) =>
      noKeychain
        ? new MemorySecretStore()
        : createSecretStore({ backend: 'auto', ...(onFallback ? { onFallback } : {}) }),
    prompt: defaultPrompt,
    promptSecret: defaultPromptSecret,
    probes: defaultProbes(),
    // heavy modules (Fastify, MCP SDK) are loaded only by the commands that need them
    startDaemon: async (options) => (await import('@unicontext/daemon')).startDaemon(options),
    spawnDaemon: (script, args) => {
      const child = spawn(process.execPath, [script, ...args], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', () => undefined);
      child.unref();
    },
    killProcess: (pid) => {
      process.kill(pid);
    },
    runStdioServer: async (mcpDeps) => (await import('@unicontext/mcp')).runStdioServer(mcpDeps),
    daemonScript: resolveDaemonScript,
    execPath: process.execPath,
  };
  return { ...deps, ...overrides };
}

export { VERSION };
