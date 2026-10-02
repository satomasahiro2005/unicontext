import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BrowserSession,
  type BrowserDriver,
  defaultProfileDir,
  type PageLike,
} from '@unicontext/adapter-browser';
import { type ConnectorModule, defineConnector } from '@unicontext/connector-sdk';
import { DEFAULT_TIMEZONE } from '@unicontext/core';
import { TeamsWebAdapter } from './adapter.js';
import { installReadOnlyRoute, PlaywrightTeamsClient } from './client.js';
import { type TeamsWebConfig, TeamsWebConfigSchema } from './config.js';
import { metadata, PRODUCT } from './metadata.js';
import { createTeamsWebNormalizer } from './normalizer.js';
import { CLIENT_READY, call } from './page-scripts.js';

export interface TeamsWebConnectorOptions {
  /** Playwright driver override (tests). */
  driver?: BrowserDriver;
}

/**
 * The browser profile to use: an explicit `browser.profileDir`, else the profile of the source
 * named by `browser.shareProfileWith` (default LiveCampusU, whose SSO already signed the student
 * in to Microsoft), else this source's own profile.
 */
export function resolveProfileDir(
  sourceId: string,
  config: TeamsWebConfig,
  cacheDir: string | undefined,
  profileDefault?: string,
): string {
  if (config.browser.profileDir) return config.browser.profileDir;
  const share = config.browser.shareProfileWith ?? profileDefault ?? 'livecampusu';
  if (share && share !== sourceId) {
    const shared = cacheDir
      ? join(dirname(cacheDir), share, 'browser-profile')
      : defaultProfileDir(share);
    return shared;
  }
  return defaultProfileDir(sourceId, cacheDir);
}

export function createTeamsWebConnector(
  options: TeamsWebConnectorOptions = {},
): ConnectorModule<TeamsWebConfig> {
  return defineConnector<TeamsWebConfig>({
    metadata,
    configSchema: TeamsWebConfigSchema,
    createAdapter(ctx) {
      const cfg = ctx.config;
      const settings = ctx.profile?.products[PRODUCT] as { browserProfile?: unknown } | undefined;
      const profileDir = resolveProfileDir(
        ctx.sourceId,
        cfg,
        ctx.cacheDir,
        typeof settings?.browserProfile === 'string' ? settings.browserProfile : undefined,
      );
      const clientUrl = cfg.clientUrl.replace(/\/+$/, '');
      const isReady = async (page: PageLike): Promise<boolean> => {
        const evaluate = (page as unknown as { evaluate(expr: string): Promise<unknown> }).evaluate;
        if (typeof evaluate !== 'function') return false;
        const r = (await evaluate.call(page, call(CLIENT_READY)).catch(() => undefined)) as
          { ready?: boolean } | undefined;
        return r?.ready === true;
      };
      const session = new BrowserSession({
        sourceId: ctx.sourceId,
        profileDir,
        secrets: ctx.secrets,
        logger: ctx.logger,
        clock: ctx.clock,
        startUrl: `${clientUrl}/_#/`,
        isAuthenticated: isReady,
        // Nothing is exported: the connector reads only inside the page.
        cookieUrls: [],
        launch: { serviceWorkers: 'block', viewport: { width: 1366, height: 900 } },
        prepareContext: (context) => installReadOnlyRoute(context, ctx.logger),
        refreshTimeoutMs: cfg.browser.bootTimeoutMs,
        ...(cfg.browser.loginTimeoutMs ? { timeoutMs: cfg.browser.loginTimeoutMs } : {}),
        ...(options.driver ? { driver: options.driver } : {}),
        ...(cfg.browser.channel ? { channel: cfg.browser.channel } : {}),
        ...(cfg.browser.executablePath ? { executablePath: cfg.browser.executablePath } : {}),
      });
      return new TeamsWebAdapter({
        sourceId: ctx.sourceId,
        config: cfg,
        clock: ctx.clock,
        logger: ctx.logger,
        timezone: ctx.profile?.academicCalendar.timezone ?? DEFAULT_TIMEZONE,
        profileExists: () => existsSync(profileDir),
        withClient: (fn) =>
          session.withPage(
            async (page, context) => {
              const client = new PlaywrightTeamsClient(page, context, {
                clientUrl,
                bootTimeoutMs: cfg.browser.bootTimeoutMs,
                clock: ctx.clock,
                logger: ctx.logger,
              });
              try {
                return await fn(client);
              } finally {
                await client.close();
              }
            },
            { headless: true },
          ),
        login: (o) => session.login(o),
        // Logout forgets nothing shared: the profile may belong to another source.
        logout: () => session.close(),
        close: () => session.close(),
      });
    },
    createNormalizer: () => createTeamsWebNormalizer(),
  });
}

/** Default module (Playwright with an installed Chrome/Edge). */
export const teamsWebConnector: ConnectorModule<TeamsWebConfig> = createTeamsWebConnector();
