import type { Document } from '@unicontext/canonical-model';
import {
  type LinkFailureStatus,
  type LinkFile,
  type LinkResolvingAdapter,
  type LinkSubfolder,
  type RawItem,
  supportsFileDownloads,
  supportsLinks,
} from '@unicontext/connector-sdk';
import { errorMessage, ValidationError } from '@unicontext/core';
import { rawItemId } from '@unicontext/database';
import {
  type DownloadedFileResult,
  type DownloadFilesReport,
  downloadCourseFiles,
  type FileStoreOptions,
} from './files.js';
import type { UniContext } from './runtime.js';

/*
 * open_link: a SharePoint / OneDrive link (typically in a university email the AI reads through
 * another connector) opened through a source that holds the student's signed-in session
 * (teams-web). The source resolves the link read-only; the file(s) are stored as its ordinary
 * file raw items (so they get document ids `download_course_file` accepts, and a class team's
 * file belongs to its course), and a file is then downloaded and text-extracted through the
 * ordinary on-demand download. A link that cannot be opened returns its reason — nothing is
 * guessed.
 */

export const MAX_LINK_LENGTH = 4000;

export interface OpenLinkFileEntry {
  /** Document id (document:…): download_course_file / open_link take it. */
  id: string;
  name: string;
  sizeBytes?: number;
  modifiedAt?: string;
  mimeType?: string;
}

export interface OpenLinkReport {
  url: string;
  status: 'file' | 'folder' | LinkFailureStatus;
  /** Why the link could not be opened (status other than file/folder). */
  reason?: string;
  sourceId?: string;
  /** status file: the stored document and its download (path, text stats, course). */
  file?: DownloadedFileResult;
  /** status folder. */
  folder?: {
    name: string;
    url?: string;
    path?: string;
    childCount?: number;
    course?: { id: string; title: string };
  };
  files?: OpenLinkFileEntry[];
  folders?: LinkSubfolder[];
  truncated?: boolean;
  warnings: string[];
}

export interface OpenLinkOptions extends FileStoreOptions {
  /** Extract text when the file is downloaded (default true). */
  extract?: boolean;
  /** Download a linked file (default true). False: resolve and store only. */
  download?: boolean;
  /** Download override (the MCP server routes it like download_course_file). */
  downloadFiles?: (refs: string[], options: { extract: boolean }) => Promise<DownloadFilesReport>;
  signal?: AbortSignal;
}

function linkSources(uc: UniContext): { sourceId: string; adapter: LinkResolvingAdapter }[] {
  const out: { sourceId: string; adapter: LinkResolvingAdapter }[] = [];
  for (const s of uc.sync.sources())
    if (supportsLinks(s.adapter) && supportsFileDownloads(s.adapter))
      out.push({ sourceId: s.sourceId, adapter: s.adapter });
  return out;
}

function documentOf(uc: UniContext, sourceId: string, f: LinkFile): Document | undefined {
  const stores = uc.sync.stores;
  for (const ref of stores.sourceRefs.byRawItem(rawItemId(sourceId, f.sourceType, f.externalId))) {
    const d = ref.entityId ? stores.entities.getOfKind('document', ref.entityId) : undefined;
    if (d) return d;
  }
  return undefined;
}

function courseOf(uc: UniContext, d: Document): { id: string; title: string } | undefined {
  if (!d.courseOfferingId) return undefined;
  const ids = uc.identity.expand(d.courseOfferingId);
  // Prefer the academic system's offering the team is linked to.
  for (const id of [...ids.filter((x) => x !== d.courseOfferingId), d.courseOfferingId]) {
    const o = uc.sync.stores.entities.getOfKind('courseOffering', id);
    if (o) return { id: o.id, title: o.title };
  }
  return undefined;
}

