import type { SourceLocation, SourceReference } from '@unicontext/canonical-model';
import { DEFAULT_TIMEZONE, formatShortJa } from '@unicontext/core';

/** What every context item carries so an AI answer can point back to its source (§49, §75). */
export interface Citation {
  sourceReferenceId: string;
  sourceSystem: string;
  sourceLabel: string | undefined;
  authority: string;
  sourceItemId: string;
  retrievedAt: string;
  url: string | undefined;
  location: SourceLocation | undefined;
  rawItemId: string | undefined;
  /** Ready-to-quote text, e.g. "学務情報システム 10/1 09:42取得". */
  label: string;
}

export function formatCitationLabel(
  ref: Pick<SourceReference, 'sourceSystem' | 'sourceLabel' | 'retrievedAt' | 'location'>,
  timezone: string = DEFAULT_TIMEZONE,
): string {
  const name = ref.sourceLabel ?? ref.sourceSystem;
  const loc = ref.location;
  const where = loc?.timestamp ? ` ${loc.timestamp}` : loc?.page ? ` p.${loc.page}` : '';
  return `${name}${where} ${formatShortJa(new Date(ref.retrievedAt), timezone)}取得`;
}

export function toCitation(ref: SourceReference, timezone: string = DEFAULT_TIMEZONE): Citation {
  return {
    sourceReferenceId: ref.id,
    sourceSystem: ref.sourceSystem,
    sourceLabel: ref.sourceLabel,
    authority: ref.authority,
    sourceItemId: ref.sourceItemId,
    retrievedAt: ref.retrievedAt,
    url: ref.url,
    location: ref.location,
    rawItemId: ref.rawItemId,
    label: formatCitationLabel(ref, timezone),
  };
}

/** De-duplicate citations by source reference id, newest retrieval first. */
export function uniqueCitations(list: readonly Citation[]): Citation[] {
  const map = new Map<string, Citation>();
  for (const c of list) if (!map.has(c.sourceReferenceId)) map.set(c.sourceReferenceId, c);
  return [...map.values()].sort((a, b) => b.retrievedAt.localeCompare(a.retrievedAt));
}
