import { defineConnector, defineMetadata } from '@unicontext/connector-sdk';
import { WordpressPortalAdapter, type WordpressAdapterOptions } from './adapter.js';
import { createPortalNormalizer } from './normalizer.js';
import { resolvePortal } from './profiles/index.js';
import {
  PORTAL_PRODUCT,
  WP_CATEGORY,
  WP_PDF,
  WP_POST,
  type WordpressConfig,
  WordpressConfigSchema,
} from './types.js';

export const metadata = defineMetadata({
  name: '@unicontext/wordpress-portal',
  product: PORTAL_PRODUCT,
  version: '1.0.0',
  license: 'MIT',
  description:
    'University portal on WordPress: announcements from the REST API (wp-json/wp/v2) and the PDFs linked from posts and watched pages.',
  capabilities: ['announcements', 'materials', 'files'],
  adapter: 'native',
  // The WordPress REST API is documented and public.
  apiStability: 'official',
  risk: 'supported',
  defaultAuthority: 'university-portal',
  sourceLabel: '大学ポータル',
  defaultSchedule: '1h',
  rawTypes: [WP_POST, WP_CATEGORY, WP_PDF],
  homepage: 'https://developer.wordpress.org/rest-api/',
});

/** `options.pdfExtractor` swaps the PDF text engine (default: unpdf). */
export function createWordpressPortalConnector(options: WordpressAdapterOptions = {}) {
  return defineConnector<WordpressConfig>({
    metadata,
    configSchema: WordpressConfigSchema,
    createAdapter: (ctx) => new WordpressPortalAdapter(ctx, options),
    createNormalizer: (ctx) =>
      createPortalNormalizer({
        label: resolvePortal(ctx.config, ctx.profile?.products[PORTAL_PRODUCT]).label,
      }),
  });
}

export const wordpressPortalConnector = createWordpressPortalConnector();
