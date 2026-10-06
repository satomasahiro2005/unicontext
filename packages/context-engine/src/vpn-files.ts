import { stableId, type Document } from '@unicontext/canonical-model';
import type { RawItemRecord } from '@unicontext/database';
import type { UniContext } from './runtime.js';

/*
 * Browsing and searching the Shizuoka SSL-VPN file share from UniContext's LOCAL index — never the
 * live portal (the portal is flaky and the session is short, docs/research/shizuoka-vpn-files.md).
 * The background sync keeps the tree in the raw store (`szvpn.folder`/`szvpn.file`); these read it
 * and answer instantly, and each folder carries the time it was last listed successfully.
 *
 * Downloading a file's bytes/text is the shared on-demand path (downloadCourseFiles /
 * download_course_file) by the file's document id; this module only reads metadata.
 */

export const VPN_FOLDER_TYPE = 'szvpn.folder';
export const VPN_FILE_TYPE = 'szvpn.file';
export const VPN_PLATFORM = 'vpn-fs';

interface FolderChild {
  name: string;
  isFile: boolean;
  path: string;
  sizeBytes?: number;
  modifiedAt?: string;
}
interface CourseHint {
  title: string;
  year?: number;
}
interface FolderPayload {
  root: string;
  path: string;
  name: string;
  parent?: string;
  label: string;
  listedAt: string;
  status: 'ok' | 'forbidden';
  accessError?: string;
  childFileCount: number;
  childFolderCount: number;
  depth: number;
  children: FolderChild[];
  course?: CourseHint | null;
}

export interface VpnFolderRef {
  source: string;
  root: string;
  path: string;
  name: string;
  label: string;
  listedAt?: string;
  status: 'ok' | 'forbidden' | 'unlisted';
  accessError?: string;
  fileCount: number;
  folderCount: number;
  course?: CourseHint;
}

export interface VpnFileRef {
  /** Document id (document:…) — pass to download_course_file. */
  id: string;
  source: string;
  root: string;
  name: string;
  /** Full path within the share (no leading slash). */
  path: string;
  label: string;
  sizeBytes?: number;
  modifiedAt?: string;
  mimeType?: string;
  /** Text has been extracted and is searchable. */
  indexed?: boolean;
  course?: CourseHint;
}

export interface VpnBrowse {
  /** '' when listing the roots. */
  source?: string;
  root?: string;
  path: string;
  label: string;
  listedAt?: string;
  status: 'ok' | 'forbidden' | 'unlisted' | 'roots';
  accessError?: string;
  folders: VpnFolderRef[];
  files: VpnFileRef[];
  /** More children than `limit`; raise `offset`. */
  truncated?: boolean;
  /**
   * Only when nothing has been indexed yet: why (each VPN source's sync state), so an empty
   * answer is never read as "the share is empty".
   */
  index?: VpnIndexStatus;
}

export interface VpnIndexStatus {
  empty: true;
  sources: {
    source: string;
    /** Connector health: healthy / auth_required / degraded / … (never_synced when unknown). */
    health: string;
    message?: string;
    lastSuccessAt?: string;
  }[];
  note: string;
}

/** Why the index is empty (no folder listed yet), from the VPN sources' health. */
function emptyIndexStatus(uc: UniContext, source?: string): VpnIndexStatus {
  const sources = uc.sync
    .sources()
    .filter((s) => s.metadata.rawTypes.includes(VPN_FOLDER_TYPE))
    .filter((s) => !source || s.sourceId === source)
    .map((s) => {
      const h = uc.sync.health(s.sourceId);
      return {
        source: s.sourceId,
        health: h?.state ?? 'never_synced',
        ...(h?.message ? { message: h.message } : {}),
        ...(h?.lastSuccessAt ? { lastSuccessAt: h.lastSuccessAt } : {}),
      };
    });
  const signIn = sources.some((s) => s.health === 'auth_required');
  return {
    empty: true,
    sources,
    note: signIn
      ? 'VPNファイル共有の索引はまだ空です（フォルダを1つも一覧できていません）。SSL-VPN ポータルへのサインインが必要です。「共有が空」という意味ではありません。 / The VPN file index is still empty (no folder listed yet): the SSL-VPN portal needs a sign-in. This does not mean the share is empty.'
      : 'VPNファイル共有の索引はまだ空です（フォルダを1つも一覧できていません）。「共有が空」という意味ではありません。 / The VPN file index is still empty (no folder listed yet). This does not mean the share is empty.',
  };
}

