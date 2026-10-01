import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

/** Every canonical entity kind (§7). IDs are "<kind>:<uuid>", e.g. "courseOffering:6f1c...". */
export const ENTITY_KINDS = [
  'university',
  'campus',
  'academicTerm',
  'person',
  'course',
  'courseOffering',
  'enrollment',
  'assignment',
  'submission',
  'exam',
  'announcement',
  'message',
  'thread',
  'material',
  'document',
  'documentChunk',
  'lecture',
  'lectureTranscript',
  'lectureSegment',
  'calendarEvent',
  'classSession',
  'location',
  'grade',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** Kinds that are records about entities rather than entities themselves. */
export const RECORD_KINDS = [
  'task',
  'sourceReference',
  'fact',
  'conflict',
  'changeEvent',
  'identityLink',
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export type IdKind = EntityKind | RecordKind;
export type Id<K extends IdKind = IdKind> = `${K}:${string}`;

const ALL_KINDS: readonly string[] = [...ENTITY_KINDS, ...RECORD_KINDS];

export function isEntityKind(kind: string): kind is EntityKind {
  return (ENTITY_KINDS as readonly string[]).includes(kind);
}

/** Random id for a new record. */
export function makeId<K extends IdKind>(kind: K, uuid: string = randomUUID()): Id<K> {
  return `${kind}:${uuid}`;
}

/**
 * Deterministic id: the same parts always give the same id. Normalizers use this with
 * (sourceId, externalId) so reprocessing raw data updates instead of duplicating.
 */
export function stableId<K extends IdKind>(kind: K, ...parts: string[]): Id<K> {
  const h = createHash('sha1')
    .update([kind, ...parts].join('\u0000'))
    .digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${kind}:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface ParsedId {
  kind: IdKind;
  local: string;
}

export function parseId(id: string): ParsedId {
  const i = id.indexOf(':');
  if (i <= 0 || i === id.length - 1) throw new RangeError(`Invalid id: ${id}`);
  const kind = id.slice(0, i);
  if (!ALL_KINDS.includes(kind)) throw new RangeError(`Unknown id kind: ${kind}`);
  return { kind: kind as IdKind, local: id.slice(i + 1) };
}

export function kindOf(id: string): IdKind {
  return parseId(id).kind;
}

export function isIdOf<K extends IdKind>(kind: K, id: string): id is Id<K> {
  return id.startsWith(`${kind}:`) && id.length > kind.length + 1;
}

/** zod schema for an id of a given kind. */
export function idSchema<K extends IdKind>(kind: K): z.ZodType<Id<K>, Id<K>> {
  return z.string().refine((s) => isIdOf(kind, s) && !/\s/.test(s), {
    message: `expected ${kind}:<id>`,
  }) as unknown as z.ZodType<Id<K>, Id<K>>;
}

/** Any entity id ("<entityKind>:<id>"). */
export const EntityIdSchema = z.string().refine(
  (s) => {
    const i = s.indexOf(':');
    return i > 0 && isEntityKind(s.slice(0, i)) && i < s.length - 1;
  },
  { message: 'expected <entityKind>:<id>' },
);
export type EntityId = Id<EntityKind>;
