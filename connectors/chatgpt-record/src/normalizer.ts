import type { JsonValue } from '@unicontext/canonical-model';
import {
  detectSchemaDrift,
  type FactInput,
  type NormalizeContext,
  type NormalizedEntity,
  type NormalizeOutput,
  type Normalizer,
  type RawItemView,
} from '@unicontext/connector-sdk';
import { DEADLINE_PREDICATE, EXTRACTOR_ID, extractDeadlines } from '@unicontext/task-engine';
import {
  RAW_TYPE_TRANSCRIPT,
  type TranscriptPayload,
  TranscriptPayloadSchema,
} from './importer.js';
import { joinText } from './parsers.js';
import { formatTimestamp, localDateOf, localMinutesOf } from './time.js';

/** Stable id key for a course hint: NFKC, lower case, years and punctuation removed. */
export function courseKeyOf(hint: string): string {
  const key = hint
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(?<!\d)(?:19|20)\d{2}\s*(?:年度|年)?/g, ' ')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  return key || hint.normalize('NFKC').toLowerCase();
}

/** Academic year of a recording: profile terms first, else the Japanese April-March rule. */
export function academicYearOf(
  ctx: Pick<NormalizeContext, 'profile' | 'timezone'>,
  recordedAt: string,
  hint?: string,
): number {
  const fromHint = hint ? /(?<!\d)((?:19|20)\d{2})(?!\d)/.exec(hint.normalize('NFKC')) : null;
  if (fromHint) return Number(fromHint[1]);
  const date = localDateOf(recordedAt, ctx.timezone);
  const term = ctx.profile?.academicCalendar.terms.find((t) => t.start <= date && date <= t.end);
  if (term) return term.year;
  const [y, m] = date.split('-').map(Number) as [number, number];
  return m >= 4 ? y : y - 1;
}

/**
 * Term word (前期 / 後期) of a recording, only when the profile's term definitions say so: a wrong
 * guess would make the identity resolver veto the match, so there is no calendar fallback.
 */
export function academicTermOf(
  ctx: Pick<NormalizeContext, 'profile' | 'timezone'>,
  recordedAt: string,
): string | undefined {
  const date = localDateOf(recordedAt, ctx.timezone);
  const term = ctx.profile?.academicCalendar.terms.find((t) => t.start <= date && date <= t.end);
  const m = term ? /前期|後期/.exec(term.name.normalize('NFKC')) : null;
  return m?.[0];
}

/** Timetable period (e.g. 2限) whose time range contains the recording start (20 min early allowed). */
export function inferPeriod(
  ctx: Pick<NormalizeContext, 'profile' | 'timezone'>,
  recordedAt: string,
): number | undefined {
  const periods = ctx.profile?.academicCalendar.periods ?? [];
  const minutes = localMinutesOf(recordedAt, ctx.timezone);
  const toMin = (hhmm: string): number => {
    const [h, m] = hhmm.split(':').map(Number) as [number, number];
    return h * 60 + m;
  };
  let best: { period: number; start: number } | undefined;
  for (const p of periods) {
    const start = toMin(p.start);
    const end = toMin(p.end);
    if (minutes >= start - 20 && minutes < end) {
      if (!best || Math.abs(minutes - start) < Math.abs(minutes - best.start))
        best = { period: p.period, start };
    }
  }
  return best?.period;
}

interface Block {
  text: string;
  spans: { segment: number; start: number; end: number }[];
}

/**
 * Group consecutive segments of one speaker into sentence-sized blocks so a deadline phrase that a
 * caption cue split in two ("10月15日" / "23時59分までに") is still found.
 */
function buildBlocks(segments: TranscriptPayload['segments']): Block[] {
  const blocks: Block[] = [];
  let cur: Block | undefined;
  let curSpeaker: string | undefined;
  segments.forEach((seg, i) => {
    if (!cur || seg.speaker !== curSpeaker) {
      cur = { text: '', spans: [] };
      curSpeaker = seg.speaker;
      blocks.push(cur);
    }
    const joined = joinText(cur.text, seg.text);
    const start = joined.length - seg.text.length;
    cur.text = joined;
    cur.spans.push({ segment: i, start, end: joined.length });
    if (/[。．.！？!?]\s*$/.test(seg.text) || cur.text.length > 500) cur = undefined;
  });
  return blocks;
}

export interface NormalizerOptions {
  /** Importer id when the payload does not carry one. */
  importer?: string;
}

