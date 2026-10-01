import { type Capability, type HealthStatus, type JsonValue } from '@unicontext/canonical-model';
import { addZonedDays, findPeriod, parseZonedDate, zonedTime } from '@unicontext/core';
import { z } from 'zod';
import type {
  AuthResult,
  RawDeletion,
  RawItem,
  SourceAdapter,
  SyncInput,
  SyncResult,
} from './adapter.js';
import { defineConnector, type ConnectorModule } from './connector.js';
import { detectSchemaDrift } from './drift.js';
import { type ConnectorMetadata, defineMetadata } from './metadata.js';
import type {
  FactInput,
  NormalizeContext,
  NormalizedEntity,
  NormalizeOutput,
  Normalizer,
  RawItemView,
} from './normalizer.js';

/*
 * A small in-memory connector used by tests and as a worked example of the SDK. Raw item types:
 * fake.course, fake.session, fake.assignment, fake.announcement, fake.message, fake.exam,
 * fake.submission, fake.document, fake.transcript.
 */

const ts = z.string().optional();
export const FakePayloadSchemas = {
  'fake.course': z.object({
    id: z.string(),
    code: z.string().optional(),
    title: z.string(),
    year: z.number().optional(),
    term: z.string().optional(),
    teacher: z.string().optional(),
    department: z.string().optional(),
    room: z.string().optional(),
    /** The student is enrolled (adds an enrollment of the self person). */
    enrolled: z.boolean().optional(),
    schedule: z
      .array(z.object({ day: z.number(), period: z.number(), room: z.string().optional() }))
      .optional(),
    updatedAt: ts,
  }),
  'fake.session': z.object({
    id: z.string(),
    courseId: z.string(),
    date: z.string(),
    period: z.number().optional(),
    room: z.string().optional(),
    status: z.enum(['scheduled', 'cancelled', 'makeup', 'online', 'changed']).optional(),
    number: z.number().optional(),
    updatedAt: ts,
  }),
  'fake.assignment': z.object({
    id: z.string(),
    courseId: z.string().optional(),
    title: z.string(),
    due: z.string().optional(),
    description: z.string().optional(),
    url: z.string().optional(),
    updatedAt: ts,
  }),
  'fake.announcement': z.object({
    id: z.string(),
    courseId: z.string().optional(),
    title: z.string(),
    body: z.string(),
    publishedAt: z.string().optional(),
    author: z.string().optional(),
    importance: z.enum(['critical', 'high', 'normal', 'low']).optional(),
    scope: z.enum(['university', 'faculty', 'course', 'other']).optional(),
    url: z.string().optional(),
    /** Simulates an instructor post such as 「本日の授業は11教室で行います」. */
    roomChange: z.object({ room: z.string(), date: z.string().optional() }).optional(),
    updatedAt: ts,
  }),
  'fake.message': z.object({
    id: z.string(),
    courseId: z.string().optional(),
    thread: z.string().optional(),
    author: z.string().optional(),
    authorRole: z.enum(['student', 'instructor', 'ta', 'staff', 'other']).optional(),
    body: z.string(),
    sentAt: z.string().optional(),
    url: z.string().optional(),
    isQuestion: z.boolean().optional(),
    updatedAt: ts,
  }),
  'fake.exam': z.object({
    id: z.string(),
    courseId: z.string().optional(),
    title: z.string(),
    kind: z.enum(['midterm', 'final', 'quiz', 'report', 'other']).optional(),
    startsAt: z.string().optional(),
    room: z.string().optional(),
    scope: z.string().optional(),
    updatedAt: ts,
  }),
  'fake.submission': z.object({
    id: z.string(),
    assignmentId: z.string(),
    status: z.enum(['not_submitted', 'submitted', 'late', 'graded', 'returned']),
    submittedAt: z.string().optional(),
    updatedAt: ts,
  }),
  'fake.document': z.object({
    id: z.string(),
    courseId: z.string().optional(),
    title: z.string(),
    text: z.string(),
    path: z.string().optional(),
    lectureDate: z.string().optional(),
    updatedAt: ts,
  }),
  'fake.transcript': z.object({
    id: z.string(),
    courseId: z.string().optional(),
    date: z.string(),
    title: z.string().optional(),
    segments: z.array(
      z.object({ start: z.string(), text: z.string(), speaker: z.string().optional() }),
    ),
    updatedAt: ts,
  }),
} as const;

export type FakeSourceType = keyof typeof FakePayloadSchemas;
type P<T extends FakeSourceType> = z.infer<(typeof FakePayloadSchemas)[T]>;

