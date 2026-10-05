import {
  ADDITIONS_SOURCE_ID,
  type Addition,
  type AdditionKind,
  type AdditionStatus,
  type AdditionTool,
  type Assignment,
  type ChangeEvent,
  type ClassSession,
  type EntityId,
  type Exam,
  type Fact,
  type JsonValue,
  makeId,
  type SourceReference,
  stableId,
} from '@unicontext/canonical-model';
import {
  addLocalDays,
  type Clock,
  formatShortJa,
  NotFoundError,
  parseZonedDate,
  PolicyViolationError,
  RateLimitedError,
  sha256,
  stableStringify,
  ValidationError,
  zonedDateString,
  zonedParts,
  zonedTime,
} from '@unicontext/core';
import {
  AdditionStore,
  ChangeEventStore,
  EntityStore,
  SourceReferenceStore,
  type UniContextDatabase,
} from '@unicontext/database';
import type { IdentityResolver } from '@unicontext/identity';
import { type Citation, type ConflictResolver, factId, toCitation } from '@unicontext/provenance';
import {
  resolveDueExpression,
  type ResolvedDue,
  type TaskEngine,
  TODO_PREDICATE,
  type TodoValue,
} from '@unicontext/task-engine';

/*
 * Writes from AI clients (§11, §19–22, §47–49, §74): lectures, deadlines, notes and things to do
 * that ChatGPT heard in a lecture recording (via `recording`) or that the student told it — or
 * planned with it — in any chat (via `chat`), stored in UniContext's own database only, so every
 * other session and client sees them. Nothing is ever sent to a university system. Every claim is
 * origin=extracted with a SourceReference to the recording or the chat (client, time, recording
 * timestamp, evidence); it never overrides a system that states the same thing, it opens a
 * Conflict instead, and only the owner can confirm it (→ user fact) or reject it. Task status,
 * grades, submissions and authoritative entities are never written.
 */

/**
 * Where an addition came from: heard in a lecture recording (ChatGPT Record …) or told / created
 * in a chat with the student. Both are shown and shared at once; confirming is only needed to let
 * an item win over a system that says something else.
 */
export const ADDITION_VIAS = ['recording', 'chat'] as const;
export type AdditionVia = (typeof ADDITION_VIAS)[number];

/** How an unconfirmed addition is labelled on Today, in deadlines and in notifications. */
export const ADDITION_VIA_LABELS: Record<AdditionVia, string> = {
  recording: '録音から',
  chat: 'チャットで登録',
};

/** SourceReference authority per channel (see default-rules.yaml). */
export const ADDITION_VIA_AUTHORITY: Record<AdditionVia, string> = {
  recording: 'transcript',
  chat: 'student-statement',
};

export function additionViaOfAuthority(authority: string | undefined): AdditionVia {
  return authority === ADDITION_VIA_AUTHORITY.chat ? 'chat' : 'recording';
}

/** Subject of to-dos that belong to no course (the student's own list). */
export const PERSONAL_TODO_SUBJECT = stableId('person', ADDITIONS_SOURCE_ID, 'self');

/** Who is writing: the OAuth client (remote) or `local:<name>` (stdio / local HTTP). */
export interface AdditionClient {
  id: string;
  name?: string | undefined;
}

/** Size limits of one write call (also used for the MCP input schemas). */
export const ADDITION_LIMITS = {
  title: 200,
  summary: 4000,
  keyPoints: 30,
  keyPoint: 500,
  segments: 500,
  segmentText: 2000,
  transcriptChars: 100_000,
  evidence: 1000,
  noteText: 20_000,
  notes: 2000,
  source: 60,
  idempotencyKey: 128,
} as const;

/** Per-client write budget. */
export const ADDITION_RATE_LIMITS = {
  /** writes (created/updated additions) per 10 minutes */
  perTenMinutes: 30,
  /** writes per 24 hours */
  perDay: 300,
  /** calls (incl. duplicates and retractions) per minute, per process */
  burstPerMinute: 30,
} as const;

/** Two deadlines with the same course + title this close together are the same item. */
export const DEDUPE_TOLERANCE_MS = 36 * 3_600_000;

const CONFIDENCE = 0.7;
/** Predicates an addition may put on someone else's entity. Never grades, submissions, status. */
const ATTACHABLE_PREDICATES = new Set(['assignment_due', 'exam_at']);
const OWN_PREDICATES = new Set(['assignment_due', 'exam_at', TODO_PREDICATE]);

export type DeadlineKind = 'assignment' | 'report' | 'quiz' | 'exam' | 'prep';

interface Common {
  /** The course it belongs to; optional except for record_lecture (personal deadlines/to-dos/notes). */
  courseOfferingId?: string | undefined;
  /**
   * recording = heard in a lecture recording, chat = the student said it (or planned it) in a chat.
   * Default: recording for record_lecture or when recordingTimestamp is given, else chat.
   */
  via?: AdditionVia | undefined;
  /** Date (YYYY-MM-DD) of the lecture it was heard in / of the conversation; default: today. */
  lectureDate?: string | undefined;
  /** Position in the recording, "HH:MM:SS" (or "MM:SS"). */
  recordingTimestamp?: string | undefined;
  /**
   * Name of the source; default "ChatGPT Record" (recording, ChatGPT) or "ChatGPTとの会話" (chat),
   * else from the client name.
   */
  source?: string | undefined;
  idempotencyKey?: string | undefined;
}

export interface RecordLectureInput extends Omit<Common, 'lectureDate' | 'courseOfferingId'> {
  courseOfferingId: string;
  date: string;
  period?: number | undefined;
  title?: string | undefined;
  summary: string;
  keyPoints?: string[] | undefined;
  transcriptExcerpt?: string | undefined;
  segments?: { at?: string | undefined; text: string; speaker?: string | undefined }[] | undefined;
}

export interface AddDeadlineInput extends Common {
  title: string;
  /** Absolute ISO-8601, or Japanese relative (来週の金曜 / 次回 / 10月15日17時). */
  dueAt: string;
  kind: DeadlineKind;
  evidence: string;
  notes?: string | undefined;
}

export interface AddNoteInput extends Common {
  title?: string | undefined;
  text: string;
  evidence?: string | undefined;
}

export interface AddTaskInput extends Common {
  title: string;
  dueAt?: string | undefined;
  notes?: string | undefined;
  evidence?: string | undefined;
}

export type AdditionWriteStatus =
  'created' | 'updated' | 'duplicate' | 'replayed' | 'retracted' | 'confirmed' | 'rejected';

