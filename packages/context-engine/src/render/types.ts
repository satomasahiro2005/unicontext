import type { DocumentImage } from './image.js';

export type RenderMode = 'text' | 'images' | 'both';

/** One page of a PDF, one slide of a deck, or the picture / body of a single-page document. */
export interface DocumentPage {
  /** 1-based. */
  index: number;
  kind: 'page' | 'slide' | 'image';
  text: string;
  /** Text read from the picture by OCR (text is then empty or too short to trust). */
  ocrText?: string;
  /** Where `ocrText` comes from. */
  origin?: 'ocr';
  /** No text layer: only the picture (or the client's vision) can tell what is on it. */
  needsVision?: boolean;
}

export interface RenderOptions {
  /** Pages / slides wanted (1-based, ascending). Undefined: the first `defaultPages`. */
  pages?: readonly number[] | undefined;
  defaultPages: number;
  render: RenderMode;
  /** At most this many pictures are produced. */
  maxImages: number;
  /** Largest base64 size of one picture. */
  maxImageBase64: number;
  /** Read text from scanned pages with the OS OCR when it is available. */
  ocr: boolean;
}

export interface RenderedDocument {
  kind: 'pdf' | 'pptx' | 'docx' | 'image' | 'text' | 'other';
  /** Pages / slides in the whole document (undefined: not paged). */
  pageCount?: number;
  pages: DocumentPage[];
  images: DocumentImage[];
  warnings: string[];
}

/** The pages to read: the wanted ones that exist, else the first `defaultPages`. */
export function selectPages(
  pageCount: number,
  options: Pick<RenderOptions, 'pages' | 'defaultPages'>,
  warnings: string[],
): number[] {
  if (!options.pages || options.pages.length === 0) {
    const n = Math.min(pageCount, options.defaultPages);
    if (pageCount > n)
      warnings.push(
        `先頭の${n}ページだけを返しています（全${pageCount}ページ）。続きは pages で指定してください`,
      );
    return Array.from({ length: n }, (_, i) => i + 1);
  }
  const wanted = [...new Set(options.pages)].sort((a, b) => a - b);
  const valid = wanted.filter((p) => p >= 1 && p <= pageCount);
  const missing = wanted.filter((p) => p < 1 || p > pageCount);
  if (missing.length > 0)
    warnings.push(`存在しないページ: ${missing.join(', ')}（全${pageCount}ページ）`);
  return valid;
}

/** Fewer characters than this on a page: it is a scan (a picture), not text. */
export const SCANNED_PAGE_CHARS = 20;
