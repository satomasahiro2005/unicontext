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
  /**
   * An unfinished assignment of a term that has ended (or of a past academic year). Derived by the
   * task engine, never set by a user or an AI, and never a value of a source system's own
   * submission status (Teams' / LMS' stay on the submission entity untouched).
   */
  'expired_past_term',
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
  taskKind: z.enum(['assignment', 'exam_preparation', 'extracted', 'manual', 'weekly_pace']),
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

/** What an AI client wrote into UniContext through an MCP write tool, and what became of it. */
export const ADDITION_TOOLS = ['record_lecture', 'add_deadline', 'add_note', 'add_task'] as const;
export type AdditionTool = (typeof ADDITION_TOOLS)[number];
export const ADDITION_KINDS = [
  'lecture',
  'assignment',
  'report',
  'quiz',
  'exam',
  'prep',
  'note',
  'task',
] as const;
export type AdditionKind = (typeof ADDITION_KINDS)[number];
/** unconfirmed → confirmed (owner, becomes user facts) | rejected (owner) | retracted (the client). */
export const ADDITION_STATUSES = ['unconfirmed', 'confirmed', 'rejected', 'retracted'] as const;
export type AdditionStatus = (typeof ADDITION_STATUSES)[number];

export const AdditionSchema = z.object({
  id: idSchema('addition'),
  /** OAuth client id (remote) or `local:<client name>` (stdio / local HTTP). */
  clientId: z.string().min(1),
  clientName: z.string().optional(),
  tool: z.enum(ADDITION_TOOLS),
  kind: z.enum(ADDITION_KINDS),
  status: z.enum(ADDITION_STATUSES),
  courseOfferingId: idSchema('courseOffering').optional(),
  title: z.string().min(1),
  dueAt: IsoDateTimeSchema.optional(),
  /** course + normalized title (+ kind group): additions with the same key and a close due date are one item. */
  dedupeKey: z.string().optional(),
  idempotencyKey: z.string().optional(),
  sourceReferenceId: idSchema('sourceReference').optional(),
  /** Entities this addition created (its own) or attached facts to (someone else's). */
  entityIds: z.array(EntityIdSchema).default([]),
  /** Entities it created itself (removed again on reject/retract). */
  ownEntityIds: z.array(EntityIdSchema).default([]),
  factIds: z.array(idSchema('fact')).default([]),
  /** What was stored, as echoed back to the client (no secrets; the text the client sent). */
  data: z.record(z.string(), JsonValueSchema).default({}),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  decidedAt: IsoDateTimeSchema.optional(),
});
export type Addition = z.infer<typeof AdditionSchema>;
