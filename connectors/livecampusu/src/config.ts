import { z } from 'zod';

/** `sources.<id>` config of the LiveCampusU connector (§53). Unknown keys pass through. */
export const LiveCampusUConfigSchema = z.looseObject({
  /** Deployment profile key (e.g. "shizuoka"); defaults to profile.products.livecampusu.deployment. */
  deployment: z.string().optional(),
  /** Auth strategy: saml / entra / browser-sso → browser-sso; local → local-account (stub). */
  auth: z.enum(['saml', 'entra', 'browser-sso', 'local']).optional(),
  /** Only with auth: local — documents the (unimplemented) local-account extension point. */
  allowLocalAccount: z.boolean().optional(),
  /** Per-key deployment overrides (see DEPLOYMENT_OVERRIDE_KEYS). */
  baseUrl: z.string().url().optional(),
  idpHosts: z.array(z.string()).optional(),
  maintenanceWindow: z.string().optional(),
  idleTimeoutMinutes: z.number().positive().optional(),
  /** Academic year to read (default: current academic year, April start). */
  academicYear: z.number().int().optional(),
  /** Semester codes (default: every semester of the deployment). */
  semesters: z.array(z.string()).optional(),
  /** Grades are personal and sensitive: opt-in. */
  grades: z.boolean().default(false),
  attendance: z.boolean().default(true),
  /** Fetch bodies of READ notices whose list row changed (unread notices are never opened). */
  noticeDetails: z.boolean().default(true),
  maxNoticeDetailsPerRun: z.number().int().nonnegative().default(20),
  /** Minimum gap between two requests to LCU, in ms (politeness). */
  minRequestIntervalMs: z.number().int().nonnegative().default(1000),
  browser: z
    .object({
      channel: z.string().optional(),
      executablePath: z.string().optional(),
      profileDir: z.string().optional(),
      loginTimeoutMs: z.number().int().positive().optional(),
      refreshTimeoutMs: z.number().int().positive().optional(),
    })
    .optional(),
});
export type LiveCampusUConfig = z.infer<typeof LiveCampusUConfigSchema>;
