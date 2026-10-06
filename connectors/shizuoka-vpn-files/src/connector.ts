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
import {
  describeChecks,
  installReadOnlyRoute,
  onPortalHost,
  PlaywrightVpnClient,
  probePortalSession,
} from './client.js';
import { type ShizuokaVpnFilesConfig, ShizuokaVpnFilesConfigSchema } from './config.js';
import { resolveDeployment, signInUrl, type VpnDeployment } from './deployment.js';
import { metadata, PRODUCT } from './metadata.js';
import { createShizuokaVpnFilesNormalizer } from './normalizer.js';

export interface ShizuokaVpnFilesConnectorOptions {
  /** Playwright driver override (tests). */
  driver?: BrowserDriver;
  /** How often an interactive sign-in says what it is waiting on (tests; default 15 s). */
  notifyIntervalMs?: number;
}

/** What the sign-in window says when the student has to press the portal's own button. */
export const CONTINUE_NOTICE = '画面の「続行」を押してください';

/** Minimum gap between two session probes from the same page path. */
const PROBE_GAP_MS = 2_000;

/**
 * The URL alone says a page *might* be inside a signed-in portal session (home page, /files, …):
 * not the pre-authentication area `/dana-na/…`, the static `/dana-cached/…`, or the bare root `/`
 * (signed out, `/dana/home/index.cgi` redirects to `/dana-na/auth/welcome.cgi`, then to `/`, a 404
 * page). It is only a shortcut and NEVER a gate: after sign-in the tab may well stay on
 * `/dana-na/auth/url_3/login.cgi` while the session is live (observed 2026-10-06), so
 * {@link portalSessionLive} asks the portal on every page of the portal host.
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

/** True when the portal confirms the session (see {@link probePortalSession}). */
export async function portalSessionLive(page: PageLike, deployment: VpnDeployment): Promise<boolean> {
  return (await probePortalSession(page, deployment)).live;
}

/**
 * Ivanti's "other user sessions in progress" / sign-in notice has a Continue button (and a hidden
 * FormDataStr). Looked for by field name only; nothing here ever fills or presses it.
 */
export async function hasContinuePrompt(page: PageLike): Promise<boolean> {
  try {
    for (const sel of ['input[name="btnContinue"]', 'input[name="FormDataStr"]'])
      if ((await page.locator(sel).count()) > 0) return true;
  } catch {
    // a page in transition: not now
  }
  return false;
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
      // Said to the student during an interactive sign-in only (the notify line and the info log).
      const blocked = { count: 0 };
      let interactive = false;
      let lastSummary: string | undefined;
      let lastNotLive: { path: string; at: number } | undefined;
      const isAuthenticated = async (page: PageLike): Promise<boolean> => {
        const url = page.url();
        if (!onPortalHost(deployment, url)) return false;
        const path = pathOf(url);
        // Polled every second: do not send two or three probes a second while the student is
        // still typing on the same sign-in page.
        if (lastNotLive && lastNotLive.path === path && Date.now() - lastNotLive.at < PROBE_GAP_MS)
          return false;
        const probe = await probePortalSession(page, deployment);
        lastSummary = describeChecks(probe.checks);
        lastNotLive = probe.live ? undefined : { path, at: Date.now() };
        return probe.live;
      };
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
        describe: async (page) => {
          const parts: string[] = [];
          if (lastSummary) parts.push(`確認: ${lastSummary}`);
          if (blocked.count > 0) parts.push(`ブロックした通信 ${blocked.count}件`);
          return {
            ...(parts.length > 0 ? { detail: parts.join('、') } : {}),
            ...(onPortalHost(deployment, page.url()) && (await hasContinuePrompt(page))
              ? { notice: CONTINUE_NOTICE }
              : {}),
          };
        },
        ...(options.notifyIntervalMs ? { describeIntervalMs: options.notifyIntervalMs } : {}),
        // Read inside the page only: never export the (HttpOnly) DSID cookie out of the browser.
        cookieUrls: [],
        // DSID has no expiry: without this, Chrome drops it when the sign-in window closes and
        // every later (headless) run would be signed out. It stays in the profile's cookie store.
        keepSessionCookies: true,
        launch: { serviceWorkers: 'block', viewport: { width: 1366, height: 900 } },
        prepareContext: (context, info) => {
          interactive = info?.headless === false;
          blocked.count = 0;
          lastNotLive = undefined;
          return installReadOnlyRoute(context, deployment.origin, ctx.logger, {
            interactive: () => interactive,
            onBlocked: () => {
              blocked.count++;
            },
          });
        },
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
