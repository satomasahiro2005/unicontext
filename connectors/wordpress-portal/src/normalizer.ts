import {
  detectSchemaDrift,
  type NormalizeContext,
  type NormalizedEntity,
  type NormalizeOutput,
  type Normalizer,
  type RawItemView,
} from '@unicontext/connector-sdk';
import type { JsonValue } from '@unicontext/canonical-model';
import { classifyNoticeImportance, zonedTime } from '@unicontext/core';
import { decodeEntities, extractLinks, htmlToText } from './html.js';
import {
  WP_CATEGORY,
  WP_PDF,
  WP_POST,
  WpCategoryPayloadSchema,
  WpPdfPayloadSchema,
  type WpPostPayload,
  WpPostPayloadSchema,
} from './types.js';

/** Authority of everything this connector produces (a university portal, not a course source). */
export const PORTAL_AUTHORITY = 'university-portal';

export type PdfKind = 'timetable' | 'exam-timetable' | 'calendar';

/** Guess what a PDF is from its link text: 時間割 / 期末試験時間割 / 行事予定表. */
export function detectPdfKind(title: string): PdfKind | undefined {
  const t = title.normalize('NFKC');
  if (/試験時間割|期末試験|定期試験|exam/i.test(t)) return 'exam-timetable';
  if (/時間割|timetable/i.test(t)) return 'timetable';
  if (/行事予定|学年暦|calendar/i.test(t)) return 'calendar';
  return undefined;
}

/** "2026-03-06T08:34:23" is GMT in WordPress' *_gmt fields and site-local otherwise. */
function postInstant(p: WpPostPayload, tz: string): string | undefined {
  if (p.date_gmt) {
    const t = new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(p.date_gmt) ? p.date_gmt : `${p.date_gmt}Z`);
    if (!Number.isNaN(t.getTime())) return t.toISOString();
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(p.date ?? '');
  if (!m) return undefined;
  return zonedTime(
    {
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: Number(m[4]),
      minute: Number(m[5]),
      second: Number(m[6]),
    },
    tz,
  ).toISOString();
}

function postBody(p: WpPostPayload): string {
  const html = p.content?.rendered ?? '';
  const text = htmlToText(html) || htmlToText(p.excerpt?.rendered ?? '');
  const links = extractLinks(html, p.link).filter((l) => !/\.pdf$/i.test(new URL(l.url).pathname));
  if (links.length === 0) return text;
  const lines = links.map((l) => `・${l.text && l.text !== l.url ? `${l.text}: ` : ''}${l.url}`);
  return `${text}\n\nリンク:\n${lines.join('\n')}`.trim();
}

function compact(o: Record<string, JsonValue | undefined>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Record<
    string,
    JsonValue
  >;
}

export interface PortalNormalizerOptions {
  /** Display name for citations (e.g. "学生教務ポータル"); defaults to the source label. */
  label?: string | undefined;
}

export function createPortalNormalizer(options: PortalNormalizerOptions = {}): Normalizer {
  const label = options.label;
  return {
    id: 'wordpress-portal-normalizer',
    version: '2',
    sourceTypes: [WP_POST, WP_CATEGORY, WP_PDF],
    normalize(item: RawItemView, ctx: NormalizeContext): NormalizeOutput {
      const refBase = { authority: PORTAL_AUTHORITY, ...(label ? { sourceLabel: label } : {}) };

      if (item.sourceType === WP_CATEGORY) {
        // Categories only provide names, which the adapter resolves into post payloads.
        return { entities: [], drift: detectSchemaDrift(item.payload, WpCategoryPayloadSchema) };
      }

      if (item.sourceType === WP_POST) {
        const drift = detectSchemaDrift(item.payload, WpPostPayloadSchema);
        const parsed = WpPostPayloadSchema.safeParse(item.payload);
        if (!parsed.success)
          return {
            entities: [],
            drift,
            warnings: [`invalid wp.post payload: ${parsed.error.issues[0]?.message ?? ''}`],
          };
        const p = parsed.data;
        const title = decodeEntities(p.title.rendered) || `投稿 ${p.id}`;
        const publishedAt = postInstant(p, ctx.timezone);
        const category = p.categoryNames?.length ? p.categoryNames.join('、') : undefined;
        return {
          entities: [
            {
              entity: {
                id: ctx.id('announcement', item.externalId),
                kind: 'announcement',
                title,
                body: postBody(p),
                ...(publishedAt ? { publishedAt } : {}),
                importance: classifyNoticeImportance({ title }).importance,
                scope: 'university',
                ...(category ? { category } : {}),
                url: p.link,
              },
              ref: { ...refBase, url: p.link },
            },
          ],
          drift,
        };
      }

      // wp.pdf
      const drift = detectSchemaDrift(item.payload, WpPdfPayloadSchema);
      const parsed = WpPdfPayloadSchema.safeParse(item.payload);
      if (!parsed.success)
        return {
          entities: [],
          drift,
          warnings: [`invalid wp.pdf payload: ${parsed.error.issues[0]?.message ?? ''}`],
        };
      const p = parsed.data;
      const kind = detectPdfKind(p.title);
      const documentId = ctx.id('document', item.externalId);
      const ref = { ...refBase, url: p.url };
      const entities: NormalizedEntity[] = [
        {
          entity: {
            id: documentId,
            kind: 'document',
            title: p.title,
            mimeType: 'application/pdf',
            url: p.url,
            sizeBytes: p.size,
            contentHash: p.sha256,
            text: p.pages.map((pg) => pg.text).join('\n\n'),
            pageCount: p.pages.length,
            ...(p.lastModified ? { modifiedAt: p.lastModified } : {}),
            extra: compact({ kind, foundOn: p.foundOn }),
          },
          ref,
        },
      ];
      p.pages.forEach((pg, i) => {
        if (!pg.text.trim()) return;
        entities.push({
          entity: {
            id: ctx.id('documentChunk', item.externalId, String(pg.page)),
            kind: 'documentChunk',
            documentId,
            ordinal: i,
            text: pg.text,
            page: pg.page,
          },
          ref: { ...ref, location: { page: pg.page } },
        });
      });
      entities.push({
        entity: {
          id: ctx.id('material', item.externalId),
          kind: 'material',
          title: p.title,
          materialKind: 'handout',
          documentId,
          url: p.url,
          ...(p.lastModified ? { publishedAt: p.lastModified } : {}),
        },
        ref,
      });
      return { entities, drift };
    },
  };
}
