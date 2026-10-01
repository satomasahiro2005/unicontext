import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
      if (cur && cur.pid !== process.pid && isProcessAlive(cur.pid))
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
