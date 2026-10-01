import { z } from 'zod';
import { DeploymentSettingsSchema } from '../profiles/index.js';

export const CANCELLATION_TYPE = 'lcu.publicCancellation';
/** Key under `profile.products` for this connector's deployment settings. */
export const CANCELLATIONS_PRODUCT = 'lcu-public-cancellations';

/** A course of the user (usually fed from the LCU timetable). */
export const UserCourseSchema = z.object({
  title: z.string().min(1),
  /** Class label as printed on the cancellation page (e.g. "情", "理２"), optional. */
  classCode: z.string().optional(),
});
export type UserCourse = z.infer<typeof UserCourseSchema>;

export const CancellationsConfigSchema = DeploymentSettingsSchema.extend({
  /** The user's courses: only matching rows become cancelled class sessions. */
  courses: z.array(UserCourseSchema).default([]),
  /** Minimum titleSimilarity (0..1) between page title and user course title. */
  matchThreshold: z.number().min(0).max(1).default(0.85),
});
export type CancellationsConfig = z.infer<typeof CancellationsConfigSchema>;

/** Raw type `lcu.publicCancellation`: one row of the whole-university 休講 table. */
export const CancellationPayloadSchema = z.object({
  /** The 授業科目 cell as printed. */
  title: z.string(),
  courseTitle: z.string(),
  className: z.string().optional(),
  /** "MM/DD" as printed (no year on the page). */
  dateText: z.string(),
  /** Date with the year inferred from the page's "as of" footer. */
  date: z.string(),
  /** 時限 as printed, e.g. "3・4". */
  period: z.string(),
  /** 90-minute period index (1・2 -> 1 ...). */
  periodIndex: z.number().int().optional(),
  instructors: z.array(z.string()),
  /** Present when the row is one of the user's courses. */
  matched: z.object({ title: z.string(), classCode: z.string().optional() }).optional(),
  url: z.string(),
});
export type CancellationPayload = z.infer<typeof CancellationPayloadSchema>;
