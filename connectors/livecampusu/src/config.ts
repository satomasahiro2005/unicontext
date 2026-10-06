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
   * Fetch the body (and attachment names) of notices, once, and again when the list row changes.
   * Unread notices are included unless `openUnreadNotices` is false.
   */
  noticeDetails: z.boolean().default(true),
  /**
   * Open notices that are UNREAD in LCU during a sync too, so their content is known (the student's
   * decision: content wins over the unread flag). LCU marks an opened notice read and cannot set it
   * back; UniContext keeps such a notice 未読 until the student reads it in UniContext. Default:
   * `products.livecampusu.openUnreadNotices` of the university profile, else true. False: unread
   * notices are opened only on an explicit request (open_announcement / `announcements open`).
   */
  openUnreadNotices: z.boolean().optional(),
  /**
   * Details per sync run (about 4 requests each at minRequestIntervalMs). The default covers the
   * whole first backfill in one run; progress is checkpointed after every notice.
   */
  maxNoticeDetailsPerRun: z.number().int().nonnegative().default(300),
  /**
   * Of those, unread notices that are neither course-linked (教員連絡 …) nor high importance opened
   * per run (newest first); the rest follow in later syncs. Course and high-importance unread
   * notices are only bounded by maxNoticeDetailsPerRun.
   */
  maxUnreadNoticesPerRun: z.number().int().nonnegative().default(30),
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
