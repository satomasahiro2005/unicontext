#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { errorMessage } from '@unicontext/core';
import { startDaemon } from './daemon.js';
import { DaemonAlreadyRunningError } from './lock.js';
import { VERSION } from './version.js';

const HELP = `unicontextd ${VERSION}

Usage: unicontextd [options]

  --port <n>        listen port (default: config daemon.port, 17878); always bound to 127.0.0.1
  --data-dir <dir>  data directory (default: per-OS location, UNICONTEXT_DATA_DIR)
  --config <file>   config.yaml path
  --dev             synthetic seed data and fake connectors (no university access)
  --no-keychain     keep secrets in memory only
  --no-scheduler    do not run background sync
  -h, --help
`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      'data-dir': { type: 'string' },
      config: { type: 'string' },
      dev: { type: 'boolean', default: false },
      'no-keychain': { type: 'boolean', default: false },
      'no-scheduler': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    process.stderr.write('--port must be an integer between 0 and 65535\n');
    return 2;
  }
  try {
    const daemon = await startDaemon({
      ...(port !== undefined ? { port } : {}),
      ...(values['data-dir'] ? { dataDir: values['data-dir'] } : {}),
      ...(values.config ? { configFile: values.config } : {}),
      dev: values.dev,
      noKeychain: values['no-keychain'],
      noScheduler: values['no-scheduler'],
      handleSignals: true,
    });
    process.stdout.write(
      `unicontextd listening on ${daemon.url}${values.dev ? ' (dev seed data)' : ''}\n`,
    );
    await daemon.stopped;
    return 0;
  } catch (e) {
    if (e instanceof DaemonAlreadyRunningError) {
      process.stderr.write(`${e.message}\n`);
      return 0; // already running is not a failure for service managers
    }
    process.stderr.write(`unicontextd: ${errorMessage(e)}\n`);
    return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`unicontextd: ${errorMessage(e)}\n`);
    process.exitCode = 1;
  },
);
