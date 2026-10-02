import { supportsOpenAnnouncements } from '@unicontext/connector-sdk';
import { errorMessage, ValidationError } from '@unicontext/core';
import { ReadMarkStore } from '@unicontext/database';
import { readAnnouncementExtra } from './announcements.js';
import type { UniContext } from './runtime.js';

/*
 * On-request fetching of announcement bodies (LiveCampusU notices that are unread there). LCU
 * marks a notice read when its detail is opened and cannot set it back, so a sync never opens
 * unread notices; this is the only path that does, and only for the notices the user names
 * (CLI `unicontext announcements open`, REST, the Web UI button, MCP open_announcement).
 * UniContext keeps such a notice 未読 until the user reads it in UniContext or marks it.
 */

export const MAX_OPEN_PER_REQUEST = 50;

export interface OpenAnnouncementResult {
  id: string;
  title: string | undefined;
  status: 'opened' | 'alreadyFetched' | 'notFound' | 'unsupported' | 'failed';
  /** It was unread at the source and is read there now. */
  markedReadAtSource: boolean;
  error?: string;
}

export interface OpenAnnouncementsReport {
  results: OpenAnnouncementResult[];
  opened: number;
  markedReadAtSource: number;
  warnings: string[];
}

/**
 * Fetch the bodies of these announcements through their connector (which must support it),
 * ingest them, and keep each one unread in UniContext. Already fetched ones are left alone.
 */
export async function openAnnouncements(
  uc: UniContext,
  ids: readonly string[],
  options: { signal?: AbortSignal } = {},
): Promise<OpenAnnouncementsReport> {
  const unique = [...new Set(ids.map((x) => x.trim()).filter(Boolean))];
  if (unique.length === 0) throw new ValidationError('give at least one announcement id');
  if (unique.length > MAX_OPEN_PER_REQUEST)
    throw new ValidationError(`at most ${MAX_OPEN_PER_REQUEST} announcements per request`);
  const stores = uc.sync.stores;
  const marks = new ReadMarkStore(uc.db);
  const results = new Map<string, OpenAnnouncementResult>();
  const bySource = new Map<string, { id: string; externalId: string; payload: unknown }[]>();

  for (const id of unique) {
    const a = stores.entities.getOfKind('announcement', id);
    if (!a) {
      results.set(id, { id, title: undefined, status: 'notFound', markedReadAtSource: false });
      continue;
    }
    const base = { id, title: a.title, markedReadAtSource: false };
    if (readAnnouncementExtra(a.extra).bodyStatus === 'fetched') {
      results.set(id, { ...base, status: 'alreadyFetched' });
      continue;
    }
    const raw = stores.sourceRefs
      .forEntity(id)
      .map((r) => (r.rawItemId ? stores.raw.get(r.rawItemId) : undefined))
      .find((r) => r !== undefined && !r.deletedAt);
    const supported = ((): boolean => {
      try {
        return (
          raw !== undefined && supportsOpenAnnouncements(uc.sync.getSource(raw.sourceId).adapter)
        );
      } catch {
        return false; // the source is not registered (connector not loaded)
      }
    })();
    if (!raw || !supported) {
      results.set(id, { ...base, status: 'unsupported' });
      continue;
    }
    const list = bySource.get(raw.sourceId) ?? [];
    list.push({ id, externalId: raw.externalId, payload: raw.payload });
    bySource.set(raw.sourceId, list);
  }

  const warnings: string[] = [];
  for (const [sourceId, wanted] of bySource) {
    const adapter = uc.sync.getSource(sourceId).adapter;
    if (!supportsOpenAnnouncements(adapter)) continue;
    try {
      const out = await adapter.openAnnouncements(
        wanted.map((w) => ({ externalId: w.externalId, previousPayload: w.payload })),
        { acceptMarksRead: true, ...(options.signal ? { signal: options.signal } : {}) },
      );
      warnings.push(...out.warnings);
      if (out.items.length > 0) await uc.sync.ingest(sourceId, { items: out.items });
      const now = uc.clock.now().toISOString();
      for (const w of wanted) {
        const r = out.results.find((x) => x.externalId === w.externalId);
        const title = stores.entities.getOfKind('announcement', w.id)?.title;
        if (r?.status === 'opened') {
          // Read in LCU now, but the user has not read it in UniContext yet.
          if (!marks.get(w.id) || r.wasUnread) marks.set(w.id, true, 'opened-on-request', now);
          results.set(w.id, {
            id: w.id,
            title,
            status: 'opened',
            markedReadAtSource: r.wasUnread === true,
          });
        } else
          results.set(w.id, {
            id: w.id,
            title,
            status: r?.status === 'notFound' ? 'notFound' : 'failed',
            markedReadAtSource: false,
            ...(r?.error ? { error: r.error } : {}),
          });
      }
    } catch (e) {
      for (const w of wanted)
        results.set(w.id, {
          id: w.id,
          title: stores.entities.getOfKind('announcement', w.id)?.title,
          status: 'failed',
          markedReadAtSource: false,
          error: errorMessage(e),
        });
    }
  }

  const list = unique.map((id) => results.get(id)).filter((r) => r !== undefined);
  return {
    results: list,
    opened: list.filter((r) => r.status === 'opened').length,
    markedReadAtSource: list.filter((r) => r.markedReadAtSource).length,
    warnings,
  };
}
