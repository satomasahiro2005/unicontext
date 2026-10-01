import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CanonicalEntityInput, JsonValue } from '@unicontext/canonical-model';
import {
  detectSchemaDrift,
  type NormalizeContext,
  type NormalizedEntity,
  type NormalizeOutput,
  type Normalizer,
  type RawItemView,
} from '@unicontext/connector-sdk';
import { zonedParts } from '@unicontext/core';
import { extractYear, normalizeCourseTitle, normalizeText } from '@unicontext/identity';
import { chunkMarkdown, chunkText, type TextChunk } from './chunk.js';
import { academicYearFromFolder, parseDateFromName } from './course.js';
import { CODE_EXTENSIONS, RECORDING_EXTENSIONS } from './extract.js';
import { type FileDocumentPayload, FileDocumentPayloadSchema, RAW_TYPE_DOCUMENT } from './types.js';

export interface NormalizerOptions {
  chunkSize?: number;
  chunkOverlap?: number;
}

/** Maximum characters of Document.text (chunks cover the rest). */
const MAX_DOCUMENT_TEXT = 100_000;

export type MaterialKind = 'slides' | 'handout' | 'recording' | 'code' | 'other';

export function materialKindFor(ext: string): MaterialKind {
  if (ext === 'pptx' || ext === 'ppt' || ext === 'key') return 'slides';
  if (ext === 'pdf') return 'handout';
  if (RECORDING_EXTENSIONS.has(ext)) return 'recording';
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  return 'other';
}

/** Whole-document plain text (pages / slides joined). */
export function documentText(p: FileDocumentPayload): string | undefined {
  if (p.pages)
    return p.pages
      .map((x) => x.text)
      .filter(Boolean)
      .join('\n\n');
  if (p.slides)
    return p.slides
      .map((s) => [s.text, s.notes].filter(Boolean).join('\n'))
      .filter(Boolean)
      .join('\n\n');
  return p.text;
}

/** Page-aware (PDF), slide-aware (PPTX), heading-aware (Markdown) or plain chunks. */
export function buildChunks(p: FileDocumentPayload, size: number, overlap: number): TextChunk[] {
  const out: TextChunk[] = [];
  if (p.pages) {
    for (const page of p.pages)
      for (const text of chunkText(page.text, size, overlap)) out.push({ text, page: page.page });
  } else if (p.slides) {
    for (const s of p.slides) {
      const body = s.notes ? `${s.text}\n\n[Notes]\n${s.notes}` : s.text;
      const heading = s.title ?? `Slide ${s.slide}`;
      for (const text of chunkText(body, size, overlap)) out.push({ text, page: s.slide, heading });
    }
  } else if (p.text) {
    if (p.ext === 'md' || p.ext === 'markdown') out.push(...chunkMarkdown(p.text, size, overlap));
    else for (const text of chunkText(p.text, size, overlap)) out.push({ text });
  }
  return out;
}

function termWord(termFolder: string | undefined): string | undefined {
  if (!termFolder) return undefined;
  const t = termFolder.normalize('NFKC');
  if (/前期|前学期|春学期/.test(t)) return '前期';
  if (/後期|後学期|秋学期/.test(t)) return '後期';
  return undefined;
}

