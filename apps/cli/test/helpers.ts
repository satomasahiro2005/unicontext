import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemorySecretStore } from '@unicontext/auth';
import { createRuntime, type RuntimeOptions, type Runtime } from '@unicontext/daemon';
import { defaultDeps, type CliDeps, type DoctorProbes } from '../src/deps.js';
import { run } from '../src/main.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const OK_PROBES: DoctorProbes = {
  nodeVersion: () => '22.14.0',
  platform: () => 'win32',
  keychain: async () => ({ ok: true, detail: 'fake-keyring' }),
  playwright: async () => ({ ok: true, detail: 'playwright' }),
  desktopNotifications: async () => ({ ok: true, detail: 'node-notifier' }),
};

export interface TestDeps {
  deps: CliDeps;
  stdout(): string;
  stderr(): string;
  prompts: string[];
  spawned: { script: string; args: string[] }[];
  killed: number[];
  runtimeOptions: RuntimeOptions[];
}

/** Deterministic dependencies: collected output, no TTY, no keychain, no daemon, instant sleeps. */
export function makeDeps(overrides: Partial<CliDeps> = {}, answers: string[] = []): TestDeps {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const spawned: { script: string; args: string[] }[] = [];
  const killed: number[] = [];
  const runtimeOptions: RuntimeOptions[] = [];
  const remaining = [...answers];
  const deps = defaultDeps({
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    env: {},
    isTTY: false,
    interactive: false,
    now: () => new Date('2026-10-01T00:30:00.000Z'),
    sleep: async () => undefined,
    createRuntime: async (options) => {
      runtimeOptions.push(options);
      return createRuntime(options);
    },
    daemonClient: async () => undefined,
    secretStore: async () => new MemorySecretStore(),
    prompt: async (question) => {
      prompts.push(question);
      return remaining.shift() ?? '';
    },
    probes: OK_PROBES,
    startDaemon: async () => {
      throw new Error('startDaemon is not available in this test');
    },
    spawnDaemon: (script, args) => void spawned.push({ script, args }),
    killProcess: (pid) => void killed.push(pid),
    runStdioServer: async () => undefined,
    daemonScript: () => path.join(tmpdir(), 'unicontext-test-daemon-bin.js'),
    execPath: 'node-for-tests',
    ...overrides,
  });
  return {
    deps,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    prompts,
    spawned,
    killed,
    runtimeOptions,
  };
}

export async function exec(
  args: string[],
  overrides: Partial<CliDeps> = {},
  answers: string[] = [],
): Promise<ExecResult & { t: TestDeps }> {
  const t = makeDeps(overrides, answers);
  const code = await run(args, t.deps);
  return { code, stdout: t.stdout(), stderr: t.stderr(), t };
}

/** Parse the stdout of a `--json` run. */
export function json<T = unknown>(result: ExecResult): T {
  return JSON.parse(result.stdout) as T;
}

/**
 * One dev (seed data) runtime shared by several CLI invocations, so multi-step flows
 * (correct then today) see each other's writes. close() is a no-op until dispose().
 */
export interface SharedRuntime {
  runtime: Runtime;
  overrides: Partial<CliDeps>;
  dispose(): Promise<void>;
}

export async function sharedDevRuntime(): Promise<SharedRuntime> {
  const runtime = await createRuntime({ dev: true, noKeychain: true, logSink: () => undefined });
  const shared: Runtime = { ...runtime, close: async () => undefined };
  return {
    runtime,
    overrides: { createRuntime: async () => shared },
    dispose: () => runtime.close(),
  };
}

export function tempDir(prefix = 'unicontext-cli-test-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows may keep a handle for a moment; temp files are harmless
  }
}

export function writeConfig(dir: string, yaml: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.yaml');
  writeFileSync(file, yaml);
  return file;
}