export interface FakeDataset {
  courses?: P<'fake.course'>[];
  sessions?: P<'fake.session'>[];
  assignments?: P<'fake.assignment'>[];
  announcements?: P<'fake.announcement'>[];
  messages?: P<'fake.message'>[];
  exams?: P<'fake.exam'>[];
  submissions?: P<'fake.submission'>[];
  documents?: P<'fake.document'>[];
  transcripts?: P<'fake.transcript'>[];
  /** Explicit deletions reported on incremental syncs. */
  deleted?: { type: FakeSourceType; id: string }[];
}

const DATASET_KEYS: [keyof Omit<FakeDataset, 'deleted'>, FakeSourceType][] = [
  ['courses', 'fake.course'],
  ['sessions', 'fake.session'],
  ['assignments', 'fake.assignment'],
  ['announcements', 'fake.announcement'],
  ['messages', 'fake.message'],
  ['exams', 'fake.exam'],
  ['submissions', 'fake.submission'],
  ['documents', 'fake.document'],
  ['transcripts', 'fake.transcript'],
];

export interface FakeConnectorOptions {
  /** Source system name used in citations, e.g. "livecampusu-fake". */
  product: string;
  sourceLabel?: string;
  /** Default authority for this source, e.g. "academic-system". */
  authority: string;
  /** Per raw type authority overrides, e.g. { "fake.submission": "submission-system" }. */
  authorities?: Partial<Record<FakeSourceType, string>>;
  capabilities?: Capability[];
  pageSize?: number;
  productVersion?: string;
  testedVersion?: string;
  apiStability?: 'official' | 'unofficial' | 'experimental';
  /** Reference data only, like a syllabus catalog (connector metadata `referenceOnly`). */
  referenceOnly?: boolean;
  dataset?: FakeDataset;
}

/** In-memory SourceAdapter. Tests mutate `dataset` between syncs and can inject failures. */
export class FakeSourceAdapter implements SourceAdapter {
  readonly id: string;
  readonly version = '1.0.0';
  dataset: FakeDataset;
  /** Error thrown by the next sync() call (then cleared). */
  failNext: Error | undefined;
  authenticated = true;
  syncCalls: SyncInput[] = [];
  disposed = false;

  constructor(private readonly options: FakeConnectorOptions) {
    this.id = `fake:${options.product}`;
    this.dataset = options.dataset ?? {};
  }

  capabilities(): Promise<Capability[]> {
    return Promise.resolve(
      this.options.capabilities ?? [
        'courses',
        'timetable',
        'assignments',
        'announcements',
        'messages',
        'exams',
        'submissions',
        'materials',
        'lectures',
      ],
    );
  }

  authenticate(): Promise<AuthResult> {
    return Promise.resolve(
      this.authenticated
        ? { status: 'authenticated', account: 'student@example.ac.jp' }
        : { status: 'auth_required', message: 'login required' },
    );
  }

  health(): Promise<HealthStatus> {
    return Promise.resolve({
      state: this.authenticated ? 'healthy' : 'auth_required',
      checkedAt: new Date().toISOString(),
      ...(this.options.productVersion ? { detectedVersion: this.options.productVersion } : {}),
    });
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return Promise.resolve();
  }

  private allItems(): RawItem[] {
    const out: RawItem[] = [];
    for (const [key, type] of DATASET_KEYS) {
      for (const rec of this.dataset[key] ?? []) {
        const r = rec as { id: string; updatedAt?: string };
        out.push({
          sourceType: type,
          externalId: r.id,
          payload: rec,
          ...(r.updatedAt ? { sourceUpdatedAt: r.updatedAt } : {}),
        });
      }
    }
    return out;
  }

  sync(input: SyncInput): Promise<SyncResult> {
    this.syncCalls.push(input);
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = undefined;
      return Promise.reject(e);
    }
    let items = this.allItems();
    const since = input.mode === 'incremental' ? input.cursor?.lastModified : undefined;
    if (since) items = items.filter((i) => !i.sourceUpdatedAt || i.sourceUpdatedAt > since);
    const pageSize = this.options.pageSize ?? Number.POSITIVE_INFINITY;
    const offset = input.pageToken ? Number(input.pageToken) : 0;
    const page = items.slice(offset, offset + pageSize);
    const hasMore = offset + pageSize < items.length;
    const maxUpdated = this.allItems().reduce<string>(
      (m, i) => (i.sourceUpdatedAt && i.sourceUpdatedAt > m ? i.sourceUpdatedAt : m),
      since ?? '',
    );
    const deletions: RawDeletion[] =
      input.mode === 'incremental'
        ? (this.dataset.deleted ?? []).map((d) => ({ sourceType: d.type, externalId: d.id }))
        : [];
    return Promise.resolve({
      items: page,
      deletions,
      cursor: { ...(maxUpdated ? { lastModified: maxUpdated } : {}) },
      hasMore,
      ...(hasMore ? { nextPageToken: String(offset + pageSize) } : {}),
      ...(input.mode !== 'incremental' && !hasMore
        ? { complete: { sourceTypes: DATASET_KEYS.map(([, t]) => t) } }
        : {}),
      ...(this.options.productVersion
        ? {
            productVersion: { product: this.options.product, version: this.options.productVersion },
          }
        : {}),
    });
  }
}

