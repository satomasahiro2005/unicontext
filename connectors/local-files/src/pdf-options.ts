import { createRequire } from 'node:module';
import path from 'node:path';

/*
 * unpdf bundles pdf.js without its CMap and standard-font data. Japanese slides exported by
 * PowerPoint use CID fonts (Adobe-Japan1 and friends); without the CMaps pdf.js drops every CJK
 * glyph, so both the text layer and the page render come back empty. pdfjs-dist is installed (same
 * version as the pdf.js unpdf bundles) only to supply those data files from disk.
 */

export interface PdfDataOptions {
  cMapUrl: string;
  cMapPacked: true;
  standardFontDataUrl: string;
}

let cached: PdfDataOptions | undefined;

/** Options for unpdf getDocumentProxy that let pdf.js read CJK CMaps and the standard fonts. */
export function pdfDataOptions(): PdfDataOptions {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  // pdf.js appends file names directly to these paths and insists on a trailing "/" (also on Windows).
  const dir = (name: string): string => `${path.join(root, name).replaceAll('\\', '/')}/`;
  cached = {
    cMapUrl: dir('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: dir('standard_fonts'),
  };
  return cached;
}
