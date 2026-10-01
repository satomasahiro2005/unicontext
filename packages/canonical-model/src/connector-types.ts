import { z } from 'zod';
import { IsoDateTimeSchema } from './common.js';

/** What a source can provide (§5). */
export const CAPABILITIES = [
  'courses',
  'enrollments',
  'assignments',
  'submissions',
  'grades',
  'announcements',
  'messages',
  'materials',
  'calendar',
  'timetable',
  'rooms',
  'exams',
  'lectures',
  'files',
] as const;
export const CapabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof CapabilitySchema>;

/** Connector health (§38). */
export const HEALTH_STATES = [
  'healthy',
  'degraded',
  'auth_required',
  'rate_limited',
  'offline',
  'failed',
] as const;
export const HealthStateSchema = z.enum(HEALTH_STATES);
export type HealthState = z.infer<typeof HealthStateSchema>;

export const HealthStatusSchema = z.object({
  state: HealthStateSchema,
  checkedAt: IsoDateTimeSchema,
  message: z.string().optional(),
  /** Detected product version for unofficial APIs (§72). */
  detectedVersion: z.string().optional(),
  retryAfter: IsoDateTimeSchema.optional(),
  lastSuccessAt: IsoDateTimeSchema.optional(),
  consecutiveFailures: z.number().int().nonnegative().optional(),
});
export type HealthStatus = z.infer<typeof HealthStatusSchema>;
