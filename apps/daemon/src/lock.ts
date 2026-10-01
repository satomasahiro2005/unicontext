import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import path from 'node:path';
import type { DataPaths } from '@unicontext/core';

export interface LockInfo {
  pid: number;
  port: number | undefined;
  startedAt: string;
}

export class DaemonAlreadyRunningError extends Error {
  constructor(readonly info: LockInfo) {
    super(
      `unicontextd は既に起動しています（pid ${info.pid}${info.port ? `, port ${info.port}` : ''}）`,
    );
    this.name = 'DaemonAlreadyRunningError';
  }
}

export function lockFile(paths: Pick<DataPaths, 'root'>): string {
  return path.join(paths.root, 'unicontextd.lock');
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLock(paths: Pick<DataPaths, 'root'>): LockInfo | undefined {
  const file = lockFile(paths);
  if (!existsSync(file)) return undefined;
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockInfo>;
    if (typeof v.pid !== 'number') return undefined;
    return { pid: v.pid, port: v.port, startedAt: v.startedAt ?? '' };
  } catch {
    return undefined;
  }
}

/** Lock files written more than this long before the computed boot time are from a previous boot. */
const BOOT_SLACK_MS = 10 * 60_000;

/**
 * True when the lock was written before the current OS boot, so its pid (if alive) now belongs to
 * an unrelated process. The slack absorbs wall-clock corrections after boot (NTP on machines
 * without an RTC). An unparsable startedAt is not treated as stale.
 */
export function startedBeforeBoot(
  info: Pick<LockInfo, 'startedAt'>,
  now: Date = new Date(),
  uptimeSeconds: number = uptime(),
): boolean {
  const started = Date.parse(info.startedAt);
  if (Number.isNaN(started)) return false;
  return started < now.getTime() - uptimeSeconds * 1000 - BOOT_SLACK_MS;
}

export interface DaemonLock {
  readonly file: string;
  setPort(port: number): void;
  release(): void;
}

/** Single-instance guard (§34): O_EXCL lock file with stale-pid recovery. */
export function acquireLock(
  paths: Pick<DataPaths, 'root'>,
  now: () => Date = () => new Date(),
): DaemonLock {
  const file = lockFile(paths);
  const info: LockInfo = { pid: process.pid, port: undefined, startedAt: now().toISOString() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      try {
        writeFileSync(fd, JSON.stringify(info));
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        file,
        setPort(port) {
          info.port = port;
          writeFileSync(file, JSON.stringify(info));
        },
        release() {
          if (released) return;
          released = true;
          const cur = readLock(paths);
          if (cur && cur.pid === process.pid) {
            try {
              unlinkSync(file);
            } catch {
              // already gone
            }
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const cur = readLock(paths);
      // After a crash or power loss the pid may have been reused by another process; a lock from a
      // previous boot must not keep the daemon from starting.
      if (
        cur &&
        cur.pid !== process.pid &&
        isProcessAlive(cur.pid) &&
        !startedBeforeBoot(cur, now())
      )
        throw new DaemonAlreadyRunningError(cur);
      try {
        unlinkSync(file);
      } catch {
        // someone else cleaned it up; retry
      }
    }
  }
  throw new Error(`ロックファイルを取得できません: ${file}`);
}
