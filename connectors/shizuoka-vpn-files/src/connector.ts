import { existsSync } from 'node:fs';
import {
  BrowserSession,
  type BrowserDriver,
  defaultProfileDir,
  type PageLike,
} from '@unicontext/adapter-browser';
import { type ConnectorModule, defineConnector } from '@unicontext/connector-sdk';
import { DEFAULT_TIMEZONE } from '@unicontext/core';
import {
  ShizuokaVpnFilesAdapter,
  type WithClient,
} from './adapter.js';
import { installReadOnlyRoute, PlaywrightVpnClient } from './client.js';
import { type ShizuokaVpnFilesConfig, ShizuokaVpnFilesConfigSchema } from './config.js';
import { resolveDeployment, type VpnDeployment } from './deployment.js';
import { metadata, PRODUCT } from './metadata.js';
import { createShizuokaVpnFilesNormalizer } from './normalizer.js';

export interface ShizuokaVpnFilesConnectorOptions {
  /** Playwright driver override (tests). */
  driver?: BrowserDriver;
}

/** A signed-in portal page (not the Ivanti sign-in form). */
export function onPortal(deployment: VpnDeployment, url: string): boolean {
  try {
    const u = new URL(url);
    const portal = new URL(deployment.origin);
    if (u.host !== portal.host) return false;
    // The sign-in form lives under /dana-na/auth/<realm>/welcome.cgi; anything else on the portal
    // host (the home page, /files, the fb API) means the session is live.
    return !/^\/dana-na\/auth\//i.test(u.pathname);
  } catch {
    return false;
  }
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
      const isAuthenticated = (page: PageLike): boolean => onPortal(deployment, page.url());
      const session = new BrowserSession({
        sourceId: ctx.sourceId,
        profileDir,
        secrets: ctx.secrets,
        logger: ctx.logger,
        clock: ctx.clock,
        startUrl,
        isAuthenticated,
        // Read inside the page only: never export the (HttpOnly) DSID cookie out of the browser.
        cookieUrls: [],
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
