import JSZip from 'jszip';
import {
  CANVAS_WARNING,
  type CanvasModule,
  canvasUnavailableReason,
  type DocumentImage,
  fitImage,
  imageDims,
  loadCanvas,
  passThroughImage,
} from './image.js';
import {
  type DocumentPage,
  type RenderedDocument,
  type RenderOptions,
  SCANNED_PAGE_CHARS,
  selectPages,
} from './types.js';

/*
 * PowerPoint and Word: the text (the local-files extractors) and the pictures inside the file.
 * There is no layout engine here (LibreOffice is not installed), so a slide is not drawn: its
 * embedded media (ppt/media/* referenced by the slide's relationships) come back as pictures
 * instead, and so do the images of a .docx. Small decorations (icons, bullets, logos) are left out.
 */

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
/** Smaller files / pictures are decoration, not content. */
const MIN_BYTES = 2048;
const MIN_EDGE = 48;

interface Embedded {
  /** Path inside the zip. */
  path: string;
  /** 1-based page / slide. */
  page: number;
  label: string;
}

/** Resolve a relationship target ("../media/image1.png", "/ppt/media/x.png") against its part. */
function resolveTarget(partDir: string, target: string): string {
  const parts = (target.startsWith('/') ? target.slice(1) : `${partDir}/${target}`).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

function relationships(xml: string): { id: string; type: string; target: string }[] {
  const out: { id: string; type: string; target: string }[] = [];
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[0])?.[1];
    const type = /\bType="([^"]*)"/.exec(m[0])?.[1];
    const target = /\bTarget="([^"]*)"/.exec(m[0])?.[1];
    if (id && type && target && !/TargetMode="External"/i.test(m[0]))
      out.push({ id, type, target });
  }
  return out;
}

const extOf = (p: string): string => p.split('.').pop()?.toLowerCase() ?? '';

async function embeddedImages(
  zip: JSZip,
  embedded: Embedded[],
  options: RenderOptions,
  warnings: string[],
): Promise<DocumentImage[]> {
  const images: DocumentImage[] = [];
  if (embedded.length === 0) return images;
  const canvas = await loadCanvas();
  let skippedFormat = 0;
  let capped = 0;
  let noCanvas = false;
  const seen = new Set<string>();
  for (const e of embedded) {
    if (seen.has(e.path)) continue; // the same logo on every slide is sent once
    seen.add(e.path);
    if (!IMAGE_EXT.has(extOf(e.path))) {
      skippedFormat += 1;
      continue;
    }
    if (images.length >= options.maxImages) {
      capped += 1;
      continue;
    }
    const data = await zip.file(e.path)?.async('uint8array');
    if (!data || data.length < MIN_BYTES) continue;
    const dims = imageDims(data);
    if (dims && Math.min(dims.width, dims.height) < MIN_EDGE) continue;
    const fit = {
      label: e.label,
      page: e.page,
      source: 'embedded' as const,
      maxBase64: options.maxImageBase64,
    };
    const image = canvas
      ? await fitImage(canvas as CanvasModule, data, fit)
      : passThroughImage(data, dims, fit);
    if (image) images.push(image);
    else if (!canvas) noCanvas = true;
  }
  if (noCanvas) {
    const why = canvasUnavailableReason();
    warnings.push(`${CANVAS_WARNING}${why ? `: ${why}` : ''}`);
  }
  if (skippedFormat > 0)
    warnings.push(`画像形式が非対応のため${skippedFormat}枚は省きました（EMF/WMF/SVG など）`);
  if (capped > 0)
    warnings.push(
      `画像は${options.maxImages}枚までです。残り${capped}枚は pages を絞って取得してください`,
    );
  return images;
}

export async function renderPptx(
  bytes: Uint8Array,
  options: RenderOptions,
): Promise<RenderedDocument> {
  const lf = await import('@unicontext/local-files');
  const warnings: string[] = [];
  const slides = (await lf.extractPptx(bytes)).slides ?? [];
  const selected = selectPages(slides.length, options, warnings);
  const zip = await JSZip.loadAsync(bytes);
  const paths = await lf.pptxSlidePaths(zip);

  const embedded: Embedded[] = [];
  const hasMedia = new Set<number>();
  for (const n of selected) {
    const part = paths[n - 1];
    const relXml = part
      ? await zip
          .file(part.replace(/^ppt\/slides\//, 'ppt/slides/_rels/') + '.rels')
          ?.async('string')
      : undefined;
    if (!relXml || !part) continue;
    for (const r of relationships(relXml)) {
      if (!/\/image$/.test(r.type)) continue;
      const target = resolveTarget('ppt/slides', r.target);
      if (!zip.file(target)) continue;
      hasMedia.add(n);
      embedded.push({
        path: target,
        page: n,
        label: `slide ${n} ${target.split('/').pop() ?? ''}`.trim(),
      });
    }
  }

  const pages: DocumentPage[] = selected.map((n) => {
    const s = slides[n - 1];
    const text = [s?.title && !s.text.startsWith(s.title) ? s.title : undefined, s?.text]
      .filter(Boolean)
      .join('\n');
    const full = s?.notes ? `${text}\n\n[ノート]\n${s.notes}` : text;
    return {
      index: n,
      kind: 'slide' as const,
      text: full,
      // A slide that is only a picture says nothing as text.
      ...(text.trim().length < SCANNED_PAGE_CHARS && hasMedia.has(n) ? { needsVision: true } : {}),
    };
  });

  const images =
    options.render === 'text' ? [] : await embeddedImages(zip, embedded, options, warnings);
  return { kind: 'pptx', pageCount: slides.length, pages, images, warnings };
}

export async function renderDocx(
  bytes: Uint8Array,
  options: RenderOptions,
): Promise<RenderedDocument> {
  const lf = await import('@unicontext/local-files');
  const warnings: string[] = [];
  const text = (await lf.extractContent(bytes, 'docx')).text ?? '';
  const zip = await JSZip.loadAsync(bytes);
  const embedded: Embedded[] = [];
  const relXml = await zip.file('word/_rels/document.xml.rels')?.async('string');
  const docXml = await zip.file('word/document.xml')?.async('string');
  if (relXml && docXml) {
    const byId = new Map(
      relationships(relXml)
        .filter((r) => /\/image$/.test(r.type))
        .map((r) => [r.id, resolveTarget('word', r.target)] as const),
    );
    // In the order the pictures appear in the text.
    for (const m of docXml.matchAll(/\br:embed="([^"]*)"/g)) {
      const target = byId.get(m[1] ?? '');
      if (target && zip.file(target))
        embedded.push({ path: target, page: 1, label: `image ${target.split('/').pop() ?? ''}` });
    }
  }
  const images =
    options.render === 'text' ? [] : await embeddedImages(zip, embedded, options, warnings);
  return {
    kind: 'docx',
    pageCount: 1,
    pages: [{ index: 1, kind: 'page', text: text.trim() }],
    images,
    warnings,
  };
}