/**
 * `{ index }` when no folder of the VPN sources has been listed yet (else `{}`): attached to every
 * answer that could otherwise read as "nothing there" (browse, search, recent).
 */
function emptyIndexField(
  uc: UniContext,
  source: string | undefined,
  index: Map<string, FolderEntry> = folderIndex(uc, source),
): { index?: VpnIndexStatus } {
  return index.size === 0 ? { index: emptyIndexStatus(uc, source) } : {};
}

const norm = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

function parseFolder(rec: RawItemRecord): FolderPayload | undefined {
  const p = rec.payload as Partial<FolderPayload> | undefined;
  if (!p || typeof p.root !== 'string' || typeof p.path !== 'string' || !Array.isArray(p.children))
    return undefined;
  return p as FolderPayload;
}

interface FolderEntry {
  source: string;
  payload: FolderPayload;
}

/** All folder records (optionally one source), newest listing per (source, root, path). */
function folderIndex(uc: UniContext, source?: string): Map<string, FolderEntry> {
  const recs = uc.sync.stores.raw.list({
    sourceTypes: [VPN_FOLDER_TYPE],
    ...(source ? { sourceId: source } : {}),
  });
  const map = new Map<string, FolderEntry>();
  for (const rec of recs) {
    const payload = parseFolder(rec);
    if (!payload) continue;
    map.set(`${rec.sourceId}\u0000${payload.root}\u0000${payload.path}`, {
      source: rec.sourceId,
      payload,
    });
  }
  return map;
}

function folderRef(
  entry: FolderEntry | undefined,
  source: string,
  root: string,
  path: string,
  name: string,
): VpnFolderRef {
  if (!entry)
    return {
      source,
      root,
      path,
      name,
      label: name,
      status: 'unlisted',
      fileCount: 0,
      folderCount: 0,
    };
  const p = entry.payload;
  return {
    source: entry.source,
    root: p.root,
    path: p.path,
    name: p.name || name,
    label: p.label,
    listedAt: p.listedAt,
    status: p.status,
    ...(p.accessError ? { accessError: p.accessError } : {}),
    fileCount: p.childFileCount,
    folderCount: p.childFolderCount,
    ...(p.course ? { course: p.course } : {}),
  };
}

function docIdFor(source: string, root: string, path: string): string {
  return stableId('document', source, root, path);
}

function fileRef(
  uc: UniContext,
  source: string,
  root: string,
  child: FolderChild,
  course?: CourseHint,
): VpnFileRef {
  const id = docIdFor(source, root, child.path);
  const doc = uc.sync.stores.entities.getOfKind('document', id);
  const indexed =
    uc.sync.stores.entities.list('documentChunk', { where: { documentId: id }, limit: 1 }).length >
    0;
  return {
    id,
    source,
    root,
    name: child.name,
    path: child.path,
    label:
      doc?.extra && typeof doc.extra.label === 'string' ? doc.extra.label : `${root}/${child.path}`,
    ...(child.sizeBytes !== undefined
      ? { sizeBytes: child.sizeBytes }
      : doc?.sizeBytes !== undefined
        ? { sizeBytes: doc.sizeBytes }
        : {}),
    ...(child.modifiedAt
      ? { modifiedAt: child.modifiedAt }
      : doc?.modifiedAt
        ? { modifiedAt: doc.modifiedAt }
        : {}),
    ...(doc?.mimeType ? { mimeType: doc.mimeType } : {}),
    ...(indexed ? { indexed: true } : {}),
    ...(course ? { course } : {}),
  };
}

