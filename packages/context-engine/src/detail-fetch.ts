import { supportsDetailFetch } from '@unicontext/connector-sdk';
import { errorMessage, ValidationError } from '@unicontext/core';
import type { UniContext } from './runtime.js';

/*
 * On-request detail fetching: the user asks for something a sync stored only partially (a
 * syllabus list row whose detail page the budgeted daily sync has not opened yet), and its
 * connector reads it on the spot through its own paced session (read-only at the source). What
 * cannot be read now is queued by the connector for its next sync. Callers: MCP get_syllabus,
 * REST POST /api/v1/details/fetch (which `unicontext mcp` uses when the daemon runs).
 */

export const MAX_DETAIL_FETCH_PER_REQUEST = 5;

export interface DetailFetchItemResult {
  /** The entity id asked for. */
  id: string;
  status: 'fetched' | 'alreadyFetched' | 'queued' | 'notFound' | 'unsupported' | 'failed';
  error?: string;
}

export interface DetailFetchReport {
  results: DetailFetchItemResult[];
  fetched: number;
  warnings: string[];
}

/**
 * Fetch the details of these entities (canonical ids, e.g. syllabus course offerings) through the
 * connector that stored them, and ingest the result. The connector paces the requests with its
 * sync; ingesting waits for a running sync of that source to finish.
 */
export async function fetchDetailsOnRequest(
  uc: UniContext,
  ids: readonly string[],
  options: { signal?: AbortSignal } = {},
): Promise<DetailFetchReport> {
  const unique = [...new Set(ids.map((x) => x.trim()).filter(Boolean))];
  if (unique.length === 0) throw new ValidationError('give at least one id');
  if (unique.length > MAX_DETAIL_FETCH_PER_REQUEST)
    throw new ValidationError(`at most ${MAX_DETAIL_FETCH_PER_REQUEST} ids per request`);
  const stores = uc.sync.stores;
  const results = new Map<string, DetailFetchItemResult>();
  const bySource = new Map<
    string,
    { id: string; externalId: string; sourceType: string; payload: unknown }[]
  >();

  for (const id of unique) {
    const raw = stores.sourceRefs
      .forEntity(id)
      .map((r) => (r.rawItemId ? stores.raw.get(r.rawItemId) : undefined))
      .find((r) => r !== undefined && !r.deletedAt);
    if (!raw) {
      results.set(id, { id, status: 'notFound' });
      continue;
    }
    let supported: boolean;
    try {
      supported = supportsDetailFetch(uc.sync.getSource(raw.sourceId).adapter);
    } catch {
      supported = false; // the source is not registered (connector not loaded)
    }
    if (!supported) {
      results.set(id, { id, status: 'unsupported' });
      continue;
    }
    const list = bySource.get(raw.sourceId) ?? [];
    list.push({ id, externalId: raw.externalId, sourceType: raw.sourceType, payload: raw.payload });
    bySource.set(raw.sourceId, list);
  }

  const warnings: string[] = [];
  for (const [sourceId, wanted] of bySource) {
    const adapter = uc.sync.getSource(sourceId).adapter;
    if (!supportsDetailFetch(adapter)) continue;
    try {
      const out = await adapter.fetchDetails(
        wanted.map((w) => ({
          externalId: w.externalId,
          sourceType: w.sourceType,
          previousPayload: w.payload,
        })),
        options.signal ? { signal: options.signal } : {},
      );
      warnings.push(...out.warnings);
      if (out.items.length > 0) await uc.sync.ingest(sourceId, { items: out.items });
      for (const w of wanted) {
        const r = out.results.find((x) => x.externalId === w.externalId);
        results.set(w.id, {
          id: w.id,
          status: r?.status ?? 'failed',
          ...(r?.error ? { error: r.error } : {}),
        });
      }
    } catch (e) {
      for (const w of wanted)
        results.set(w.id, { id: w.id, status: 'failed', error: errorMessage(e) });
    }
  }

  const list = unique.map((id) => results.get(id)).filter((r) => r !== undefined);
  return {
    results: list,
    fetched: list.filter((r) => r.status === 'fetched').length,
    warnings,
  };
}
