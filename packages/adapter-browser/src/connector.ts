import {
  type ConnectorModule,
  defineConnector,
  defineMetadata,
  detectSchemaDrift,
  type NormalizedEntity,
  type Normalizer,
} from '@unicontext/connector-sdk';
import { z } from 'zod';
import { BrowserSourceAdapter } from './adapter.js';
import { shibbolethConsentHandler, type InterstitialHandler } from './interstitial.js';
import { BrowserSession, defaultProfileDir } from './session.js';
import type { BrowserDriver } from './types.js';

/**
 * Config-driven "page snapshot" connector (§31): log in once in a real browser, then capture the
 * text of a fixed list of pages as searchable documents. It is the documented fallback for
 * services without a usable API (e.g. Outlook on the web / Teams web when Graph consent is
 * blocked). Read-only: it only navigates to the configured URLs.
 */
export const BrowserConfigSchema = z.looseObject({
  startUrl: z.string().url(),
  /** Regex the page URL must match once logged in. */
  authenticatedUrlPattern: z.string().min(1),
  /** Selector clicked after opening startUrl (e.g. an "SSO login" button). */
  loginButton: z.string().optional(),
  /** Pages captured on every sync (default: just startUrl). */
  pages: z.array(z.object({ url: z.string().url(), title: z.string().optional() })).default([]),
  cookieUrls: z.array(z.string().url()).optional(),
  consent: z
    .object({
      shibboleth: z
        .object({ hosts: z.array(z.string()).min(1), remember: z.boolean().default(true) })
        .optional(),
    })
    .optional(),
  channel: z.string().optional(),
  executablePath: z.string().optional(),
  profileDir: z.string().optional(),
  /** Max characters kept per page. */
  maxChars: z.number().int().positive().default(200_000),
});
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;

export const BrowserPagePayloadSchema = z.object({
  url: z.string(),
  title: z.string(),
  text: z.string(),
});

export const browserMetadata = defineMetadata({
  name: '@unicontext/adapter-browser',
  product: 'browser',
  version: '1.0.0',
  license: 'MIT',
  description: 'Captures pages of a human-logged-in browser session as documents (last resort)',
  capabilities: ['materials'],
  adapter: 'browser',
  apiStability: 'experimental',
  risk: 'experimental',
  defaultAuthority: 'collaboration',
  sourceLabel: 'ブラウザ',
  defaultSchedule: '1d',
  rawTypes: ['browser.page'],
});

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Visible text of an HTML page (scripts/styles dropped, block tags become line breaks). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v\xa0]+/g, ' ')
    .replace(/ *\n[ \n]*/g, '\n')
    .trim();
}

function chunk(text: string, size = 1200): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export function createBrowserPageNormalizer(): Normalizer {
  return {
    id: 'browser-page',
    version: '1',
    sourceTypes: ['browser.page'],
    normalize(item, ctx) {
      const drift = detectSchemaDrift(item.payload, BrowserPagePayloadSchema);
      const parsed = BrowserPagePayloadSchema.safeParse(item.payload);
      if (!parsed.success)
        return { entities: [], drift, warnings: ['invalid browser.page payload'] };
      const p = parsed.data;
      const documentId = ctx.id('document', item.externalId);
      const ref = { url: p.url };
      const entities: NormalizedEntity[] = [
        {
          entity: {
            id: documentId,
            kind: 'document',
            title: p.title || p.url,
            mimeType: 'text/html',
            url: p.url,
            text: p.text,
            contentHash: item.contentHash,
          },
          ref,
        },
        ...chunk(p.text).map((text, ordinal): NormalizedEntity => ({
          entity: {
            id: ctx.id('documentChunk', item.externalId, String(ordinal)),
            kind: 'documentChunk',
            documentId,
            ordinal,
            text,
          },
          ref,
        })),
      ];
      return { entities, drift };
    },
  };
}

export interface BrowserConnectorOptions {
  driver?: BrowserDriver;
  /** Extra interstitial handlers (e.g. a university's own consent screen). */
  handlers?: InterstitialHandler[];
  pollIntervalMs?: number;
}

export function createBrowserConnector(
  options: BrowserConnectorOptions = {},
): ConnectorModule<BrowserConfig> {
  return defineConnector<BrowserConfig>({
    metadata: browserMetadata,
    configSchema: BrowserConfigSchema,
    createAdapter(ctx) {
      const cfg = ctx.config;
      const pattern = new RegExp(cfg.authenticatedUrlPattern);
      const handlers = [...(options.handlers ?? [])];
      if (cfg.consent?.shibboleth)
        handlers.push(
          shibbolethConsentHandler({
            hosts: cfg.consent.shibboleth.hosts,
            remember: cfg.consent.shibboleth.remember,
          }),
        );
      const loginButton = cfg.loginButton;
      const session = new BrowserSession({
        sourceId: ctx.sourceId,
        profileDir: cfg.profileDir ?? defaultProfileDir(ctx.sourceId, ctx.cacheDir),
        secrets: ctx.secrets,
        logger: ctx.logger,
        clock: ctx.clock,
        startUrl: cfg.startUrl,
        ...(loginButton
          ? {
              begin: async (page) => {
                await page.locator(loginButton).first().click();
              },
            }
          : {}),
        isAuthenticated: (page) => pattern.test(page.url()),
        handlers,
        cookieUrls: cfg.cookieUrls ?? [cfg.startUrl],
        ...(options.driver ? { driver: options.driver } : {}),
        ...(cfg.channel ? { channel: cfg.channel } : {}),
        ...(cfg.executablePath ? { executablePath: cfg.executablePath } : {}),
        ...(options.pollIntervalMs ? { pollIntervalMs: options.pollIntervalMs } : {}),
      });
      const pages = cfg.pages.length ? cfg.pages : [{ url: cfg.startUrl }];
      return new BrowserSourceAdapter({
        id: `browser:${ctx.sourceId}`,
        capabilities: ['materials'],
        session,
        clock: ctx.clock,
        async scrape({ page }) {
          const items = [];
          for (const target of pages) {
            await page.goto(target.url, { waitUntil: 'load' });
            const title = (target as { title?: string }).title ?? (await page.title());
            const text = htmlToText(await page.content()).slice(0, cfg.maxChars);
            items.push({
              sourceType: 'browser.page',
              externalId: target.url,
              payload: { url: target.url, title, text },
            });
          }
          return { items, complete: { sourceTypes: ['browser.page'] } };
        },
      });
    },
    createNormalizer: () => createBrowserPageNormalizer(),
  });
}

/** Default module (Playwright driver with an installed Chrome/Edge). */
export const browserConnector: ConnectorModule<BrowserConfig> = createBrowserConnector();
