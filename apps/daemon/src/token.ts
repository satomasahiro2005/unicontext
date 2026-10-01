import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type DataPaths, secretKey, type SecretStore } from '@unicontext/core';

/** SecretStore key of the REST/MCP write token (§41, §32). */
export const API_TOKEN_KEY = secretKey('daemon', 'api-token');
const TOKEN_FILE = 'daemon.token';

export function tokenFile(paths: Pick<DataPaths, 'root'>): string {
  return path.join(paths.root, TOKEN_FILE);
}

function readFile(paths: Pick<DataPaths, 'root'>): string | undefined {
  const file = tokenFile(paths);
  if (!existsSync(file)) return undefined;
  const v = readFileSync(file, 'utf8').trim();
  return v.length >= 32 ? v : undefined;
}

/**
 * Read the daemon write token: OS keychain first, then the 0600 file used when no keychain is
 * available (headless Linux). Used by the CLI to talk to a running daemon.
 */
export async function readApiToken(
  secrets: SecretStore,
  paths: Pick<DataPaths, 'root'>,
): Promise<string | undefined> {
  try {
    const v = await secrets.get(API_TOKEN_KEY);
    if (v) return v;
  } catch {
    // keychain unavailable: fall through to the file
  }
  return readFile(paths);
}

/** Create the token on first start. It never goes into the database or config.yaml. */
export async function loadOrCreateApiToken(
  secrets: SecretStore,
  paths: Pick<DataPaths, 'root'>,
): Promise<string> {
  const existing = await readApiToken(secrets, paths);
  if (existing) return existing;
  const token = randomBytes(32).toString('base64url');
  let stored = false;
  if (secrets.backend !== 'memory') {
    try {
      await secrets.set(API_TOKEN_KEY, token);
      stored = true;
    } catch {
      // fall back to the file
    }
  }
  if (!stored) {
    const file = tokenFile(paths);
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      // not supported on every filesystem
    }
  }
  return token;
}

/** Constant-time comparison of a presented token. */
export function tokensEqual(expected: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}
