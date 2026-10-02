import { type CanonicalEntity, type EntityKind, entityLabel } from '@unicontext/canonical-model';
import {
  addZonedDays,
  type Clock,
  DEFAULT_TIMEZONE,
  type DateRange,
  startOfZonedDay,
  startOfZonedWeek,
  systemClock,
  zonedDateString,
} from '@unicontext/core';
import {
  ChangeEventStore,
  conflicts,
  EntityStore,
  rowToConflict,
  rowToTask,
  SourceReferenceStore,
  tasks,
  type UniContextDatabase,
} from '@unicontext/database';
import { type Citation, toCitation } from '@unicontext/provenance';
import { and, eq, sql } from 'drizzle-orm';
import { lexicalSearch, SEARCHABLE_KINDS } from './lexical.js';
import {
  type QueryRoute,
  type RelativeRange,
  routeQuery,
  type RoutedQuery,
  type StructuredIntent,
} from './router.js';
import type { EmbeddingIndex } from './semantic.js';

export type SearchHitKind = EntityKind | 'task' | 'changeEvent' | 'conflict';

export interface SearchHit {
  id: string;
  kind: SearchHitKind;
  title: string;
  snippet: string;
  score: number;
  /** The time that made it relevant (due date, start time, publish time...). */
  at: string | undefined;
  courseOfferingId: string | undefined;
  /** Where it came from (§49). */
  citations: Citation[];
  /** "lexical" | "semantic" | "structured" */
  via: 'lexical' | 'semantic' | 'structured';
  /** Document chunks: the file they belong to (download_course_file takes this id) and page. */
  documentId?: string;
  page?: number;
}

export interface SearchOptions {
  limit?: number;
  /** Restrict to one course (identity-expanded via expandCourse). */
  courseOfferingId?: string;
  kinds?: EntityKind[];
  /** Force a route instead of using the router. */
  route?: QueryRoute;
}

export interface SearchResponse {
  query: RoutedQuery;
  hits: SearchHit[];
}

export interface SearchServiceOptions {
  db: UniContextDatabase;
  clock?: Clock;
  timezone?: string;
  /** Optional semantic layer (§16). */
  embeddings?: EmbeddingIndex;
  /** Identity expansion of course offering ids (§14). */
  expandCourse?: (id: string) => string[];
}

export function rangeFor(range: RelativeRange, now: Date, tz: string): DateRange {
  const today = startOfZonedDay(now, tz);
  switch (range) {
    case 'today':
      return { from: today, to: addZonedDays(today, 1, tz) };
    case 'tomorrow':
      return { from: addZonedDays(today, 1, tz), to: addZonedDays(today, 2, tz) };
    case 'yesterday':
      return { from: addZonedDays(today, -1, tz), to: today };
    case 'this_week': {
      const w = startOfZonedWeek(now, tz);
      return { from: w, to: addZonedDays(w, 7, tz) };
    }
    case 'next_week': {
      const w = addZonedDays(startOfZonedWeek(now, tz), 7, tz);
      return { from: w, to: addZonedDays(w, 7, tz) };
    }
    case 'upcoming':
      return { from: now, to: addZonedDays(today, 15, tz) };
  }
}

/** Search entry point used by MCP/REST/CLI (§15). */
export class SearchService {
  private readonly db: UniContextDatabase;
  private readonly clock: Clock;
  private readonly tz: string;
  private readonly entities: EntityStore;
  private readonly refs: SourceReferenceStore;
  private readonly embeddings: EmbeddingIndex | undefined;
  private readonly expandCourse: (id: string) => string[];

  constructor(options: SearchServiceOptions) {
    this.db = options.db;
    this.clock = options.clock ?? systemClock;
    this.tz = options.timezone ?? DEFAULT_TIMEZONE;
    this.entities = new EntityStore(options.db, { clock: this.clock });
    this.refs = new SourceReferenceStore(options.db);
    this.embeddings = options.embeddings;
    this.expandCourse = options.expandCourse ?? ((id) => [id]);
  }

  private citationsFor(ids: readonly string[]): Map<string, Citation[]> {
    const refs = this.refs.forEntities(ids);
    const out = new Map<string, Citation[]>();
    for (const [id, list] of refs)
      out.set(
        id,
        list.map((r) => toCitation(r, this.tz)),
      );
    return out;
  }

