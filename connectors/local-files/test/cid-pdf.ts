/*
 * A Japanese PDF the way PowerPoint writes one: a Type0 font with a predefined Adobe-Japan1 CMap
 * (90ms-RKSJ-H, Shift_JIS codes) over an embedded TrueType CIDFont, and no ToUnicode map. pdf.js
 * can only turn the codes back into text, and only draw the glyphs, when it is given its CMap
 * data (cMapUrl); without it every glyph is dropped and the page is blank.
 *
 * The embedded font is generated here: glyphs 840..899 are filled 600x800 boxes, so a page that
 * is drawn correctly has dark pixels where the characters are (no real font file is needed).
 */

/**
 * The text on the page (long enough not to count as a scan), and the Shift_JIS bytes it is written
 * with: あいうえお are CIDs 843, 845, 847, 849, 851 in Adobe-Japan1.
 */
export const CID_PDF_TEXT = 'あいうえお'.repeat(5);
const SJIS_HEX = '82A082A282A482A682A8'.repeat(5);

const FIRST_BOX_GID = 840;
const NUM_GLYPHS = 900;

function u16(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}
function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function i16(n: number): number[] {
  return u16(n < 0 ? n + 0x10000 : n);
}

function tableChecksum(bytes: number[]): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    sum =
      (sum +
        (((bytes[i] ?? 0) << 24) |
          ((bytes[i + 1] ?? 0) << 16) |
          ((bytes[i + 2] ?? 0) << 8) |
          (bytes[i + 3] ?? 0))) >>>
      0;
  }
  return sum;
}

/** A TrueType font whose glyphs FIRST_BOX_GID.. are boxes and the rest are empty. */
export function makeBoxFont(): Uint8Array {
  const head = [
    ...u32(0x00010000),
    ...u32(0x00010000),
    ...u32(0),
    ...u32(0x5f0f3cf5),
    ...u16(0),
    ...u16(1000),
    ...new Array<number>(16).fill(0),
    ...i16(0),
    ...i16(0),
    ...i16(600),
    ...i16(800),
    ...u16(0),
    ...u16(8),
    ...i16(2),
    ...i16(1), // long loca offsets
    ...i16(0),
  ];
  const hhea = [
    ...u32(0x00010000),
    ...i16(800),
    ...i16(-200),
    ...i16(0),
    ...u16(1000),
    ...i16(0),
    ...i16(0),
    ...i16(600),
    ...i16(1),
    ...i16(0),
    ...i16(0),
    ...new Array<number>(8).fill(0),
    ...i16(0),
    ...u16(1),
  ];
  const maxp = [
    ...u32(0x00010000),
    ...u16(NUM_GLYPHS),
    ...u16(4),
    ...u16(1),
    ...u16(0),
    ...u16(0),
    ...u16(1),
    ...new Array<number>(18).fill(0),
  ];
  const hmtx = [...u16(1000), ...i16(0), ...new Array<number>((NUM_GLYPHS - 1) * 2).fill(0)];
  const box = [
    ...i16(1), // one contour
    ...i16(0),
    ...i16(0),
    ...i16(600),
    ...i16(800),
    ...u16(3), // last point of the contour
    ...u16(0), // no instructions
    1,
    1,
    1,
    1, // four on-curve points, 16-bit deltas
    ...i16(0),
    ...i16(600),
    ...i16(0),
    ...i16(-600),
    ...i16(0),
    ...i16(0),
    ...i16(800),
    ...i16(0),
    ...u16(0), // pad to 4 bytes
  ];
  const loca: number[] = [];
  const glyf: number[] = [];
  for (let g = 0; g < NUM_GLYPHS; g++) {
    loca.push(...u32(glyf.length));
    if (g >= FIRST_BOX_GID) glyf.push(...box);
  }
  loca.push(...u32(glyf.length));
  // a format 4 cmap with no mappings, so a parser that insists on one is satisfied
  const cmap = [
    ...u16(0),
    ...u16(1),
    ...u16(3),
    ...u16(1),
    ...u32(12),
    ...u16(4),
    ...u16(24),
    ...u16(0),
    ...u16(2),
    ...u16(2),
    ...u16(0),
    ...u16(0),
    ...u16(0xffff),
    ...u16(0),
    ...u16(0xffff),
    ...u16(1),
    ...u16(0),
  ];
  const post = [...u32(0x00030000), ...new Array<number>(28).fill(0)];
  const tables: [string, number[]][] = [
    ['cmap', cmap],
    ['glyf', glyf],
    ['head', head],
    ['hhea', hhea],
    ['hmtx', hmtx],
    ['loca', loca],
    ['maxp', maxp],
    ['post', post],
  ];
  const out: number[] = [
    ...u32(0x00010000),
    ...u16(tables.length),
    ...u16(128),
    ...u16(3),
    ...u16(0),
  ];
  let offset = 12 + tables.length * 16;
  const bodies: number[][] = [];
  for (const [tag, body] of tables) {
    out.push(...[...tag].map((c) => c.charCodeAt(0)), ...u32(tableChecksum(body)));
    out.push(...u32(offset), ...u32(body.length));
    const padded = [...body, ...new Array<number>((4 - (body.length % 4)) % 4).fill(0)];
    bodies.push(padded);
    offset += padded.length;
  }
  for (const b of bodies) out.push(...b);
  return Uint8Array.from(out);
}

export function makeCidPdf(): Buffer {
  const font = makeBoxFont();
  const fontBinary = Buffer.from(font).toString('latin1');
  const content = `BT /F1 20 Tf 72 700 Td <${SJIS_HEX}> Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [7 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /TestGothic /Encoding /90ms-RKSJ-H /DescendantFonts [4 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TestGothic /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor 5 0 R /DW 1000 /CIDToGIDMap /Identity >>',
    '<< /Type /FontDescriptor /FontName /TestGothic /Flags 4 /FontBBox [0 0 600 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 800 /StemV 80 /FontFile2 6 0 R >>',
    `<< /Length ${fontBinary.length} /Length1 ${fontBinary.length} >>\nstream\n${fontBinary}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 8 0 R /Resources << /Font << /F1 3 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
