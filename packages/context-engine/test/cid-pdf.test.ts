import { createCanvas, loadImage } from '@napi-rs/canvas';
import { extractContent } from '@unicontext/local-files';
import { describe, expect, it } from 'vitest';
import { CID_PDF_TEXT, makeCidPdf } from '../../../connectors/local-files/test/cid-pdf.js';
import { renderPdf } from '../src/render/pdf.js';

/* A Japanese PDF with a CID font and a predefined CMap, as PowerPoint writes it (no ToUnicode). */

async function inkPixels(jpeg: Buffer): Promise<number> {
  const img = await loadImage(jpeg);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, img.width, img.height);
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) if ((data[i] ?? 255) < 128) dark++;
  return dark;
}

describe('CID-font Japanese PDF', () => {
  it('renderPdf returns the text and draws the glyphs', async () => {
    const doc = await renderPdf(new Uint8Array(makeCidPdf()), {
      defaultPages: 5,
      render: 'both',
      maxImages: 3,
      maxImageBase64: 4_000_000,
      ocr: false,
    });
    expect(doc.pageCount).toBe(1);
    expect(doc.pages[0]?.text).toBe(CID_PDF_TEXT);
    expect(doc.pages[0]?.needsVision).toBeUndefined();
    expect(doc.warnings).toEqual([]);
    expect(doc.images).toHaveLength(1);
    // 25 boxes of about 12 x 16 pt each: a page without glyphs has no dark pixel at all
    expect(await inkPixels(doc.images[0]!.data)).toBeGreaterThan(2000);
  });

  it('extractContent (indexing) reads the same text', async () => {
    const out = await extractContent(new Uint8Array(makeCidPdf()), 'pdf');
    expect(out.pages?.[0]?.text).toBe(CID_PDF_TEXT);
  });
});