  async search(q: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const routed = routeQuery(q);
    const route = options.route ?? routed.route;
    const query: RoutedQuery = { ...routed, route };
    let hits: SearchHit[];
    if (route === 'structured' && routed.intent) {
      hits = this.structured(routed.intent, routed.range ?? 'upcoming', options);
      if (hits.length === 0 && routed.terms.length) hits = this.lexical(routed.terms, options);
    } else if (route === 'transcript') {
      hits = this.lexical(routed.terms, {
        ...options,
        kinds: options.kinds ?? ['lectureSegment', 'announcement', 'message'],
      });
    } else {
      hits = this.lexical(routed.terms.length ? routed.terms : [q], options);
    }
    if (routed.semantic && this.embeddings && route !== 'structured')
      hits = await this.blendSemantic(q, hits, options);
    return { query, hits: hits.slice(0, options.limit ?? 20) };
  }

  /** FTS5 lexical search with citations. */
  lexical(terms: readonly string[], options: SearchOptions = {}): SearchHit[] {
    const courses = options.courseOfferingId
      ? this.expandCourse(options.courseOfferingId)
      : undefined;
    const lex = lexicalSearch(this.db, terms, {
      ...(options.kinds ? { kinds: options.kinds } : {}),
      ...(courses ? { courseOfferingIds: courses } : {}),
      limit: options.limit ?? 20,
    });
    const cites = this.citationsFor(lex.map((h) => h.entityId));
    return lex.map((h) => {
      const e = this.entities.get(h.entityId);
      // A chunk of a file: name the file (and page) instead of the chunk id.
      const doc = e?.kind === 'documentChunk' ? this.entities.get(e.documentId) : undefined;
      const chunk = e?.kind === 'documentChunk' ? e : undefined;
      return {
        id: h.entityId,
        kind: h.kind,
        title:
          doc && chunk
            ? `${entityLabel(doc)}${chunk.page ? ` p.${chunk.page}` : ''}`
            : e
              ? entityLabel(e)
              : h.title,
        ...(chunk ? { documentId: chunk.documentId } : {}),
        ...(chunk?.page ? { page: chunk.page } : {}),
        snippet: h.snippet,
        score: h.score,
        at: e ? timeOf(e) : undefined,
        courseOfferingId: h.courseOfferingId,
        citations: cites.get(h.entityId) ?? [],
        via: 'lexical' as const,
      };
    });
  }

  private async blendSemantic(
    q: string,
    hits: SearchHit[],
    options: SearchOptions,
  ): Promise<SearchHit[]> {
    if (!this.embeddings) return hits;
    const sem = await this.embeddings.search(q, {
      limit: options.limit ?? 10,
      kinds: options.kinds ?? SEARCHABLE_KINDS,
    });
    const seen = new Set(hits.map((h) => h.id));
    const extra = sem.filter((s) => !seen.has(s.entityId) && s.score > 0.2);
    const cites = this.citationsFor(extra.map((s) => s.entityId));
    const extraHits: SearchHit[] = [];
    for (const s of extra) {
      const e = this.entities.get(s.entityId);
      if (!e) continue;
      extraHits.push({
        id: s.entityId,
        kind: s.kind,
        title: entityLabel(e),
        snippet: snippetOf(e),
        score: s.score,
        at: timeOf(e),
        courseOfferingId: courseOf(e),
        citations: cites.get(s.entityId) ?? [],
        via: 'semantic',
      });
    }
    return [...hits, ...extraHits];
  }

