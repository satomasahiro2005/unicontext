import { spawn } from 'node:child_process';

/**
 * Driving a UniContext that lives on another machine (a Raspberry Pi at home, say) from this one.
 * With `UNICONTEXT_REMOTE=<ssh destination>` every command runs there over ssh, so `unicontext
 * guest add`, `ai set-key` or `secrets set` typed on the PC act on the Pi's data. `login` is the
 * exception: the browser opens here and the result is handed over (handoff.ts).
 *
 * Commands that name local data on purpose (`--dev`, `--data-dir`, `--config`) stay local.
 */

export const REMOTE_ENV = 'UNICONTEXT_REMOTE';
/** The CLI on the remote machine (default `unicontext`). */
export const REMOTE_COMMAND_ENV = 'UNICONTEXT_REMOTE_COMMAND';
const DEFAULT_REMOTE_COMMAND = 'unicontext';

export interface RemoteTarget {
  /** ssh destination, e.g. `oppi@raspberrypi.local`. */
  host: string;
  /** Shell command line that runs the CLI there. */
  command: string;
}

const LOCAL_FLAGS = new Set(['--dev', '--data-dir', '--config']);
/** Global options that take a value (the value is not the command name). */
const VALUE_FLAGS = new Set(['--data-dir', '--config']);

export function remoteTarget(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): RemoteTarget | undefined {
  const host = env[REMOTE_ENV]?.trim();
  if (!host) return undefined;
  if (argv.some((a) => LOCAL_FLAGS.has(a.split('=')[0] ?? a))) return undefined;
  return { host, command: env[REMOTE_COMMAND_ENV]?.trim() || DEFAULT_REMOTE_COMMAND };
}

/** The command name (`status`, `login`, …): the first argument that is not a global option. */
export function commandOf(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (!a.startsWith('-')) return a;
  }
  return undefined;
}

/** POSIX shell quoting for the remote command line. */
export function shQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function remoteCommandLine(target: RemoteTarget, argv: readonly string[]): string {
  return [target.command, ...argv.map(shQuote)].join(' ');
}

/** ssh arguments; a terminal is allocated only when both ends of this one are terminals. */
export function sshArgs(target: RemoteTarget, argv: readonly string[], tty: boolean): string[] {
  return [tty ? '-t' : '-T', '-o', 'LogLevel=ERROR', target.host, remoteCommandLine(target, argv)];
}

export type Spawner = typeof spawn;

/** Runs the command on the remote machine with this terminal attached; resolves to its exit code. */
export function runOverSsh(
  target: RemoteTarget,
  argv: readonly string[],
  options: { tty: boolean; spawner?: Spawner; stdin?: string },
): Promise<number> {
  const spawner = options.spawner ?? spawn;
  return new Promise((resolve) => {
    const child = spawner('ssh', sshArgs(target, argv, options.tty), {
      stdio: [options.stdin === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
      windowsHide: true,
    });
    child.on('error', (e) => {
      process.stderr.write(`エラー: sshを起動できません（${e.message}）\n`);
      resolve(255);
    });
    child.on('close', (code) => resolve(code ?? 1));
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });
}