export function createChatGptRecordNormalizer(options: NormalizerOptions = {}): Normalizer {
  return {
    id: 'chatgpt-record-normalizer',
    version: '1',
    sourceTypes: [RAW_TYPE_TRANSCRIPT],
    normalize(item: RawItemView, ctx: NormalizeContext): NormalizeOutput {
      const drift = detectSchemaDrift(item.payload, TranscriptPayloadSchema);
      const parsed = TranscriptPayloadSchema.safeParse(item.payload);
      if (!parsed.success)
        return {
          entities: [],
          drift,
          warnings: [
            `invalid ${item.sourceType} payload: ${parsed.error.issues[0]?.message ?? ''}`,
          ],
        };
      const p = parsed.data;
      const key = item.externalId;
      const date = localDateOf(p.recordedAt, ctx.timezone);
      const timestamped = p.hasTimestamps !== false;
      const entities: NormalizedEntity[] = [];
      const facts: FactInput[] = [];

      // Source-local offering keyed by the hint; IdentityResolver links it to the LCU/Teams offering,
      // and the context engine then joins Lecture and ClassSession by (course, date) (§21, §14).
      let offeringId: ReturnType<typeof ctx.id<'courseOffering'>> | undefined;
      let courseKey: string | undefined;
      if (p.courseHint) {
        courseKey = courseKeyOf(p.courseHint);
        const year = academicYearOf(ctx, p.recordedAt, p.courseHint);
        offeringId = ctx.id('courseOffering', courseKey, String(year));
        const term = academicTermOf(ctx, p.recordedAt);
        entities.push({
          entity: {
            id: offeringId,
            kind: 'courseOffering',
            title: p.courseHint,
            academicYear: year,
            ...(term ? { term } : {}),
            instructorNames: [],
            schedule: [],
          },
          deriveFacts: false,
        });
      }

      const period = inferPeriod(ctx, p.recordedAt);
      const lectureId = courseKey
        ? ctx.id('lecture', courseKey, date)
        : ctx.id('lecture', 'transcript', key);
      entities.push({
        entity: {
          id: lectureId,
          kind: 'lecture',
          date,
          title: p.title,
          ...(offeringId ? { courseOfferingId: offeringId } : {}),
          topics: [],
          ...(period !== undefined ? { extra: { period } } : {}),
        },
        deriveFacts: false,
      });

      const transcriptId = ctx.id('lectureTranscript', key);
      entities.push({
        entity: {
          id: transcriptId,
          kind: 'lectureTranscript',
          lectureId,
          ...(offeringId ? { courseOfferingId: offeringId } : {}),
          title: p.title,
          ...(p.language ? { language: p.language } : {}),
          recordedAt: p.recordedAt,
          durationMs: p.durationMs,
          importer: p.importer ?? options.importer ?? 'chatgpt-record',
          extra: { format: p.format, fileName: p.fileName },
        },
        deriveFacts: false,
      });

      p.segments.forEach((s, i) => {
        entities.push({
          entity: {
            id: ctx.id('lectureSegment', key, String(i)),
            kind: 'lectureSegment',
            transcriptId,
            ordinal: i,
            startMs: s.startMs,
            ...(s.endMs !== undefined ? { endMs: s.endMs } : {}),
            ...(s.speaker ? { speaker: s.speaker } : {}),
            text: s.text,
          },
          ...(timestamped
            ? {
                ref: {
                  location: { timestampMs: s.startMs, timestamp: formatTimestamp(s.startMs) },
                },
              }
            : {}),
          deriveFacts: false,
        });
      });

      // Deadlines mentioned in the lecture (§20): origin extracted, sentence as evidence.
      const reference = new Date(p.recordedAt);
      const seen = new Set<string>();
      for (const block of buildBlocks(p.segments)) {
        for (const d of extractDeadlines(block.text, { reference, timezone: ctx.timezone })) {
          const dedupe = `${d.dueAt}\u0000${d.phrase}`;
          if (seen.has(dedupe)) continue;
          seen.add(dedupe);
          const at = Math.max(0, block.text.indexOf(d.phrase));
          const span =
            block.spans.find((s) => at >= s.start && at < s.end) ??
            block.spans[block.spans.length - 1] ??
            block.spans[0];
          const segment = span ? p.segments[span.segment] : undefined;
          const value: Record<string, JsonValue> = {
            dueAt: d.dueAt,
            phrase: d.phrase,
            rule: d.rule,
            ...(offeringId ? { courseOfferingId: offeringId } : {}),
            // All facts of one lecture share one SourceReference, so keep each position in the value.
            ...(timestamped && segment
              ? { timestampMs: segment.startMs, timestamp: formatTimestamp(segment.startMs) }
              : {}),
          };
          facts.push({
            subject: lectureId,
            predicate: DEADLINE_PREDICATE,
            value,
            origin: 'extracted',
            confidence: d.confidence,
            observedAt: p.recordedAt,
            evidence: d.evidence,
            producer: { type: 'rule', id: EXTRACTOR_ID },
            ...(timestamped && segment
              ? {
                  ref: {
                    location: {
                      timestampMs: segment.startMs,
                      timestamp: formatTimestamp(segment.startMs),
                    },
                  },
                }
              : {}),
          });
        }
      }
      return { entities, facts, drift };
    },
  };
}
