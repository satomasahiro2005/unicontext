import {
  ADDITIONS_SOURCE_ID,
  type EntityId,
  type JsonValue,
  SESSION_RULE_PREDICATE,
  type SessionRuleValue,
} from '@unicontext/canonical-model';
import type { Clock } from '@unicontext/core';
import type { SourceReferenceStore, UniContextDatabase } from '@unicontext/database';
import { factId, type FactStore } from '@unicontext/provenance';
import type { EnrolledOffering } from './class-schedule.js';
import { courseOfTable, parseGroupScheduleTable } from './group-schedule.js';

/** Producer id of session_rule facts parsed from a synced document or post. */
export const GROUP_SCHEDULE_RULE_ID = 'group-schedule-table';
const CONFIDENCE = 0.9;

export interface SessionRuleExtractionDeps {
  db: UniContextDatabase;
  clock: Clock;
  facts: FactStore;
  refs: SourceReferenceStore;
  enrolled: () => EnrolledOffering[];
}

interface Candidate {
  id: string;
  title: string;
  courseOfferingId: string | undefined;
  text: string;
  at: string | undefined;
}

/**
 * Texts that may hold a date × group table: synced documents (all chunks in order), notices and
 * posts mentioning a group. Notes written by AI clients (mcp-additions) are never a source of an
 * official table.
 */
function candidates(db: UniContextDatabase): Candidate[] {
  const out: Candidate[] = [];
  const docs = db.sqlite
    .prepare(
      `SELECT d.id AS id, d.title AS title, d.course_offering_id AS course, d.modified_at AS at,
              group_concat(json_extract(c.data, '$.text'), char(10)) AS text
         FROM (SELECT * FROM document_chunks WHERE deleted_at IS NULL ORDER BY document_id, ordinal) c
         JOIN documents d ON d.id = c.document_id
        WHERE d.deleted_at IS NULL AND (d.source_id IS NULL OR d.source_id <> ?)
          AND c.document_id IN (
            SELECT document_id FROM document_chunks
             WHERE deleted_at IS NULL AND (data LIKE '%班%' OR data LIKE '%グループ%'))
        GROUP BY d.id`,
    )
    .all(ADDITIONS_SOURCE_ID) as {
    id: string;
    title: string | null;
    course: string | null;
    at: string | null;
    text: string | null;
  }[];
  for (const d of docs)
    if (d.text)
      out.push({
        id: d.id,
        title: d.title ?? '',
        courseOfferingId: d.course ?? undefined,
        text: d.text,
        at: d.at ?? undefined,
      });
  const posts = db.sqlite
    .prepare(
      `SELECT id, course_offering_id AS course, json_extract(data, '$.title') AS title,
              json_extract(data, '$.body') AS text, published_at AS at
         FROM announcements
        WHERE deleted_at IS NULL AND (source_id IS NULL OR source_id <> ?)
          AND (data LIKE '%班%' OR data LIKE '%グループ%')
       UNION ALL
       SELECT id, course_offering_id AS course, NULL AS title,
              json_extract(data, '$.body') AS text, sent_at AS at
         FROM messages
        WHERE deleted_at IS NULL AND (source_id IS NULL OR source_id <> ?)
          AND (data LIKE '%班%' OR data LIKE '%グループ%')`,
    )
    .all(ADDITIONS_SOURCE_ID, ADDITIONS_SOURCE_ID) as {
    id: string;
    course: string | null;
    title: string | null;
    text: string | null;
    at: string | null;
  }[];
  for (const p of posts)
    if (p.text)
      out.push({
        id: p.id,
        title: p.title ?? '',
        courseOfferingId: p.course ?? undefined,
        text: p.title ? `${p.title}\n${p.text}` : p.text,
        at: p.at ?? undefined,
      });
  return out;
}

/**
 * Parse every synced date × group schedule table into session_rule facts on the enrolled course
 * it is about (origin extracted, cited to the document / post, the table line as evidence).
 * Idempotent; rows that disappeared from a document are retracted.
 */
export function extractSessionRuleFacts(deps: SessionRuleExtractionDeps): number {
  const enrolled = deps.enrolled();
  if (enrolled.length === 0) return 0;
  const courses = enrolled.map((e) => ({
    id: e.offering.id,
    title: e.offering.title,
    academicYear: e.offering.academicYear,
    ids: e.ids,
  }));
  const keep = new Set<string>();
  let added = 0;
  for (const c of candidates(deps.db)) {
    const own = c.courseOfferingId
      ? courses.find((x) => x.ids.includes(c.courseOfferingId as string))
      : undefined;
    // Try the academic year of the owning course first, else of any enrolled course.
    const years = [
      ...new Set([own?.academicYear, ...courses.map((x) => x.academicYear)].filter(Boolean)),
    ] as number[];
    let table: ReturnType<typeof parseGroupScheduleTable>;
    for (const y of years) {
      table = parseGroupScheduleTable(c.text, { academicYear: y });
      if (table) break;
    }
    if (!table) continue;
    const course = courseOfTable(c.text, table.heading ?? c.title, own, courses, table.context);
    if (!course) continue;
    const ref = deps.refs.forEntity(c.id)[0];
    if (!ref) continue;
    const observedAt = c.at ?? deps.clock.now().toISOString();
    for (const row of table.rows) {
      const { line, ...rest } = row;
      const value: SessionRuleValue = {
        ...rest,
        ...(c.title ? { documentTitle: c.title.slice(0, 200) } : {}),
      };
      const id = factId(ref.id, course.id, SESSION_RULE_PREDICATE, value);
      keep.add(id);
      const existing = deps.facts.get(id);
      if (existing && !existing.retractedAt) continue;
      deps.facts.put({
        id,
        subject: course.id as EntityId,
        predicate: SESSION_RULE_PREDICATE,
        value: value as unknown as JsonValue,
        origin: 'extracted',
        confidence: CONFIDENCE,
        observedAt,
        sourceReferenceId: ref.id,
        producer: { type: 'rule', id: GROUP_SCHEDULE_RULE_ID },
        evidence: line.slice(0, 500),
      });
      added++;
    }
  }
  const pairs = deps.facts.activePairs().filter((p) => p.predicate === SESSION_RULE_PREDICATE);
  const stale = deps.facts
    .active({
      subjects: [...new Set(pairs.map((p) => p.subject))],
      predicate: SESSION_RULE_PREDICATE,
    })
    .filter((f) => f.producer.id === GROUP_SCHEDULE_RULE_ID && !keep.has(f.id));
  if (stale.length) deps.facts.retract(stale.map((f) => f.id));
  return added;
}
