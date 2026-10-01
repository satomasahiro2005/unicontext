import { z } from 'zod';
import { IsoDateTimeSchema, JsonValueSchema } from './common.js';
import { EntityIdSchema, idSchema } from './ids.js';

/**
 * Where a fact came from (§11).
 * - authoritative: an external system states it directly
 * - user: entered/corrected by the student (§74)
 * - extracted: pulled out of text (rules or LLM)
 * - inferred: derived from several pieces of information; never promoted to authoritative
 */
export const FACT_ORIGINS = ['authoritative', 'user', 'extracted', 'inferred'] as const;
export const FactOriginSchema = z.enum(FACT_ORIGINS);
export type FactOrigin = z.infer<typeof FactOriginSchema>;

/**
 * Authority classes used by conflict rules (§12). Free-form strings are allowed; these are the
 * well-known ones shipped in the default rules.
 */
export const KNOWN_AUTHORITIES = [
  'user',
  'academic-system',
  'submission-system',
  'instructor-announcement',
  'syllabus',
  'lms',
  'calendar',
  'collaboration',
  'discussion',
  'transcript',
  'local-file',
  'unknown',
] as const;
export type KnownAuthority = (typeof KNOWN_AUTHORITIES)[number];

export const SourceLocationSchema = z.object({
  page: z.number().int().positive().optional(),
  /** "HH:MM:SS" into a recording (§10: 講義録音の 00:42:18). */
  timestamp: z.string().optional(),
  timestampMs: z.number().int().nonnegative().optional(),
  messageId: z.string().optional(),
  line: z.number().int().positive().optional(),
  selector: z.string().optional(),
});
export type SourceLocation = z.infer<typeof SourceLocationSchema>;

/** Pointer back to the exact place a piece of information came from (§10, §49). */
export const SourceReferenceSchema = z.object({
  id: idSchema('sourceReference'),
  /** Product/system, e.g. "livecampusu", "microsoft365". */
  sourceSystem: z.string().min(1),
  /** Configured source instance id (key under config `sources:`). */
  sourceId: z.string().optional(),
  /** Display name for citations, e.g. "学務情報システム". */
  sourceLabel: z.string().optional(),
  /** Authority class for conflict rules, e.g. "academic-system". */
  authority: z.string().default('unknown'),
  /** Id of the item in the external system (e.g. Teams message id). */
  sourceItemId: z.string().min(1),
  url: z.string().optional(),
  retrievedAt: IsoDateTimeSchema,
  rawItemId: z.string().optional(),
  location: SourceLocationSchema.optional(),
  /** Entity this reference supports, if any. */
  entityId: EntityIdSchema.optional(),
});
export type SourceReference = z.infer<typeof SourceReferenceSchema>;
export type SourceReferenceInput = z.input<typeof SourceReferenceSchema>;

export const ProducerSchema = z.object({
  type: z.enum(['connector', 'user', 'ai', 'rule']),
  id: z.string().min(1),
});
export type Producer = z.infer<typeof ProducerSchema>;

/**
 * An atomic claim about an entity (§9). Contradicting facts coexist; the conflict resolver
 * decides what to present.
 */
export const FactSchema = z
  .object({
    id: idSchema('fact'),
    subject: EntityIdSchema,
    predicate: z.string().min(1),
    value: JsonValueSchema,
    origin: FactOriginSchema,
    confidence: z.number().min(0).max(1),
    observedAt: IsoDateTimeSchema,
    validFrom: IsoDateTimeSchema.optional(),
    validUntil: IsoDateTimeSchema.optional(),
    sourceReferenceId: idSchema('sourceReference'),
    producer: ProducerSchema,
    /** Supporting text (e.g. the sentence a deadline was extracted from). */
    evidence: z.string().optional(),
    retractedAt: IsoDateTimeSchema.optional(),
  })
  .superRefine((f, ctx) => {
    if (f.producer.type === 'ai' && f.origin !== 'extracted' && f.origin !== 'inferred') {
      ctx.addIssue({
        code: 'custom',
        path: ['origin'],
        message: 'AI-produced facts must be extracted or inferred (§48)',
      });
    }
    if ((f.origin === 'user') !== (f.producer.type === 'user')) {
      ctx.addIssue({
        code: 'custom',
        path: ['origin'],
        message: 'origin "user" requires producer.type "user" and vice versa',
      });
    }
  });
export type Fact = z.infer<typeof FactSchema>;

export const ConflictCandidateSchema = z.object({
  factId: idSchema('fact'),
  value: JsonValueSchema,
  origin: FactOriginSchema,
  authority: z.string(),
  sourceSystem: z.string(),
  sourceLabel: z.string().optional(),
  observedAt: IsoDateTimeSchema,
});
export type ConflictCandidate = z.infer<typeof ConflictCandidateSchema>;

export const ConflictStatusSchema = z.enum(['open', 'resolved', 'dismissed']);
export type ConflictStatus = z.infer<typeof ConflictStatusSchema>;

/** Unresolvable disagreement between facts, passed to the AI as-is (§12). */
export const ConflictSchema = z.object({
  id: idSchema('conflict'),
  subject: EntityIdSchema,
  predicate: z.string(),
  status: ConflictStatusSchema,
  candidates: z.array(ConflictCandidateSchema).min(2),
  detectedAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.optional(),
  resolution: z
    .object({
      factId: idSchema('fact').optional(),
      method: z.enum(['user', 'authority', 'recency', 'superseded']),
    })
    .optional(),
  reason: z.string().optional(),
});
export type Conflict = z.infer<typeof ConflictSchema>;