/**
 * Browse one folder of the indexed tree (or, with no root, the roots). `path` is share-relative.
 * Shows subfolders (with their own last-listed time) and files directly in the folder.
 */
export function browseVpnFiles(
  uc: UniContext,
  options: { source?: string; root?: string; path?: string; limit?: number; offset?: number } = {},
): VpnBrowse {
  const index = folderIndex(uc, options.source);
  const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
  const offset = Math.max(0, options.offset ?? 0);

  // No root chosen → list the roots (folders with no parent).
  if (!options.root && (options.path === undefined || options.path === '')) {
    const roots = [...index.values()]
      .filter((e) => e.payload.parent === undefined || e.payload.parent === null)
      .sort((a, b) => a.payload.label.localeCompare(b.payload.label, 'ja'));
    // When there is exactly one root, step straight into it.
    if (roots.length === 1 && options.path === undefined)
      return browseVpnFiles(uc, { ...options, root: roots[0]!.payload.root });
    return {
      path: '',
      label: 'VPN ファイル共有',
      status: 'roots',
      folders: roots.map((e) =>
        folderRef(e, e.source, e.payload.root, e.payload.path, e.payload.name || e.payload.label),
      ),
      files: [],
      ...emptyIndexField(uc, options.source, index),
    };
  }

  const root = options.root!;
  const path = options.path ?? '';
  // Resolve the source if not given (first that has this folder).
  let entry: FolderEntry | undefined;
  if (options.source) entry = index.get(`${options.source}\u0000${root}\u0000${path}`);
  else
    for (const e of index.values())
      if (e.payload.root === root && e.payload.path === path) {
        entry = e;
        break;
      }
  const source = entry?.source ?? options.source ?? '';
  if (!entry)
    return {
      source,
      root,
      path,
      label: path ? `${root}/${path}` : root,
      status: 'unlisted',
      folders: [],
      files: [],
      ...emptyIndexField(uc, options.source, index),
    };

  const p = entry.payload;
  const children = p.children.slice(offset, offset + limit);
  const folders: VpnFolderRef[] = [];
  const files: VpnFileRef[] = [];
  for (const c of children) {
    if (c.isFile) files.push(fileRef(uc, source, root, c, p.course ?? undefined));
    else {
      const sub = index.get(`${source}\u0000${root}\u0000${c.path}`);
      folders.push(folderRef(sub, source, root, c.path, c.name));
    }
  }
  return {
    source,
    root,
    path,
    label: p.label,
    listedAt: p.listedAt,
    status: p.status,
    ...(p.accessError ? { accessError: p.accessError } : {}),
    ...(p.course ? { course: p.course } : {}),
    folders,
    files,
    ...(p.children.length > offset + limit ? { truncated: true } : {}),
  };
}

export interface VpnSearchResult {
  files: VpnFileRef[];
  folders: VpnFolderRef[];
  truncated: boolean;
  /** Only when nothing has been indexed yet (see {@link VpnBrowse.index}). */
  index?: VpnIndexStatus;
}

