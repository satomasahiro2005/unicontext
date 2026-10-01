import { ConfigError } from '@unicontext/core';
import { z } from 'zod';
import { shizuokaPortal } from './shizuoka.js';
import type { PortalDeployment } from './types.js';

export type { PortalDeployment } from './types.js';
export { shizuokaPortal } from './shizuoka.js';

/** Built-in portal deployments, selected by `deployment: <id>`. */
export const PORTAL_DEPLOYMENTS: Map<string, PortalDeployment> = new Map([
  [shizuokaPortal.id, shizuokaPortal],
]);

export function registerPortalDeployment(deployment: PortalDeployment): void {
  PORTAL_DEPLOYMENTS.set(deployment.id, deployment);
}

/** Keys accepted in config and in `profile.products['wordpress-portal']`. */
export const PortalSettingsSchema = z.object({
  deployment: z.string().optional(),
  baseUrl: z.string().url().optional(),
  label: z.string().optional(),
});
export type PortalSettings = z.infer<typeof PortalSettingsSchema>;

export interface ResolvedPortal {
  id: string;
  /** Site root with a trailing slash. */
  baseUrl: string;
  /** `<baseUrl>wp-json/wp/v2/` */
  restBase: string;
  label: string | undefined;
}

/** Merge settings: explicit config > profile product settings > named deployment. */
export function resolvePortal(
  config: PortalSettings,
  profileSettings: Record<string, unknown> | undefined,
): ResolvedPortal {
  const fromProfile = PortalSettingsSchema.safeParse(profileSettings ?? {});
  if (!fromProfile.success)
    throw new ConfigError(
      `Invalid portal settings in the profile: ${fromProfile.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  const profile = fromProfile.data;
  const name = config.deployment ?? profile.deployment;
  const named = name ? PORTAL_DEPLOYMENTS.get(name) : undefined;
  if (name && !named) throw new ConfigError(`Unknown deployment "${name}"`);
  const baseUrl = config.baseUrl ?? profile.baseUrl ?? named?.baseUrl;
  if (!baseUrl)
    throw new ConfigError(
      'No WordPress base URL: set `baseUrl` (or `deployment`) in the source config or the profile product settings',
    );
  const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return {
    id: name ?? 'custom',
    baseUrl: root,
    restBase: `${root}wp-json/wp/v2/`,
    label: config.label ?? profile.label ?? named?.label,
  };
}
