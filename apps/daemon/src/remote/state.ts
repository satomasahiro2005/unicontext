import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { DataPaths } from '@unicontext/core';
import type { PassphraseHash } from './passphrase.js';

/**
 * Persistent state of the remote OAuth authorization server: registered clients, grants
 * (one per authorization, carrying the current refresh token), live access tokens and the owner's
 * passphrase/lockout. Tokens and client secrets are stored only as SHA-256 hashes (they are 256-bit
 * random values, so a fast hash is enough); the passphrase is scrypt-hashed.
 *
 * The file is small and single-user, so it is plain JSON written atomically (tmp + rename). Both
 * the daemon and the CLI (`unicontext remote revoke`) write it; every mutation re-reads the file
 * first, and readers reload when its mtime changes, so a revoke takes effect on the next request.
 */

export const REMOTE_STATE_FILE = 'oauth-state.json';

export type ClientType = 'dcr' | 'cimd';
export type TokenEndpointAuthMethod =
  'none' | 'client_secret_post' | 'client_secret_basic' | 'private_key_jwt';

export interface StoredClient {
  clientId: string;
  type: ClientType;
  name: string | undefined;
  redirectUris: string[];
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  /** SHA-256 of the client secret (DCR confidential clients only). */
  secretHash?: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface StoredGrant {
  grantId: string;
  clientId: string;
  scope: string;
  /** The protected resource (RFC 8707) the tokens are bound to: `<publicUrl>/mcp`. */
  resource: string;
  createdAt: string;
  lastUsedAt?: string;
  refreshHash: string;
  refreshExpiresAt: string;
  /** Hashes of refresh tokens already rotated away; presenting one again revokes the grant. */
  rotatedRefreshHashes: string[];
  revokedAt?: string;
}

export interface StoredAccessToken {
  grantId: string;
  clientId: string;
  scope: string;
  resource: string;
  expiresAt: string;
}

export interface OwnerState {
  passphrase?: PassphraseHash;
  passphraseSetAt?: string;
  /** Consecutive failed unlocks since the last success or lockout. */
  failures: number;
  /** Lockouts since the last success (each doubles the lockout time). */
  lockouts: number;
  lockedUntil?: string;
}

export interface RemoteState {
  version: 1;
  owner: OwnerState;
  clients: Record<string, StoredClient>;
  grants: Record<string, StoredGrant>;
  /** Keyed by SHA-256 of the access token. */
  accessTokens: Record<string, StoredAccessToken>;
}

export function emptyRemoteState(): RemoteState {
  return {
    version: 1,
    owner: { failures: 0, lockouts: 0 },
    clients: {},
    grants: {},
    accessTokens: {},
  };
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`;
}

export function remoteStateDir(paths: Pick<DataPaths, 'root'>): string {
  return path.join(paths.root, 'remote');
}

export function remoteStateFile(paths: Pick<DataPaths, 'root'>): string {
  return path.join(remoteStateDir(paths), REMOTE_STATE_FILE);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class RemoteStateStore {
  private cache: RemoteState | undefined;
  private mtimeMs = -1;

  constructor(
    readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  static forPaths(paths: Pick<DataPaths, 'root'>, now?: () => Date): RemoteStateStore {
    return new RemoteStateStore(remoteStateFile(paths), now);
  }

  private currentMtime(): number {
    try {
      return statSync(this.file).mtimeMs;
    } catch {
      return -1;
    }
  }

  private readFresh(): RemoteState {
    if (!existsSync(this.file)) return emptyRemoteState();
    const text = readFileSync(this.file, 'utf8');
    const parsed = JSON.parse(text) as Partial<RemoteState>;
    const base = emptyRemoteState();
    return {
      version: 1,
      owner: { ...base.owner, ...(parsed.owner ?? {}) },
      clients: parsed.clients ?? {},
      grants: parsed.grants ?? {},
      accessTokens: parsed.accessTokens ?? {},
    };
  }

  /** Current state (reloaded when another process changed the file). Do not mutate it. */
  read(): RemoteState {
    const m = this.currentMtime();
    if (!this.cache || m !== this.mtimeMs) {
      this.cache = this.readFresh();
      this.mtimeMs = m;
    }
    return this.cache;
  }

  /** Read-modify-write against the file on disk; the result is written atomically. */
  update<T>(fn: (state: RemoteState) => T): T {
    const state = this.readFresh();
    const result = fn(state);
    this.prune(state);
    this.write(state);
    return result;
  }

  private prune(state: RemoteState): void {
    const now = this.now().getTime();
    for (const [hash, t] of Object.entries(state.accessTokens)) {
      const grant = state.grants[t.grantId];
      if (Date.parse(t.expiresAt) <= now || !grant || grant.revokedAt)
        delete state.accessTokens[hash];
    }
    for (const [id, g] of Object.entries(state.grants)) {
      // keep revoked/expired grants for a day so `remote clients` can still show them
      const end = g.revokedAt ? Date.parse(g.revokedAt) : Date.parse(g.refreshExpiresAt);
      if (end + 24 * 3600_000 <= now) delete state.grants[id];
    }
  }

  private write(state: RemoteState): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // not supported on every filesystem
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        renameSync(tmp, this.file);
        this.cache = state;
        this.mtimeMs = this.currentMtime();
        return;
      } catch (e) {
        // Windows: the target may be open by a concurrent reader for a moment
        lastError = e;
        sleepSync(20);
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw lastError;
  }

  // ---- convenience queries --------------------------------------------------------------

  activeGrants(clientId?: string): StoredGrant[] {
    const now = this.now().getTime();
    return Object.values(this.read().grants).filter(
      (g) =>
        !g.revokedAt &&
        Date.parse(g.refreshExpiresAt) > now &&
        (clientId === undefined || g.clientId === clientId),
    );
  }

  /** Revoke every grant (and its access tokens) of a client and forget the client. */
  revokeClient(clientId: string): { grants: number; found: boolean } {
    return this.update((state) => {
      const at = this.now().toISOString();
      let grants = 0;
      for (const g of Object.values(state.grants)) {
        if (g.clientId !== clientId || g.revokedAt) continue;
        g.revokedAt = at;
        grants++;
      }
      for (const [hash, t] of Object.entries(state.accessTokens))
        if (t.clientId === clientId) delete state.accessTokens[hash];
      const found = clientId in state.clients || grants > 0;
      delete state.clients[clientId];
      return { grants, found };
    });
  }

  revokeAll(): { clients: number; grants: number } {
    return this.update((state) => {
      const at = this.now().toISOString();
      let grants = 0;
      for (const g of Object.values(state.grants)) {
        if (g.revokedAt) continue;
        g.revokedAt = at;
        grants++;
      }
      const clients = Object.keys(state.clients).length;
      state.accessTokens = {};
      state.clients = {};
      return { clients, grants };
    });
  }

  setPassphrase(hash: PassphraseHash): void {
    this.update((state) => {
      state.owner = {
        passphrase: hash,
        passphraseSetAt: this.now().toISOString(),
        failures: 0,
        lockouts: 0,
      };
    });
  }

  hasPassphrase(): boolean {
    return this.read().owner.passphrase !== undefined;
  }
}
