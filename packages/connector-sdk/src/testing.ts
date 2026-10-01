import {
  CAPABILITIES,
  type CanonicalEntity,
  CanonicalEntitySchema,
  HealthStatusSchema,
} from '@unicontext/canonical-model';
import {
  contentHash,
  DEFAULT_SENSITIVE_KEY_PATTERN,
  type UniversityProfile,
} from '@unicontext/core';
import { describe, expect, it } from 'vitest';
import {
  AuthResultSchema,
  type RawItem,
  type SourceAdapter,
  type SyncInput,
  type SyncResult,
} from './adapter.js';
import { type ConnectorMetadata, ConnectorMetadataSchema } from './metadata.js';
import {
  createNormalizeContext,
  handlesType,
  type Normalizer,
  type RawItemView,
} from './normalizer.js';

export interface ComplianceOptions {
  /** Fresh adapter per test (fixtures/mocked transport only — CI never touches a real university, §65). */
  createAdapter: () => SourceAdapter | Promise<SourceAdapter>;
  metadata: ConnectorMetadata;
  normalizer?: Normalizer;
  /** Extra raw items (sanitized fixtures) to run through the normalizer. */
  rawFixtures?: RawItem[];
  /** Max pages followed during a sync (default 50). */
  maxPages?: number;
  /** Profile passed to the normalizer context. */
  profile?: UniversityProfile;
  sourceId?: string;
  /** Skip the authenticate() check (e.g. adapter needs interactive login and the fixture cannot fake it). */
  skipAuthenticate?: boolean;
}

async function collectSync(
  adapter: SourceAdapter,
  input: SyncInput,
  maxPages: number,
): Promise<{ pages: SyncResult[]; items: RawItem[] }> {
  const pages: SyncResult[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const res = await adapter.sync({ ...input, ...(pageToken ? { pageToken } : {}) });
    pages.push(res);
    if (!res.hasMore) return { pages, items: pages.flatMap((p) => p.items) };
    pageToken = res.nextPageToken;
    if (!pageToken) throw new Error('hasMore without nextPageToken');
  }
  throw new Error(`sync did not finish within ${maxPages} pages`);
}

function findSensitiveKeys(value: unknown, path = ''): string[] {
  if (!value || typeof value !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    const p = path ? `${path}.${k}` : k;
    if (DEFAULT_SENSITIVE_KEY_PATTERN.test(k) && typeof v === 'string' && v.length > 0) out.push(p);
    out.push(...findSensitiveKeys(v, p));
  }
  return out;
}

function toView(sourceId: string, item: RawItem): RawItemView {
  return {
    id: `raw:${item.sourceType}:${item.externalId}`,
    sourceId,
    sourceType: item.sourceType,
    externalId: item.externalId,
    payload: JSON.parse(JSON.stringify(item.payload)) as unknown,
    fetchedAt: '2026-10-01T00:00:00.000Z',
    sourceUpdatedAt: item.sourceUpdatedAt,
    contentHash: contentHash(item.payload),
  };
}

/**
 * Shared contract suite (§66). Call inside a vitest file:
 *   testConnectorCompliance('livecampusu', { createAdapter, metadata, normalizer, rawFixtures });
 */