  /** Structured lookups: deadlines, classes, exams, changes, conflicts, announcements in a time window. */
  structured(
    intent: StructuredIntent,
    range: RelativeRange,
    options: SearchOptions = {},
  ): SearchHit[] {
    const now = this.clock.now();
    const window = rangeFor(
      range === 'today' && intent === 'changes' ? 'yesterday' : range,
      now,
      this.tz,
    );
    if (intent === 'changes' && range === 'today') window.to = addZonedDays(window.to, 1, this.tz);
    const from = window.from.toISOString();
    const to = window.to.toISOString();
    const courses = options.courseOfferingId
      ? new Set(this.expandCourse(options.courseOfferingId))
      : undefined;
    const inCourse = (id: string | undefined): boolean =>
      !courses || (id !== undefined && courses.has(id));
    const fromEntities = (list: CanonicalEntity[]): SearchHit[] => {
      const filtered = list.filter((e) => inCourse(courseOf(e)));
      const cites = this.citationsFor(filtered.map((e) => e.id));
      return filtered.map((e) => ({
        id: e.id,
        kind: e.kind,
        title: entityLabel(e),
        snippet: snippetOf(e),
        score: 1,
        at: timeOf(e),
        courseOfferingId: courseOf(e),
        citations: cites.get(e.id) ?? [],
        via: 'structured' as const,
      }));
    };
    switch (intent) {
      case 'deadlines': {
        const assignments = fromEntities(
          this.entities.listInRange('assignment', 'dueAt', from, to),
        );
        const taskHits: SearchHit[] = this.db.orm
          .select()
          .from(tasks)
          .where(
            sql`${tasks.dueAt} IS NOT NULL AND julianday(${tasks.dueAt}) >= julianday(${from}) AND julianday(${tasks.dueAt}) < julianday(${to}) AND ${tasks.status} NOT IN ('cancelled', 'completed', 'submitted') AND ${tasks.assignmentId} IS NULL`,
          )
          .all()
          .map(rowToTask)
          .filter((t) => inCourse(t.courseOfferingId))
          .map((t) => ({
            id: t.id,
            kind: 'task' as const,
            title: t.title,
            snippet: t.evidence ?? '',
            score: 1,
            at: t.dueAt,
            courseOfferingId: t.courseOfferingId,
            citations: [],
            via: 'structured' as const,
          }));
        return [...assignments, ...taskHits].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
      }
      case 'classes': {
        const fromDate = zonedDateString(window.from, this.tz);
        const toDate = zonedDateString(window.to, this.tz);
        return [
          ...fromEntities(this.entities.listByDateRange('classSession', 'date', fromDate, toDate)),
          ...fromEntities(this.entities.listInRange('calendarEvent', 'startsAt', from, to)),
        ].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
      }
      case 'exams':
        return fromEntities(this.entities.listInRange('exam', 'startsAt', from, to));
      case 'announcements':
        return fromEntities(
          this.entities.listInRange('announcement', 'publishedAt', from, to),
        ).reverse();
      case 'changes':
        return new ChangeEventStore(this.db)
          .list({ since: from, until: to })
          .filter((c) => inCourse(c.courseOfferingId))
          .reverse()
          .map((c) => ({
            id: c.id,
            kind: 'changeEvent' as const,
            title: c.summary ?? `${c.entityKind} ${c.type}`,
            snippet: c.changedFields.join(', '),
            score: 1,
            at: c.observedAt,
            courseOfferingId: c.courseOfferingId,
            citations: [],
            via: 'structured' as const,
          }));
      case 'conflicts':
        return this.db.orm
          .select()
          .from(conflicts)
          .where(and(eq(conflicts.status, 'open')))
          .all()
          .map(rowToConflict)
          .map((c) => ({
            id: c.id,
            kind: 'conflict' as const,
            title: `${c.predicate}: ${c.candidates.map((x) => String(x.value)).join(' / ')}`,
            snippet: c.reason ?? '',
            score: 1,
            at: c.detectedAt,
            courseOfferingId: undefined,
            citations: [],
            via: 'structured' as const,
          }));
    }
  }
}

function courseOf(e: CanonicalEntity): string | undefined {
  const r = e as unknown as Record<string, unknown>;
  if (e.kind === 'courseOffering') return e.id;
  return typeof r.courseOfferingId === 'string' ? r.courseOfferingId : undefined;
}

function timeOf(e: CanonicalEntity): string | undefined {
  const r = e as unknown as Record<string, unknown>;
  for (const k of [
    'dueAt',
    'startsAt',
    'publishedAt',
    'sentAt',
    'recordedAt',
    'modifiedAt',
    'date',
  ]) {
    const v = r[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function snippetOf(e: CanonicalEntity): string {
  const r = e as unknown as Record<string, unknown>;
  for (const k of ['body', 'text', 'description', 'room', 'scope']) {
    const v = r[k];
    if (typeof v === 'string' && v) return v.length > 120 ? `${v.slice(0, 120)}…` : v;
  }
  return '';
}
