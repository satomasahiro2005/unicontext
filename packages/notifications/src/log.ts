import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { errorMessage, type Logger, silentLogger } from '@unicontext/core';
import { z } from 'zod';
import {
  meetsPriority,
  type Notification,
  NotificationSchema,
  type NotificationPriority,
} from './types.js';

export interface NotificationLogOptions {
  /** JSONL file. Omit for an in-memory log. */
  file?: string;
  /** Cap for the in-memory list (dedupe keys of older entries are kept). Default 1000. */
  maxEntries?: number;
  logger?: Logger;
}

export interface NotificationListOptions {
  limit?: number;
  /** ISO timestamp; only notifications created at or after it. */
  since?: string;
  minPriority?: NotificationPriority;
  unreadOnly?: boolean;
}

const LineSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('n'), n: NotificationSchema }),
  z.object({ t: z.literal('read'), id: z.string() }),
  z.object({ t: z.literal('reset'), key: z.string() }),
]);
type LogLine = z.infer<typeof LineSchema>;

/**
 * Append-only notification history. Entries are JSON lines: `{"t":"n","n":{...}}` for a
 * notification, `{"t":"read","id"}` for read state and `{"t":"reset","key"}` for forgetting a
 * dedupe key (used when a source recovers). Loaded on construction; corrupt lines are skipped.
 */
export class NotificationLog {
  readonly file: string | undefined;
  private readonly maxEntries: number;
  private readonly logger: Logger;
  private items: Notification[] = [];
  private readonly byId = new Map<string, Notification>();
  private readonly lastByKey = new Map<string, string>();
  private readonly readIds = new Set<string>();
  /** Lines that could not be parsed while loading. */
  corruptLines = 0;

  constructor(options: NotificationLogOptions = {}) {
    this.file = options.file;
    this.maxEntries = options.maxEntries ?? 1000;
    this.logger = options.logger ?? silentLogger;
    if (this.file) {
      try {
        mkdirSync(path.dirname(this.file), { recursive: true });
      } catch (e) {
        this.logger.warn('notification log directory unavailable', { error: errorMessage(e) });
      }
      this.load(this.file);
    }
  }

  get size(): number {
    return this.items.length;
  }

  has(dedupeKey: string): boolean {
    return this.lastByKey.has(dedupeKey);
  }

  /** createdAt of the latest notification with this dedupe key (unless reset since). */
  lastCreatedAt(dedupeKey: string): string | undefined {
    return this.lastByKey.get(dedupeKey);
  }

  get(id: string): Notification | undefined {
    const n = this.byId.get(id);
    return n ? this.view(n) : undefined;
  }

  add(n: Notification): void {
    const stored: Notification = { ...n };
    delete stored.read;
    this.insert(stored);
    this.append({ t: 'n', n: stored });
  }

  markRead(id: string): boolean {
    if (!this.byId.has(id)) return false;
    if (this.readIds.has(id)) return true;
    this.readIds.add(id);
    this.append({ t: 'read', id });
    return true;
  }

  /** Forget a dedupe key so the next matching notification is delivered again. */
  resetKey(dedupeKey: string): void {
    if (!this.lastByKey.delete(dedupeKey)) return;
    this.append({ t: 'reset', key: dedupeKey });
  }

  /** Newest first. */
  list(options: NotificationListOptions = {}): Notification[] {
    const out: Notification[] = [];
    for (let i = this.items.length - 1; i >= 0; i--) {
      const n = this.items[i];
      if (!n) continue;
      if (options.since !== undefined && n.createdAt < options.since) continue;
      if (options.minPriority && !meetsPriority(n.priority, options.minPriority)) continue;
      if (options.unreadOnly && this.readIds.has(n.id)) continue;
      out.push(this.view(n));
      if (options.limit !== undefined && out.length >= options.limit) break;
    }
    return out;
  }

  unreadCount(): number {
    let c = 0;
    for (const n of this.items) if (!this.readIds.has(n.id)) c++;
    return c;
  }

  private view(n: Notification): Notification {
    return this.readIds.has(n.id) ? { ...n, read: true } : { ...n };
  }

  private insert(n: Notification): void {
    this.items.push(n);
    this.byId.set(n.id, n);
    this.lastByKey.set(n.dedupeKey, n.createdAt);
    if (this.items.length > this.maxEntries) {
      const dropped = this.items.splice(0, this.items.length - this.maxEntries);
      for (const d of dropped) {
        this.byId.delete(d.id);
        this.readIds.delete(d.id);
      }
    }
  }

  private append(line: LogLine): void {
    if (!this.file) return;
    try {
      appendFileSync(this.file, `${JSON.stringify(line)}\n`, 'utf8');
    } catch (e) {
      this.logger.warn('notification log write failed', { error: errorMessage(e) });
    }
  }

  private load(file: string): void {
    if (!existsSync(file)) return;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      this.logger.warn('notification log unreadable', { error: errorMessage(e) });
      return;
    }
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        this.corruptLines++;
        continue;
      }
      const parsed = LineSchema.safeParse(json);
      if (!parsed.success) {
        this.corruptLines++;
        continue;
      }
      const l = parsed.data;
      if (l.t === 'n') this.insert(l.n as Notification);
      else if (l.t === 'read') this.readIds.add(l.id);
      else this.lastByKey.delete(l.key);
    }
    if (this.corruptLines > 0)
      this.logger.warn('notification log had corrupt lines', { count: this.corruptLines });
  }
}