/** Substring search over the indexed tree (file/folder name and path), optional year/course filters. */
export function searchVpnFiles(
  uc: UniContext,
  options: {
    query: string;
    source?: string;
    root?: string;
    year?: number;
    course?: string;
    limit?: number;
  },
): VpnSearchResult {
  const q = norm(options.query);
  const limit = Math.max(1, Math.min(options.limit ?? 30, 200));
  if (!q)
    return { files: [], folders: [], truncated: false, ...emptyIndexField(uc, options.source) };

  // Course filter → the set of linked offering ids.
  let courseIds: Set<string> | undefined;
  if (options.course) {
    const linked = new Set<string>();
    const offerings = uc.sync.stores.entities.list('courseOffering');
    for (const o of offerings)
      if (norm(o.title).includes(norm(options.course)) || o.id === options.course)
        for (const id of uc.identity.expand(o.id)) linked.add(id);
    courseIds = linked;
  }

  const files: VpnFileRef[] = [];
  const docs = uc.sync.stores.entities.list('document') as Document[];
  let fileTrunc = false;
  for (const d of docs) {
    const extra = d.extra ?? {};
    if (extra.platform !== VPN_PLATFORM) continue;
    const root = typeof extra.root === 'string' ? extra.root : '';
    if (options.root && root !== options.root) continue;
    const source = uc.sync.stores.entities.meta(d.id)?.sourceId ?? '';
    if (options.source && source !== options.source) continue;
    const path = (d.path ?? '').replace(/^\/+/, '');
    if (options.year !== undefined && !path.includes(String(options.year))) continue;
    if (courseIds && !(d.courseOfferingId && courseIds.has(d.courseOfferingId))) continue;
    if (!norm(d.title).includes(q) && !norm(path).includes(q)) continue;
    if (files.length >= limit) {
      fileTrunc = true;
      break;
    }
    files.push({
      id: d.id,
      source,
      root,
      name: d.title,
      path,
      label: typeof extra.label === 'string' ? extra.label : `${root}/${path}`,
      ...(d.sizeBytes !== undefined ? { sizeBytes: d.sizeBytes } : {}),
      ...(d.modifiedAt ? { modifiedAt: d.modifiedAt } : {}),
      ...(d.mimeType ? { mimeType: d.mimeType } : {}),
    });
  }

  const folders: VpnFolderRef[] = [];
  const index = folderIndex(uc, options.source);
  for (const e of index.values()) {
    if (options.root && e.payload.root !== options.root) continue;
    if (!norm(e.payload.name).includes(q) && !norm(e.payload.path).includes(q)) continue;
    if (folders.length >= limit) break;
    folders.push(folderRef(e, e.source, e.payload.root, e.payload.path, e.payload.name));
  }
  return { files, folders, truncated: fileTrunc, ...emptyIndexField(uc, options.source, index) };
}

/** Recently added or updated files across the indexed tree, newest first. */
export function recentVpnFiles(
  uc: UniContext,
  options: { source?: string; root?: string; since?: string; limit?: number } = {},
): { files: VpnFileRef[]; index?: VpnIndexStatus } {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 200));
  const docs = uc.sync.stores.entities.list('document') as Document[];
  const rows: { d: Document; at: string; source: string; root: string; path: string }[] = [];
  for (const d of docs) {
    const extra = d.extra ?? {};
    if (extra.platform !== VPN_PLATFORM) continue;
    const root = typeof extra.root === 'string' ? extra.root : '';
    if (options.root && root !== options.root) continue;
    const source = uc.sync.stores.entities.meta(d.id)?.sourceId ?? '';
    if (options.source && source !== options.source) continue;
    const at = d.modifiedAt ?? (typeof extra.listedAt === 'string' ? extra.listedAt : '');
    if (options.since && at && at < options.since) continue;
    rows.push({ d, at, source, root, path: (d.path ?? '').replace(/^\/+/, '') });
  }
  rows.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  return {
    // Files exist only from folder listings: check the (larger) folder index only when none did.
    ...(rows.length === 0 ? emptyIndexField(uc, options.source) : {}),
    files: rows.slice(0, limit).map(({ d, source, root, path }) => ({
      id: d.id,
      source,
      root,
      name: d.title,
      path,
      label: typeof d.extra?.label === 'string' ? d.extra.label : `${root}/${path}`,
      ...(d.sizeBytes !== undefined ? { sizeBytes: d.sizeBytes } : {}),
      ...(d.modifiedAt ? { modifiedAt: d.modifiedAt } : {}),
      ...(d.mimeType ? { mimeType: d.mimeType } : {}),
    })),
  };
}
