import { closeSync, existsSync, openSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectorError } from '@unicontext/core';

/**
 * A persistent browser profile is already open in another browser process (a background sync of
 * the daemon, a sign-in window left open, or a second UniContext process). Chrome cannot open one
 * profile twice: a second launch only hands its command line to the running instance and exits.
 */
export class BrowserProfileInUseError extends ConnectorError {
  constructor(
    readonly profileDir: string,
    options?: { cause?: unknown },
  ) {
    super(
      `ブラウザのプロファイルを別のブラウザが使用中です（UniContext デーモンの同期中か、サインイン画面が開いたままです）。終わってからもう一度実行してください: ${profileDir} / The browser profile is in use by another browser process (a running sync or an open sign-in window): ${profileDir}`,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * True when a running Chrome/Edge holds the profile's process-singleton lock.
 *
 * - Windows: Chrome keeps `<profile>/lockfile` open without write sharing (and deletes it on exit),
 *   so opening it for writing fails with EBUSY while the browser runs. A leftover file that opens
 *   fine is stale.
 * - macOS/Linux: `<profile>/SingletonLock` is a symlink to `<host>-<pid>`; the profile is in use
 *   while that pid is alive.
 */
export function isProfileInUse(profileDir: string): boolean {
  if (process.platform === 'win32') {
    const lock = join(profileDir, 'lockfile');
    if (!existsSync(lock)) return false;
    try {
      closeSync(openSync(lock, 'r+'));
      return false;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
    }
  }
  try {
    const target = readlinkSync(join(profileDir, 'SingletonLock'));
    const pid = Number(/-(\d+)$/.exec(target)?.[1]);
    return pidAlive(pid);
  } catch {
    return false;
  }
}

/**
 * A launch that failed because the profile was already open: Chrome hands off to the running
 * instance and exits with code 21 (RESULT_CODE_NORMAL_EXIT_PROCESS_NOTIFIED), which Playwright
 * reports as "Target page, context or browser has been closed" with the exit code in its log.
 */
export function isProfileHandOffError(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  return /exitCode=21\b|Opening in existing browser session|ProcessSingleton|profile (?:appears to be )?in use/i.test(
    text,
  );
}
