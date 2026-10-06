/*
 * Images for the client's vision: every picture that leaves UniContext (a rendered PDF page, a slide's
 * embedded image, an image file) is brought down to at most 1568 px on the long edge and sent as
 * JPEG q80 (smaller again when it still does not fit the size budget). Drawing needs
 * @napi-rs/canvas, a native module that is loaded on first use: when it is missing the pictures
 * are left out (or sent as they are when they already fit) and the text still comes back.
 */

import { ocrImage } from './ocr.js';
import type { DocumentPage, RenderedDocument, RenderOptions } from './types.js';

export type CanvasModule = typeof import('@napi-rs/canvas');

/** Long edge of every image handed to the client. */
export const MAX_EDGE = 1568;
export const JPEG_QUALITY = 80;

export interface DocumentImage {
  /** 1-based page / slide the picture belongs to (undefined: the document itself is the image). */
  page?: number;
  /** `render`: the page drawn as a picture; `embedded`: a picture inside the document. */
  source: 'render' | 'embedded' | 'file';
  mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: Buffer;
  width: number;
  height: number;
  /** Short description: "p.3", "slide 2 image1.png". */
  label: string;
}

let loader: () => Promise<CanvasModule> = () => import('@napi-rs/canvas');
let cached: Promise<CanvasModule | undefined> | undefined;

/**
 * The canvas module, or undefined (with the reason in `canvasUnavailableReason()`) when the native
 * binary cannot be loaded. The answer is kept for the process.
 */
export function loadCanvas(): Promise<CanvasModule | undefined> {
  cached ??= loader().then(
    (m) => {
      failure = undefined;
      return m;
    },
    (e: unknown) => {
      failure = e instanceof Error ? e.message : String(e);
      return undefined;
    },
  );
  return cached;
}

let failure: string | undefined;
export function canvasUnavailableReason(): string | undefined {
  return failure;
}

/** Tests: replace the module loader (a missing native binary) and forget the cached answer. */
export function setCanvasLoader(next: (() => Promise<CanvasModule>) | undefined): void {
  loader = next ?? (() => import('@napi-rs/canvas'));
  cached = undefined;
  failure = undefined;
}

export const CANVAS_WARNING =
  'ページ画像を作れないため本文だけを返しています（@napi-rs/canvas が読み込めません）';

export function sniffImageMime(b: Uint8Array): DocumentImage['mimeType'] | undefined {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38)
    return 'image/gif';
  if (
    b.length > 12 &&
    b.subarray(0, 4).toString() === 'RIFF' &&
    Buffer.from(b.subarray(8, 12)).toString() === 'WEBP'
  )
    return 'image/webp';
  return undefined;
}

/** Pixel size read from the header of a PNG, JPEG or GIF (no decoding). */
export function imageDims(b: Uint8Array): { width: number; height: number } | undefined {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const mime = sniffImageMime(buf);
  if (mime === 'image/png' && buf.length >= 24)
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (mime === 'image/gif' && buf.length >= 10)
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (mime === 'image/jpeg') {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1] ?? 0;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return undefined;
}

/** base64 length of `bytes` raw bytes. */
export const base64Size = (bytes: number): number => Math.ceil(bytes / 3) * 4;

export interface FitOptions {
  /** Largest base64 size of one image (default 1.5 MB). */
  maxBase64?: number;
  label: string;
  page?: number;
  source: DocumentImage['source'];
}

export const DEFAULT_MAX_IMAGE_BASE64 = 1_500_000;

/** Steps tried until the picture fits: [long edge, jpeg quality]. */
const LADDER: readonly (readonly [number, number])[] = [
  [MAX_EDGE, JPEG_QUALITY],
  [1400, 65],
  [1100, 55],
  [900, 45],
  [700, 40],
];

/**
 * An encoded image (any format the canvas can decode) as a JPEG at most 1568 px on the long edge
 * and `maxBase64` in size. Undefined when it cannot be decoded.
 */
