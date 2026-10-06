import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BrowserSession,
  type BrowserDriver,
  defaultProfileDir,
  type PageLike,
} from '@unicontext/adapter-browser';
import { type ConnectorModule, defineConnector } from '@unicontext/connector-sdk';
import { DEFAULT_TIMEZONE } from '@unicontext/core';
import {
  type SessionMarker,
  ShizuokaVpnFilesAdapter,
  type WithClient,
} from './adapter.js';
import { installReadOnlyRoute, PlaywrightVpnClient } from './client.js';
import { type ShizuokaVpnFilesConfig, ShizuokaVpnFilesConfigSchema } from './config.js';
import { resolveDeployment, signInUrl, type VpnDeployment } from './deployment.js';
import { metadata, PRODUCT } from './metadata.js';
import { createShizuokaVpnFilesNormalizer } from './normalizer.js';
import { call, SESSION_CHECK } from './page-scripts.js';

export interface ShizuokaVpnFilesConnectorOptions {
  /** Playwright driver override (tests). */
  driver?: BrowserDriver;
}

/**
 * A page that can only be shown inside a signed-in portal session (home page, /files, …). Not:
 * the pre-authentication area `/dana-na/…` (sign-in form, `login.cgi`, the "other sessions in
 * progress" prompt), the static `/dana-cached/…`, and the bare root `/` — signed out,
 * `/dana/home/index.cgi` redirects to `/dana-na/auth/welcome.cgi`, which redirects to `/`, a 404
 * page. The URL alone is never proof of a session: see {@link portalSessionLive}.
 */
export function onPortal(deployment: VpnDeployment, url: string): boolean {
  try {
    const u = new URL(url);
    const portal = new URL(deployment.origin);
    if (u.host !== portal.host) return false;
    if (u.pathname === '/' || u.pathname === '') return false;
    return !/^\/dana-(?:na|cached)\//i.test(u.pathname);
  } catch {
    return false;
  }
}

interface Evaluable {
  evaluate(expression: string): Promise<unknown>;
}

/** Ask the portal itself (same-origin GET of the landing-page JSON) whether the session is live. */
export async function portalSessionLive(page: PageLike, deployment: VpnDeployment): Promise<boolean> {
  if (!onPortal(deployment, page.url())) return false;
  const r = (await (page as unknown as Evaluable).evaluate(
    call(SESSION_CHECK, { url: deployment.sessionCheckPath }),
  )) as { live?: boolean } | undefined;
  return r?.live === true;
}

/** `<cacheDir>/portal-session.json`: when a live portal session was last verified (no secrets). */
export function fileSessionMarker(file: string): SessionMarker {
  return {
    read() {
      try {
        const v = JSON.parse(readFileSync(file, 'utf8')) as { verifiedAt?: unknown };
        return typeof v.verifiedAt === 'string' ? v.verifiedAt : undefined;
      } catch {
        return undefined;
      }
    },
    write(at) {
      try {
        if (at === undefined) rmSync(file, { force: true });
        else {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, `${JSON.stringify({ verifiedAt: at })}\n`);
        }
      } catch {
        // best effort: a lost marker only means one more check
      }
    },
  };
}

export function createShizuokaVpnFilesConnector(
  options: ShizuokaVpnFilesConnectorOptions = {},
): ConnectorModule<ShizuokaVpnFilesConfig> {
  return defineConnector<ShizuokaVpnFilesConfig>({
    metadata,
    configSchema: ShizuokaVpnFilesConfigSchema,
    createAdapter(ctx) {
      const cfg = ctx.config;
      const settings = ctx.profile?.products[PRODUCT] as Record<string, unknown> | undefined;
      const deployment = resolveDeployment(settings);
      // A dedicated profile: never shared with LiveCampusU/Teams (different host and session).
      const profileDir = cfg.browser.profileDir ?? defaultProfileDir(ctx.sourceId, ctx.cacheDir);
      const startUrl = `${deployment.origin}${deployment.startPath}`;
      const isAuthenticated = (page: PageLike): Promise<boolean> =>
        portalSessionLive(page, deployment);
      const session = new BrowserSession({
        sourceId: ctx.sourceId,
        profileDir,
        secrets: ctx.secrets,
        logger: ctx.logger,
        clock: ctx.clock,
        startUrl,
        // Signed out, the start page ends on the portal's 404 root: go to the realm's sign-in form
        // (the human signs in there; a headless run sees the password field and stops).
        begin: async (page) => {
          if (!/^\/dana-na\/auth\//i.test(pathOf(page.url())))
            await page.goto(signInUrl(deployment), { waitUntil: 'load' });
        },
        isAuthenticated,
        // Read inside the page only: never export the (HttpOnly) DSID cookie out of the browser.
        cookieUrls: [],
        // DSID has no expiry: without this, Chrome drops it when the sign-in window closes and
        // every later (headless) run would be signed out. It stays in the profile's cookie store.
        keepSessionCookies: true,
        launch: { serviceWorkers: 'block', viewport: { width: 1366, height: 900 } },
        prepareContext: (context) => installReadOnlyRoute(context, deployment.origin, ctx.logger),
        refreshTimeoutMs: cfg.browser.bootTimeoutMs,
        ...(cfg.browser.loginTimeoutMs ? { timeoutMs: cfg.browser.loginTimeoutMs } : {}),
        ...(options.driver ? { driver: options.driver } : {}),
        ...(cfg.browser.channel ? { channel: cfg.browser.channel } : {}),
        ...(cfg.browser.executablePath ? { executablePath: cfg.browser.executablePath } : {}),
      });
      const withClient: WithClient = (fn, o) =>
        session.withPage(
          (page) => fn(new PlaywrightVpnClient(page, deployment, ctx.logger)),
          { headless: true, ...(o?.startUrl ? { url: o.startUrl } : {}) },
        );
      return new ShizuokaVpnFilesAdapter({
        sourceId: ctx.sourceId,
        config: cfg,
        deployment,
        clock: ctx.clock,
        logger: ctx.logger,
        timezone: ctx.profile?.academicCalendar.timezone ?? DEFAULT_TIMEZONE,
        profileExists: () => existsSync(profileDir),
        profileInUse: () => session.profileInUse(),
        verifySession: () => session.refresh(),
        sessionMarker: fileSessionMarker(
          join(ctx.cacheDir ?? dirname(profileDir), 'portal-session.json'),
        ),
        withClient,
        login: (o) => session.login(o),
        logout: () => session.close(),
        close: () => session.close(),
      });
    },
    createNormalizer: () => createShizuokaVpnFilesNormalizer(),
  });
}

/** Default module (Playwright with an installed Chrome/Edge). */
export const shizuokaVpnFilesConnector: ConnectorModule<ShizuokaVpnFilesConfig> =
  createShizuokaVpnFilesConnector();

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}
