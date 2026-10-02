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
  /**
   * Fetch the body (and attachment names) of every notice that is READ in LCU, once, and again when
   * its list row changes. Unread notices are never opened: opening marks them read and LCU cannot
   * set a notice back to unread. Their bodies are fetched after the student reads them in LCU.
   */
  noticeDetails: z.boolean().default(true),
  /**
   * Details per sync run (about 4 requests each at minRequestIntervalMs). The default covers the
   * whole first backfill in one run; progress is checkpointed after every notice.
   */
  maxNoticeDetailsPerRun: z.number().int().nonnegative().default(300),
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
