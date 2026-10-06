import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DocumentChunk, isEntityKind, isIdOf } from '@unicontext/canonical-model';
import { errorMessage, NotFoundError, ValidationError } from '@unicontext/core';
import type { Citation } from '@unicontext/provenance';
import {
  canDownloadFile,
  type DownloadFilesReport,
  downloadCourseFiles,
  resolveFileRef,
} from './files.js';
import { type DocumentImage, renderImageFile } from './render/image.js';
import { renderPdf } from './render/pdf.js';
import { renderDocx, renderPptx } from './render/pptx.js';
import {
  type DocumentPage,
  type RenderedDocument,
  type RenderMode,
  type RenderOptions,
} from './render/types.js';
import type { UniContext } from './runtime.js';

export type { DocumentImage } from './render/image.js';
export type { DocumentPage, RenderedDocument, RenderMode } from './render/types.js';

/*
 * One door to any document UniContext knows: `resolveDocument` turns an id (document: / material: /
 * announcement: / a search hit / "<course>/<path>" / a path inside a local-files root) into a
 * handle, `handle.fetch()` gets its bytes on demand through whatever source has them, and
 * `readDocument` renders them: text page by page or slide by slide, plus pictures for the client's
 * vision. Read-only everywhere: only requests a source already allows are made, and a document
 * whose source forbids downloads (LiveCampusU attachments) comes back as `unsupported` with the
 * address to open it at.
 */

export interface UnsupportedDocument {
  reason: string;
  /** Where the student can open it themselves. */
  openUrl?: string;
}

export type DocumentFetch =
  | { ok: true; path: string; bytes?: undefined; fileName: string; mimeType?: string }
  | { ok: true; bytes: Uint8Array; path?: undefined; fileName: string; mimeType?: string }
  | { ok: false; unsupported: UnsupportedDocument };

export interface DocumentHandle {
  /** `document:…`, `announcement:…`, or `file:<absolute path>` for a local file nobody indexed. */
  id: string;
  /** What was asked for. */
  ref: string;
  sourceId: string | undefined;
  title: string;
  mimeType: string | undefined;
  sizeBytes: number | undefined;
  /** Library path at the source, e.g. "/Ed Lessons/第1回/講義資料.pdf". */
  sourcePath: string | undefined;
  citations: Citation[];
  /** Several documents hang off the id (an announcement with attachments): pick one of these. */
  candidates?: { id: string; title: string }[];
  fetch(): Promise<DocumentFetch>;
  /** The text UniContext stored for the document (what search indexes), page by page. */
  storedPages(): DocumentPage[];
}

export interface ResolveDocumentOptions {
  /** `<data dir>/files` (downloads of sources that serve files). */
  filesDir?: string | undefined;
  /**
   * Download through another process (the daemon holds the browser sessions of Teams and the VPN
   * portal). Default: in this process with `filesDir`.
   */
  downloadFiles?:
    ((refs: string[], options: { extract: boolean }) => Promise<DownloadFilesReport>) | undefined;
  signal?: AbortSignal | undefined;
}

export const LCU_ATTACHMENT_REASON =
  'LiveCampusU の添付は LiveCampusU で開いてください（コネクタ方針でダウンロード不可）';
export const M365_REASON =
  'Microsoft 365（OneDrive・メール）のコネクタは無効のため、この添付・ファイルは取得できません';

const MAX_BYTES = 200 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
};

const extOf = (name: string): string => /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
const mimeFromName = (name: string): string | undefined => MIME_BY_EXT[extOf(name)];

// ---------------------------------------------------------------------------------------------
// Resolution

const isLocalPathRef = (r: string): boolean =>
  r.startsWith('file://') || r.startsWith('~') || path.isAbsolute(r) || /^[A-Za-z]:[\\/]/.test(r);

/** Roots of the local-files source(s), as the indexed files recorded them. */
function localRoots(uc: UniContext): string[] {
  const rows = uc.db.sqlite
    .prepare(
      `SELECT DISTINCT json_extract(payload_json, '$.root') AS root FROM raw_items
       WHERE source_type = 'file.document' AND deleted_at IS NULL`,
    )
    .all() as { root: string | null }[];
  return rows.map((r) => r.root).filter((r): r is string => typeof r === 'string' && r !== '');
}

const norm = (p: string): string =>
  process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);

