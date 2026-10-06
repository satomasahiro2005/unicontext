import exifr from 'exifr';
import { imageSize } from 'image-size';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import type { FileSlide } from './types.js';

export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'log',
  'rst',
  'tex',
  'json',
  'ipynb',
  'yaml',
  'yml',
  'toml',
  'ini',
  'xml',
  'sql',
  // source code
  'py',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'java',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'go',
  'rs',
  'rb',
  'php',
  'swift',
  'kt',
  'scala',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'bat',
  'r',
  'jl',
  'lua',
  'pl',
  'm',
  'hs',
  'ml',
  'v',
  'vhd',
  'asm',
  's',
  'css',
  'scss',
  'vue',
  'svelte',
  'dart',
  'ex',
  'exs',
  'erl',
  'clj',
  'lisp',
  'scm',
  'pas',
  'f90',
]);

/** Extensions classified as source code (material kind "code"). */
export const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  'py',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'java',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'go',
  'rs',
  'rb',
  'php',
  'swift',
  'kt',
  'scala',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'bat',
  'r',
  'jl',
  'lua',
  'pl',
  'm',
  'hs',
  'ml',
  'v',
  'vhd',
  'asm',
  's',
  'sql',
  'ipynb',
  'dart',
  'ex',
  'exs',
  'erl',
  'clj',
  'lisp',
  'scm',
  'pas',
  'f90',
  'vue',
  'svelte',
]);
export const HTML_EXTENSIONS: ReadonlySet<string> = new Set(['html', 'htm', 'xhtml']);
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'heic',
  'heif',
]);
export const RECORDING_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp4',
  'm4a',
  'mov',
  'mp3',
  'wav',
  'webm',
  'mkv',
  'aac',
  'flac',
  'ogg',
]);

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword',
  ppt: 'application/vnd.ms-powerpoint',
  xls: 'application/vnd.ms-excel',
  key: 'application/x-iwork-keynote-sffkey',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'application/xhtml+xml',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  zip: 'application/zip',
};

export function mimeTypeFor(ext: string): string {
  const known = MIME[ext];
  if (known) return known;
  if (TEXT_EXTENSIONS.has(ext)) return 'text/plain';
  return 'application/octet-stream';
}

export interface ExtractedContent {
  pages?: { page: number; text: string }[];
  text?: string;
  slides?: FileSlide[];
  image?: { width: number; height: number; takenAt?: string };
}

/** Upper bound of extracted characters per file (keeps the raw store bounded). */
export const MAX_EXTRACTED_CHARS = 2_000_000;

function cap(s: string): string {
  return s.length > MAX_EXTRACTED_CHARS ? s.slice(0, MAX_EXTRACTED_CHARS) : s;
}

/** utf-8 (BOM stripped); UTF-16 by BOM; Shift_JIS when the bytes are not valid utf-8. */
export function decodeText(buf: Uint8Array): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff)
    return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const body =
    buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
      ? buf.subarray(3)
      : buf;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    try {
      return new TextDecoder('shift_jis').decode(body);
    } catch {
      return new TextDecoder('latin1').decode(body);
    }
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  hellip: '…',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
    if (g.startsWith('#x') || g.startsWith('#X')) {
      const cp = parseInt(g.slice(2), 16);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    if (g.startsWith('#')) {
      const cp = parseInt(g.slice(1), 10);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED_ENTITIES[g.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): string {
  const withoutNoise = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(withoutNoise)?.[1];
  const body = withoutNoise
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, ' ')
    .replace(
      /<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|section|article|table|ul|ol|blockquote|pre)\s*>/gi,
      '\n',
    )
    .replace(/<[^>]+>/g, '');
  const text = decodeEntities(body)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const t = title ? decodeEntities(title).replace(/\s+/g, ' ').trim() : '';
  return t ? `${t}\n\n${text}`.trim() : text;
}

async function extractPdf(buf: Uint8Array): Promise<ExtractedContent> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    let total = 0;
    const pages: { page: number; text: string }[] = [];
    for (let i = 0; i < text.length; i++) {
      let t = (text[i] ?? '').trim();
      if (total + t.length > MAX_EXTRACTED_CHARS)
        t = t.slice(0, Math.max(0, MAX_EXTRACTED_CHARS - total));
      total += t.length;
      pages.push({ page: i + 1, text: t });
    }
    return { pages };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

async function extractDocx(buf: Uint8Array): Promise<ExtractedContent> {
  const res = await mammoth.extractRawText({ buffer: Buffer.from(buf) });
  return { text: cap(res.value.trim()) };
}

/** Text of an OOXML fragment: paragraphs (`<a:p>`) joined by newlines, runs (`<a:t>`) concatenated. */
function drawingText(xml: string): string {
  const paragraphs: string[] = [];
  for (const p of xml.matchAll(/<a:p[ >][\s\S]*?<\/a:p>|<a:p\/>/g)) {
    const runs: string[] = [];
    for (const m of p[0].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\s*\/>/g))
      runs.push(m[1] === undefined ? '\n' : decodeEntities(m[1]));
    const line = runs.join('').trim();
    if (line) paragraphs.push(line);
  }
  return paragraphs.join('\n');
}