export interface AdditionView {
  id: string;
  tool: AdditionTool;
  kind: AdditionKind;
  status: AdditionStatus;
  /** recording = heard in a lecture recording, chat = told / created in a chat. */
  via: AdditionVia;
  /** 「録音から」 / 「チャットで登録」 */
  label: string;
  title: string;
  course: { id: string; title: string } | undefined;
  dueAt: string | undefined;
  /** "10/9 23:59" in the profile timezone. */
  dueText: string | undefined;
  /** How a relative due date was resolved. */
  dueResolution: JsonValue | undefined;
  evidence: string | undefined;
  recordingTimestamp: string | undefined;
  source: string;
  client: { id: string; name: string | undefined };
  /** Ids written for this addition (lecture/transcript/segments/assignment/exam/document/task). */
  stored: Record<string, JsonValue>;
  /** Someone else's entity (e.g. the LiveCampusU assignment) the due date was attached to. */
  attachedTo: { id: string; kind: string; title: string; source: string | undefined } | undefined;
  /** Open conflicts about what this addition says (the recording disagrees with a system). */
  conflicts: { id: string; predicate: string; values: { value: JsonValue; source: string }[] }[];
  createdAt: string;
  updatedAt: string;
  decidedAt: string | undefined;
}

export interface AdditionResult {
  status: AdditionWriteStatus;
  addition: AdditionView;
  /** Ids touched by this call (audit log; never payload text). */
  audit: { additionId: string; entityIds: string[]; factIds: string[] };
}

/** A note (add_note) or lecture summary (record_lecture) as every client sees it (get_notes). */
export interface NoteItem {
  /** The document holding the note. */
  id: string;
  additionId: string;
  kind: 'note' | 'lecture_summary';
  title: string;
  /** Cut to {@link NOTE_PREVIEW_CHARS} in lists; complete when one note is asked for by id. */
  text: string;
  truncated: boolean;
  course: { id: string; title: string } | undefined;
  via: AdditionVia;
  /** 「録音から」 / 「チャットで登録」 */
  label: string;
  /** unconfirmed | confirmed (rejected / retracted notes are gone). */
  status: AdditionStatus;
  source: string;
  client: string | undefined;
  lectureDate: string | undefined;
  createdAt: string;
  updatedAt: string;
  citations: Citation[];
}

export const NOTE_PREVIEW_CHARS = 500;

export interface AdditionsServiceDeps {
  db: UniContextDatabase;
  clock: Clock;
  timezone: string;
  resolver: ConflictResolver;
  identity: IdentityResolver;
  tasks: TaskEngine;
  courseTitle: (id: string) => string | undefined;
  /** Identity → conflicts → tasks (createUniContext's runPipeline). */
  runPipeline: () => Promise<unknown>;
}

interface Applied {
  entityIds: string[];
  ownEntityIds: string[];
  factIds: string[];
  stored: Record<string, JsonValue>;
  attachedTo?: string;
}

function normTitle(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function digits(s: string): string {
  return (s.normalize('NFKC').match(/\d+/g) ?? []).map((d) => String(Number(d))).join(',');
}

function bigramDice(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    if (s.length === 1) out.add(s);
    return out;
  };
  const x = grams(a);
  const y = grams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let n = 0;
  for (const g of x) if (y.has(g)) n++;
  return (2 * n) / (x.size + y.size);
}

/** Same work item? Titles must be close and, when both carry numbers (課題2 / 課題3), the same ones. */
export function sameItemTitle(a: string, b: string): boolean {
  const x = normTitle(a);
  const y = normTitle(b);
  if (!x || !y) return false;
  const dx = digits(a);
  const dy = digits(b);
  if (dx && dy && dx !== dy) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 3 && long.includes(short)) return true;
  return bigramDice(x, y) >= 0.6;
}

/** "HH:MM:SS" / "MM:SS" / "H:MM:SS" → milliseconds. */
export function parseRecordingTimestamp(s: string): number | undefined {
  const m = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?$/.exec(s.normalize('NFKC').trim());
  if (!m) return undefined;
  const [h, mi, se] = [Number(m[1] ?? 0), Number(m[2]), Number(m[3])];
  if (se > 59 || (m[1] !== undefined && mi > 59)) return undefined;
  return ((h * 60 + mi) * 60 + se) * 1000 + Number((m[4] ?? '0').padEnd(3, '0'));
}