function inside(root: string, file: string): boolean {
  const rel = path.relative(norm(root), norm(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Document handle of a path on this computer. Only files inside a configured local-files root:
 * anything else is refused (this tool is not a way to read the rest of the disk).
 */
function resolveLocalPath(uc: UniContext, ref: string): DocumentHandle {
  let p = ref.trim();
  if (p.startsWith('file://')) p = fileURLToPath(p);
  else if (p === '~' || p.startsWith('~/') || p.startsWith('~\\'))
    p = path.join(homedir(), p.slice(1));
  p = path.resolve(p);
  const roots = localRoots(uc);
  const root = roots.find((r) => inside(r, p));
  if (!root)
    throw new ValidationError(
      `"${ref}" is not inside a local-files folder UniContext reads (${roots.length} configured)`,
    );
  if (!existsSync(p) || !statSync(p).isFile()) throw new NotFoundError(`file ${ref}`);
  // A link inside the root that leads outside it is not a file of the root.
  const real = realpathSync(p);
  if (!inside(realpathSync(root), real))
    throw new ValidationError(`"${ref}" leads outside the local-files folder`);
  const rel = path.relative(root, p).split(path.sep).join('/');
  const hit = uc.db.sqlite
    .prepare(
      `SELECT id FROM raw_items WHERE source_type = 'file.document' AND deleted_at IS NULL
       AND json_extract(payload_json, '$.root') = ? AND json_extract(payload_json, '$.relativePath') = ?`,
    )
    .get(root, rel) as { id: string } | undefined;
  if (hit) {
    for (const sr of uc.sync.stores.sourceRefs.byRawItem(hit.id))
      if (sr.entityId && isIdOf('document', sr.entityId))
        return documentHandle(uc, sr.entityId, ref, {});
  }
  const size = statSync(p).size;
  return {
    id: `file:${p}`,
    ref,
    sourceId: 'local-files',
    title: path.basename(p),
    mimeType: mimeFromName(p),
    sizeBytes: size,
    sourcePath: rel,
    citations: [],
    fetch: () =>
      Promise.resolve({
        ok: true,
        path: p,
        fileName: path.basename(p),
        ...(mimeFromName(p) ? { mimeType: mimeFromName(p) as string } : {}),
      }),
    storedPages: () => [],
  };
}

/**
 * Handle of any document reference: `document:…`, `material:…`, `announcement:…`, the id of a
 * search hit (a document chunk), `<course>/<path>`, or a path inside a local-files root.
 */
export function resolveDocument(
  uc: UniContext,
  ref: string,
  options: ResolveDocumentOptions = {},
): DocumentHandle {
  const r = ref.trim();
  if (!r) throw new ValidationError('give a document id, "<course>/<path>" or a local path');
  if (isLocalPathRef(r)) return resolveLocalPath(uc, r);
  const entities = uc.sync.stores.entities;
  if (isIdOf('announcement', r)) return announcementHandle(uc, r, options);
  if (isIdOf('documentChunk', r)) {
    const chunk = entities.getOfKind('documentChunk', r);
    if (!chunk) throw new NotFoundError(`document ${r}`);
    return documentHandle(uc, chunk.documentId, r, options);
  }
  if (isIdOf('material', r)) {
    const m = entities.getOfKind('material', r);
    if (!m) throw new NotFoundError(`document ${r}`);
    if (m.documentId) return documentHandle(uc, m.documentId, r, options);
    return unsupportedHandle(
      uc,
      r,
      r,
      m.title,
      m.url,
      'この資料にはファイルが取り込まれていません（リンクだけです）',
    );
  }
  const prefix = r.slice(0, Math.max(0, r.indexOf(':')));
  if (prefix !== '' && prefix !== 'document' && isEntityKind(prefix))
    throw new ValidationError(
      `${r} is not a document (use a document:… id; for an assignment use get_assignment)`,
    );
  return documentHandle(uc, resolveFileRef(uc, r), r, options);
}

function unsupportedHandle(
  uc: UniContext,
  id: string,
  ref: string,
  title: string,
  openUrl: string | undefined,
  reason: string,
): DocumentHandle {
  return {
    id,
    ref,
    sourceId: undefined,
    title,
    mimeType: undefined,
    sizeBytes: undefined,
    sourcePath: undefined,
    citations: uc.context.citationsFor([id]),
    fetch: () =>
      Promise.resolve({ ok: false, unsupported: { reason, ...(openUrl ? { openUrl } : {}) } }),
    storedPages: () => [],
  };
}

function chunksOf(uc: UniContext, documentId: string): DocumentChunk[] {
  return uc.sync.stores.entities
    .list('documentChunk', { where: { documentId }, orderBy: 'ordinal' })
    .sort((a, b) => a.ordinal - b.ordinal);
}

function storedPagesOf(uc: UniContext, documentId: string): DocumentPage[] {
  const d = uc.sync.stores.entities.getOfKind('document', documentId);
  const slides =
    /\.(pptx?|key|odp)$/i.test(d?.title ?? '') || /presentation/i.test(d?.mimeType ?? '');
  const kind = slides ? ('slide' as const) : ('page' as const);
  const chunks = chunksOf(uc, documentId);
  if (chunks.length === 0) return d?.text ? [{ index: 1, kind: 'page', text: d.text }] : [];
  const byPage = new Map<number, string[]>();
  for (const c of chunks) {
    const list = byPage.get(c.page ?? 1) ?? [];
    list.push(c.text);
    byPage.set(c.page ?? 1, list);
  }
  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, texts]) => ({ index, kind, text: texts.join('\n') }));
}

