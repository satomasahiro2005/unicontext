import { z } from 'zod';

/**
 * Source config (`sources.teams-web` in config.yaml, merged over the profile entry). Every limit
 * here keeps the run polite: one channel at a time, short pauses, a bounded number of channels.
 */
export const TeamsWebConfigSchema = z.looseObject({
  /** Teams web client origin. */
  clientUrl: z.string().url().default('https://teams.cloud.microsoft'),
  /** Channels opened per run (changed channels first, then a slow round-robin). */
  maxChannelsPerRun: z.number().int().positive().max(200).default(12),
  /** Unchanged channels revisited per run to pick up edits and deletions. */
  revisitPerRun: z.number().int().nonnegative().max(50).default(2),
  /** Pause after each channel (ms), plus up to 50% random jitter. */
  channelDelayMs: z.number().int().nonnegative().default(2500),
  /** Times the post list is scrolled up per channel to load older posts. */
  scrollPages: z.number().int().nonnegative().max(20).default(2),
  /** Wait for the client to settle after opening a channel (ms). */
  settleMs: z.number().int().positive().default(4000),
  /** Read the Assignments (課題) app. */
  assignments: z.boolean().default(true),
  /** Include teams that are not class teams (labs, groups). Their posts are kept without a course. */
  includeNonClassTeams: z.boolean().default(true),
  files: z
    .object({
      enabled: z.boolean().default(true),
      /** Opt-in: download PDF/DOCX/PPTX in the page and extract text (size-capped). */
      extractText: z.boolean().default(false),
      maxExtractBytes: z
        .number()
        .int()
        .positive()
        .default(15 * 1024 * 1024),
      extractExtensions: z.array(z.string()).default(['pdf', 'docx', 'pptx']),
      /** Files extracted per run (the rest wait for later runs). */
      maxExtractPerRun: z.number().int().nonnegative().default(10),
      /** Local hours (profile timezone) in which the daily full file listing runs. */
      fullListingHours: z
        .tuple([z.number().int().min(0).max(23), z.number().int().min(1).max(24)])
        .default([2, 6]),
    })
    .prefault({}),
  browser: z
    .object({
      /**
       * Reuse another source's persistent browser profile. Default: the profile's
       * `products.teams-web.browserProfile`, else `livecampusu` (its SSO already signed the student
       * in to Microsoft). Set `profileDir` to use a fixed path.
       */
      shareProfileWith: z.string().optional(),
      profileDir: z.string().optional(),
      channel: z.string().optional(),
      executablePath: z.string().optional(),
      /** Max time to wait for the Teams client to boot (ms). */
      bootTimeoutMs: z.number().int().positive().default(90_000),
      loginTimeoutMs: z.number().int().positive().optional(),
    })
    .prefault({}),
});
export type TeamsWebConfig = z.infer<typeof TeamsWebConfigSchema>;
