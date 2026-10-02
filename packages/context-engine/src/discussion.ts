import type { JsonValue } from '@unicontext/canonical-model';

const isObject = (v: unknown): v is Record<string, JsonValue> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `extra.<key>` as a non-empty string; anything else counts as unknown. */
export function extraString(
  extra: Record<string, JsonValue> | undefined,
  key: string,
): string | undefined {
  const v = extra?.[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** `extra.attachments` ([{name, url?}]) of a post, validated defensively. */
export function readAttachments(
  extra: Record<string, JsonValue> | undefined,
): { name: string; url: string | undefined }[] {
  const raw = extra?.attachments;
  if (!Array.isArray(raw)) return [];
  const out: { name: string; url: string | undefined }[] = [];
  for (const a of raw) {
    if (!isObject(a) || typeof a.name !== 'string' || a.name.length === 0) continue;
    out.push({ name: a.name, url: typeof a.url === 'string' && a.url ? a.url : undefined });
  }
  return out;
}

/** A folder path without empty segments, leading or trailing slashes ('' = library root). */
export function normalizeFolderPath(path: string | undefined): string {
  return (path ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '' && s !== '.')
    .join('/');
}

/** The folder of a file: `extra.folder`, else the directory part of its library path. */
export function folderOfFile(
  extra: Record<string, JsonValue> | undefined,
  path: string | undefined,
): string {
  if (typeof extra?.folder === 'string') return normalizeFolderPath(extra.folder);
  const parts = normalizeFolderPath(path).split('/');
  parts.pop();
  return parts.join('/');
}

/** Orders by folder and then title (Japanese-aware, numbers as numbers). */
export function compareFiles(
  a: { folder: string; title: string },
  b: { folder: string; title: string },
): number {
  return (
    a.folder.localeCompare(b.folder, 'ja', { numeric: true }) ||
    a.title.localeCompare(b.title, 'ja', { numeric: true })
  );
}
