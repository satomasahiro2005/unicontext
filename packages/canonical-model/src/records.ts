import { z } from 'zod';
import { IsoDateTimeSchema, JsonValueSchema } from './common.js';
import { FactOriginSchema } from './provenance.js';
import { ENTITY_KINDS, EntityIdSchema, idSchema } from './ids.js';

export const ChangeEventTypeSchema = z.enum([
  'created',
  'updated',
  'deleted',
  'restored',
  'conflict_detected',
  'conflict_resolved',
]);
export type ChangeEventType = z.infer<typeof ChangeEventTypeSchema>;

/** Append-only history entry (§13). before/after hold only the changed fields for updates. */
export const ChangeEventSchema = z.object({
  id: idSchema('changeEvent'),
  entityId: EntityIdSchema,
  entityKind: z.enum(ENTITY_KINDS),
  type: ChangeEventTypeSchema,
  changedFields: z.array(z.string()).default([]),
  before: z.record(z.string(), JsonValueSchema).nullable(),
  after: z.record(z.string(), JsonValueSchema).nullable(),
  source: z.object({
    sourceId: z.string().optional(),
    sourceSystem: z.string().optional(),
    rawItemId: z.string().optional(),
  }),
  /** When it happened in the source system (best effort). */
  occurredAt: IsoDateTimeSchema,
  /** When UniContext noticed. */
  observedAt: IsoDateTimeSchema,
  courseOfferingId: idSchema('courseOffering').optional(),
  summary: z.string().optional(),
});
export type ChangeEvent = z.infer<typeof ChangeEventSchema>;

export const TASK_STATUSES = [
  'pending',
  'in_progress',
  'submitted',
  'completed',
  'cancelled',
  'unknown',
] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** §19. status "submitted" is only set by the user or a submission-system fact. */
export const TaskSchema = z.object({
  id: idSchema('task'),
  title: z.string().min(1),
  courseOfferingId: idSchema('courseOffering').optional(),
  assignmentId: idSchema('assignment').optional(),
  examId: idSchema('exam').optional(),
  sourceFactIds: z.array(idSchema('fact')).default([]),
  dueAt: IsoDateTimeSchema.optional(),
  status: TaskStatusSchema,
  createdBy: z.enum(['system', 'user', 'extractor']),
  taskKind: z.enum(['assignment', 'exam_preparation', 'extracted', 'manual']),
  origin: FactOriginSchema,
  /** Who last changed status: user, submission-system, or system defaults. */
  statusSetBy: z.enum(['system', 'user', 'submission-system']).default('system'),
  statusEvidenceFactId: idSchema('fact').optional(),
  evidence: z.string().optional(),
  notes: z.string().optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Task = z.infer<typeof TaskSchema>;

export const IdentityLinkStatusSchema = z.enum(['auto', 'suggested', 'confirmed', 'rejected']);
export type IdentityLinkStatus = z.infer<typeof IdentityLinkStatusSchema>;

/** Pairwise "same real-world thing" decision between two entity ids (§14). */
export const IdentityLinkSchema = z.object({
  id: idSchema('identityLink'),
  entityKind: z.enum(ENTITY_KINDS),
  leftId: EntityIdSchema,
  rightId: EntityIdSchema,
  status: IdentityLinkStatusSchema,
  score: z.number().min(0).max(1),
  method: z.string(),
  evidence: z.array(z.string()).default([]),
  decidedBy: z.enum(['system', 'user']),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type IdentityLink = z.infer<typeof IdentityLinkSchema>;
