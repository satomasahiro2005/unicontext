import type { EntityKind } from '@unicontext/canonical-model';
import {
  ConfigError,
  contentHash,
  type EmbeddingProviderId,
  type FetchLike,
  UniContextError,
} from '@unicontext/core';
import { EntityStore, embeddings, FTS_TABLES, type UniContextDatabase } from '@unicontext/database';
import { and, eq } from 'drizzle-orm';

/** Optional embedding backend (§16). Default is none: everything works on FTS5 alone. */
export interface EmbeddingProvider {
  readonly id: EmbeddingProviderId;
  readonly model: string;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

export interface EmbeddingProviderOptions {
  provider: EmbeddingProviderId;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  fetch?: FetchLike;
  /** Required for provider "local": an in-process embedding function. */
  embedFn?: (texts: readonly string[]) => Promise<Float32Array[]>;
}

async function postJson(
  fetchFn: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new UniContextError('internal', `Embedding provider HTTP ${res.status}`);
  return res.json();
}

function vectorsFrom(json: unknown, path: 'data' | 'embeddings'): Float32Array[] {
  const j = json as Record<string, unknown>;
  if (path === 'data' && Array.isArray(j.data))
    return j.data.map((d) => Float32Array.from((d as { embedding: number[] }).embedding));
  if (path === 'embeddings' && Array.isArray(j.embeddings))
    return (j.embeddings as number[][]).map((e) => Float32Array.from(e));
  throw new UniContextError('internal', 'Unexpected embedding response');
}

/** Returns undefined for "none". */
export function createEmbeddingProvider(
  options: EmbeddingProviderOptions,
): EmbeddingProvider | undefined {
  const fetchFn: FetchLike = options.fetch ?? ((i, init) => fetch(i, init));
  switch (options.provider) {
    case 'none':
      return undefined;
    case 'local': {
      if (!options.embedFn) throw new ConfigError('embeddings.provider "local" needs an embedFn');
      const fn = options.embedFn;
      return { id: 'local', model: options.model ?? 'local', embed: (t) => fn(t) };
    }
    case 'openai':
    case 'voyage': {
      if (!options.apiKey)
        throw new ConfigError(
          `${options.provider} embeddings need an API key (embeddings.apiKeyRef)`,
        );
      if (!options.model) throw new ConfigError('embeddings.model is required');
      const base =
        options.baseUrl ??
        (options.provider === 'openai'
          ? 'https://api.openai.com/v1'
          : 'https://api.voyageai.com/v1');
      const key = options.apiKey;
      const model = options.model;
      return {
        id: options.provider,
        model,
        embed: async (input) =>
          vectorsFrom(
            await postJson(
              fetchFn,
              `${base}/embeddings`,
              { authorization: `Bearer ${key}` },
              { model, input },
            ),
            'data',
          ),
      };
    }
    case 'ollama': {
      if (!options.model) throw new ConfigError('embeddings.model is required');
      const base = options.baseUrl ?? 'http://127.0.0.1:11434';
      const model = options.model;
      return {
        id: 'ollama',
        model,
        embed: async (input) =>
          vectorsFrom(
            await postJson(fetchFn, `${base}/api/embed`, {}, { model, input }),
            'embeddings',
          ),
      };
    }
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function textOf(db: UniContextDatabase, kind: EntityKind, entityId: string): string | undefined {
  const table = FTS_TABLES[kind];
  if (!table) return undefined;
  const r = db.sqlite
    .prepare(`SELECT title, body FROM ${table} WHERE entity_id = ?`)
    .get(entityId) as { title: string; body: string } | undefined;
  return r ? `${r.title}\n${r.body}`.trim() : undefined;
}

export interface SemanticHit {
  entityId: string;
  kind: EntityKind;
  score: number;
}

/** Brute-force vector index stored in the embeddings table. Fine for one student's data. */
export class EmbeddingIndex {
  constructor(
    private readonly db: UniContextDatabase,
    private readonly provider: EmbeddingProvider,
  ) {}

  /** Embed searchable entities whose text changed since the last run. Returns count embedded. */
  async refresh(
    kinds: readonly EntityKind[] = Object.keys(FTS_TABLES) as EntityKind[],
    batchSize = 32,
  ): Promise<number> {
    const entities = new EntityStore(this.db);
    const pending: { id: string; text: string; hash: string }[] = [];
    for (const kind of kinds) {
      for (const e of entities.list(kind)) {
        const text = textOf(this.db, kind, e.id);
        if (!text) continue;
        const hash = contentHash(text);
        const existing = this.db.orm
          .select({ h: embeddings.contentHash })
          .from(embeddings)
          .where(
            and(
              eq(embeddings.entityId, e.id),
              eq(embeddings.provider, this.provider.id),
              eq(embeddings.model, this.provider.model),
            ),
          )
          .get();
        if (existing?.h !== hash) pending.push({ id: e.id, text, hash });
      }
    }
    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      const vectors = await this.provider.embed(batch.map((b) => b.text));
      batch.forEach((b, j) => {
        const v = vectors[j];
        if (!v) return;
        const row = {
          entityId: b.id,
          provider: this.provider.id,
          model: this.provider.model,
          dims: v.length,
          vector: Buffer.from(v.buffer, v.byteOffset, v.byteLength),
          contentHash: b.hash,
          createdAt: new Date().toISOString(),
        };
        this.db.orm
          .insert(embeddings)
          .values(row)
          .onConflictDoUpdate({
            target: [embeddings.entityId, embeddings.provider, embeddings.model],
            set: row,
          })
          .run();
      });
    }
    return pending.length;
  }

  async search(
    query: string,
    options: { limit?: number; kinds?: readonly EntityKind[] } = {},
  ): Promise<SemanticHit[]> {
    const [qv] = await this.provider.embed([query]);
    if (!qv) return [];
    const rows = this.db.orm
      .select()
      .from(embeddings)
      .where(
        and(eq(embeddings.provider, this.provider.id), eq(embeddings.model, this.provider.model)),
      )
      .all();
    const kinds = options.kinds ? new Set(options.kinds) : undefined;
    return rows
      .map((r) => {
        const v = new Float32Array(Uint8Array.from(r.vector).buffer);
        return {
          entityId: r.entityId,
          kind: r.entityId.slice(0, r.entityId.indexOf(':')) as EntityKind,
          score: cosine(qv, v),
        };
      })
      .filter((h) => !kinds || kinds.has(h.kind))
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit ?? 10);
  }
}
