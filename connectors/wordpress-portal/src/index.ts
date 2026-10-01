import { wordpressPortalConnector } from './connector.js';

export { WordpressPortalAdapter, gmtToIso } from './adapter.js';
export type { WordpressAdapterOptions } from './adapter.js';
export { createWordpressPortalConnector, metadata, wordpressPortalConnector } from './connector.js';
export { PORTAL_AUTHORITY, createPortalNormalizer, detectPdfKind } from './normalizer.js';
export type { PdfKind, PortalNormalizerOptions } from './normalizer.js';
export { decodeEntities, extractLinks, extractPdfLinks, htmlToText } from './html.js';
export { looksLikePdf, unpdfExtractor } from './pdf.js';
export type { PdfPage, PdfTextExtractor } from './pdf.js';
export * from './profiles/index.js';
export * from './types.js';

export default wordpressPortalConnector;
export { wordpressPortalConnector as connector };
