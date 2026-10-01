import type { OAuthClientConfig } from '@unicontext/auth';
import { ConfigError, type UniversityProfile } from '@unicontext/core';
import { z } from 'zod';

export const DEFAULT_AUTHORITY = 'https://login.microsoftonline.com';
export const DEFAULT_GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

/** Delegated scopes requested by default (§25). `offline_access openid profile` are always added. */
export const DEFAULT_SCOPES = [
  'User.Read',
  'Calendars.Read',
  'Mail.Read',
  'Files.Read.All',
  'Team.ReadBasic.All',
  'Channel.ReadBasic.All',
] as const;
export const ALWAYS_SCOPES = ['offline_access', 'openid', 'profile'] as const;
/** Needs tenant admin consent; only requested with `resources.channelMessages: true`. */
export const CHANNEL_MESSAGE_SCOPE = 'ChannelMessage.Read.All';

export const ResourcesSchema = z.object({
  calendar: z.boolean().default(true),
  mail: z.boolean().default(true),
  drive: z.boolean().default(true),
  teams: z.boolean().default(true),
  channelMessages: z.boolean().default(false),
});
export type Resources = z.infer<typeof ResourcesSchema>;

export const Microsoft365ConfigSchema = z.object({
  /** Application (client) ID of the user's own Entra app registration (public client). */
  clientId: z.string().min(1).optional(),
  /** Tenant id or verified domain. Default: profile.products.microsoft365.tenant|tenantHint, else "organizations". */
  tenant: z.string().min(1).optional(),
  /** Login authority base URL. */
  authority: z.string().min(1).default(DEFAULT_AUTHORITY),
  graphBaseUrl: z.string().min(1).default(DEFAULT_GRAPH_BASE_URL),
  /** Override the delegated scopes (space/comma separated string or array). */
  scopes: z.union([z.string(), z.array(z.string())]).optional(),
  loginHint: z.string().optional(),
  resources: ResourcesSchema.prefault({}),
  calendar: z
    .object({
      pastDays: z.number().int().nonnegative().default(30),
      futureDays: z.number().int().nonnegative().default(180),
    })
    .prefault({}),
  mail: z
    .object({
      folder: z.string().min(1).default('inbox'),
      /** Cap on messages stored from an initial/full run. */
      maxItems: z.number().int().positive().default(1000),
      /** Initial sync only looks at messages received in the last N days. */
      pastDays: z.number().int().positive().default(90),
    })
    .prefault({}),
  drive: z
    .object({
      /** Cap on drive items stored from an initial/full run. */
      maxItems: z.number().int().positive().default(2000),
    })
    .prefault({}),
});
export type Microsoft365Config = z.infer<typeof Microsoft365ConfigSchema>;

export function resolveTenant(
  config: Microsoft365Config,
  profile: UniversityProfile | undefined,
): string {
  if (config.tenant) return config.tenant;
  const settings = profile?.products['microsoft365'];
  for (const key of ['tenant', 'tenantHint']) {
    const v = settings?.[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return 'organizations';
}

export function resolveScopes(config: Microsoft365Config): string[] {
  const configured =
    typeof config.scopes === 'string'
      ? config.scopes.split(/[\s,]+/)
      : (config.scopes ?? [...DEFAULT_SCOPES]);
  const scopes = new Set<string>(configured.filter((s) => s.length > 0));
  for (const s of ALWAYS_SCOPES) scopes.add(s);
  if (config.resources.channelMessages) scopes.add(CHANNEL_MESSAGE_SCOPE);
  return [...scopes];
}

export function buildOAuthConfig(
  config: Microsoft365Config,
  profile: UniversityProfile | undefined,
): OAuthClientConfig {
  if (!config.clientId)
    throw new ConfigError(
      'microsoft365: clientId is not configured. Register an app in Entra ID (docs/connectors/microsoft365.md) and set sources.<id>.clientId.',
    );
  const base = `${config.authority.replace(/\/+$/, '')}/${encodeURIComponent(resolveTenant(config, profile))}/oauth2/v2.0`;
  return {
    authorizationEndpoint: `${base}/authorize`,
    tokenEndpoint: `${base}/token`,
    clientId: config.clientId,
    scopes: resolveScopes(config),
  };
}