type SourceKind = 'local' | 'blob' | 'lcu' | 'm365' | 'other';

function sourceKind(uc: UniContext, sourceId: string, sourceType: string): SourceKind {
  if (sourceType === 'file.document') return 'local';
  let product = '';
  try {
    product = uc.sync.getSource(sourceId).metadata.product.toLowerCase();
  } catch {
    // the connector is not loaded in this process
  }
  if (product === 'livecampusu' || sourceType.startsWith('lcu.')) return 'lcu';
  if (product.startsWith('microsoft365') || sourceType.startsWith('graph.')) return 'm365';
  return 'other';
}

function documentHandle(
  uc: UniContext,
  documentId: string,
  ref: string,
  options: ResolveDocumentOptions,
): DocumentHandle {
  const stores = uc.sync.stores;
  const doc = stores.entities.getOfKind('document', documentId);
  if (!doc) throw new NotFoundError(`document ${documentId}`);
  const raws = stores.sourceRefs
    .forEntity(documentId)
    .flatMap((sr) => (sr.rawItemId ? [stores.raw.get(sr.rawItemId)] : []))
    .filter((r): r is NonNullable<typeof r> => r !== undefined && !r.deletedAt);
  const sourceId = raws[0]?.sourceId;
  const fileName = doc.title;

  const fetch = async (): Promise<DocumentFetch> => {
    let unsupported: UnsupportedDocument | undefined;
    // 1. a file on this computer (local-files)
    for (const raw of raws) {
      if (sourceKind(uc, raw.sourceId, raw.sourceType) !== 'local') continue;
      const p = raw.payload as { root?: unknown; relativePath?: unknown; name?: unknown };
      if (typeof p.root !== 'string' || typeof p.relativePath !== 'string') continue;
      const file = path.join(p.root, ...p.relativePath.split('/'));
      if (existsSync(file))
        return {
          ok: true,
          path: file,
          fileName: typeof p.name === 'string' ? p.name : fileName,
          ...((doc.mimeType ?? mimeFromName(file))
            ? { mimeType: (doc.mimeType ?? mimeFromName(file)) as string }
            : {}),
        };
      unsupported = {
        reason: `ローカルのファイルが見つかりません（移動または削除された可能性）: ${file}`,
      };
    }
    // 2. a source that serves files on request (Teams, the VPN file share, Ed attachments)
    if (canDownloadFile(uc, documentId)) {
      const run =
        options.downloadFiles ??
        ((refs: string[], o: { extract: boolean }) => {
          if (!options.filesDir) throw new ValidationError('file downloads are not available here');
          return downloadCourseFiles(uc, refs, {
            filesDir: options.filesDir,
            extract: o.extract,
            ...(options.signal ? { signal: options.signal } : {}),
          });
        });
      try {
        const report = await run([documentId], { extract: false });
        const r = report.results[0];
        if ((r?.status === 'downloaded' || r?.status === 'cached') && r.path)
          return {
            ok: true,
            path: r.path,
            fileName,
            ...((r.mimeType ?? doc.mimeType)
              ? { mimeType: (r.mimeType ?? doc.mimeType) as string }
              : {}),
          };
        unsupported = {
          reason:
            r?.status === 'tooLarge'
              ? 'ファイルが大きすぎるため取得しませんでした'
              : `ダウンロードできませんでした${r?.error ? `: ${r.error}` : ''}`,
          ...(doc.url ? { openUrl: doc.url } : {}),
        };
      } catch (e) {
        unsupported = {
          reason: `ダウンロードできませんでした: ${errorMessage(e)}`,
          ...(doc.url ? { openUrl: doc.url } : {}),
        };
      }
    }
    // 3. bytes the source kept (the portal's PDFs are stored as raw blobs)
    for (const raw of raws) {
      const row = uc.db.sqlite
        .prepare(
          'SELECT id, mime_type FROM raw_blobs WHERE raw_item_id = ? ORDER BY created_at LIMIT 1',
        )
        .get(raw.id) as { id: string; mime_type: string | null } | undefined;
      if (!row) continue;
      try {
        const bytes = stores.raw.readBlob(row.id);
        return {
          ok: true,
          bytes,
          fileName,
          ...((row.mime_type ?? doc.mimeType)
            ? { mimeType: (row.mime_type ?? doc.mimeType) as string }
            : {}),
        };
      } catch (e) {
        unsupported = { reason: `保存済みのファイルを読めませんでした: ${errorMessage(e)}` };
      }
    }
    // 4. sources whose connector policy or state rules a download out
    if (!unsupported)
      for (const raw of raws) {
        const k = sourceKind(uc, raw.sourceId, raw.sourceType);
        if (k === 'lcu')
          unsupported = { reason: LCU_ATTACHMENT_REASON, ...(doc.url ? { openUrl: doc.url } : {}) };
        else if (k === 'm365')
          unsupported = { reason: M365_REASON, ...(doc.url ? { openUrl: doc.url } : {}) };
        if (unsupported) break;
      }
    return {
      ok: false,
      unsupported: unsupported ?? {
        reason: 'このファイルの取得方法がありません（本文は取り込み済みの分だけ返します）',
        ...(doc.url ? { openUrl: doc.url } : {}),
      },
    };
  };

  return {
    id: documentId,
    ref,
    sourceId,
    title: doc.title,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    sourcePath: doc.path,
    citations: uc.context.citationsFor([documentId]),
    fetch,
    storedPages: () => storedPagesOf(uc, documentId),
  };
}

