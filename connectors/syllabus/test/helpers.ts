import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { type ConnectorContext, RateLimiter } from '@unicontext/connector-sdk';
import {
  type FetchLike,
  loadProfile,
  type SecretStore,
  silentLogger,
  systemClock,
  type UniversityProfile,
} from '@unicontext/core';

const here = path.dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): string {
  return readFileSync(path.join(here, 'fixtures', name), 'utf8');
}

export function memorySecrets(): SecretStore {
  const m = new Map<string, string>();
  return {
    backend: 'memory',
    get: (k) => Promise.resolve(m.get(k)),
    set: (k, v) => {
      m.set(k, v);
      return Promise.resolve();
    },
    delete: (k) => Promise.resolve(m.delete(k)),
  };
}

export const shizuokaProfile = (): UniversityProfile => loadProfile('shizuoka-university');

export function makeContext<T>(
  config: T,
  fetchFn: FetchLike,
  profile?: UniversityProfile,
): ConnectorContext<T> {
  return {
    sourceId: 'test',
    config,
    secrets: memorySecrets(),
    logger: silentLogger,
    clock: systemClock,
    // Tests must not sleep for politeness.
    rateLimiter: new RateLimiter({ capacity: 10_000, refillPerSecond: 10_000 }),
    profile,
    cacheDir: undefined,
    fetch: fetchFn,
  };
}

export const BASE = 'https://lcu.example.ac.jp/lcu-web/';
