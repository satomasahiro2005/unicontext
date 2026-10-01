export interface LocationLike {
  page?: number | undefined;
  timestamp?: string | undefined;
  messageId?: string | undefined;
  line?: number | undefined;
  selector?: string | undefined;
}

/** `3ページ`, `00:42:18`, `メッセージ3812` ... joined with 、; empty string when nothing is known. */
export function describeLocation(loc: LocationLike | undefined): string {
  if (!loc) return '';
  const parts: string[] = [];
  if (loc.page !== undefined) parts.push(`${loc.page}ページ`);
  if (loc.timestamp) parts.push(loc.timestamp);
  if (loc.messageId) parts.push(`メッセージ${loc.messageId}`);
  if (loc.line !== undefined) parts.push(`${loc.line}行目`);
  if (loc.selector) parts.push(loc.selector);
  return parts.join('、');
}

/** Drops repeated citations (same source reference) while keeping order. */
export function dedupeCitations<T extends { sourceReferenceId: string }>(
  citations: readonly T[] | undefined,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const c of citations ?? []) {
    if (seen.has(c.sourceReferenceId)) continue;
    seen.add(c.sourceReferenceId);
    out.push(c);
  }
  return out;
}
