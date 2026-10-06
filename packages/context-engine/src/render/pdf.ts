import {
  CANVAS_WARNING,
  type CanvasModule,
  canvasUnavailableReason,
  type DocumentImage,
  fitImage,
  loadCanvas,
  MAX_EDGE,
} from './image.js';
import { ocrImage } from './ocr.js';
import {
  type DocumentPage,
  type RenderedDocument,
  type RenderOptions,
  SCANNED_PAGE_CHARS,
  selectPages,
} from './types.js';

/*
 * PDF: the text of each wanted page (unpdf / pdf.js, page by page) and, on request, each page drawn
 * as a picture (unpdf renderPageAsImage on @napi-rs/canvas). A page with almost no text is a scan:
 * it is always drawn (unless only text was asked for) and marked needsVision.
 */

interface PdfPageText {
  getTextContent(): Promise<{ items: unknown[] }>;
}

function pageText(content: { items: unknown[] }): string {
  let out = '';
  for (const item of content.items) {
    const it = item as { str?: unknown; hasEOL?: unknown };
    if (typeof it.str !== 'string') continue;
    out += it.str + (it.hasEOL === true ? '\n' : '');
  }
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function renderPdf(
  bytes: Uint8Array,
  options: RenderOptions,
): Promise<RenderedDocument> {
  const { getDocumentProxy, renderPageAsImage } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const warnings: string[] = [];
  try {
    const pageCount = pdf.numPages;
    const selected = selectPages(pageCount, options, warnings);
    const pages: DocumentPage[] = [];
    for (const n of selected) {
      const page = (await pdf.getPage(n)) as unknown as PdfPageText;
      const text = pageText(await page.getTextContent());
      pages.push({
        index: n,
        kind: 'page',
        text,
        ...(text.length < SCANNED_PAGE_CHARS ? { needsVision: true } : {}),
      });
    }

    const images: DocumentImage[] = [];
    if (options.render !== 'text' && pages.length > 0) {
      // Scans first (their picture is all there is), then the others in page order.
      const order = [...pages.filter((p) => p.needsVision), ...pages.filter((p) => !p.needsVision)]
        .slice(0, options.maxImages)
        .sort((a, b) => a.index - b.index);
      if (pages.length > order.length)
        warnings.push(
          `ページ画像は${order.length}枚までです（${pages.length}ページ中）。残りは pages を絞って取得してください`,
        );
      const canvas = await loadCanvas();
      if (!canvas) {
        const why = canvasUnavailableReason();
        warnings.push(`${CANVAS_WARNING}${why ? `: ${why}` : ''}`);
      } else {
        for (const p of order) {
          const image = await renderOne(pdf, p.index, canvas, options, renderPageAsImage, warnings);
          if (!image) continue;
          images.push(image);
          if (p.needsVision && options.ocr) {
            const ocrText = await ocrImage(image.data, 'jpg');
            if (ocrText) {
              p.ocrText = ocrText;
              p.origin = 'ocr';
              delete p.needsVision;
            }
          }
        }
      }
    }
    return { kind: 'pdf', pageCount, pages, images, warnings };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

async function renderOne(
  pdf: Awaited<ReturnType<typeof import('unpdf').getDocumentProxy>>,
  n: number,
  canvas: CanvasModule,
  options: RenderOptions,
  renderPageAsImage: typeof import('unpdf').renderPageAsImage,
  warnings: string[],
): Promise<DocumentImage | undefined> {
  try {
    const page = await pdf.getPage(n);
    const view = page.getViewport({ scale: 1 });
    const scale = Math.min(4, MAX_EDGE / Math.max(view.width, view.height, 1));
    const png = await renderPageAsImage(pdf, n, {
      canvasImport: () => Promise.resolve(canvas),
      scale,
    });
    const image = await fitImage(canvas, new Uint8Array(png), {
      label: `p.${n}`,
      page: n,
      source: 'render',
      maxBase64: options.maxImageBase64,
    });
    if (!image) warnings.push(`p.${n} の画像を作れませんでした`);
    return image;
  } catch (e) {
    warnings.push(`p.${n} の画像を作れませんでした: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}