function hmsToMs(hms: string): number {
  const parts = hms.split(':').map(Number);
  let ms = 0;
  for (const p of parts) ms = ms * 60 + (Number.isFinite(p) ? p : 0);
  return ms * 1000;
}

function periodInstant(
  ctx: NormalizeContext,
  date: string,
  period: number | undefined,
  which: 'start' | 'end',
): string | undefined {
  if (!period || !ctx.profile) return undefined;
  const def = findPeriod(ctx.profile, period);
  if (!def) return undefined;
  const [h, m] = (which === 'start' ? def.start : def.end).split(':').map(Number);
  const [y, mo, d] = date.split('-').map(Number);
  return zonedTime(
    { year: y ?? 0, month: mo ?? 1, day: d ?? 1, hour: h ?? 0, minute: m ?? 0 },
    ctx.timezone,
  ).toISOString();
}

/** Normalizer for the fake raw types. Shows the intended patterns for real connectors. */
export function createFakeNormalizer(
  options: Pick<FakeConnectorOptions, 'authorities'> = {},
): Normalizer {
  return {
    id: 'fake-normalizer',
    version: '1',
    sourceTypes: DATASET_KEYS.map(([, t]) => t),
    normalize(item: RawItemView, ctx: NormalizeContext): NormalizeOutput {
      const type = item.sourceType as FakeSourceType;
      const schema = FakePayloadSchemas[type];
      const drift = detectSchemaDrift(item.payload, schema);
      const parsed = schema.safeParse(item.payload);
      if (!parsed.success)
        return {
          entities: [],
          drift,
          warnings: [`invalid ${type} payload: ${parsed.error.issues[0]?.message ?? ''}`],
        };
      const authority = options.authorities?.[type];
      const ref = authority ? { authority } : undefined;
      const offeringId = (courseId: string | undefined) =>
        courseId ? ctx.id('courseOffering', courseId) : undefined;
      const entities: NormalizedEntity[] = [];
      const facts: FactInput[] = [];
      const push = (
        entity: NormalizedEntity['entity'],
        extra: Partial<NormalizedEntity> = {},
      ): void => {
        entities.push({ entity, ...(ref ? { ref } : {}), ...extra });
      };

      switch (type) {
        case 'fake.course': {
          const p = parsed.data as P<'fake.course'>;
          const courseId = ctx.id('course', p.code ?? p.id);
          push({
            id: courseId,
            kind: 'course',
            title: p.title,
            ...(p.code ? { courseCode: p.code } : {}),
            ...(p.department ? { department: p.department } : {}),
          });
          push({
            id: ctx.id('courseOffering', p.id),
            kind: 'courseOffering',
            courseId,
            title: p.title,
            ...(p.code ? { courseCode: p.code } : {}),
            ...(p.year ? { academicYear: p.year } : {}),
            ...(p.term ? { term: p.term } : {}),
            instructorNames: p.teacher ? [p.teacher] : [],
            schedule: (p.schedule ?? []).map((s) => ({
              dayOfWeek: s.day,
              period: s.period,
              ...(s.room ? { room: s.room } : {}),
            })),
            ...((p.room ?? p.schedule?.[0]?.room) ? { room: p.room ?? p.schedule?.[0]?.room } : {}),
          });
          if (p.enrolled) {
            const self = ctx.id('person', 'self');
            push({ id: self, kind: 'person', name: '本人', roles: ['student'], isSelf: true });
            push({
              id: ctx.id('enrollment', p.id),
              kind: 'enrollment',
              personId: self,
              courseOfferingId: ctx.id('courseOffering', p.id),
              role: 'student',
              status: 'active',
            });
          }
          break;
        }
        case 'fake.session': {
          const p = parsed.data as P<'fake.session'>;
          const startsAt = periodInstant(ctx, p.date, p.period, 'start');
          const endsAt = periodInstant(ctx, p.date, p.period, 'end');
          push({
            id: ctx.id('classSession', p.id),
            kind: 'classSession',
            courseOfferingId: ctx.id('courseOffering', p.courseId),
            date: p.date,
            ...(p.period ? { period: p.period } : {}),
            ...(startsAt ? { startsAt } : {}),
            ...(endsAt ? { endsAt } : {}),
            ...(p.room ? { room: p.room } : {}),
            status: p.status ?? 'scheduled',
            ...(p.number ? { number: p.number } : {}),
          });
          break;
        }
        case 'fake.assignment': {
          const p = parsed.data as P<'fake.assignment'>;
          const co = offeringId(p.courseId);
          push(
            {
              id: ctx.id('assignment', p.id),
              kind: 'assignment',
              title: p.title,
              ...(co ? { courseOfferingId: co } : {}),
              ...(p.due ? { dueAt: p.due } : {}),
              ...(p.description ? { description: p.description } : {}),
              ...(p.url ? { url: p.url } : {}),
            },
            p.url ? { ref: { ...(ref ?? {}), url: p.url } } : {},
          );
          break;
        }
        case 'fake.announcement': {
          const p = parsed.data as P<'fake.announcement'>;
          const co = offeringId(p.courseId);
          const id = ctx.id('announcement', p.id);
          push({
            id,
            kind: 'announcement',
            title: p.title,
            body: p.body,
            ...(co ? { courseOfferingId: co } : {}),
            ...(p.publishedAt ? { publishedAt: p.publishedAt } : {}),
            ...(p.author ? { authorName: p.author } : {}),
            importance: p.importance ?? 'normal',
            scope: p.scope ?? (co ? 'course' : 'university'),
            ...(p.url ? { url: p.url } : {}),
          });
          if (p.roomChange && co) {
            const day = p.roomChange.date
              ? parseZonedDate(p.roomChange.date, ctx.timezone)
              : undefined;
            facts.push({
              subject: co,
              predicate: 'room',
              value: p.roomChange.room,
              origin: 'extracted',
              confidence: 0.9,
              evidence: p.body,
              ...(p.publishedAt ? { observedAt: p.publishedAt } : {}),
              ...(day
                ? {
                    validFrom: day.toISOString(),
                    validUntil: addZonedDays(day, 1, ctx.timezone).toISOString(),
                  }
                : {}),
              ref: {
                authority: authority ?? 'instructor-announcement',
                ...(p.url ? { url: p.url } : {}),
                location: { messageId: p.id },
              },
            });
          }
          break;
        }
        case 'fake.message': {
          const p = parsed.data as P<'fake.message'>;
          const co = offeringId(p.courseId);
          let threadId: ReturnType<typeof ctx.id<'thread'>> | undefined;
          if (p.thread) {
            threadId = ctx.id('thread', p.courseId ?? '', p.thread);
            push({
              id: threadId,
              kind: 'thread',
              title: p.thread,
              ...(co ? { courseOfferingId: co } : {}),
            });
          }
          push(
            {
              id: ctx.id('message', p.id),
              kind: 'message',
              body: p.body,
              ...(threadId ? { threadId } : {}),
              ...(co ? { courseOfferingId: co } : {}),
              ...(p.author ? { authorName: p.author } : {}),
              ...(p.authorRole ? { authorRole: p.authorRole } : {}),
              ...(p.sentAt ? { sentAt: p.sentAt } : {}),
              ...(p.url ? { url: p.url } : {}),
              ...(p.isQuestion !== undefined ? { isQuestion: p.isQuestion } : {}),
            },
            {
              ref: {
                ...(ref ?? {}),
                location: { messageId: p.id },
                ...(p.url ? { url: p.url } : {}),
              },
            },
          );
          break;
        }
        case 'fake.exam': {
          const p = parsed.data as P<'fake.exam'>;
          const co = offeringId(p.courseId);
          push({
            id: ctx.id('exam', p.id),
            kind: 'exam',
            title: p.title,
            examKind: p.kind ?? 'other',
            ...(co ? { courseOfferingId: co } : {}),
            ...(p.startsAt ? { startsAt: p.startsAt } : {}),
            ...(p.room ? { room: p.room } : {}),
            ...(p.scope ? { scope: p.scope } : {}),
          });
          break;
        }
        case 'fake.submission': {
          const p = parsed.data as P<'fake.submission'>;
          push({
            id: ctx.id('submission', p.id),
            kind: 'submission',
            assignmentId: ctx.id('assignment', p.assignmentId),
            status: p.status,
            ...(p.submittedAt ? { submittedAt: p.submittedAt } : {}),
          });
          break;
        }
        case 'fake.document': {
          const p = parsed.data as P<'fake.document'>;
          const co = offeringId(p.courseId);
          const docId = ctx.id('document', p.id);
          push({
            id: docId,
            kind: 'document',
            title: p.title,
            text: p.text,
            ...(co ? { courseOfferingId: co } : {}),
            ...(p.path ? { path: p.path } : {}),
          });
          const paragraphs = p.text
            .split(/\n\s*\n/)
            .map((s) => s.trim())
            .filter(Boolean);
          paragraphs.forEach((text, i) => {
            push(
              {
                id: ctx.id('documentChunk', p.id, String(i)),
                kind: 'documentChunk',
                documentId: docId,
                ordinal: i,
                text,
                page: i + 1,
              },
              { ref: { ...(ref ?? {}), location: { page: i + 1 } } },
            );
          });
          if (co) {
            const lectureId = p.lectureDate
              ? ctx.id('lecture', p.courseId ?? '', p.lectureDate)
              : undefined;
            if (lectureId && p.lectureDate)
              push(
                {
                  id: lectureId,
                  kind: 'lecture',
                  date: p.lectureDate,
                  courseOfferingId: co,
                  topics: [],
                },
                { deriveFacts: false },
              );
            push({
              id: ctx.id('material', p.id),
              kind: 'material',
              title: p.title,
              materialKind: 'slides',
              documentId: docId,
              courseOfferingId: co,
              ...(lectureId ? { lectureId } : {}),
            });
          }
          break;
        }
        case 'fake.transcript': {
          const p = parsed.data as P<'fake.transcript'>;
          const co = offeringId(p.courseId);
          const lectureId = ctx.id('lecture', p.courseId ?? '', p.date);
          const transcriptId = ctx.id('lectureTranscript', p.id);
          push(
            {
              id: lectureId,
              kind: 'lecture',
              date: p.date,
              ...(co ? { courseOfferingId: co } : {}),
              ...(p.title ? { title: p.title } : {}),
              topics: [],
            },
            { deriveFacts: false },
          );
          push({
            id: transcriptId,
            kind: 'lectureTranscript',
            lectureId,
            importer: 'fake',
            ...(co ? { courseOfferingId: co } : {}),
            ...(p.title ? { title: p.title } : {}),
          });
          p.segments.forEach((s, i) => {
            push(
              {
                id: ctx.id('lectureSegment', p.id, String(i)),
                kind: 'lectureSegment',
                transcriptId,
                ordinal: i,
                startMs: hmsToMs(s.start),
                text: s.text,
                ...(s.speaker ? { speaker: s.speaker } : {}),
              },
              {
                ref: {
                  ...(ref ?? {}),
                  location: { timestamp: s.start, timestampMs: hmsToMs(s.start) },
                },
              },
            );
          });
          break;
        }
      }
      return { entities, facts, drift };
    },
  };
}