/**
 * An announcement: its attached files when they are documents (Ed text attachments), else what
 * can be said about the attachments (LiveCampusU lists names only and forbids downloading them).
 */
function announcementHandle(
  uc: UniContext,
  id: string,
  options: ResolveDocumentOptions,
): DocumentHandle {
  const stores = uc.sync.stores;
  const a = stores.entities.getOfKind('announcement', id);
  if (!a) throw new NotFoundError(`announcement ${id}`);
  const refs = stores.sourceRefs.forEntity(id);
  const docs = new Map<string, string>();
  for (const sr of refs) {
    if (!sr.rawItemId) continue;
    for (const other of stores.sourceRefs.byRawItem(sr.rawItemId)) {
      if (!other.entityId || !isIdOf('document', other.entityId)) continue;
      const d = stores.entities.getOfKind('document', other.entityId);
      if (d) docs.set(d.id, d.title);
    }
  }
  if (docs.size === 1) return documentHandle(uc, [...docs.keys()][0] as string, id, options);

  const raws = refs
    .flatMap((sr) => (sr.rawItemId ? [stores.raw.get(sr.rawItemId)] : []))
    .filter((r): r is NonNullable<typeof r> => r !== undefined);
  const lcu = raws.some((r) => sourceKind(uc, r.sourceId, r.sourceType) === 'lcu');
  const m365 = raws.some((r) => sourceKind(uc, r.sourceId, r.sourceType) === 'm365');
  const extra = (a.extra ?? {}) as { attachments?: { name?: unknown }[] };
  const names = (Array.isArray(extra.attachments) ? extra.attachments : [])
    .map((x) => (typeof x?.name === 'string' ? x.name : undefined))
    .filter((x): x is string => x !== undefined);
  const candidates = [...docs.entries()].map(([cid, title]) => ({ id: cid, title }));
  const reason =
    candidates.length > 1
      ? `このお知らせには添付が${candidates.length}件あります。candidates の id を指定してください`
      : lcu
        ? LCU_ATTACHMENT_REASON
        : m365
          ? M365_REASON
          : names.length > 0
            ? '添付ファイルは UniContext に取り込まれていません'
            : 'このお知らせに添付ファイルはありません（本文は get_announcement で読めます）';
  return {
    id,
    ref: id,
    sourceId: raws[0]?.sourceId,
    title: a.title,
    mimeType: undefined,
    sizeBytes: undefined,
    sourcePath: names.length > 0 ? names.join(', ') : undefined,
    citations: uc.context.citationsFor([id]),
    ...(candidates.length > 1 ? { candidates } : {}),
    fetch: () =>
      Promise.resolve({ ok: false, unsupported: { reason, ...(a.url ? { openUrl: a.url } : {}) } }),
    storedPages: () => [],
  };
}

