import type { RawItem, SourceAdapter } from './adapter.js';

/*
 * Links to files at a source (e.g. a SharePoint / OneDrive link in an email), opened on the
 * student's request. The adapter resolves the link with its own signed-in session (read-only),
 * and answers with the file(s) as raw items of one of its `fileSourceTypes`, so the engine can
 * store them and hand them to the ordinary on-demand download (`downloadFiles`).
 */

/** Why a link could not be opened. */
export type LinkFailureStatus =
  | 'unsupported' // not a link this source can open (host, kind)
  | 'notFound' // the source says the item or the sharing link does not exist
  | 'forbidden' // the student's account has no access
  | 'authRequired' // the source's session needs a sign-in
  | 'throttled' // the source asked to slow down
  | 'failed';

/** One file found through a link. */
export interface LinkFile {
  /** Raw source type / external id of the file (one of the adapter's `fileSourceTypes`). */
  sourceType: string;
  externalId: string;
  /** The raw item to store; absent when the stored one is current (synced by the source). */
  raw?: RawItem;
  name: string;
}

/** A subfolder of a linked folder (open it with its own link). */
export interface LinkSubfolder {
  name: string;
  url?: string;
  childCount?: number;
  modifiedAt?: string;
}

export type LinkResolution =
  | { status: 'file'; file: LinkFile }
  | {
      status: 'folder';
      folder: { name: string; url?: string; path?: string; childCount?: number };
      files: LinkFile[];
      folders: LinkSubfolder[];
      /** More children exist than were listed. */
      truncated: boolean;
    }
  | { status: LinkFailureStatus; reason: string };

/** What the engine already holds for the adapter (its `linkContextSourceTypes`). */
export interface LinkContext {
  items: readonly { sourceType: string; externalId: string; payload: unknown }[];
}

export interface LinkResolvingAdapter extends SourceAdapter {
  /** Raw source types the adapter wants as context (known teams, synced files). */
  readonly linkContextSourceTypes: readonly string[];
  /** Cheap syntactic check: is this a link this adapter may be able to open? */
  canOpenLink(url: string): boolean;
  /** Resolve the link with the adapter's session (read-only at the source). */
  resolveLink(url: string, context: LinkContext): Promise<LinkResolution>;
}

export function supportsLinks(adapter: SourceAdapter): adapter is LinkResolvingAdapter {
  const a = adapter as Partial<LinkResolvingAdapter>;
  return typeof a.resolveLink === 'function' && typeof a.canOpenLink === 'function';
}