function slideTitle(xml: string): string | undefined {
  for (const sp of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
    if (/<p:ph\b[^>]*type="(?:title|ctrTitle)"/.test(sp[0])) {
      const t = drawingText(sp[0]).replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
  }
  return undefined;
}

export function relTargets(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[0])?.[1];
    const target = /\bTarget="([^"]*)"/.exec(m[0])?.[1];
    if (id && target) map.set(id, target);
  }
  return map;
}

/**
 * Paths of the slide parts of a PPTX in presentation order (`ppt/slides/slideN.xml`): from
 * presentation.xml (sldIdLst) and its relationships, else by slide number.
 */
export async function pptxSlidePaths(zip: JSZip): Promise<string[]> {
  const read = async (name: string): Promise<string | undefined> => zip.file(name)?.async('string');
  let slidePaths: string[] = [];
  const pres = await read('ppt/presentation.xml');
  const presRels = await read('ppt/_rels/presentation.xml.rels');
  if (pres && presRels) {
    const rels = relTargets(presRels);
    for (const m of pres.matchAll(/<p:sldId\b[^>]*\br:id="([^"]*)"/g)) {
      const target = rels.get(m[1] as string);
      if (target) slidePaths.push(`ppt/${target.replace(/^\/?(?:ppt\/)?/, '')}`);
    }
  }
  slidePaths = slidePaths.filter((p) => zip.file(p));
  if (slidePaths.length === 0) {
    const num = (n: string): number => Number(/(\d+)\.xml$/.exec(n)?.[1] ?? 0);
    slidePaths = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => num(a) - num(b));
  }
  return slidePaths;
}

export async function extractPptx(buf: Uint8Array): Promise<ExtractedContent> {
  const zip = await JSZip.loadAsync(buf);
  const read = async (name: string): Promise<string | undefined> => zip.file(name)?.async('string');
  const slidePaths = await pptxSlidePaths(zip);

  const slides: FileSlide[] = [];
  let total = 0;
  for (const [i, path] of slidePaths.entries()) {
    const xml = (await read(path)) ?? '';
    const title = slideTitle(xml);
    let text = drawingText(xml);
    let notes: string | undefined;
    const relXml = await read(`${path.replace(/^ppt\/slides\//, 'ppt/slides/_rels/')}.rels`);
    if (relXml) {
      for (const target of relTargets(relXml).values()) {
        if (!/notesSlide\d+\.xml$/.test(target)) continue;
        const nx = await read(`ppt/notesSlides/${target.split('/').pop() ?? ''}`);
        if (!nx) continue;
        // Notes pages also hold slide-number placeholders; keep only the body placeholder.
        const body = [...nx.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)]
          .map((s) => s[0])
          .filter((s) => /<p:ph\b[^>]*type="body"/.test(s))
          .map(drawingText)
          .join('\n')
          .trim();
        if (body) notes = body;
      }
    }
    if (total + text.length > MAX_EXTRACTED_CHARS)
      text = text.slice(0, Math.max(0, MAX_EXTRACTED_CHARS - total));
    total += text.length + (notes?.length ?? 0);
    slides.push({
      slide: i + 1,
      ...(title ? { title } : {}),
      text,
      ...(notes ? { notes } : {}),
    });
  }
  return { slides };
}

async function extractImage(buf: Uint8Array): Promise<ExtractedContent> {
  let dims: { width: number; height: number } | undefined;
  try {
    const s = imageSize(buf);
    if (s.width && s.height) dims = { width: s.width, height: s.height };
  } catch {
    dims = undefined;
  }
  let takenAt: string | undefined;
  try {
    const tags = (await exifr.parse(buf, ['DateTimeOriginal', 'CreateDate'])) as
      { DateTimeOriginal?: unknown; CreateDate?: unknown } | undefined;
    const v = tags?.DateTimeOriginal ?? tags?.CreateDate;
    if (v instanceof Date && !Number.isNaN(v.getTime())) takenAt = v.toISOString();
  } catch {
    takenAt = undefined;
  }
  return dims ? { image: { ...dims, ...(takenAt ? { takenAt } : {}) } } : {};
}

/**
 * Extract text/metadata according to the extension. Throws on corrupt files (the caller turns
 * that into a warning). Unknown extensions return an empty result (metadata only).
 */
export async function extractContent(buf: Uint8Array, ext: string): Promise<ExtractedContent> {
  if (ext === 'pdf') return extractPdf(buf);
  if (ext === 'docx') return extractDocx(buf);
  if (ext === 'pptx') return extractPptx(buf);
  if (HTML_EXTENSIONS.has(ext)) return { text: cap(htmlToText(decodeText(buf))) };
  if (TEXT_EXTENSIONS.has(ext)) return { text: cap(decodeText(buf).trim()) };
  if (IMAGE_EXTENSIONS.has(ext)) return extractImage(buf);
  return {};
}
