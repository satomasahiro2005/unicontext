export interface TextChunk {
  text: string;
  /** Page / slide number (1-based) when the source is paged. */
  page?: number;
  heading?: string;
}

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0\u3000]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Split text into chunks of about `size` characters with `overlap`, preferring natural breaks. */
export function chunkText(text: string, size: number, overlap: number): string[] {
  const t = normalizeWhitespace(text);
  if (!t) return [];
  const out: string[] = [];
  let pos = 0;
  while (pos < t.length) {
    let end = Math.min(pos + size, t.length);
    if (end < t.length) {
      const floor = pos + Math.floor(size * 0.6);
      let best = -1;
      for (let i = end; i > floor; i--) {
        const ch = t.charAt(i - 1);
        if (ch === '\n' || ch === '。' || ch === '！' || ch === '？' || ch === ' ') {
          best = i;
          break;
        }
        if ((ch === '.' || ch === '!' || ch === '?') && /\s/.test(t.charAt(i))) {
          best = i;
          break;
        }
      }
      if (best > 0) end = best;
      else {
        const code = t.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end -= 1;
      }
    }
    const piece = t.slice(pos, end).trim();
    if (piece) out.push(piece);
    if (end >= t.length) break;
    const next = end - Math.min(overlap, Math.floor(size / 4));
    pos = next > pos ? next : end;
  }
  return out;
}

/** Chunk Markdown by heading sections so each chunk knows its heading. */
export function chunkMarkdown(text: string, size: number, overlap: number): TextChunk[] {
  const lines = normalizeWhitespace(text).split('\n');
  const sections: { heading?: string; body: string[] }[] = [{ body: [] }];
  for (const line of lines) {
    const m = /^#{1,6}\s+(.*\S)\s*#*$/.exec(line);
    if (m) sections.push({ heading: m[1] as string, body: [line] });
    else (sections[sections.length - 1] as { body: string[] }).body.push(line);
  }
  const out: TextChunk[] = [];
  for (const s of sections)
    for (const piece of chunkText(s.body.join('\n'), size, overlap))
      out.push({ text: piece, ...(s.heading ? { heading: s.heading } : {}) });
  return out;
}
