import type { ChildProcess } from 'node:child_process';
import { ConnectorError, OfflineError, redact } from '@unicontext/core';
import spawn from 'cross-spawn';

export interface RunCommandOptions {
  command: string;
  args: string[];
  cwd?: string | undefined;
  /** The complete environment of the child (nothing is inherited implicitly). */
  env: Record<string, string>;
  /** Written to the child's stdin, then stdin is closed. */
  stdin?: string | undefined;
  timeoutMs: number;
  /** stdout larger than this kills the process (default 10 MiB). */
  maxOutputBytes?: number;
  signal?: AbortSignal | undefined;
  /** Running children, so dispose() can kill them. */
  track?: Set<ChildProcess>;
}

export interface CommandResult {
  stdout: string;
  /** Last 16 KiB of stderr. */
  stderr: string;
  code: number;
}

export const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const STDERR_TAIL_BYTES = 16 * 1024;

const SPAWN_FAILURES = new Set(['ENOENT', 'EACCES', 'ENOTDIR', 'EPERM', 'EINVAL']);

/**
 * Run a command WITHOUT a shell: `args` are passed to the program as separate argv entries, so
 * template values cannot inject shell syntax. Spawning goes through cross-spawn so Windows `.cmd`
 * / `.bat` shims (npm-installed CLIs) start too: it resolves the command via PATH/PATHEXT and, for
 * shims only, runs them through cmd.exe with every argument escaped for cmd's metacharacters. Enforces a timeout (SIGKILL) and an output cap.
 * Spawn failures are OfflineError ("the tool is not installed"); everything else resolves with the
 * exit code for the caller to judge.
 */
export function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise<CommandResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      reject(new OfflineError(`Cannot start ${options.command}: ${describe(e)}`, { cause: e }));
      return;
    }
    options.track?.add(child);

    const out: Buffer[] = [];
    let outSize = 0;
    let errTail: Buffer = Buffer.alloc(0);
    let timedOut = false;
    let tooBig = false;
    let aborted = false;
    let settled = false;

    const kill = (): void => {
      // A Windows .cmd shim runs the real tool as a grandchild of cmd.exe; kill the whole tree.
      if (process.platform === 'win32' && child.pid !== undefined && child.exitCode === null) {
        try {
          spawn.sync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } catch {
          // fall through to child.kill()
        }
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      options.track?.delete(child);
      fn();
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      outSize += chunk.length;
      if (outSize > maxOutput) {
        tooBig = true;
        kill();
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      errTail = Buffer.concat([errTail, chunk]);
      if (errTail.length > STDERR_TAIL_BYTES)
        errTail = errTail.subarray(errTail.length - STDERR_TAIL_BYTES);
    });
    child.stdin?.on('error', () => {
      // the child may exit before reading stdin (EPIPE): not an error by itself
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      finish(() => {
        if (e.code && SPAWN_FAILURES.has(e.code))
          reject(new OfflineError(`Cannot start ${options.command}: ${e.code}`, { cause: e }));
        else reject(new ConnectorError(`${options.command} failed: ${describe(e)}`, { cause: e }));
      });
    });
    child.on('close', (code) => {
      finish(() => {
        if (aborted) reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        else if (timedOut)
          reject(
            new ConnectorError(`${options.command} timed out after ${options.timeoutMs} ms`, {
              details: { timeoutMs: options.timeoutMs },
            }),
          );
        else if (tooBig)
          reject(
            new ConnectorError(
              `${options.command} produced more than ${maxOutput} bytes of output`,
              {
                details: { maxOutputBytes: maxOutput },
              },
            ),
          );
        else
          resolve({
            stdout: Buffer.concat(out).toString('utf8'),
            stderr: errTail.toString('utf8'),
            code: code ?? -1,
          });
      });
    });

    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
    else child.stdin?.end();
  });
}

function describe(e: unknown): string {
  return String(redact(e instanceof Error ? e.message : String(e)));
}

/** Parse command output as JSON (`json`: one document, `jsonl`: one value per line). */
export function parseOutput(
  stdout: string,
  format: 'json' | 'jsonl',
  command = 'command',
): unknown {
  const text = stdout.charCodeAt(0) === 0xfeff ? stdout.slice(1) : stdout;
  if (text.trim() === '')
    throw new ConnectorError(`${command} printed no output (expected ${format})`);
  if (format === 'json') {
    try {
      return JSON.parse(text) as unknown;
    } catch (e) {
      throw new ConnectorError(
        `${command} did not print valid JSON: ${describe(e)} (output starts with ${JSON.stringify(
          String(redact(text.slice(0, 60))),
        )})`,
        { cause: e },
      );
    }
  }
  const values: unknown[] = [];
  const lines = text.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '') continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch (e) {
      throw new ConnectorError(`${command} printed invalid JSON on line ${i + 1}: ${describe(e)}`, {
        cause: e,
      });
    }
  }
  return values;
}

/** Last lines of stderr, redacted, for error messages. */
export function stderrSummary(stderr: string, max = 400): string {
  const t = String(redact(stderr.trim()));
  return t.length > max ? `…${t.slice(t.length - max)}` : t;
}
