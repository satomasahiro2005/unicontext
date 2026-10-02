import { createHash, randomBytes } from 'node:crypto';

/**
 * Short-lived download links of the remote listener (`/files/<token>`), minted by the
 * download_course_file tool for the OAuth client that called it. In memory only (a restart drops
 * them), 256-bit random tokens, about ten minutes, bounded in number. The token is the capability;
 * a request that also carries a bearer token must belong to the same client.
 */
export interface FileLinkEntry {
  clientId: string;
  documentId: string;
  path: string;
  name: string;
  mimeType: string | undefined;
  bytes: number;
  expiresAt: number;
}

export const FILE_LINK_TTL_MS = 10 * 60_000;
const MAX_LINKS = 200;

export class FileLinks {
  private readonly links = new Map<string, FileLinkEntry>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs = FILE_LINK_TTL_MS,
  ) {}

  mint(entry: Omit<FileLinkEntry, 'expiresAt'>): { token: string; expiresAt: string } {
    this.sweep();
    while (this.links.size >= MAX_LINKS) {
      const oldest = this.links.keys().next().value;
      if (oldest === undefined) break;
      this.links.delete(oldest);
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.now().getTime() + this.ttlMs;
    this.links.set(token, { ...entry, expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  get(token: string): FileLinkEntry | undefined {
    const e = this.links.get(token);
    if (!e) return undefined;
    if (e.expiresAt <= this.now().getTime()) {
      this.links.delete(token);
      return undefined;
    }
    return e;
  }

  private sweep(): void {
    const t = this.now().getTime();
    for (const [k, v] of this.links) if (v.expiresAt <= t) this.links.delete(k);
  }
}

/** What the audit log records instead of the token. */
export function tokenTag(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}
