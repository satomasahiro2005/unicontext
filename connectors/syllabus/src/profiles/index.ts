import { ConfigError } from '@unicontext/core';
import { z } from 'zod';
import { getDeployment } from './registry.js';
import type { LcuDeployment, LcuScreens, TitleCodes } from './types.js';

export type { LcuDeployment, LcuScreens, TitleCodes } from './types.js';
export { shizuokaDeployment } from './shizuoka.js';
export { DEPLOYMENTS, getDeployment, registerDeployment } from './registry.js';

/** Deployment-related keys accepted in connector config and in `profile.products[<product>]`. */
export const DeploymentSettingsSchema = z.object({
  /** Name of a built-in deployment profile, e.g. "shizuoka". */
  deployment: z.string().optional(),
  baseUrl: z.string().url().optional(),
  screens: z
    .object({
      syllabusSearch: z.string().optional(),
      syllabusDetail: z.string().optional(),
      publicCancellations: z.string().optional(),
    })
    .optional(),
  titles: z.record(z.string(), z.record(z.string(), z.string())).optional(),
});
export type DeploymentSettings = z.infer<typeof DeploymentSettingsSchema>;

function ensureSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/**
 * Merge deployment settings: explicit config > profile product settings > named deployment.
 * Product code never contains a university: the base URL and screen ids must come from one of
 * the three sources, otherwise the connector refuses to start.
 */
export function resolveDeployment(
  config: DeploymentSettings,
  profileSettings: Record<string, unknown> | undefined,
  options: { requireScreens: (keyof LcuScreens)[] },
): LcuDeployment {
  const fromProfile = DeploymentSettingsSchema.safeParse(profileSettings ?? {});
  if (!fromProfile.success)
    throw new ConfigError(
      `Invalid deployment settings in the profile: ${fromProfile.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  const profile = fromProfile.data;
  const name = config.deployment ?? profile.deployment;
  const named = name ? getDeployment(name) : undefined;
  if (name && !named) throw new ConfigError(`Unknown deployment "${name}"`);

  const baseUrl = config.baseUrl ?? profile.baseUrl ?? named?.baseUrl;
  if (!baseUrl)
    throw new ConfigError(
      'No LiveCampusU base URL: set `baseUrl` (or `deployment`) in the source config or the profile product settings',
    );
  const screens: Partial<LcuScreens> = {
    ...(named?.screens ?? {}),
    ...(profile.screens ?? {}),
    ...(config.screens ?? {}),
  };
  for (const key of options.requireScreens)
    if (!screens[key])
      throw new ConfigError(`No LiveCampusU screen id for "${key}" (set \`screens.${key}\`)`);
  const titles: TitleCodes = { ...(named?.titles ?? {}) };
  for (const source of [profile.titles, config.titles])
    for (const [year, codes] of Object.entries(source ?? {}))
      titles[year] = { ...(titles[year] ?? {}), ...codes };
  return {
    id: name ?? 'custom',
    baseUrl: ensureSlash(baseUrl),
    screens: {
      syllabusSearch: screens.syllabusSearch ?? '',
      syllabusDetail: screens.syllabusDetail ?? '',
      publicCancellations: screens.publicCancellations ?? '',
    },
    titles,
  };
}
