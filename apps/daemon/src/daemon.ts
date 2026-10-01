import { mkdirSync, mkdtempSync, rmSync, appendFileSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type LogSink,
  type LogRecord,
  stderrSink,
  errorMessage,
  type Logger,
} from '@unicontext/core';
import {
  createConsoleSink,
  createSinksFromConfig,
  NotificationService,
} from '@unicontext/notifications';
import type { WatchHandle } from '@unicontext/connector-sdk';
import type { FastifyInstance } from 'fastify';
import { acquireLock, type DaemonLock } from './lock.js';
import { createRestServer, defaultWebDir } from './rest.js';
import { buildLogger, createRuntime, type Runtime, type RuntimeOptions } from './runtime.js';
import { startWatchers } from './wiring.js';
import { loadOrCreateApiToken } from './token.js';
import { VERSION } from './version.js';
import { resolveDataPaths, dataPathsFromRoot, type DataPaths } from '@unicontext/core';

export const LOOPBACK_HOST = '127.0.0.1';

export interface DaemonOptions extends RuntimeOptions {
  /** 0 picks a free port (tests). Defaults to config.daemon.port. */
  port?: number;
  webDir?: string;
  /** Do not start the background sync scheduler (default: follow config.sync.background). */
  noScheduler?: boolean;
  noNotifications?: boolean;
  /** Skip the single-instance lock (tests that start several daemons on separate dirs do not need it). */
  noLock?: boolean;
  /** Install SIGINT/SIGTERM handlers (the bin does; tests do not). */
  handleSignals?: boolean;
}

export interface RunningDaemon {
  runtime: Runtime;
  app: FastifyInstance;
  host: string;
  port: number;
  url: string;
  token: string;
  notifications: NotificationService | undefined;
  stop(): Promise<void>;
  /** Resolves when stop() has finished (after a signal or POST /api/v1/daemon/stop). */
  stopped: Promise<void>;
}

/** Rotating JSON-lines file sink (§52 logs/). Failures never break the daemon. */
export function createFileSink(file: string, maxBytes = 5 * 1024 * 1024): LogSink {
  mkdirSync(path.dirname(file), { recursive: true });
  return (record: LogRecord) => {
    try {
      try {
        if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
      } catch {
        // no file yet
      }
      appendFileSync(file, `${JSON.stringify(record)}\n`);
    } catch {
      // logging must not take the daemon down
    }
  };
}

function safeStderr(record: LogRecord): void {
  try {
    stderrSink(record);
  } catch {
    // no console attached (hidden wscript launch)
  }
}

export function daemonLogSink(paths: Pick<DataPaths, 'logs'>): LogSink {
  const file = createFileSink(path.join(paths.logs, 'unicontextd.log'));
  return (record) => {
    safeStderr(record);
    file(record);
  };
}

/**
 * Wait (bounded) for syncs that are already running before the database is closed. SyncEngine.sync
 * returns the in-flight promise for a running source, so this never starts a new sync.
 */
