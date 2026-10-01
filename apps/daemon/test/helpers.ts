import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createRestServer } from '../src/rest.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

export const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

export interface TestServer {
  runtime: Runtime;
  app: FastifyInstance;
  webDir: string | undefined;
  stopped: boolean;
  close(): Promise<void>;
}

/** Dev-seed runtime (synthetic data, 2026-10-01 09:30 JST) behind a Fastify instance (use app.inject). */
export async function createTestServer(
  options: { webDir?: string; onStop?: () => void } = {},
): Promise<TestServer> {
  const dir = mkdtempSync(path.join(tmpdir(), 'uc-daemon-test-'));
  const runtime = await createRuntime({ dev: true, dataDir: dir, noKeychain: true });
  const app = await createRestServer({
    runtime,
    token: TOKEN,
    version: '1.0.0-test',
    webDir: options.webDir ?? path.join(dir, 'no-web'),
    ...(options.onStop ? { onStop: options.onStop } : {}),
  });
  await app.ready();
  const server: TestServer = {
    runtime,
    app,
    webDir: options.webDir,
    stopped: false,
    async close() {
      await app.close();
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return server;
}

export const bearer = { authorization: `Bearer ${TOKEN}` };