export function createLocalFilesNormalizer(options: NormalizerOptions = {}): Normalizer {
  const size = options.chunkSize ?? 1200;
  const overlap = options.chunkOverlap ?? 120;
  return {
    id: 'local-files-normalizer',
    version: '1',
    sourceTypes: [RAW_TYPE_DOCUMENT],
    normalize(item: RawItemView, ctx: NormalizeContext): NormalizeOutput {
      const drift = detectSchemaDrift(item.payload, FileDocumentPayloadSchema);
      const parsed = FileDocumentPayloadSchema.safeParse(item.payload);
      if (!parsed.success)
        return {
          entities: [],
          drift,
          warnings: [
            `invalid ${item.sourceType} payload: ${parsed.error.issues[0]?.message ?? ''}`,
          ],
        };
      const p = parsed.data;
      const key = item.externalId;
      const absolute = path.join(p.root, ...p.relativePath.split('/'));
      const fileUrl = pathToFileURL(absolute).href;
      const entities: NormalizedEntity[] = [];

      // Course inferred from the folder name; IdentityResolver links it to the LCU/Teams offering (§14).
      const year =
        academicYearFromFolder(p.termFolder) ??
        (p.courseFolder ? extractYear(p.courseFolder) : undefined);
      let offeringId: ReturnType<typeof ctx.id<'courseOffering'>> | undefined;
      let courseKey = '';
      if (p.courseFolder) {
        courseKey = normalizeCourseTitle(p.courseFolder) || normalizeText(p.courseFolder);
        offeringId = ctx.id('courseOffering', courseKey, year ? String(year) : '');
        const term = termWord(p.termFolder);
        entities.push({
          entity: {
            id: offeringId,
            kind: 'courseOffering',
            title: p.courseFolder,
            ...(year ? { academicYear: year } : {}),
            ...(term ? { term } : {}),
            instructorNames: [],
            schedule: [],
          },
          deriveFacts: false,
        });
      }

      // Lecture date hint from the file name.
      const mtimeYear = zonedParts(new Date(p.mtime), ctx.timezone).year;
      const lectureDate = parseDateFromName(p.name, {
        fallbackYear: mtimeYear,
        ...(year ? { academicYear: year } : {}),
      });

      const docId = ctx.id('document', key);
      const fullText = documentText(p);
      const pageCount = p.pages?.length ?? p.slides?.length;
      const extra: Record<string, JsonValue> = { relativePath: p.relativePath, ext: p.ext };
      if (lectureDate) extra.lectureDate = lectureDate;
      if (p.courseFolder) extra.courseFolder = p.courseFolder;
      if (p.termFolder) extra.termFolder = p.termFolder;
      if (p.note) extra.note = p.note;
      if (p.image)
        extra.image = {
          width: p.image.width,
          height: p.image.height,
          ...(p.image.takenAt ? { takenAt: p.image.takenAt } : {}),
        };
      const doc: CanonicalEntityInput = {
        id: docId,
        kind: 'document',
        title: p.name,
        mimeType: p.mimeType,
        path: absolute,
        url: fileUrl,
        sizeBytes: p.size,
        contentHash: p.hash,
        ...(fullText ? { text: fullText.slice(0, MAX_DOCUMENT_TEXT) } : {}),
        ...(pageCount !== undefined ? { pageCount } : {}),
        ...(offeringId ? { courseOfferingId: offeringId } : {}),
        modifiedAt: p.mtime,
        extra,
      };
      entities.push({ entity: doc, ref: { url: fileUrl }, deriveFacts: false });

      buildChunks(p, size, overlap).forEach((c, i) => {
        entities.push({
          entity: {
            id: ctx.id('documentChunk', key, String(i)),
            kind: 'documentChunk',
            documentId: docId,
            ordinal: i,
            text: c.text,
            ...(c.page ? { page: c.page } : {}),
            ...(c.heading ? { heading: c.heading } : {}),
          },
          ref: { url: fileUrl, ...(c.page ? { location: { page: c.page } } : {}) },
          deriveFacts: false,
        });
      });

      if (offeringId) {
        const lectureId =
          lectureDate !== undefined ? ctx.id('lecture', courseKey, lectureDate) : undefined;
        if (lectureId && lectureDate)
          entities.push({
            entity: {
              id: lectureId,
              kind: 'lecture',
              date: lectureDate,
              courseOfferingId: offeringId,
              topics: [],
            },
            deriveFacts: false,
          });
        entities.push({
          entity: {
            id: ctx.id('material', key),
            kind: 'material',
            title: p.name,
            materialKind: materialKindFor(p.ext),
            documentId: docId,
            courseOfferingId: offeringId,
            ...(lectureId ? { lectureId } : {}),
          },
          ref: { url: fileUrl },
          deriveFacts: false,
        });
      }
      return { entities, drift };
    },
  };
}