// ---------------------------------------------------------------------------------------------
// Reading

export interface ReadDocumentOptions {
  /** Pages / slides wanted (1-based). Undefined: the first `defaultPages`. */
  pages?: readonly number[] | undefined;
  /** Default 5. */
  defaultPages?: number;
  /** Default `both`. */
  render?: RenderMode;
  /** At most this many pictures (default 8). */
  maxImages?: number;
  /** Largest base64 size of one picture (default 1.5 MB). */
  maxImageBase64?: number;
  /** OCR scanned pages when the OS can (default true). */
  ocr?: boolean;
}

export interface DocumentRead {
  document: {
    id: string;
    title: string;
    mimeType?: string;
    sizeBytes?: number;
    sourceId?: string;
    path?: string;
  };
  kind: RenderedDocument['kind'];
  pageCount?: number;
  pages: DocumentPage[];
  images: DocumentImage[];
  warnings: string[];
  citations: Citation[];
  /** Set when the bytes cannot be had; `pages` then hold whatever text UniContext stored. */
  unsupported?: UnsupportedDocument;
  candidates?: { id: string; title: string }[];
  /** The pages are UniContext's stored text, not the file. */
  fromStoredText?: boolean;
}

export const DEFAULT_PAGES = 5;
export const DEFAULT_MAX_IMAGES = 8;

/** `1-5`, `2,4-6`, `7` or a list of numbers → ascending unique page numbers. */
export function parsePageSpec(input: string | readonly number[] | undefined): number[] | undefined {
  if (input === undefined) return undefined;
  const out = new Set<number>();
  const add = (n: number): void => {
    if (!Number.isInteger(n) || n < 1 || n > 100_000)
      throw new ValidationError(`pages: "${n}" is not a page number`);
    out.add(n);
    if (out.size > 500) throw new ValidationError('pages: at most 500 pages at a time');
  };
  if (typeof input === 'string') {
    for (const part of input.split(',')) {
      const s = part.trim();
      if (!s) continue;
      const range = /^(\d+)\s*-\s*(\d+)$/.exec(s);
      if (range) {
        const a = Number(range[1]);
        const b = Number(range[2]);
        if (b < a) throw new ValidationError(`pages: "${s}" runs backwards`);
        if (b - a >= 500) throw new ValidationError('pages: at most 500 pages at a time');
        for (let n = a; n <= b; n++) add(n);
      } else if (/^\d+$/.test(s)) add(Number(s));
      else throw new ValidationError(`pages: cannot read "${s}" (use 3, 1-5 or 2,4-6)`);
    }
  } else for (const n of input) add(n);
  return out.size > 0 ? [...out].sort((a, b) => a - b) : undefined;
}

