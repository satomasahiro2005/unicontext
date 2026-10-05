import { ConfigError } from '@unicontext/core';
import { z } from 'zod';

/**
 * A walk root: one Ivanti file bookmark (Windows SMB share) and the share-relative directory the
 * crawl starts from. Resource ids are deployment facts (they change per appliance / per year for
 * the `fs home` shares), so they live in the profile, never in code.
 */
export const VpnRootSchema = z.object({
  /** Stable key used in ids and config (`roots[].key`), e.g. "fs-share". */
  key: z.string().min(1),
  /** Display name of the bookmark, e.g. "FS share". */
  label: z.string().min(1),
  /** Ivanti resource id, e.g. "resource_1423533946.487706.3". */
  resourceId: z.string().min(1),
  /** Bookmark name passed to the fb API as `bmname`. */
  bookmark: z.string().min(1),
  /** `bmtype` (1 = system file bookmark). */
  bmtype: z.number().int().default(1),
  /** Share-relative directory the walk starts at ('' = the share root). */
  startDir: z.string().default(''),
  /** Enabled by default. */
  enabled: z.boolean().default(true),
});
export type VpnRoot = z.infer<typeof VpnRootSchema>;
export type VpnRootInput = z.input<typeof VpnRootSchema>;

export const VpnDeploymentSchema = z.object({
  id: z.string(),
  name: z.string(),
  profileIds: z.array(z.string()).default([]),
  /** Portal origin (no trailing slash). */
  origin: z.string().url(),
  /** Page that lands on the portal when signed in and redirects to the login form otherwise. */
  startPath: z.string().default('/dana/home/index.cgi'),
  /** Realm/role path segment of the sign-in URL (`/dana-na/auth/<realm>/welcome.cgi`). */
  realmPath: z.string().default('url_3'),
  /** fb list / download endpoint paths. */
  listPath: z.string().default('/api/v1/fb/list'),
  listSharesPath: z.string().default('/api/v1/fb/list-shares'),
  /** Ivanti SMB download CGI (`$value`). Exact params are reconstructed by the client. */
  downloadPath: z.string().default('/dana/fb/smb/wfd.cgi'),
  roots: z.array(VpnRootSchema).min(1),
});
export type VpnDeployment = z.infer<typeof VpnDeploymentSchema>;
export type VpnDeploymentInput = z.input<typeof VpnDeploymentSchema>;

/**
 * 静岡大学 情報学部 SSL-VPN ポータル (Ivanti Connect Secure, https://vpn.inf.shizuoka.ac.jp).
 * Source: docs/research/shizuoka-vpn-files.md (observed 2026-10-05). The resource id and bookmark
 * are the observed "FS share"; the `fs home` shares (per admission year) are not enabled by default
 * because their resource ids were not captured and they hold personal data.
 */
export const SHIZUOKA_VPN_DEPLOYMENT: VpnDeploymentInput = {
  id: 'shizuoka',
  name: '静岡大学 情報学部 ファイル共有 (VPN)',
  profileIds: ['shizuoka-university'],
  origin: 'https://vpn.inf.shizuoka.ac.jp',
  startPath: '/dana/home/index.cgi',
  realmPath: 'url_3',
  roots: [
    {
      key: 'fs-share',
      label: 'FS share',
      resourceId: 'resource_1423533946.487706.3',
      bookmark: 'FS share',
      bmtype: 1,
      // Start at the share root so `class` and the (403) report/student/submit roots are recorded.
      startDir: '',
      enabled: true,
    },
  ],
};

const DEPLOYMENTS: Record<string, VpnDeploymentInput> = {
  shizuoka: SHIZUOKA_VPN_DEPLOYMENT,
};

/**
 * Resolve the deployment: a built-in id (`deployment: shizuoka`) merged with/overridden by any
 * fields given in `profile.products['shizuoka-vpn-files']`.
 */
export function resolveDeployment(settings: Record<string, unknown> | undefined): VpnDeployment {
  const raw = { ...(settings ?? {}) } as Record<string, unknown>;
  const base = typeof raw.deployment === 'string' ? DEPLOYMENTS[raw.deployment] : undefined;
  if (typeof raw.deployment === 'string' && !base)
    throw new ConfigError(`unknown shizuoka-vpn-files deployment "${String(raw.deployment)}"`);
  delete raw.deployment;
  const merged: Record<string, unknown> = { ...(base ?? {}), ...raw };
  // Roots given in the profile replace the built-in list entirely (a deployment may differ).
  const parsed = VpnDeploymentSchema.safeParse(merged);
  if (!parsed.success)
    throw new ConfigError(`invalid shizuoka-vpn-files deployment: ${parsed.error.message}`);
  return parsed.data;
}
