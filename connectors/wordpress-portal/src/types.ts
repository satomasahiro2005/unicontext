import { z } from 'zod';
import { PortalSettingsSchema } from './profiles/index.js';

export const WP_POST = 'wp.post';
export const WP_CATEGORY = 'wp.category';
export const WP_PDF = 'wp.pdf';
export const PORTAL_PRODUCT = 'wordpress-portal';

export const PdfConfigSchema = z.object({
  /** Download PDFs linked from posts fetched in this run. */
  followLinksInPosts: z.boolean().default(true),
  /** Pages (e.g. a faculty page) whose PDF links are watched on every run. */
  watchPages: z.array(z.string().url()).default([]),
  /** PDFs larger than this are not downloaded. */
  maxSizeMb: z.number().positive().default(20),
});

export const WordpressConfigSchema = PortalSettingsSchema.extend({
  /** Posts per REST page (WordPress allows up to 100). */
  perPage: z.number().int().min(1).max(100).default(20),
  /** Only posts in these category ids. */
  categories: z.array(z.number().int()).optional(),
  /** Maximum number of post pages fetched per run. */
  maxPages: z.number().int().positive().default(10),
  pdf: PdfConfigSchema.default({ followLinksInPosts: true, watchPages: [], maxSizeMb: 20 }),
});
export type WordpressConfig = z.infer<typeof WordpressConfigSchema>;

const rendered = z.object({ rendered: z.string(), protected: z.boolean().optional() });

/** Raw type `wp.post`: the REST object as requested with `_fields` (+ resolved category names). */
export const WpPostPayloadSchema = z.object({
  id: z.number().int(),
  date: z.string().optional(),
  date_gmt: z.string().optional(),
  modified: z.string().optional(),
  modified_gmt: z.string().optional(),
  link: z.string(),
  title: rendered,
  excerpt: rendered.optional(),
  content: rendered.optional(),
  categories: z.array(z.number().int()).optional(),
  /** Names of `categories` from /categories (the only field added to the REST object). */
  categoryNames: z.array(z.string()).optional(),
});
export type WpPostPayload = z.infer<typeof WpPostPayloadSchema>;

/** Raw type `wp.category`. */
export const WpCategoryPayloadSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  slug: z.string().optional(),
  parent: z.number().int().optional(),
  count: z.number().int().optional(),
  link: z.string().optional(),
});
export type WpCategoryPayload = z.infer<typeof WpCategoryPayloadSchema>;

/** Raw type `wp.pdf` (the PDF bytes travel as the raw item's blob). */
export const WpPdfPayloadSchema = z.object({
  url: z.string(),
  /** Link text. */
  title: z.string(),
  /** Post or page the link was found on. */
  foundOn: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  lastModified: z.string().optional(),
  pages: z.array(z.object({ page: z.number().int().positive(), text: z.string() })),
});
export type WpPdfPayload = z.infer<typeof WpPdfPayloadSchema>;

/** Fields requested from /posts: WordPress 5.2 has no modified_after, so we sort and stop early. */
export const POST_FIELDS =
  'id,date,date_gmt,modified,modified_gmt,link,title,excerpt,content,categories';
