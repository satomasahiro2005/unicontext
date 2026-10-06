const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function piece(m: unknown): string | undefined {
  if (typeof m === 'string') return m;
  if (typeof m === 'number' || typeof m === 'boolean') return String(m);
  return undefined;
}

/**
 * Markup (Ed document XML, simple HTML) → text, one line per paragraph / heading / break / list
 * item; text inside <pre> keeps its line breaks. Arrays are joined line by line. Undefined when
 * nothing is left.
 */
export function markupToText(markup: unknown): string | undefined {
  const parts = (Array.isArray(markup) ? markup : [markup])
    .map(piece)
    .filter((m): m is string => m !== undefined && m !== '');
  if (parts.length === 0) return undefined;
  const text = parts
    .join('\n')
    .replace(/<\/(?:paragraph|p|div|li|heading|h[1-6]|callout)>|<br\s*\/?>|<break\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|[a-z]+);/gi, (m, e: string) =>
      e.startsWith('#')
        ? String.fromCodePoint(Number(e.slice(1)))
        : (ENTITIES[e.toLowerCase()] ?? m),
    )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || undefined;
}