function hms(ms: number): string {
  const s = Math.floor(ms / 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

function deadlineGroup(kind: DeadlineKind): 'assignment' | 'exam' | 'todo' {
  if (kind === 'exam' || kind === 'quiz') return 'exam';
  if (kind === 'prep') return 'todo';
  return 'assignment';
}

function examKindOf(kind: DeadlineKind, title: string): Exam['examKind'] {
  if (kind === 'quiz' || /小テスト|クイズ|quiz/i.test(title)) return 'quiz';
  if (/期末|final/i.test(title)) return 'final';
  if (/中間|midterm/i.test(title)) return 'midterm';
  return 'other';
}

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function viaOf(input: Common): AdditionVia {
  if (input.via) return input.via;
  return input.recordingTimestamp?.trim() ? 'recording' : 'chat';
}

/** Additions stored before the chat channel existed were all heard in a recording. */
export function viaOfAddition(a: Pick<Addition, 'data'>): AdditionVia {
  return a.data.via === 'chat' ? 'chat' : 'recording';
}

function labelOf(a: Pick<Addition, 'data'>): string {
  return ADDITION_VIA_LABELS[viaOfAddition(a)];
}

export class AdditionsService {
  readonly store: AdditionStore;
  private readonly entities: EntityStore;
  private readonly refs: SourceReferenceStore;
  private readonly changes: ChangeEventStore;
  private readonly burst = new Map<string, number[]>();

  constructor(private readonly deps: AdditionsServiceDeps) {
    this.store = new AdditionStore(deps.db);
    this.entities = new EntityStore(deps.db, { clock: deps.clock });
    this.refs = new SourceReferenceStore(deps.db);
    this.changes = new ChangeEventStore(deps.db);
  }

  private now(): Date {
    return this.deps.clock.now();
  }

  private get tz(): string {
    return this.deps.timezone;
  }

  // ---------- public API: AI clients ----------

  async recordLecture(client: AdditionClient, input: RecordLectureInput): Promise<AdditionResult> {
    if (!LOCAL_DATE.test(input.date)) throw new ValidationError('date must be YYYY-MM-DD');
    parseZonedDate(input.date, this.tz);
    const course = this.requireCourse(input.courseOfferingId);
    const session = this.sessionOf(course, input.date, input.period);
    const period = input.period ?? session?.period;
    const title = input.title?.trim() || `${this.courseTitle(course)} ${input.date}`;
    const segments = this.segmentsOf(input);
    return this.write(client, {
      tool: 'record_lecture',
      kind: 'lecture',
      input,
      via: input.via ?? 'recording',
      course,
      title,
      dedupeKey: `lecture|${course}|${input.date}|${period ?? ''}`,
      dueAt: undefined,
      data: {
        date: input.date,
        ...(period !== undefined ? { period } : {}),
        summary: input.summary,
        keyPoints: input.keyPoints ?? [],
        segmentCount: segments.length,
      },
      apply: (a, ref) => this.applyLecture(a, ref, input, session, period, title, segments),
    });
  }

  async addDeadline(client: AdditionClient, input: AddDeadlineInput): Promise<AdditionResult> {
    const course = this.course(input.courseOfferingId);
    const title = input.title.trim();
    if (!title) throw new ValidationError('title is empty');
    const due = this.resolveDue(course, input.dueAt, input.lectureDate, input.recordingTimestamp);
    const group = deadlineGroup(input.kind);
    return this.write(client, {
      tool: 'add_deadline',
      kind: input.kind,
      input,
      via: viaOf(input),
      course,
      title,
      dedupeKey: `${group}|${course ?? '-'}|${normTitle(title)}`,
      dueAt: due.dueAt,
      data: {
        dueInput: input.dueAt,
        dueResolution: { ...due.resolution },
        evidence: input.evidence,
        ...(input.notes ? { notes: input.notes } : {}),
      },
      apply: (a, ref) =>
        group === 'todo'
          ? this.applyTodo(a, ref, course, title, 'prep', due.dueAt, input.evidence, input.notes)
          : group === 'exam'
            ? this.applyExam(a, ref, course, title, input, due)
            : this.applyAssignment(a, ref, course, title, input, due),
    });
  }

  async addNote(client: AdditionClient, input: AddNoteInput): Promise<AdditionResult> {
    const course = this.course(input.courseOfferingId);
    const text = input.text.trim();
    if (!text) throw new ValidationError('text is empty');
    const title = input.title?.trim() || (text.length > 40 ? `${text.slice(0, 40)}…` : text);
    return this.write(client, {
      tool: 'add_note',
      kind: 'note',
      input,
      via: viaOf(input),
      course,
      title,
      dedupeKey: `note|${course ?? '-'}|${normTitle(title)}`,
      dueAt: undefined,
      data: { text, ...(input.evidence ? { evidence: input.evidence } : {}) },
      apply: (a, ref) => this.applyNote(a, ref, course, title, text, input.lectureDate),
    });
  }

  async addTask(client: AdditionClient, input: AddTaskInput): Promise<AdditionResult> {
    const course = this.course(input.courseOfferingId);
    const title = input.title.trim();
    if (!title) throw new ValidationError('title is empty');
    const due =
      input.dueAt !== undefined && input.dueAt.trim() !== ''
        ? this.resolveDue(course, input.dueAt, input.lectureDate, input.recordingTimestamp)
        : undefined;
    return this.write(client, {
      tool: 'add_task',
      kind: 'task',
      input,
      via: viaOf(input),
      course,
      title,
      dedupeKey: `todo|${course ?? '-'}|${normTitle(title)}`,
      dueAt: due?.dueAt,
      data: {
        ...(input.dueAt ? { dueInput: input.dueAt } : {}),
        ...(due ? { dueResolution: { ...due.resolution } } : {}),
        ...(input.evidence ? { evidence: input.evidence } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
      },
      apply: (a, ref) =>
        this.applyTodo(a, ref, course, title, 'task', due?.dueAt, input.evidence, input.notes),
    });
  }

  /** The client's own additions, newest first. */
  listFor(
    client: AdditionClient,
    options: { statuses?: AdditionStatus[]; limit?: number } = {},
  ): AdditionView[] {
    return this.store
      .list({
        clientId: client.id,
        ...(options.statuses ? { statuses: options.statuses } : {}),
        limit: options.limit ?? 50,
      })
      .map((a) => this.view(a));
  }

  /** Withdraw one of the client's own, still unconfirmed additions. */
  async retract(client: AdditionClient, id: string): Promise<AdditionResult> {
    this.burstHit(client);
    const a = this.store.get(id);
    if (!a || a.clientId !== client.id) throw new NotFoundError(`addition ${id}`);
    if (a.status === 'retracted' || a.status === 'rejected')
      return { status: 'retracted', addition: this.view(a), audit: this.auditOf(a) };
    if (a.status !== 'unconfirmed')
      throw new PolicyViolationError(
        `addition ${id} was confirmed by the owner; only the owner can remove it now`,
      );
    const next = this.undo(a, 'retracted');
    await this.deps.runPipeline();
    return { status: 'retracted', addition: this.view(next), audit: this.auditOf(next) };
  }

  // ---------- public API: the owner (CLI / Web UI) ----------

  list(options: { statuses?: AdditionStatus[]; limit?: number } = {}): AdditionView[] {
    return this.store
      .list({
        ...(options.statuses ? { statuses: options.statuses } : {}),
        limit: options.limit ?? 200,
      })
      .map((a) => this.view(a));
  }

  get(id: string): AdditionView | undefined {
    const a = this.store.get(id);
    return a ? this.view(a) : undefined;
  }

  /** The owner confirms: every claim becomes a user fact (§74) and wins over the sources. */
  async confirm(id: string): Promise<AdditionView> {
    const a = this.store.get(id);
    if (!a) throw new NotFoundError(`addition ${id}`);
    if (a.status === 'confirmed') return this.view(a);
    if (a.status !== 'unconfirmed')
      throw new ValidationError(`addition ${id} is ${a.status} and cannot be confirmed`);
    const now = this.now().toISOString();
    const userFacts: string[] = [];
    for (const f of this.deps.resolver.facts.getMany(a.factIds)) {
      if (f.retractedAt || f.origin !== 'extracted') continue;
      if (f.predicate === TODO_PREDICATE) userFacts.push(this.confirmTodo(a, f, now).id);
      else
        userFacts.push(
          this.deps.resolver.correct({
            subject: f.subject,
            predicate: f.predicate,
            value: f.value,
            note: f.evidence ?? 'AIクライアントが追加した内容を本人が確認',
          }).fact.id,
        );
    }
    const next = this.store.save({
      ...a,
      status: 'confirmed',
      factIds: [...new Set([...a.factIds, ...userFacts])] as Addition['factIds'],
      updatedAt: now,
      decidedAt: now,
    });
    await this.deps.runPipeline();
    return this.view(next);
  }

  /** The owner rejects: its facts are retracted and its own entities removed. */
  async reject(id: string): Promise<AdditionView> {
    const a = this.store.get(id);
    if (!a) throw new NotFoundError(`addition ${id}`);
    if (a.status === 'rejected') return this.view(a);
    const next = this.undo(a, 'rejected');
    await this.deps.runPipeline();
    return this.view(next);
  }

  /**
   * Resolve a due-date expression for a course the way add_deadline does, against the lecture
   * date and the next class from the timetable and the academic calendar.
   */
  resolveDue(
    courseOfferingId: string | undefined,
    expression: string,
    lectureDate?: string,
    recordingTimestamp?: string,
  ): { dueAt: string; resolution: Record<string, JsonValue> } {
    const course = courseOfferingId ? this.deps.identity.canonical(courseOfferingId) : undefined;
    const reference = this.referenceTime(course, lectureDate, recordingTimestamp);
    const next = course ? this.deps.tasks.nextClassAt(course, reference) : undefined;
    const r: ResolvedDue | undefined = resolveDueExpression(expression, {
      reference,
      timezone: this.tz,
      ...(next ? { nextClassAt: next } : {}),
    });
    if (!r)
      throw new ValidationError(
        `dueAt 「${expression}」 could not be read as a date: use ISO-8601 (2026-10-15T23:59+09:00) or a Japanese expression such as 来週の金曜 / 10月15日17時${course ? ' / 次回' : ' (次回 needs a course)'}`,
      );
    if (!course && r.rule === 'next_class')
      throw new ValidationError(
        `dueAt 「${expression}」 (次回) needs a course to find the next class: give the course or a date`,
      );
    const t = Date.parse(r.dueAt);
    const span = 400 * 86_400_000;
    if (Math.abs(t - reference.getTime()) > span)
      throw new ValidationError(`dueAt ${r.dueAt} is more than a year away from the lecture`);
    return {
      dueAt: r.dueAt,
      resolution: {
        input: expression,
        rule: r.rule,
        timeAssumed: r.timeAssumed,
        reference: reference.toISOString(),
        resolvedText: formatShortJa(new Date(r.dueAt), this.tz),
        ...(r.rule === 'next_class' || r.rule === 'next_week'
          ? { nextClassAt: next?.toISOString() ?? null }
          : {}),
      },
    };
  }

  // ---------- core write path ----------

  private async write(
    client: AdditionClient,
    w: {
      tool: AdditionTool;
      kind: AdditionKind;
      input: Common;
      via: AdditionVia;
      course: string | undefined;
      title: string;
      dedupeKey: string;
      dueAt: string | undefined;
      data: Record<string, JsonValue>;
      apply: (a: Addition, ref: SourceReference) => Applied;
    },
  ): Promise<AdditionResult> {
    this.burstHit(client);
    const explicit = w.input.idempotencyKey?.trim();
    let key = explicit || this.autoKey(w.tool, w.input);
    const replay = this.store.byIdempotencyKey(client.id, key);
    // Without an explicit key, sending the same thing again after withdrawing it adds it again.
    if (replay && !explicit && replay.status === 'retracted')
      key = `${key}:${this.now().getTime()}`;
    else if (replay)
      return { status: 'replayed', addition: this.view(replay), audit: this.auditOf(replay) };

    const candidates = this.store
      .byDedupeKey(w.dedupeKey, ['unconfirmed', 'confirmed'])
      .filter((a) =>
        a.dueAt === undefined || w.dueAt === undefined
          ? a.dueAt === w.dueAt
          : Math.abs(Date.parse(a.dueAt) - Date.parse(w.dueAt)) <= DEDUPE_TOLERANCE_MS,
      );
    const same = candidates[0];
    if (same && (same.clientId !== client.id || same.status === 'confirmed'))
      return { status: 'duplicate', addition: this.view(same), audit: this.auditOf(same) };

    this.assertBudget(client);
    const now = this.now().toISOString();
    const source = this.sourceName(client, w.input.source, w.via);
    const ts = w.input.recordingTimestamp?.trim();
    const tsMs = ts ? parseRecordingTimestamp(ts) : undefined;
    if (ts && tsMs === undefined)
      throw new ValidationError('recordingTimestamp must look like HH:MM:SS');
    const base: Addition = same
      ? { ...same, idempotencyKey: same.idempotencyKey ?? key }
      : {
          id: makeId('addition'),
          clientId: client.id,
          ...(client.name ? { clientName: client.name } : {}),
          tool: w.tool,
          kind: w.kind,
          status: 'unconfirmed',
          title: w.title,
          entityIds: [],
          ownEntityIds: [],
          factIds: [],
          data: {},
          createdAt: now,
          updatedAt: now,
        };
    const addition: Addition = {
      ...base,
      title: w.title,
      ...(w.course ? { courseOfferingId: w.course as Addition['courseOfferingId'] } : {}),
      ...(w.dueAt ? { dueAt: w.dueAt } : {}),
      dedupeKey: w.dedupeKey,
      ...(same ? {} : { idempotencyKey: key }),
      data: {
        ...w.data,
        via: w.via,
        source,
        ...(w.input.lectureDate ? { lectureDate: w.input.lectureDate } : {}),
        ...(tsMs !== undefined ? { recordingTimestamp: hms(tsMs) } : {}),
      },
      updatedAt: now,
    };
    if (!w.dueAt) delete addition.dueAt;
    if (!w.course) delete addition.courseOfferingId;

    const ref = this.refFor(addition, client, source, undefined, tsMs);
    const applied = this.deps.db.transaction(() => {
      const r = w.apply(addition, ref);
      // A re-applied addition drops what it no longer says.
      const keepFacts = new Set(r.factIds);
      this.deps.resolver.facts.retract(
        addition.factIds.filter((f) => !keepFacts.has(f)),
        now,
      );
      const keepOwn = new Set(r.ownEntityIds);
      for (const id of addition.ownEntityIds)
        if (!keepOwn.has(id)) this.entities.softDelete(id, now);
      const saved = this.store.save({
        ...addition,
        sourceReferenceId: ref.id,
        entityIds: r.entityIds as Addition['entityIds'],
        ownEntityIds: r.ownEntityIds as Addition['ownEntityIds'],
        factIds: r.factIds as Addition['factIds'],
        data: {
          ...addition.data,
          stored: r.stored,
          ...(r.attachedTo ? { attachedTo: r.attachedTo } : {}),
        },
      });
      return saved;
    });
    await this.deps.runPipeline();
    const stored = this.store.get(applied.id) ?? applied;
    return {
      status: same ? 'updated' : 'created',
      addition: this.view(stored),
      audit: this.auditOf(stored),
    };
  }

  private undo(a: Addition, status: 'retracted' | 'rejected'): Addition {
    const now = this.now().toISOString();
    return this.deps.db.transaction(() => {
      this.deps.resolver.facts.retract(a.factIds, now);
      for (const id of a.ownEntityIds) this.entities.softDelete(id, now);
      return this.store.save({ ...a, status, updatedAt: now, decidedAt: now });
    });
  }

  // ---------- appliers ----------

  private applyLecture(
    a: Addition,
    primary: SourceReference,
    input: RecordLectureInput,
    session: ClassSession | undefined,
    period: number | undefined,
    title: string,
    segments: {
      startMs: number;
      text: string;
      speaker?: string | undefined;
      timestamped: boolean;
    }[],
  ): Applied {
    const course = a.courseOfferingId as string;
    const lectureId = stableId(
      'lecture',
      ADDITIONS_SOURCE_ID,
      course,
      input.date,
      String(period ?? ''),
    );
    const keyPoints = (input.keyPoints ?? []).map((k) => k.trim()).filter(Boolean);
    const own: string[] = [];
    this.upsertOwn(
      {
        id: lectureId,
        kind: 'lecture',
        courseOfferingId: course as Assignment['courseOfferingId'],
        ...(session ? { classSessionId: session.id } : {}),
        date: input.date,
        title,
        topics: keyPoints,
        extra: {
          additionId: a.id,
          summary: input.summary,
          ...(period !== undefined ? { period } : {}),
        },
      },
      a,
      primary,
    );
    own.push(lectureId);
    const documentId = stableId('document', ADDITIONS_SOURCE_ID, a.id, 'lecture-summary');
    const text = [input.summary.trim(), ...keyPoints.map((k) => `- ${k}`)].join('\n');
    this.upsertOwn(
      {
        id: documentId,
        kind: 'document',
        title: `講義メモ: ${title}`,
        mimeType: 'text/markdown',
        text,
        courseOfferingId: course as Assignment['courseOfferingId'],
        modifiedAt: this.now().toISOString(),
        extra: { additionId: a.id, lectureId, summaryOf: lectureId, recorded: true },
      },
      a,
      primary,
    );
    own.push(documentId);
    const stored: Record<string, JsonValue> = {
      lectureId,
      documentId,
      segmentCount: segments.length,
    };
    if (session) stored.classSessionId = session.id;
    if (segments.length > 0) {
      const transcriptId = stableId('lectureTranscript', ADDITIONS_SOURCE_ID, a.id);
      this.upsertOwn(
        {
          id: transcriptId,
          kind: 'lectureTranscript',
          lectureId,
          courseOfferingId: course as Assignment['courseOfferingId'],
          title,
          language: 'ja',
          importer: `mcp:${a.clientName ?? a.clientId}`,
          extra: { additionId: a.id, excerpt: true },
        },
        a,
        primary,
      );
      own.push(transcriptId);
      stored.transcriptId = transcriptId;
      segments.forEach((s, i) => {
        const id = stableId('lectureSegment', ADDITIONS_SOURCE_ID, a.id, String(i));
        const ref = s.timestamped
          ? this.refFor(a, undefined, primary.sourceSystem, id, s.startMs)
          : this.refFor(a, undefined, primary.sourceSystem, id, undefined);
        this.upsertOwn(
          {
            id,
            kind: 'lectureSegment',
            transcriptId,
            ordinal: i,
            startMs: s.startMs,
            ...(s.speaker ? { speaker: s.speaker } : {}),
            text: s.text,
          },
          a,
          ref,
        );
        own.push(id);
      });
    }
    return { entityIds: own, ownEntityIds: own, factIds: [], stored };
  }

  private applyAssignment(
    a: Addition,
    ref: SourceReference,
    course: string | undefined,
    title: string,
    input: AddDeadlineInput,
    due: { dueAt: string; resolution: Record<string, JsonValue> },
  ): Applied {
    const label = labelOf(a);
    const match = course ? this.matchAssignment(course, title, due.dueAt) : undefined;
    if (match) {
      const dueAt = this.alignTime(due, match.dueAt);
      const fact = this.putFact(a, ref, match.id, 'assignment_due', dueAt, input.evidence, false);
      return {
        entityIds: [match.id],
        ownEntityIds: [],
        factIds: [fact.id],
        stored: { assignmentId: match.id, attached: true },
        attachedTo: match.id,
      };
    }
    const id = stableId('assignment', ADDITIONS_SOURCE_ID, a.id);
    const created = this.upsertOwn(
      {
        id,
        kind: 'assignment',
        ...(course ? { courseOfferingId: course as Assignment['courseOfferingId'] } : {}),
        title,
        description: input.notes
          ? `${input.notes}\n（${label}: ${input.evidence}）`
          : `${label}: ${input.evidence}`,
        dueAt: due.dueAt,
        ...(input.kind === 'report' ? { submissionType: 'report' } : {}),
        extra: { additionId: a.id, kind: input.kind, recorded: true },
      },
      a,
      ref,
    );
    const fact = this.putFact(a, ref, id, 'assignment_due', due.dueAt, input.evidence, true);
    if (created)
      this.recordCreated(
        id,
        'assignment',
        course,
        `${label}: 課題「${title}」（締切 ${formatShortJa(new Date(due.dueAt), this.tz)}）`,
        ref,
      );
    return {
      entityIds: [id],
      ownEntityIds: [id],
      factIds: [fact.id],
      stored: { assignmentId: id, attached: false },
    };
  }

  private applyExam(
    a: Addition,
    ref: SourceReference,
    course: string | undefined,
    title: string,
    input: AddDeadlineInput,
    due: { dueAt: string; resolution: Record<string, JsonValue> },
  ): Applied {
    const label = labelOf(a);
    const match = course ? this.matchExam(course, title, due.dueAt) : undefined;
    if (match) {
      const at = this.alignTime(due, match.startsAt);
      const fact = this.putFact(a, ref, match.id, 'exam_at', at, input.evidence, false);
      return {
        entityIds: [match.id],
        ownEntityIds: [],
        factIds: [fact.id],
        stored: { examId: match.id, attached: true },
        attachedTo: match.id,
      };
    }
    const id = stableId('exam', ADDITIONS_SOURCE_ID, a.id);
    const created = this.upsertOwn(
      {
        id,
        kind: 'exam',
        ...(course ? { courseOfferingId: course as Exam['courseOfferingId'] } : {}),
        title,
        examKind: examKindOf(input.kind, title),
        startsAt: due.dueAt,
        notes: input.notes
          ? `${input.notes}\n（${label}: ${input.evidence}）`
          : `${label}: ${input.evidence}`,
        extra: { additionId: a.id, kind: input.kind, recorded: true },
      },
      a,
      ref,
    );
    const fact = this.putFact(a, ref, id, 'exam_at', due.dueAt, input.evidence, true);
    if (created)
      this.recordCreated(
        id,
        'exam',
        course,
        `${label}: 試験「${title}」（${formatShortJa(new Date(due.dueAt), this.tz)}）`,
        ref,
      );
    return {
      entityIds: [id],
      ownEntityIds: [id],
      factIds: [fact.id],
      stored: { examId: id, attached: false },
    };
  }

  private applyTodo(
    a: Addition,
    ref: SourceReference,
    course: string | undefined,
    title: string,
    kind: 'prep' | 'task',
    dueAt: string | undefined,
    evidence: string | undefined,
    notes: string | undefined,
  ): Applied {
    const value: TodoValue = {
      additionId: a.id,
      title,
      kind,
      ...(course ? { courseOfferingId: course } : {}),
      ...(dueAt ? { dueAt } : {}),
      ...(notes ? { notes } : {}),
    };
    const fact = this.putFact(
      a,
      ref,
      course ?? PERSONAL_TODO_SUBJECT,
      TODO_PREDICATE,
      value as unknown as JsonValue,
      evidence,
      true,
    );
    return {
      entityIds: [],
      ownEntityIds: [],
      factIds: [fact.id],
      stored: { taskId: stableId('task', 'todo', a.id) },
    };
  }

  private applyNote(
    a: Addition,
    ref: SourceReference,
    course: string | undefined,
    title: string,
    text: string,
    lectureDate: string | undefined,
  ): Applied {
    const id = stableId('document', ADDITIONS_SOURCE_ID, a.id);
    const lecture =
      lectureDate && course
        ? this.entities.list('lecture', {
            where: { courseOfferingId: this.deps.identity.expand(course), date: lectureDate },
          })[0]
        : undefined;
    this.upsertOwn(
      {
        id,
        kind: 'document',
        title,
        mimeType: 'text/markdown',
        text,
        ...(course ? { courseOfferingId: course as Assignment['courseOfferingId'] } : {}),
        modifiedAt: this.now().toISOString(),
        extra: {
          additionId: a.id,
          recorded: true,
          via: viaOfAddition(a),
          ...(lecture ? { lectureId: lecture.id } : {}),
          ...(lectureDate ? { lectureDate } : {}),
        },
      },
      a,
      ref,
    );
    return {
      entityIds: [id],
      ownEntityIds: [id],
      factIds: [],
      stored: { documentId: id, ...(lecture ? { lectureId: lecture.id } : {}) },
    };
  }

  // ---------- helpers ----------

  /** Upsert an entity owned by the additions source; true when it was created. */
  private upsertOwn(
    entity: Parameters<EntityStore['upsert']>[0],
    a: Addition,
    ref: SourceReference,
  ): boolean {
    const meta = this.entities.meta(entity.id);
    if (meta && meta.sourceId !== ADDITIONS_SOURCE_ID)
      throw new PolicyViolationError(`entity ${entity.id} belongs to another source`);
    const r = this.entities.upsert(entity, { sourceId: ADDITIONS_SOURCE_ID });
    this.refs.upsert({ ...ref, id: this.refId(a, entity.id), entityId: entity.id as EntityId });
    return r.status === 'created';
  }

  private putFact(
    a: Addition,
    ref: SourceReference,
    subject: string,
    predicate: string,
    value: JsonValue,
    evidence: string | undefined,
    own: boolean,
  ): Fact {
    if (!(own ? OWN_PREDICATES : ATTACHABLE_PREDICATES).has(predicate))
      throw new PolicyViolationError(`additions may not write ${predicate}`);
    const now = this.now().toISOString();
    return this.deps.resolver.facts.put({
      id: factId(ref.id, subject, predicate, value),
      subject: subject as EntityId,
      predicate,
      value,
      origin: 'extracted',
      confidence: CONFIDENCE,
      observedAt: now,
      sourceReferenceId: ref.id,
      producer: { type: 'ai', id: `mcp:${a.clientName ?? a.clientId}`.slice(0, 200) },
      ...(evidence ? { evidence } : {}),
    });
  }

  private confirmTodo(a: Addition, f: Fact, now: string): Fact {
    const source = this.refs.upsert({
      id: stableId('sourceReference', 'user', 'addition-confirm', a.id),
      sourceSystem: 'user',
      sourceLabel: '本人による確認',
      authority: 'user',
      sourceItemId: `${a.id}#confirm`,
      retrievedAt: now,
    });
    this.deps.resolver.facts.retract([f.id], now);
    return this.deps.resolver.facts.put({
      id: factId(source.id, f.subject, f.predicate, f.value),
      subject: f.subject,
      predicate: f.predicate,
      value: f.value,
      origin: 'user',
      confidence: 1,
      observedAt: now,
      sourceReferenceId: source.id,
      producer: { type: 'user', id: 'self' },
      ...(f.evidence ? { evidence: f.evidence } : {}),
    });
  }

  private refId(a: Addition, entityId: string | undefined): SourceReference['id'] {
    return stableId('sourceReference', 'addition', a.id, entityId ?? '');
  }

  private refFor(
    a: Addition,
    client: AdditionClient | undefined,
    source: string,
    entityId: string | undefined,
    timestampMs: number | undefined,
  ): SourceReference {
    const clientId = client?.id ?? a.clientId;
    return this.refs.upsert({
      id: this.refId(a, entityId),
      sourceSystem: source,
      sourceId: ADDITIONS_SOURCE_ID,
      sourceLabel: source,
      authority: ADDITION_VIA_AUTHORITY[viaOfAddition(a)],
      sourceItemId: `${clientId}#${a.id}`.slice(0, 500),
      retrievedAt: this.now().toISOString(),
      ...(timestampMs !== undefined
        ? { location: { timestamp: hms(timestampMs), timestampMs } }
        : {}),
      ...(entityId ? { entityId: entityId as EntityId } : {}),
    });
  }

  private recordCreated(
    entityId: string,
    kind: 'assignment' | 'exam',
    course: string | undefined,
    summary: string,
    ref: SourceReference,
  ): void {
    const now = this.now().toISOString();
    const entity = this.entities.get(entityId);
    const ev: ChangeEvent = {
      id: makeId('changeEvent'),
      entityId: entityId as EntityId,
      entityKind: kind,
      type: 'created',
      changedFields: [],
      before: null,
      after: entity ? (JSON.parse(JSON.stringify(entity)) as Record<string, JsonValue>) : null,
      source: { sourceId: ADDITIONS_SOURCE_ID, sourceSystem: ref.sourceSystem },
      occurredAt: now,
      observedAt: now,
      ...(course ? { courseOfferingId: course as ChangeEvent['courseOfferingId'] } : {}),
      summary,
    };
    this.changes.append(ev);
  }

  private matchAssignment(course: string, title: string, dueAt: string): Assignment | undefined {
    const ids = this.deps.identity.expand(course);
    const list = this.entities
      .list('assignment', { where: { courseOfferingId: ids } })
      .filter((x) => this.entities.meta(x.id)?.sourceId !== ADDITIONS_SOURCE_ID);
    const titled = list.filter((x) => sameItemTitle(x.title, title));
    if (titled.length <= 1) return titled[0];
    const t = Date.parse(dueAt);
    const gap = (x: Assignment): number => {
      const d = x.dueAt ? Date.parse(x.dueAt) : Number.NaN;
      return Number.isNaN(d) ? Number.POSITIVE_INFINITY : Math.abs(d - t);
    };
    return titled.sort((x, y) => gap(x) - gap(y))[0];
  }

  private matchExam(course: string, title: string, at: string): Exam | undefined {
    const ids = this.deps.identity.expand(course);
    const list = this.entities
      .list('exam', { where: { courseOfferingId: ids } })
      .filter((x) => this.entities.meta(x.id)?.sourceId !== ADDITIONS_SOURCE_ID);
    const titled = list.filter((x) => sameItemTitle(x.title, title));
    if (titled.length > 0) return titled[0];
    // Same day, same course: the exam the system already knows about.
    const day = zonedDateString(new Date(at), this.tz);
    return list.find((x) => x.startsAt && zonedDateString(new Date(x.startsAt), this.tz) === day);
  }

  /**
   * Say it the way the system does when it is the same: the same instant (whatever the ISO
   * spelling), or a heard date without a time on the day the system states — so agreement is
   * agreement and only a real difference becomes a Conflict.
   */
  private alignTime(
    due: { dueAt: string; resolution: Record<string, JsonValue> },
    known: string | undefined,
  ): string {
    if (!known || Number.isNaN(Date.parse(known))) return due.dueAt;
    if (Date.parse(known) === Date.parse(due.dueAt)) return known;
    if (due.resolution.timeAssumed !== true) return due.dueAt;
    const day = (iso: string): string => zonedDateString(new Date(iso), this.tz);
    return day(known) === day(due.dueAt) ? known : due.dueAt;
  }

  private course(id: string | undefined): string | undefined {
    const s = id?.trim();
    return s ? this.requireCourse(s) : undefined;
  }

  private requireCourse(id: string): string {
    const canonical = this.deps.identity.canonical(id);
    if (
      !this.entities.getOfKind('courseOffering', canonical) &&
      !this.entities.getOfKind('courseOffering', id)
    )
      throw new NotFoundError(`course offering ${id}`);
    return canonical;
  }

  private courseTitle(id: string): string {
    return this.deps.courseTitle(id) ?? id;
  }

  /** The class of the course on that date (stored or generated from the timetable). */
  private sessionOf(
    course: string,
    date: string,
    period: number | undefined,
  ): ClassSession | undefined {
    const sessions = this.deps.tasks.schedule
      .sessionsBetween(date, addLocalDays(date, 1), [course])
      .filter((s) => s.sessionKind !== 'self_study');
    if (period !== undefined) return sessions.find((s) => s.period === period);
    return sessions.length === 1 ? sessions[0] : undefined;
  }

  /** When the thing was said: the class start (+ recording position) or, failing that, now / noon. */
  private referenceTime(
    course: string | undefined,
    lectureDate: string | undefined,
    ts: string | undefined,
  ): Date {
    const now = this.now();
    const today = zonedDateString(now, this.tz);
    const date = lectureDate?.trim() || today;
    if (!LOCAL_DATE.test(date)) throw new ValidationError('lectureDate must be YYYY-MM-DD');
    const offset = ts ? (parseRecordingTimestamp(ts) ?? 0) : 0;
    const session = course ? this.sessionOf(course, date, undefined) : undefined;
    if (session?.startsAt) return new Date(Date.parse(session.startsAt) + offset);
    if (date === today) return now;
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    return zonedTime({ year: y, month: m, day: d, hour: 12, minute: 0 }, this.tz);
  }

  private segmentsOf(
    input: RecordLectureInput,
  ): { startMs: number; text: string; speaker?: string | undefined; timestamped: boolean }[] {
    const out: {
      startMs: number;
      text: string;
      speaker?: string | undefined;
      timestamped: boolean;
    }[] = [];
    let total = 0;
    const add = (text: string, at: string | undefined, speaker: string | undefined): void => {
      const t = text.trim();
      if (!t) return;
      total += t.length;
      if (total > ADDITION_LIMITS.transcriptChars)
        throw new ValidationError(
          `transcript is longer than ${ADDITION_LIMITS.transcriptChars} characters; send an excerpt`,
        );
      const ms = at ? parseRecordingTimestamp(at) : undefined;
      if (at && ms === undefined)
        throw new ValidationError(`segment timestamp "${at}" must look like HH:MM:SS`);
      out.push({
        startMs: ms ?? 0,
        text: t,
        ...(speaker ? { speaker } : {}),
        timestamped: ms !== undefined,
      });
    };
    for (const s of input.segments ?? []) add(s.text, s.at, s.speaker);
    if (input.transcriptExcerpt) add(input.transcriptExcerpt, input.recordingTimestamp, undefined);
    return out.sort((a, b) => a.startMs - b.startMs);
  }

  private sourceName(client: AdditionClient, given: string | undefined, via: AdditionVia): string {
    const s = given?.trim();
    if (s) return s.slice(0, ADDITION_LIMITS.source);
    const who = `${client.name ?? ''} ${client.id}`;
    const chatgpt = /chatgpt|openai/i.test(who);
    if (via === 'recording')
      return chatgpt ? 'ChatGPT Record' : (client.name ?? 'MCP').slice(0, ADDITION_LIMITS.source);
    const name = chatgpt
      ? 'ChatGPT'
      : /claude|anthropic/i.test(who)
        ? 'Claude'
        : (client.name ?? 'AI').slice(0, ADDITION_LIMITS.source - 6);
    return `${name}との会話`;
  }

  private autoKey(tool: string, input: Common): string {
    return `auto:${sha256(`${tool}\u0000${stableStringify(input as unknown as JsonValue)}`).slice(0, 40)}`;
  }

  private burstHit(client: AdditionClient): void {
    const t = this.now().getTime();
    const hits = (this.burst.get(client.id) ?? []).filter((x) => t - x < 60_000);
    if (hits.length >= ADDITION_RATE_LIMITS.burstPerMinute)
      throw new RateLimitedError('too many write calls; wait a minute', {
        retryAfterMs: 60_000 - (t - (hits[0] ?? t)),
      });
    hits.push(t);
    this.burst.set(client.id, hits);
  }

  private assertBudget(client: AdditionClient): void {
    const t = this.now().getTime();
    const since = (ms: number): string => new Date(t - ms).toISOString();
    if (
      this.store.countWritesSince(client.id, since(10 * 60_000)) >=
      ADDITION_RATE_LIMITS.perTenMinutes
    )
      throw new RateLimitedError(
        `write limit reached (${ADDITION_RATE_LIMITS.perTenMinutes} per 10 minutes)`,
        { retryAfterMs: 10 * 60_000 },
      );
    if (this.store.countWritesSince(client.id, since(86_400_000)) >= ADDITION_RATE_LIMITS.perDay)
      throw new RateLimitedError(`write limit reached (${ADDITION_RATE_LIMITS.perDay} per day)`, {
        retryAfterMs: 3_600_000,
      });
  }

  private auditOf(a: Addition): AdditionResult['audit'] {
    return { additionId: a.id, entityIds: [...a.entityIds], factIds: [...a.factIds] };
  }

  view(a: Addition): AdditionView {
    const course = a.courseOfferingId
      ? { id: a.courseOfferingId, title: this.courseTitle(a.courseOfferingId) }
      : undefined;
    const data = a.data;
    const str = (v: JsonValue | undefined): string | undefined =>
      typeof v === 'string' ? v : undefined;
    const attachedId = str(data.attachedTo);
    const attached = attachedId
      ? this.entities.get(attachedId, { includeDeleted: true })
      : undefined;
    const subjects = new Set([...a.entityIds, ...(a.courseOfferingId ? [a.courseOfferingId] : [])]);
    const facts = new Set<string>(a.factIds);
    const conflicts = this.deps.resolver
      .listConflicts({ status: 'open', subjects: [...subjects] })
      .filter((c) => c.candidates.some((x) => facts.has(x.factId)))
      .map((c) => ({
        id: c.id,
        predicate: c.predicate,
        values: c.candidates.map((x) => ({
          value: x.value,
          source: x.sourceLabel ?? x.sourceSystem,
        })),
      }));
    const via = viaOfAddition(a);
    return {
      id: a.id,
      tool: a.tool,
      kind: a.kind,
      status: a.status,
      via,
      label: ADDITION_VIA_LABELS[via],
      title: a.title,
      course,
      dueAt: a.dueAt,
      dueText: a.dueAt ? formatShortJa(new Date(a.dueAt), this.tz) : undefined,
      dueResolution: data.dueResolution,
      evidence: str(data.evidence),
      recordingTimestamp: str(data.recordingTimestamp),
      source: str(data.source) ?? a.clientName ?? a.clientId,
      client: { id: a.clientId, name: a.clientName },
      stored: (data.stored && typeof data.stored === 'object' && !Array.isArray(data.stored)
        ? data.stored
        : {}) as Record<string, JsonValue>,
      attachedTo: attached
        ? {
            id: attached.id,
            kind: attached.kind,
            title:
              'title' in attached && typeof attached.title === 'string'
                ? attached.title
                : attached.id,
            source: this.entities.meta(attached.id)?.sourceId,
          }
        : undefined,
      conflicts,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      decidedAt: a.decidedAt,
    };
  }

  /**
   * Notes and lecture summaries written by any client (read side, every client sees them):
   * newest first, optionally one course (`courseOfferingId`, identity-expanded; `personal` = notes
   * without a course), a text filter, or one note by document / addition id with its full text.
   */
  notes(
    options: {
      courseOfferingId?: string | undefined;
      personal?: boolean | undefined;
      query?: string | undefined;
      id?: string | undefined;
      limit?: number | undefined;
    } = {},
  ): { notes: NoteItem[]; total: number } {
    const course = options.courseOfferingId
      ? this.deps.identity.canonical(options.courseOfferingId)
      : undefined;
    const q = options.query?.normalize('NFKC').toLowerCase().trim();
    const items: NoteItem[] = [];
    for (const a of this.store.list({ statuses: ['unconfirmed', 'confirmed'] })) {
      if (a.tool !== 'add_note' && a.tool !== 'record_lecture') continue;
      const stored = a.data.stored;
      const documentId =
        stored && typeof stored === 'object' && !Array.isArray(stored)
          ? typeof stored.documentId === 'string'
            ? stored.documentId
            : undefined
          : undefined;
      if (!documentId) continue;
      if (options.id && options.id !== documentId && options.id !== a.id) continue;
      const own = a.courseOfferingId ? this.deps.identity.canonical(a.courseOfferingId) : undefined;
      if (course && own !== course) continue;
      if (options.personal && own) continue;
      const doc = this.entities.getOfKind('document', documentId);
      if (!doc) continue;
      const text = doc.text ?? '';
      if (q && !`${doc.title}\n${text}`.normalize('NFKC').toLowerCase().includes(q)) continue;
      const full = options.id !== undefined;
      const ref = this.refs.get(this.refId(a, documentId));
      const via = viaOfAddition(a);
      items.push({
        id: documentId,
        additionId: a.id,
        kind: a.tool === 'record_lecture' ? 'lecture_summary' : 'note',
        title: doc.title,
        text:
          full || text.length <= NOTE_PREVIEW_CHARS
            ? text
            : `${text.slice(0, NOTE_PREVIEW_CHARS)}…`,
        truncated: !full && text.length > NOTE_PREVIEW_CHARS,
        course: own ? { id: own, title: this.courseTitle(own) } : undefined,
        via,
        label: ADDITION_VIA_LABELS[via],
        status: a.status,
        source: typeof a.data.source === 'string' ? a.data.source : (a.clientName ?? a.clientId),
        client: a.clientName,
        lectureDate:
          typeof a.data.lectureDate === 'string'
            ? a.data.lectureDate
            : typeof a.data.date === 'string'
              ? a.data.date
              : undefined,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
        citations: ref ? [toCitation(ref, this.tz)] : [],
      });
    }
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    return { notes: items.slice(0, limit), total: items.length };
  }

  /** Local "today" for the timezone (exposed for callers that default the lecture date). */
  today(): string {
    const p = zonedParts(this.now(), this.tz);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  }
}
