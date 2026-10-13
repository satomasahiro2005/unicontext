import {
  type CanonicalEntity,
  type CanonicalEntityInput,
  type EntityId,
  type FactOrigin,
  type IdKind,
  isIdOf,
  type Id,
  type JsonValue,
  type Producer,
  type SourceLocation,
  stableId,
} from '@unicontext/canonical-model';
import {
  DEFAULT_TIMEZONE,
  type Logger,
  silentLogger,
  type UniversityProfile,
} from '@unicontext/core';
import type { FileTextPayload } from './adapter.js';
import type { DriftFinding } from './drift.js';

/** Read-only view of a stored raw item handed to normalizers (§6). */
export interface RawItemView {
  id: string;
  sourceId: string;
  sourceType: string;
  externalId: string;
  payload: unknown;
  fetchedAt: string;
  sourceUpdatedAt: string | undefined;
  contentHash: string;
}

/**
 * How an entity/fact points back to its origin. The engine fills id, sourceSystem, retrievedAt
 * and rawItemId; normalizers only add what they know (url, authority override, location).
 */
export interface SourceRefSpec {
  authority?: string;
  url?: string;
  location?: SourceLocation;
  /** Defaults to the raw item's externalId. */
  sourceItemId?: string;
  sourceLabel?: string;
}

export interface NormalizedEntity {
  entity: CanonicalEntityInput;
  ref?: SourceRefSpec;
  /**
   * Origin used for the facts auto-derived from DEFAULT_FACT_FIELDS (default "authoritative").
   * Use "extracted" when the entity itself was parsed out of free text.
   */
  origin?: Exclude<FactOrigin, 'user'>;
  /** Set false to skip auto-derived facts for this entity. */
  deriveFacts?: boolean;
}

export interface FactInput {
  subject: EntityId;
  predicate: string;
  value: JsonValue;
  /** "user" is reserved for human corrections and rejected here. */
  origin: Exclude<FactOrigin, 'user'>;
  confidence?: number;
  /** Defaults to sourceUpdatedAt of the raw item, then fetchedAt. */
  observedAt?: string;
  validFrom?: string;
  validUntil?: string;
  evidence?: string;
  ref?: SourceRefSpec;
  /** Defaults to { type: "connector", id: <sourceId> }. Use type "ai" for LLM output. */
  producer?: Producer;
}

export interface NormalizeOutput {
  entities: NormalizedEntity[];
  facts?: FactInput[];
  /** Schema drift findings (see detectSchemaDrift) recorded by the engine (§73). */
  drift?: DriftFinding[];
  warnings?: string[];
}

export interface NormalizeContext {
  sourceId: string;
  sourceSystem: string;
  sourceLabel: string | undefined;
  defaultAuthority: string;
  timezone: string;
  profile: UniversityProfile | undefined;
  now: Date;
  logger: Logger;
  /** Deterministic id scoped to this source: same parts → same id on every reprocess. */
  id<K extends IdKind>(kind: K, ...parts: string[]): Id<K>;
  /** Read an already stored entity (e.g. to attach to a course offering). */
  lookup(id: string): CanonicalEntity | undefined;
}

/** Converts raw items into canonical entities + facts with provenance. Must be pure/deterministic. */
export interface Normalizer {
  readonly id: string;
  /** Bump when output changes; stored per raw item to allow targeted reprocessing. */
  readonly version: string;
  /** Raw item types handled. "*" handles everything. */
  readonly sourceTypes: readonly string[];
  normalize(item: RawItemView, ctx: NormalizeContext): NormalizeOutput | Promise<NormalizeOutput>;
}

export function handlesType(normalizer: Normalizer, sourceType: string): boolean {
  return normalizer.sourceTypes.includes('*') || normalizer.sourceTypes.includes(sourceType);
}

export interface NormalizeContextInit {
  sourceId: string;
  sourceSystem: string;
  sourceLabel?: string;
  defaultAuthority?: string;
  timezone?: string;
  profile?: UniversityProfile;
  now?: Date;
  logger?: Logger;
  lookup?: (id: string) => CanonicalEntity | undefined;
}

/** Build a NormalizeContext (used by the sync engine and by connector tests). */
export function createNormalizeContext(init: NormalizeContextInit): NormalizeContext {
  return {
    sourceId: init.sourceId,
    sourceSystem: init.sourceSystem,
    sourceLabel: init.sourceLabel,
    defaultAuthority: init.defaultAuthority ?? 'unknown',
    timezone: init.timezone ?? init.profile?.academicCalendar.timezone ?? DEFAULT_TIMEZONE,
    profile: init.profile,
    now: init.now ?? new Date(),
    logger: init.logger ?? silentLogger,
    id: (kind, ...parts) => stableId(kind, init.sourceId, ...parts),
    lookup: init.lookup ?? (() => undefined),
  };
}

/**
 * Text the host extracted from a downloaded file (FILE_TEXT_SOURCE_TYPE): one documentChunk per
 * piece, tied to the document the file belongs to, so search and the file text excerpt see it.
 */
export function normalizeFileTextItem(item: RawItemView, ctx: NormalizeContext): NormalizeOutput {
  const p = item.payload as Partial<FileTextPayload> | null;
  if (
    !p ||
    typeof p.documentId !== 'string' ||
    !isIdOf('document', p.documentId) ||
    !Array.isArray(p.chunks)
  )
    return { entities: [], warnings: [`invalid ${item.sourceType} payload`] };
  const cite: SourceRefSpec = {};
  if (typeof p.ref?.sourceLabel === 'string') cite.sourceLabel = p.ref.sourceLabel;
  if (typeof p.ref?.url === 'string') cite.url = p.ref.url;
  if (typeof p.ref?.authority === 'string') cite.authority = p.ref.authority;
  const entities: NormalizedEntity[] = [];
  for (const piece of p.chunks) {
    if (typeof piece?.text !== 'string' || !piece.text.trim()) continue;
    const page = typeof piece.page === 'number' && piece.page > 0 ? piece.page : undefined;
    entities.push({
      entity: {
        id: ctx.id('documentChunk', p.documentId, String(entities.length)),
        kind: 'documentChunk',
        documentId: p.documentId,
        ordinal: entities.length,
        text: piece.text,
        ...(page ? { page } : {}),
        ...(piece.heading ? { heading: piece.heading } : {}),
      },
      ref: { ...cite, ...(page ? { location: { page } } : {}) },
    });
  }
  return { entities };
}
