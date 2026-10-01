import { extractText, getDocumentProxy } from 'unpdf';

export interface PdfPage {
  page: number;
  text: string;
}

/** Turns PDF bytes into per-page text. Injectable so tests and hosts can swap the engine. */
export type PdfTextExtractor = (data: Uint8Array) => Promise<PdfPage[]>;

/** Default extractor: unpdf (PDF.js without a canvas), text layer only (no OCR). */
export const unpdfExtractor: PdfTextExtractor = async (data) => {
  // PDF.js may detach the buffer it is given: hand it a copy, the caller keeps the original.
  const pdf = await getDocumentProxy(new Uint8Array(data));
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    return text.map((t, i) => ({ page: i + 1, text: t.replace(/[ \t]+\n/g, '\n').trim() }));
  } finally {
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
};

/** True when the bytes start like a PDF ("%PDF-" within the first 1 KiB). */
export function looksLikePdf(data: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(data.subarray(0, 1024));
  return head.includes('%PDF-');
}