export async function drainSyncs(
  uc: Pick<Runtime['uc'], 'sync'>,
  timeoutMs = 15_000,
): Promise<void> {
  const running = uc.sync
    .sources()
    .map((s) => s.sourceId)
    .filter((id) => uc.sync.isRunning(id))
    .map((id) => uc.sync.sync(id).catch(() => undefined));
  if (running.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled(running),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
}

function resolvePaths(options: DaemonOptions, root: string | undefined): DataPaths {
  const r = root ?? options.dataDir;
  return r ? dataPathsFromRoot(r, r) : resolveDataPaths();
}

/** Start unicontextd: runtime, scheduler, notifications and the 127.0.0.1-only HTTP server. */
export async function startDaemon(options: DaemonOptions = {}): Promise<RunningDaemon> {
  const dev = options.dev === true;
  const tempRoot =
    dev && !options.dataDir ? mkdtempSync(path.join(tmpdir(), 'unicontext-dev-')) : undefined;
  const earlyPaths = resolvePaths(options, tempRoot);
  mkdirSync(earlyPaths.root, { recursive: true });
  mkdirSync(earlyPaths.logs, { recursive: true });
  const lock: DaemonLock | undefined = options.noLock ? undefined : acquireLock(earlyPaths);

  let runtime: Runtime | undefined;
  let app: FastifyInstance | undefined;
  let notifications: NotificationService | undefined;
  let watchers: WatchHandle[] = [];
  try {
    runtime = await createRuntime({
      ...options,
      ...(tempRoot ? { dataDir: tempRoot } : {}),
      logSink: options.logSink ?? daemonLogSink(earlyPaths),
    });
    const rt = runtime;
    const logger: Logger = rt.logger;
    const token = await loadOrCreateApiToken(rt.secrets, rt.paths);

    let resolveStopped!: () => void;
    const stopped = new Promise<void>((r) => {
      resolveStopped = r;
    });
    let stopping: Promise<void> | undefined;
    let onUnhandled: ((reason: unknown) => void) | undefined;
    const stop = (): Promise<void> => {
      stopping ??= (async () => {
        logger.info('unicontextd stopping');
        try {
          notifications?.stop();
          rt.uc.scheduler.stop();
          await Promise.allSettled(watchers.map((w) => w.close()));
          await app?.close();
          // A scheduled sync may still be writing; closing the database under it would turn its
          // failure handling into an unhandled rejection.
          await drainSyncs(rt.uc);
          await rt.close();
        } catch (e) {
          logger.error('error during shutdown', { error: errorMessage(e) });
        } finally {
          try {
            lock?.release();
            if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
          } catch (e) {
            // Windows may still hold a file in the temp dir (EBUSY); never leave stop() pending.
            logger.warn('cleanup after shutdown failed', { error: errorMessage(e) });
          }
          if (onUnhandled) process.off('unhandledRejection', onUnhandled);
          resolveStopped();
        }
      })();
      return stopping;
    };

    app = await createRestServer({
      runtime: rt,
      token,
      version: VERSION,
      get notifications() {
        return notifications;
      },
      webDir: options.webDir ?? defaultWebDir(),
      onStop: () => void stop(),
    });

    const port = options.port ?? rt.config.daemon.port;
    try {
      await app.listen({ host: LOOPBACK_HOST, port });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE')
        throw new Error(
          `ポート ${port} は使用中です。config.yaml の daemon.port を変えるか --port を指定してください`,
          { cause: e },
        );
      throw e;
    }
    const address = app.server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    lock?.setPort(actualPort);

    if (!options.noNotifications && rt.config.notifications.enabled) {
      const sinks = dev
        ? [createConsoleSink()]
        : await createSinksFromConfig(rt.config.notifications, { secrets: rt.secrets, logger });
      notifications = new NotificationService({
        uc: rt.uc,
        sinks,
        logFile: path.join(rt.paths.root, 'notifications.jsonl'),
        minPriority: rt.config.notifications.minPriority,
        deadlineLeadTimes: rt.config.notifications.deadlineLeadTimes,
        logger,
      });
      notifications.start();
    }

    const background = options.noScheduler ? false : !dev && rt.config.sync.background;
    if (background) {
      rt.uc.scheduler.start();
      watchers = await startWatchers(rt.uc, logger);
    }

    if (options.handleSignals) {
      // A stray rejection (connector, scheduler timer) must not kill the daemon: on Windows the
      // Startup launcher does not restart it, so the user would silently lose sync until logon.
      onUnhandled = (reason: unknown): void => {
        logger.error('unhandled promise rejection', { error: errorMessage(reason) });
      };
      process.on('unhandledRejection', onUnhandled);
      const onSignal = (sig: string) => (): void => {
        logger.info('signal received', { signal: sig });
        void stop();
      };
      process.once('SIGINT', onSignal('SIGINT'));
      process.once('SIGTERM', onSignal('SIGTERM'));
      if (process.platform === 'win32') process.once('SIGBREAK', onSignal('SIGBREAK'));
    }

    logger.info('unicontextd started', {
      url: `http://${LOOPBACK_HOST}:${actualPort}`,
      dev,
      sources: rt.uc.sync.sources().map((s) => s.sourceId),
      scheduler: background,
    });
    return {
      runtime: rt,
      app,
      host: LOOPBACK_HOST,
      port: actualPort,
      url: `http://${LOOPBACK_HOST}:${actualPort}`,
      token,
      notifications,
      stop,
      stopped,
    };
  } catch (e) {
    notifications?.stop();
    await Promise.allSettled(watchers.map((w) => w.close()));
    await app?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    lock?.release();
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    throw e;
  }
}

export { buildLogger };
