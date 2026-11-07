import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DataPaths } from '@unicontext/core';

/**
 * Guests: people the student shares a read-only page with (`<publicUrl>/g/<token>`), such as a
 * parent or a friend. A guest never signs in and never reaches MCP; the link itself is the
 * capability, so it is a random 256-bit token kept only as a SHA-256 hash, and revoking it (or its
 * expiry) ends access on the next request. What the page shows depends on the role (guest-view.ts).
 *
 * Plain JSON next to oauth-state.json, written atomically; the CLI writes it and the daemon reads
 * it on every request, so `unicontext guest revoke` needs no restart.
 */

export const GUESTS_FILE = 'guests.json';

/**
 * - friend: the week's timetable (classes, rooms, 休講) only.
 * - family: the timetable plus deadlines, exams and whether each was handed in.
 */
export type GuestRole = 'friend' | 'family';
export const GUEST_ROLES: readonly GuestRole[] = ['friend', 'family'];

export interface StoredGuest {
  id: string;
  name: string;
  role: GuestRole;
  tokenHash: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

interface GuestsFile {
  version: 1;
  guests: StoredGuest[];
}

export const hashGuestToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const isGuestTokenShape = (token: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(token);

export function guestActive(g: StoredGuest, now: Date): boolean {
  return !g.revokedAt && (!g.expiresAt || Date.parse(g.expiresAt) > now.getTime());
}

export class GuestStore {
  constructor(
    readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  static forPaths(paths: DataPaths, now?: () => Date): GuestStore {
    return new GuestStore(path.join(paths.root, 'remote', GUESTS_FILE), now);
  }

  read(): StoredGuest[] {
    if (!existsSync(this.file)) return [];
    const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<GuestsFile>;
    return Array.isArray(parsed.guests) ? parsed.guests : [];
  }

  private write(guests: StoredGuest[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const body: GuestsFile = { version: 1, guests };
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
    if (process.platform !== 'win32') chmodSync(this.file, 0o600);
  }

  /** Creates a guest and returns it with the token, which is shown once and never stored. */
  add(input: { name: string; role: GuestRole; ttlMs?: number }): {
    guest: StoredGuest;
    token: string;
  } {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    const guest: StoredGuest = {
      id: `g_${randomUUID().slice(0, 8)}`,
      name: input.name,
      role: input.role,
      tokenHash: hashGuestToken(token),
      createdAt: now.toISOString(),
      ...(input.ttlMs ? { expiresAt: new Date(now.getTime() + input.ttlMs).toISOString() } : {}),
    };
    this.write([...this.read(), guest]);
    return { guest, token };
  }

  /** Revokes by id or by name (every active guest with that name). Returns the revoked guests. */
  revoke(idOrName: string): StoredGuest[] {
    const now = this.now();
    const guests = this.read();
    const hit = guests.filter((g) => !g.revokedAt && (g.id === idOrName || g.name === idOrName));
    if (hit.length === 0) return [];
    for (const g of hit) g.revokedAt = now.toISOString();
    this.write(guests);
    return hit;
  }

  /** The active guest a link token belongs to; records the use (at most once a minute). */
  resolve(token: string): StoredGuest | undefined {
    if (!isGuestTokenShape(token)) return undefined;
    const hash = hashGuestToken(token);
    const guests = this.read();
    const now = this.now();
    const g = guests.find((x) => x.tokenHash === hash);
    if (!g || !guestActive(g, now)) return undefined;
    if (!g.lastUsedAt || now.getTime() - Date.parse(g.lastUsedAt) > 60_000) {
      g.lastUsedAt = now.toISOString();
      this.write(guests);
    }
    return g;
  }
}
