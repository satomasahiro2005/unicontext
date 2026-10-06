import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemorySecretStore } from '@unicontext/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SyncJobResponse } from '../src/api-types.js';
import { DaemonClient } from '../src/client.js';
import { startDaemon, type RunningDaemon } from '../src/daemon.js';

let dir: string;
let daemon: RunningDaemon;
let client: DaemonClient;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'uc-daemon-ondemand-'));
  const webDir = path.join(dir, 'web');
  mkdirSync(webDir, { recursive: true });
  writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>UniContext</title>');
  daemon = await startDaemon({
    dev: true,
    dataDir: path.join(dir, 'data'),
    port: 0,
    webDir,
    noKeychain: true,
    noScheduler: true,
    noNotifications: true,
  });
  const found = await DaemonClient.discover(daemon.runtime.paths, new MemorySecretStore());
  if (!found) throw new Error('daemon not found');
  client = found;
}, 60_000);

afterAll(async () => {
  await daemon.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/v1/sources/:id/sync?reason=on-demand', () => {
  it('the scheduler limits forced runs through REST too (429), while a plain sync is unlimited', async () => {
    const first = await client.post<SyncJobResponse>(
      '/api/v1/sources/lcu/sync?wait=0&reason=on-demand',
    );
    expect(first.job.sourceId).toBe('lcu');
    await expect(
      client.post('/api/v1/sources/lcu/sync?wait=0&reason=on-demand'),
    ).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
    await expect(client.post('/api/v1/sources/lcu/sync?reason=on-demand')).rejects.toMatchObject({
      status: 429,
    });
    // the CLI's plain sync is not a forced run
    const plain = await client.post<{ report: { ok: boolean } }>('/api/v1/sources/lcu/sync');
    expect(plain.report.ok).toBe(true);
  });
});
