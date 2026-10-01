import type { EntityKind } from '@unicontext/canonical-model';
import { FTS_TABLES, type UniContextDatabase } from '@unicontext/database';

export const SEARCHABLE_KINDS = Object.keys(FTS_TABLES) as EntityKind[];

export interface LexicalHit {
  entityId: string;
  kind: EntityKind;
  title: string;
  snippet: string;
  /** Higher is better (negated bm25 when FTS is used). */
  score: number;
  courseOfferingId: string | undefined;
}

export interface LexicalOptions {
  kinds?: readonly EntityKind[];
  courseOfferingIds?: readonly string[];
  limit?: number;
  /** "all" requires every term, "any" at least one. Default: all, then any if nothing matched. */
  mode?: 'all' | 'any';
}

/** trigram MATCH needs >= 3 characters; shorter terms fall back to LIKE (still index-free but correct). */
const MIN_TRIGRAM = 3;

function quote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

function manualSnippet(text: string, terms: readonly string[], width = 40): string {
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    pos = lower.indexOf(t.toLowerCase());
    if (pos >= 0) break;
  }
  if (pos < 0) return text.slice(0, width * 2);
  const start = Math.max(0, pos - width);
  return `${start > 0 ? '…' : ''}${text.slice(start, pos + width)}${pos + width < text.length ? '…' : ''}`;
}

function searchTable(
  db: UniContextDatabase,
  kind: EntityKind,
  table: string,
  terms: readonly string[],
  mode: 'all' | 'any',
  options: LexicalOptions,
): LexicalHit[] {
  const long = terms.filter((t) => [...t].length >= MIN_TRIGRAM);
  const short = terms.filter((t) => [...t].length < MIN_TRIGRAM);
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  const joiner = mode === 'all' ? ' AND ' : ' OR ';
  const parts: string[] = [];
  if (long.length) {
    parts.push(`${table} MATCH ?`);
    params.push(long.map(quote).join(mode === 'all' ? ' AND ' : ' OR '));
  }
  for (const s of short) {
    parts.push('(title LIKE ? OR body LIKE ?)');
    params.push(`%${s}%`, `%${s}%`);
  }
  if (parts.length === 0) return [];
  clauses.push(`(${parts.join(joiner)})`);
  if (options.courseOfferingIds) {
    if (options.courseOfferingIds.length === 0) return [];
    clauses.push(`course_offering_id IN (${options.courseOfferingIds.map(() => '?').join(', ')})`);
    params.push(...options.courseOfferingIds);
  }
  const useFts = long.length > 0 && (mode === 'all' || short.length === 0);
  const rank = useFts ? `bm25(${table})` : '0';
  const snippet = useFts ? `snippet(${table}, 3, '[', ']', '…', 16)` : 'NULL';
  const sql = `SELECT entity_id, course_offering_id, title, body, ${rank} AS rank, ${snippet} AS snip FROM ${table} WHERE ${clauses.join(' AND ')} ORDER BY rank LIMIT ?`;
  params.push(options.limit ?? 20);
  const rows = db.sqlite.prepare(sql).all(...params) as {
    entity_id: string;
    course_offering_id: string | null;
    title: string;
    body: string;
    rank: number;
    snip: string | null;
  }[];
  return rows.map((r) => ({
    entityId: r.entity_id,
    kind,
    title: r.title,
    snippet: r.snip ?? manualSnippet(r.body || r.title, terms),
    score: -r.rank,
    courseOfferingId: r.course_offering_id ?? undefined,
  }));
}

/**
 * FTS5 search over documents, chunks, announcements, messages and transcript segments (§15).
 * The trigram tokenizer gives substring matching for Japanese without a morphological analyzer.
 */
export function lexicalSearch(
  db: UniContextDatabase,
  terms: readonly string[],
  options: LexicalOptions = {},
): LexicalHit[] {
  const cleaned = terms.map((t) => t.trim()).filter(Boolean);
  if (cleaned.length === 0) return [];
  const kinds = options.kinds ?? SEARCHABLE_KINDS;
  const run = (mode: 'all' | 'any'): LexicalHit[] =>
    kinds
      .flatMap((k) => {
        const table = FTS_TABLES[k];
        return table ? searchTable(db, k, table, cleaned, mode, options) : [];
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit ?? 20);
  if (options.mode) return run(options.mode);
  const all = run('all');
  return all.length > 0 || cleaned.length === 1 ? all : run('any');
}