export interface FakeConnector {
  metadata: ConnectorMetadata;
  adapter: FakeSourceAdapter;
  normalizer: Normalizer;
  module: ConnectorModule<Record<string, JsonValue>>;
}

/** Build a fake connector (adapter + normalizer + metadata) for tests and demos. */
export function createFakeConnector(options: FakeConnectorOptions): FakeConnector {
  const metadata = defineMetadata({
    name: `@unicontext/fake-${options.product}`,
    product: options.product,
    version: '1.0.0',
    license: 'MIT',
    capabilities: options.capabilities ?? [
      'courses',
      'timetable',
      'assignments',
      'announcements',
      'messages',
      'exams',
      'submissions',
      'materials',
      'lectures',
    ],
    adapter: 'native',
    apiStability: options.apiStability ?? 'official',
    risk: options.apiStability === 'unofficial' ? 'unsupported' : 'supported',
    ...(options.testedVersion ? { testedVersion: options.testedVersion } : {}),
    defaultAuthority: options.authority,
    ...(options.sourceLabel ? { sourceLabel: options.sourceLabel } : {}),
    rawTypes: DATASET_KEYS.map(([, t]) => t),
    defaultSchedule: '15m',
    ...(options.referenceOnly ? { referenceOnly: true } : {}),
  });
  const adapter = new FakeSourceAdapter(options);
  const normalizer = createFakeNormalizer(options);
  const module = defineConnector<Record<string, JsonValue>>({
    metadata,
    createAdapter: () => adapter,
    createNormalizer: () => normalizer,
  });
  return { metadata, adapter, normalizer, module };
}