function kindOfFile(name: string, mime: string | undefined, bytes: Uint8Array): string {
  const head = Buffer.from(bytes.subarray(0, 8)).toString('latin1');
  if (head.startsWith('%PDF')) return 'pdf';
  const ext = extOf(name);
  if (ext) return ext;
  const m = mime ?? '';
  if (m === 'application/pdf') return 'pdf';
  if (m.includes('presentationml')) return 'pptx';
  if (m.includes('wordprocessingml')) return 'docx';
  if (m.startsWith('image/')) return m.slice(6).replace('jpeg', 'jpg');
  if (m.startsWith('text/')) return 'txt';
  return '';
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif']);

async function renderBytes(
  bytes: Uint8Array,
  name: string,
  mime: string | undefined,
  options: RenderOptions,
): Promise<RenderedDocument> {
  const ext = kindOfFile(name, mime, bytes);
  if (ext === 'pdf') return renderPdf(bytes, options);
  if (ext === 'pptx') return renderPptx(bytes, options);
  if (ext === 'docx') return renderDocx(bytes, options);
  if (IMAGE_EXTS.has(ext)) return renderImageFile(bytes, ext, options);
  const lf = await import('@unicontext/local-files');
  const content = await lf.extractContent(bytes, ext);
  const text = content.text ?? content.pages?.map((p) => p.text).join('\n\n') ?? '';
  if (text.trim() === '' && !content.slides)
    return {
      kind: 'other',
      pages: [],
      images: [],
      warnings: [`この形式（.${ext || '不明'}）は本文を取り出せません`],
    };
  return {
    kind: 'text',
    pageCount: 1,
    pages: [{ index: 1, kind: 'page', text: text.trim() }],
    images: [],
    warnings: [],
  };
}

/**
 * Fetch (on demand) and render a document. Never throws for a document that exists: a source that
 * cannot hand over the bytes, or a file that does not open, is reported in `unsupported` /
 * `warnings` with the text UniContext stored (when it has any) in `pages`.
 */
export async function readDocument(
  handle: DocumentHandle,
  options: ReadDocumentOptions = {},
): Promise<DocumentRead> {
  const render = options.render ?? 'both';
  const base = {
    document: {
      id: handle.id,
      title: handle.title,
      ...(handle.mimeType ? { mimeType: handle.mimeType } : {}),
      ...(handle.sizeBytes !== undefined ? { sizeBytes: handle.sizeBytes } : {}),
      ...(handle.sourceId ? { sourceId: handle.sourceId } : {}),
      ...(handle.sourcePath ? { path: handle.sourcePath } : {}),
    },
    citations: handle.citations,
    ...(handle.candidates ? { candidates: handle.candidates } : {}),
  };
  const fallback = (warnings: string[], unsupported?: UnsupportedDocument): DocumentRead => {
    const all = handle.storedPages();
    const wanted = options.pages ? new Set(options.pages) : undefined;
    const limit = options.defaultPages ?? DEFAULT_PAGES;
    const pages = (wanted ? all.filter((p) => wanted.has(p.index)) : all.slice(0, limit)).map(
      (p) => (render === 'images' ? { ...p, text: '' } : p),
    );
    if (!wanted && all.length > limit)
      warnings.push(`先頭の${limit}ページだけを返しています（全${all.length}ページ）`);
    if (pages.length > 0)
      warnings.push('取り込み済みの本文だけを返しています（元のファイルは開けていません）');
    return {
      ...base,
      kind: 'other',
      ...(all.length > 0 ? { pageCount: all.length } : {}),
      pages,
      images: [],
      warnings,
      ...(unsupported ? { unsupported } : {}),
      ...(pages.length > 0 ? { fromStoredText: true } : {}),
    };
  };

  let fetched: DocumentFetch;
  try {
    fetched = await handle.fetch();
  } catch (e) {
    return fallback([`ファイルを取得できませんでした: ${errorMessage(e)}`], {
      reason: errorMessage(e),
    });
  }
  if (!fetched.ok) return fallback([fetched.unsupported.reason], fetched.unsupported);

  let bytes: Uint8Array;
  try {
    if (fetched.path !== undefined) {
      if (statSync(fetched.path).size > MAX_BYTES)
        return fallback(['ファイルが大きすぎるため開きません（200MB超）']);
      bytes = readFileSync(fetched.path);
    } else bytes = fetched.bytes;
  } catch (e) {
    return fallback([`ファイルを読めませんでした: ${errorMessage(e)}`]);
  }

  const renderOptions: RenderOptions = {
    pages: options.pages,
    defaultPages: options.defaultPages ?? DEFAULT_PAGES,
    render,
    maxImages: options.maxImages ?? DEFAULT_MAX_IMAGES,
    maxImageBase64: options.maxImageBase64 ?? 1_500_000,
    ocr: options.ocr !== false,
  };
  let rendered: RenderedDocument;
  try {
    rendered = await renderBytes(
      bytes,
      fetched.fileName,
      fetched.mimeType ?? handle.mimeType,
      renderOptions,
    );
  } catch (e) {
    return fallback([`${fetched.fileName} を開けませんでした: ${errorMessage(e)}`]);
  }
  if (rendered.pages.length === 0 && rendered.kind === 'other') {
    const f = fallback(rendered.warnings);
    return f;
  }
  const pages =
    render === 'images' ? rendered.pages.map((p) => ({ ...p, text: '' })) : rendered.pages;
  return {
    ...base,
    kind: rendered.kind,
    ...(rendered.pageCount !== undefined ? { pageCount: rendered.pageCount } : {}),
    pages,
    images: rendered.images,
    warnings: rendered.warnings,
  };
}

/** Test hooks: a missing native canvas, a fake OCR engine. */
export { setCanvasLoader } from './render/image.js';
export { setOcrEnvironment } from './render/ocr.js';