export async function fitImage(
  canvas: CanvasModule,
  input: Uint8Array,
  options: FitOptions,
): Promise<DocumentImage | undefined> {
  const max = options.maxBase64 ?? DEFAULT_MAX_IMAGE_BASE64;
  let image;
  try {
    image = await canvas.loadImage(Buffer.from(input));
  } catch {
    return undefined;
  }
  const { width: w0, height: h0 } = image;
  if (!w0 || !h0) return undefined;
  for (const [edge, quality] of LADDER) {
    const k = Math.min(1, edge / Math.max(w0, h0));
    const width = Math.max(1, Math.round(w0 * k));
    const height = Math.max(1, Math.round(h0 * k));
    const surface = canvas.createCanvas(width, height);
    const ctx = surface.getContext('2d');
    // JPEG has no alpha: a transparent PNG would turn black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    const data = surface.toBuffer('image/jpeg', quality);
    if (base64Size(data.length) <= max || edge === LADDER[LADDER.length - 1]?.[0])
      return base64Size(data.length) > max
        ? undefined
        : {
            ...(options.page !== undefined ? { page: options.page } : {}),
            source: options.source,
            mimeType: 'image/jpeg',
            data,
            width,
            height,
            label: options.label,
          };
  }
  return undefined;
}

/**
 * An image file (png / jpg / gif / webp; heic only when the canvas can decode it): one `image`
 * page and the picture itself, brought down to 1568 px / JPEG q80. Without the canvas a picture
 * that already fits goes out as it is; otherwise only a warning comes back.
 */
export async function renderImageFile(
  bytes: Uint8Array,
  ext: string,
  options: RenderOptions,
): Promise<RenderedDocument> {
  const warnings: string[] = [];
  const page: DocumentPage = { index: 1, kind: 'image', text: '', needsVision: true };
  const done = (images: DocumentImage[]): RenderedDocument => ({
    kind: 'image',
    pageCount: 1,
    pages: [page],
    images,
    warnings,
  });
  const fit = { label: 'image', source: 'file' as const, maxBase64: options.maxImageBase64 };
  const canvas = await loadCanvas();
  let image: DocumentImage | undefined;
  if (canvas) image = await fitImage(canvas, bytes, fit);
  else {
    image = passThroughImage(bytes, imageDims(bytes), fit);
    if (!image) {
      const why = canvasUnavailableReason();
      warnings.push(`${CANVAS_WARNING}${why ? `: ${why}` : ''}`);
    }
  }
  if (!image) {
    if (ext === 'heic' || ext === 'heif')
      warnings.push('HEIC / HEIF はこの環境では開けません（JPEG か PNG にして取り込んでください）');
    else if (canvas) warnings.push('画像を読み込めませんでした');
    return done([]);
  }
  if (options.ocr) {
    const ocrText = await ocrImage(image.data, 'jpg');
    if (ocrText) {
      page.ocrText = ocrText;
      page.origin = 'ocr';
      delete page.needsVision;
    }
  }
  return done(options.render === 'text' ? [] : [image]);
}

/**
 * Picture as it is when it already fits (no canvas needed): a supported format within the long
 * edge and size budget.
 */
export function passThroughImage(
  input: Uint8Array,
  dims: { width: number; height: number } | undefined,
  options: FitOptions,
): DocumentImage | undefined {
  const mimeType = sniffImageMime(input);
  if (!mimeType || !dims) return undefined;
  if (Math.max(dims.width, dims.height) > MAX_EDGE) return undefined;
  if (base64Size(input.length) > (options.maxBase64 ?? DEFAULT_MAX_IMAGE_BASE64)) return undefined;
  return {
    ...(options.page !== undefined ? { page: options.page } : {}),
    source: options.source,
    mimeType,
    data: Buffer.from(input),
    width: dims.width,
    height: dims.height,
    label: options.label,
  };
}