/** Open a SharePoint / OneDrive link on the student's request. Never throws for the link itself. */
export async function openLink(
  uc: UniContext,
  url: string,
  options: OpenLinkOptions,
): Promise<OpenLinkReport> {
  const link = url.trim();
  if (!link) throw new ValidationError('give a link');
  if (link.length > MAX_LINK_LENGTH)
    throw new ValidationError(`the link is longer than ${MAX_LINK_LENGTH} characters`);
  const base = { url: link, warnings: [] as string[] };
  const sources = linkSources(uc);
  if (sources.length === 0)
    return {
      ...base,
      status: 'unsupported',
      reason:
        'SharePoint / OneDriveのリンクを開ける情報源（teams-web）が設定されていません / no source that can open SharePoint or OneDrive links (teams-web) is set up',
    };
  const source = sources.find((s) => s.adapter.canOpenLink(link));
  if (!source)
    return {
      ...base,
      status: 'unsupported',
      reason: 'SharePoint / OneDriveのリンクではありません / not a SharePoint or OneDrive link',
    };
  const { sourceId, adapter } = source;
  const stores = uc.sync.stores;
  const context = {
    items: stores.raw
      .list({ sourceId, sourceTypes: [...adapter.linkContextSourceTypes] })
      .map((r) => ({ sourceType: r.sourceType, externalId: r.externalId, payload: r.payload })),
  };
  let res;
  try {
    res = await adapter.resolveLink(link, context);
  } catch (e) {
    return { ...base, sourceId, status: 'failed', reason: errorMessage(e) };
  }
  if (res.status !== 'file' && res.status !== 'folder')
    return { ...base, sourceId, status: res.status, reason: res.reason };

  const linked = res.status === 'file' ? [res.file] : res.files;
  const items: RawItem[] = linked.flatMap((f) => (f.raw ? [f.raw] : []));
  if (items.length > 0) await uc.sync.ingest(sourceId, { items });

  if (res.status === 'folder') {
    const files: OpenLinkFileEntry[] = [];
    const courses = new Map<string, { id: string; title: string }>();
    for (const f of res.files) {
      const d = documentOf(uc, sourceId, f);
      if (!d) {
        base.warnings.push(`${f.name}: not stored`);
        continue;
      }
      const c = courseOf(uc, d);
      if (c) courses.set(c.id, c);
      files.push({
        id: d.id,
        name: d.title,
        ...(d.sizeBytes !== undefined ? { sizeBytes: d.sizeBytes } : {}),
        ...(d.modifiedAt ? { modifiedAt: d.modifiedAt } : {}),
        ...(d.mimeType ? { mimeType: d.mimeType } : {}),
      });
    }
    const course = courses.size === 1 ? [...courses.values()][0] : undefined;
    return {
      ...base,
      sourceId,
      status: 'folder',
      folder: { ...res.folder, ...(course ? { course } : {}) },
      files,
      folders: res.folders,
      truncated: res.truncated,
    };
  }

  const d = documentOf(uc, sourceId, res.file);
  if (!d)
    return {
      ...base,
      sourceId,
      status: 'failed',
      reason: `${res.file.name}: the file was resolved but could not be stored`,
    };
  const course = courseOf(uc, d);
  const stored: DownloadedFileResult = {
    id: d.id,
    ref: link,
    title: d.title,
    status: 'notFound',
    ...(d.sizeBytes !== undefined ? { sizeBytes: d.sizeBytes } : {}),
    ...(d.mimeType ? { mimeType: d.mimeType } : {}),
    ...(d.modifiedAt ? { modifiedAt: d.modifiedAt } : {}),
    ...(d.path ? { sourcePath: d.path } : {}),
    ...(course ? { course } : {}),
  };
  if (options.download === false)
    return { ...base, sourceId, status: 'file', file: { ...stored, status: 'unsupported' } };
  const extract = options.extract !== false;
  let report: DownloadFilesReport;
  try {
    report = options.downloadFiles
      ? await options.downloadFiles([d.id], { extract })
      : await downloadCourseFiles(uc, [d.id], {
          filesDir: options.filesDir,
          ...(options.cacheMaxBytes !== undefined ? { cacheMaxBytes: options.cacheMaxBytes } : {}),
          extract,
          ...(options.signal ? { signal: options.signal } : {}),
        });
  } catch (e) {
    return {
      ...base,
      sourceId,
      status: 'file',
      file: { ...stored, status: 'failed', error: errorMessage(e) },
    };
  }
  const r = report.results[0];
  return {
    ...base,
    warnings: [...base.warnings, ...report.warnings],
    sourceId,
    status: 'file',
    file: r ? { ...r, ref: link } : { ...stored, status: 'failed', error: 'not processed' },
  };
}