export function testConnectorCompliance(name: string, options: ComplianceOptions): void {
  const maxPages = options.maxPages ?? 50;
  const sourceId = options.sourceId ?? 'compliance';

  describe(`connector compliance: ${name}`, () => {
    it('declares valid metadata (§55, §27)', () => {
      const parsed = ConnectorMetadataSchema.safeParse(options.metadata);
      expect(parsed.success, parsed.success ? '' : parsed.error.message).toBe(true);
    });

    it('has id/version and capabilities from the canonical list (§5)', async () => {
      const adapter = await options.createAdapter();
      expect(adapter.id.length).toBeGreaterThan(0);
      expect(adapter.version.length).toBeGreaterThan(0);
      const caps = await adapter.capabilities();
      for (const c of caps) expect(CAPABILITIES).toContain(c);
      for (const c of caps) expect(options.metadata.capabilities).toContain(c);
      await adapter.dispose();
    });

    if (!options.skipAuthenticate) {
      it('authenticate() returns a valid AuthResult without leaking secrets', async () => {
        const adapter = await options.createAdapter();
        const res = await adapter.authenticate();
        expect(AuthResultSchema.safeParse(res).success).toBe(true);
        expect(findSensitiveKeys(res)).toEqual([]);
        await adapter.dispose();
      });
    }

    it('health() returns a valid HealthStatus (§38)', async () => {
      const adapter = await options.createAdapter();
      expect(HealthStatusSchema.safeParse(await adapter.health()).success).toBe(true);
      await adapter.dispose();
    });

    it('initial sync returns raw items (§6), terminates and has serializable cursors', async () => {
      const adapter = await options.createAdapter();
      const { pages, items } = await collectSync(adapter, { mode: 'initial' }, maxPages);
      const keys = new Set<string>();
      for (const item of items) {
        expect(item.sourceType.length).toBeGreaterThan(0);
        expect(item.externalId.length).toBeGreaterThan(0);
        expect(() => JSON.stringify(item.payload)).not.toThrow();
        expect(
          findSensitiveKeys(item.payload),
          `credentials in payload of ${item.sourceType}/${item.externalId}`,
        ).toEqual([]);
        if (options.metadata.rawTypes.length)
          expect(options.metadata.rawTypes).toContain(item.sourceType);
        keys.add(`${item.sourceType}\u0000${item.externalId}`);
      }
      expect(keys.size, 'duplicate (sourceType, externalId) within one run').toBe(items.length);
      for (const p of pages) {
        if (p.cursor) expect(JSON.parse(JSON.stringify(p.cursor))).toEqual(p.cursor);
        for (const d of p.deletions ?? []) expect(d.externalId.length).toBeGreaterThan(0);
      }
      await adapter.dispose();
    });

    it('incremental sync accepts the cursor of the previous run (§35)', async () => {
      const adapter = await options.createAdapter();
      const first = await collectSync(adapter, { mode: 'initial' }, maxPages);
      const cursor = first.pages[first.pages.length - 1]?.cursor;
      const second = await collectSync(
        adapter,
        { mode: 'incremental', ...(cursor ? { cursor } : {}) },
        maxPages,
      );
      expect(Array.isArray(second.items)).toBe(true);
      await adapter.dispose();
    });

    if (options.normalizer) {
      const normalizer = options.normalizer;
      it('normalizer output validates against the canonical model, deterministically (§7, §11)', async () => {
        const adapter = await options.createAdapter();
        const { items } = await collectSync(adapter, { mode: 'initial' }, maxPages);
        await adapter.dispose();
        const all = [...items, ...(options.rawFixtures ?? [])];
        const ctx = createNormalizeContext({
          sourceId,
          sourceSystem: options.metadata.product,
          defaultAuthority: options.metadata.defaultAuthority,
          ...(options.profile ? { profile: options.profile } : {}),
          now: new Date('2026-10-01T00:00:00.000Z'),
        });
        for (const raw of all) {
          if (!handlesType(normalizer, raw.sourceType)) continue;
          const view = toView(sourceId, raw);
          const a = await normalizer.normalize(view, ctx);
          const b = await normalizer.normalize(view, ctx);
          expect(
            a.entities.map((e) => e.entity.id),
            'ids must be deterministic',
          ).toEqual(b.entities.map((e) => e.entity.id));
          for (const ne of a.entities) {
            const parsed = CanonicalEntitySchema.safeParse(ne.entity);
            expect(
              parsed.success,
              parsed.success ? '' : `${raw.sourceType}: ${parsed.error.message}`,
            ).toBe(true);
            expect((ne.entity as CanonicalEntity).id.startsWith(`${ne.entity.kind}:`)).toBe(true);
          }
          for (const f of a.facts ?? []) {
            expect(['authoritative', 'extracted', 'inferred']).toContain(f.origin);
            if (f.producer?.type === 'ai') expect(['extracted', 'inferred']).toContain(f.origin);
            if (f.confidence !== undefined) expect(f.confidence).toBeGreaterThanOrEqual(0);
          }
        }
      });
    }

    it('dispose() resolves', async () => {
      const adapter = await options.createAdapter();
      await expect(adapter.dispose()).resolves.toBeUndefined();
    });
  });
}
