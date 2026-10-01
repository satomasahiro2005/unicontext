import {
  type ChangeEvent,
  type ClassSession,
  entityLabel,
  type JsonValue,
} from '@unicontext/canonical-model';
import {
  addZonedDays,
  errorMessage,
  formatDateJa,
  formatShortJa,
  type Logger,
  parseDuration,
  parseZonedDate,
  redact,
  sha256,
  silentLogger,
  startOfZonedWeek,
  type TimerHandle,
  zonedDateString,
} from '@unicontext/core';
import type { Citation } from '@unicontext/provenance';
import type { BusChangeEvent, ChangeOrigin, SyncEngineEvents } from '@unicontext/sync-engine';
import { NotificationLog, type NotificationListOptions } from './log.js';
import {
  FLOOD_LIMIT,
  meetsPriority,
  type Notification,
  type NotificationHost,
  type NotificationKind,
  type NotificationPriority,
  type NotificationServiceOptions,
  type NotificationSink,
} from './types.js';

const HOUR_MS = 3_600_000;
const DEFAULT_LEADS = ['24h', '3h', '1h'];
const DEFAULT_DEADLINE_INTERVAL_MS = 5 * 60_000;
const DEFAULT_DEDUPE_WINDOW_MS = 6 * HOUR_MS;
/** Kinds that may legitimately repeat: suppressed for dedupeWindowMs, not forever. */
const WINDOWED_KINDS: ReadonlySet<NotificationKind> = new Set([
  'auth_expired',
  'sync_failure',
  'conflict',
]);
/**
 * Change origins that are genuine new observations. A first ingest, a reprocess or a
 * reclassification only repopulates state the user has already seen (or never needed to).
 */
const GENUINE_ORIGINS: ReadonlySet<ChangeOrigin> = new Set(['sync', 'ingest']);
const DONE_TASK_STATUSES: ReadonlySet<string> = new Set(['submitted', 'completed', 'cancelled']);

const PREDICATE_LABELS_JA: Record<string, string> = {
  room: '教室',
  dueAt: '締切',
  status: '状態',
  startsAt: '開始時刻',
  endsAt: '終了時刻',
  title: '題名',
};

function predicateLabel(predicate: string): string {
  return PREDICATE_LABELS_JA[predicate] ?? predicate;
}

type Draft = Omit<Notification, 'id' | 'createdAt' | 'citations'> & { citations?: Citation[] };

interface Lead {
  label: string;
  hours: number;
}

function str(v: JsonValue | undefined): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function safeText(text: string, max: number): string {
  return clip(String(redact(text)), max);
}

/**
 * Turns bus events and a deadline poll into notifications (§46): applies the rules, dedupes
 * (persistently, via the log), writes the log and fans out to the sinks.
 */
export class NotificationService {
  private readonly uc: NotificationHost;
  private readonly sinks: NotificationSink[];
  private readonly log: NotificationLog;
  private readonly logger: Logger;
  private readonly minPriority: NotificationPriority;
  private readonly leads: Lead[];
  private readonly intervalMs: number;
  private readonly windowMs: number;
  /** Drafts of the sync run in progress, by source: published together when it settles. */
  private readonly batches = new Map<string, Draft[]>();
  private offs: (() => void)[] = [];
  private timer: TimerHandle | undefined;
  private running = false;

  constructor(o: NotificationServiceOptions) {
    this.uc = o.uc;
    this.sinks = [...o.sinks];
    this.logger = o.logger ?? silentLogger;
    this.minPriority = o.minPriority ?? 'low';
    this.intervalMs = o.deadlineCheckIntervalMs ?? DEFAULT_DEADLINE_INTERVAL_MS;
    this.windowMs = o.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    this.log = new NotificationLog({
      ...(o.logFile ? { file: o.logFile } : {}),
      logger: this.logger,
    });
    this.leads = this.parseLeads(o.deadlineLeadTimes ?? DEFAULT_LEADS);
  }

  /** Subscribes to the bus and starts the deadline poll (runs once immediately). */
  start(): void {
    if (this.running) return;
    this.running = true;
    const bus = this.uc.bus;
    this.offs = [
      bus.on('change', (ev) => this.guard('change', () => this.handleChange(ev))),
      bus.on('changes:settled', (ev) =>
        this.guard('changes:settled', () => this.handleSettled(ev)),
      ),
      bus.on('conflict', (ev) => this.guard('conflict', () => this.handleConflict(ev))),
      bus.on('health', (ev) => this.guard('health', () => this.handleHealth(ev))),
      bus.on('sync:failed', (ev) => this.guard('sync:failed', () => this.handleSyncFailed(ev))),
      bus.on('drift', (ev) => this.guard('drift', () => this.handleDrift(ev))),
    ];
    this.tick();
  }

  stop(): void {
    this.running = false;
    for (const off of this.offs) off();
    this.offs = [];
    this.batches.clear();
    if (this.timer) this.uc.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Newest first. */
  list(o: NotificationListOptions = {}): Notification[] {
    return this.log.list(o);
  }

  get(id: string): Notification | undefined {
    return this.log.get(id);
  }

  markRead(id: string): void {
    this.log.markRead(id);
  }

  markAllRead(): number {
    const unread = this.log.list({ unreadOnly: true });
    for (const n of unread) this.log.markRead(n.id);
    return unread.length;
  }

  unreadCount(): number {
    return this.log.unreadCount();
  }

  // ---- bus handlers -------------------------------------------------------------------

  /**
   * Events the sync engine tags with an origin are collected per source and published when the
   * pass settles, so one run's notifications can be summarized (flood guard). Untagged events
   * (conflicts found by the pipeline, direct callers) are published at once.
   */
  async handleChange(ev: BusChangeEvent): Promise<Notification[]> {
    if (ev.origin !== undefined && !GENUINE_ORIGINS.has(ev.origin)) return [];
    const draft = this.draftFromChange(ev);
    if (!draft) return [];
    if (ev.origin === undefined) return this.publish([draft]);
    const key = ev.source.sourceId ?? '';
    const batch = this.batches.get(key);
    if (batch) batch.push(draft);
    else this.batches.set(key, [draft]);
    return [];
  }

  async handleSettled(ev: SyncEngineEvents['changes:settled']): Promise<Notification[]> {
    const drafts = this.batches.get(ev.sourceId);
    this.batches.delete(ev.sourceId);
    return drafts && drafts.length > 0 ? this.publish(drafts) : [];
  }

  async handleConflict(ev: SyncEngineEvents['conflict']): Promise<Notification[]> {
    if (ev.type !== 'opened') return [];
    const c = ev.conflict;
    const subject = this.uc.sync.stores.entities.get(c.subject, { includeDeleted: true });
    const label = subject ? entityLabel(subject) : c.subject;
    const values = c.candidates.map((x) => String(x.value)).join(' / ');
    const course =
      subject?.kind === 'courseOffering'
        ? subject.id
        : (subject as { courseOfferingId?: string } | undefined)?.courseOfferingId;
    return this.publish([
      {
        kind: 'conflict',
        priority: 'high',
        title: `情報が食い違っています: ${label}`,
        body: `「${label}」の${predicateLabel(c.predicate)}で情報が食い違っています: ${values}`,
        dedupeKey: `conflict:${c.subject}:${c.predicate}`,
        entityId: c.subject,
        ...(course ? { courseOfferingId: course } : {}),
        citations: this.uc.context.citationsFor([c.subject]),
      },
    ]);
  }

  async handleHealth(ev: SyncEngineEvents['health']): Promise<Notification[]> {
    const { sourceId } = ev;
    switch (ev.current.state) {
      case 'healthy':
        this.resetSource(sourceId);
        return [];
      case 'auth_required':
        return this.publish([this.authExpiredDraft(sourceId)]);
      case 'failed':
        return this.publish([
          this.syncFailureDraft(sourceId, 'high', ev.current.message ?? '同期に失敗しました'),
        ]);
      default:
        return [];
    }
  }

  async handleSyncFailed(ev: SyncEngineEvents['sync:failed']): Promise<Notification[]> {
    const state = ev.health;
    if (state === 'auth_required') return this.publish([this.authExpiredDraft(ev.sourceId)]);
    const priority: NotificationPriority = state === 'failed' ? 'high' : 'normal';
    return this.publish([this.syncFailureDraft(ev.sourceId, priority, ev.error)]);
  }

  async handleDrift(ev: SyncEngineEvents['drift']): Promise<Notification[]> {
    if (ev.findings.length === 0) return [];
    const kinds: Record<string, string> = {
      unknown: '新しい項目',
      missing: '項目の欠落',
      type_mismatch: '型の不一致',
    };
    const lines = ev.findings
      .slice(0, 3)
      .map((f) => `${kinds[f.driftKind] ?? f.driftKind}「${f.fieldPath}」`);
    const more = ev.findings.length > 3 ? ` ほか${ev.findings.length - 3}件` : '';
    const paths = ev.findings
      .map((f) => `${f.driftKind}:${f.fieldPath}`)
      .sort()
      .join(',');
    const label = this.sourceLabel(ev.sourceId);
    return this.publish([
      {
        kind: 'schema_drift',
        priority: 'low',
        title: `${label}のデータ形式が変わった可能性があります`,
        body: `${lines.join('、')}${more}を検出しました。`,
        dedupeKey: `schema_drift:${ev.sourceId}:${sha256(paths).slice(0, 16)}`,
        sourceId: ev.sourceId,
      },
    ]);
  }

  /**
   * Polls `context.deadline()` and fires `deadline_approaching` for tasks inside a lead window,
   * and `pace_behind` for offerings the student is falling behind in.
   */
  async checkDeadlines(): Promise<Notification[]> {
    const drafts = [...this.paceDrafts(), ...this.deadlineDrafts()];
    return this.publish(drafts);
  }

  /**
   * 時間割外 / 集中講義 courses whose weekly 「今週分」 tasks are not done. One notification per
   * (course, week, weeks behind), so it fires again only when the student falls one week further.
   */
  private paceDrafts(): Draft[] {
    const now = this.uc.clock.now();
    const weekStart = zonedDateString(startOfZonedWeek(now, this.uc.timezone), this.uc.timezone);
    const drafts: Draft[] = [];
    for (const item of this.uc.context.pacing()) {
      if (item.behindWeeks < 1) continue;
      const slots = item.slots.length > 0 ? ` 自習時間: ${item.slots.join('、')}` : '';
      drafts.push({
        kind: 'pace_behind',
        priority: item.behindWeeks >= 2 ? 'critical' : 'high',
        title: item.message,
        body: `${item.course.title}の「今週分」が${item.behindWeeks}週続けて終わっていません。${slots}`.trim(),
        dedupeKey: `pace_behind:${item.course.id}:${weekStart}:${item.behindWeeks}`,
        entityId: item.course.id,
        courseOfferingId: item.course.id,
      });
    }
    return drafts;
  }

  private deadlineDrafts(): Draft[] {
    if (this.leads.length === 0) return [];
    const maxHours = Math.max(...this.leads.map((l) => l.hours));
    const days = Math.max(3, Math.ceil(maxHours / 24) + 1);
    const { upcoming } = this.uc.context.deadline({ days });
    const tz = this.uc.timezone;
    const nowMs = this.uc.clock.now().getTime();
    const drafts: Draft[] = [];
    for (const item of upcoming) {
      if (item.overdue) continue;
      if (DONE_TASK_STATUSES.has(item.status)) continue;
      // The view rounds hoursLeft; compute it exactly from the due date.
      const hoursLeft = (Date.parse(item.dueAt) - nowMs) / HOUR_MS;
      if (!Number.isFinite(hoursLeft) || hoursLeft < 0) continue;
      const lead = this.leads.find((l) => hoursLeft <= l.hours);
      if (!lead) continue;
      const priority: NotificationPriority =
        lead.hours <= 1 ? 'critical' : lead.hours <= 3 ? 'high' : 'normal';
      const left =
        hoursLeft < 1
          ? `${Math.max(1, Math.round(hoursLeft * 60))}分`
          : `${Math.floor(hoursLeft)}時間`;
      const due = formatShortJa(new Date(item.dueAt), tz);
      const subject = item.course ? `${item.course.title}「${item.title}」` : `「${item.title}」`;
      drafts.push({
        kind: 'deadline_approaching',
        priority,
        title: `締切まであと約${left}: ${item.title}`,
        body: `${subject}の締切は${due}です。`,
        dedupeKey: `deadline_approaching:${item.taskId}:${item.dueAt}:${lead.label}`,
        entityId: item.taskId,
        ...(item.course ? { courseOfferingId: item.course.id } : {}),
        citations: item.citations,
      });
    }
    return drafts;
  }

  // ---- scope: only courses the student takes ----------------------------------------------

  /**
   * Course-scoped notifications are for offerings the student is enrolled in (per an
   * enrollment-authoritative source, or entered by the user) in the current or an upcoming term.
   * Syllabus-catalog offerings and other classes of the same subject never qualify.
   */
  private inScope(courseId: string | undefined): boolean {
    if (courseId === undefined) return true; // not course-scoped
    const scope = this.uc.context.enrollmentOf(courseId);
    if (!scope.enrolled) return false;
    if (!scope.sourceIds.some((id) => this.isEnrollmentAuthority(id))) return false;
    const today = zonedDateString(this.uc.clock.now(), this.uc.timezone);
    return !scope.term || scope.term.end >= today;
  }

  private isEnrollmentAuthority(sourceId: string | undefined): boolean {
    if (sourceId === undefined) return true; // entered by the user
    try {
      return this.uc.sync.getSource(sourceId).metadata.capabilities.includes('enrollments');
    } catch {
      return false;
    }
  }

  private isPast(iso: string | undefined): boolean {
    if (!iso) return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && t < this.uc.clock.now().getTime();
  }

  /** The same course can exist as several offerings: dedupe by title, not by id. */
  private courseKeyOf(course: { id: string; title: string } | undefined, fallback: string): string {
    const title = course?.title.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    return title || course?.id || fallback;
  }

  // ---- rules: change events ---------------------------------------------------------------

  private draftFromChange(ev: ChangeEvent): Draft | undefined {
    if (ev.type === 'conflict_detected') return this.conflictDraft(ev);
    const after = ev.after ?? {};
    const before = ev.before ?? {};
    const tz = this.uc.timezone;
    switch (ev.entityKind) {
      case 'classSession': {
        if (ev.type !== 'updated' && ev.type !== 'created') return undefined;
        const cancelled = str(after.status) === 'cancelled' && ev.changedFields.includes('status');
        const roomChanged = ev.type === 'updated' && ev.changedFields.includes('room');
        if (!cancelled && !roomChanged) return undefined;
        return this.classDraft(ev, cancelled ? 'cancelled' : 'room', before, after);
      }
      case 'courseOffering': {
        if (ev.type !== 'updated' || !ev.changedFields.includes('room')) return undefined;
        const course = this.uc.context.courseRef(ev.entityId);
        const name = course?.title ?? ev.summary ?? ev.entityId;
        const to = str(after.room);
        const from = str(before.room);
        // No earlier room: the room was just learned (a syllabus detail), nothing changed.
        if (!from) return undefined;
        if (!this.inScope(course?.id ?? ev.entityId)) return undefined;
        const today = zonedDateString(this.uc.clock.now(), tz);
        return {
          kind: 'room_change',
          priority: 'high',
          title: `教室変更: ${name}`,
          body: this.roomSentence(`${name}の教室`, from, to),
          dedupeKey: `room_change:${this.courseKeyOf(course, ev.entityId)}:course:${today}:${to ?? ''}`,
          entityId: ev.entityId,
          courseOfferingId: course?.id ?? ev.entityId,
          citations: this.uc.context.citationsFor([ev.entityId]),
        };
      }
      case 'assignment': {
        const title = str(after.title) ?? this.entityTitle(ev.entityId) ?? '課題';
        const course = this.courseOf(ev);
        if (!this.inScope(course?.id)) return undefined;
        const where = course ? `${course.title}に` : '';
        if (ev.type === 'created') {
          const due = str(after.dueAt);
          if (this.isPast(due)) return undefined; // already over
          return {
            kind: 'new_assignment',
            priority: 'normal',
            title: `新しい課題: ${title}`,
            body: `${where}課題「${title}」が追加されました。${due ? `締切は${formatShortJa(new Date(due), tz)}です。` : '締切は未設定です。'}`,
            dedupeKey: `new_assignment:${ev.entityId}`,
            entityId: ev.entityId,
            ...(course ? { courseOfferingId: course.id } : {}),
            citations: this.uc.context.citationsFor([ev.entityId]),
          };
        }
        if (ev.type === 'updated' && ev.changedFields.includes('dueAt')) {
          const from = str(before.dueAt);
          const to = str(after.dueAt);
          if (this.isPast(to)) return undefined; // moved to a time that has passed
          const now = this.uc.clock.now().getTime();
          const left = to ? new Date(to).getTime() - now : undefined;
          const urgent = left !== undefined && left > 0 && left < 24 * HOUR_MS;
          const fmt = (v: string): string => formatShortJa(new Date(v), tz);
          const body = to
            ? `${course ? `${course.title}の` : ''}課題「${title}」の締切が${from ? `「${fmt(from)}」` : '未設定'}から「${fmt(to)}」に変更されました。`
            : `${course ? `${course.title}の` : ''}課題「${title}」の締切が取り消されました。`;
          return {
            kind: 'deadline_changed',
            priority: urgent ? 'critical' : 'high',
            title: `締切変更: ${title}`,
            body,
            dedupeKey: `deadline_changed:${ev.entityId}:${to ?? 'none'}`,
            entityId: ev.entityId,
            ...(course ? { courseOfferingId: course.id } : {}),
            citations: this.uc.context.citationsFor([ev.entityId]),
          };
        }
        return undefined;
      }
      case 'exam': {
        if (ev.type !== 'created') return undefined;
        const title = str(after.title) ?? this.entityTitle(ev.entityId) ?? '試験';
        const course = this.courseOf(ev);
        if (!this.inScope(course?.id)) return undefined;
        const when = str(after.startsAt);
        if (this.isPast(str(after.endsAt) ?? when)) return undefined; // already over
        const room = str(after.room);
        const parts = [
          `${course ? `${course.title}の` : ''}試験「${title}」が発表されました。`,
          when ? `日時は${formatShortJa(new Date(when), tz)}です。` : '',
          room ? `教室は${room}です。` : '',
        ];
        return {
          kind: 'exam_announced',
          priority: 'high',
          title: `試験の発表: ${title}`,
          body: parts.join(''),
          dedupeKey: `exam_announced:${ev.entityId}`,
          entityId: ev.entityId,
          ...(course ? { courseOfferingId: course.id } : {}),
          citations: this.uc.context.citationsFor([ev.entityId]),
        };
      }
      case 'announcement': {
        if (ev.type !== 'created') return undefined;
        const importance = str(after.importance) ?? 'normal';
        const scope = str(after.scope);
        const important = importance === 'high' || importance === 'critical';
        if (!important && scope !== 'university') return undefined;
        const title = str(after.title) ?? this.entityTitle(ev.entityId) ?? 'お知らせ';
        const course = this.courseOf(ev);
        if (!this.inScope(course?.id)) return undefined;
        const text = str(after.body);
        const lead = course ? `${course.title}: ` : scope === 'university' ? '大学から: ' : '';
        return {
          kind: 'important_announcement',
          priority: importance === 'critical' ? 'critical' : 'high',
          title: `重要なお知らせ: ${title}`,
          body: `${lead}${text ? safeText(text, 120) : title}`,
          dedupeKey: `important_announcement:${ev.entityId}`,
          entityId: ev.entityId,
          ...(course ? { courseOfferingId: course.id } : {}),
          citations: this.uc.context.citationsFor([ev.entityId]),
        };
      }
      default:
        return undefined;
    }
  }

  private classDraft(
    ev: ChangeEvent,
    what: 'cancelled' | 'room',
    before: Record<string, JsonValue>,
    after: Record<string, JsonValue>,
  ): Draft | undefined {
    const tz = this.uc.timezone;
    const session = this.sessionOf(ev.entityId);
    const course = this.courseOf(ev, session?.courseOfferingId);
    // A class session always belongs to a course; one the student does not take is not news.
    if (!course || !this.inScope(course.id)) return undefined;
    const name = course.title;
    let proximity: 'soon' | 'later' = 'later';
    let when = '';
    if (session) {
      const now = this.uc.clock.now();
      const today = zonedDateString(now, tz);
      const tomorrow = zonedDateString(addZonedDays(now, 1, tz), tz);
      if (session.date < today) return undefined; // already over
      if (session.date === today || session.date === tomorrow) proximity = 'soon';
      when = `${formatDateJa(parseZonedDate(session.date, tz), tz)}${session.period ? `${session.period}限` : ''}`;
    }
    const courseKey = this.courseKeyOf(course, ev.entityId);
    const dateKey = session?.date ?? ev.entityId;
    const citations = this.uc.context.citationsFor([ev.entityId]);
    const common = {
      entityId: ev.entityId,
      ...(course ? { courseOfferingId: course.id } : {}),
      citations,
    };
    if (what === 'cancelled') {
      return {
        kind: 'class_cancelled',
        priority: 'critical',
        title: `休講: ${name}`,
        body: `${when}${name}は休講です。`,
        dedupeKey: `class_cancelled:${courseKey}:${dateKey}`,
        ...common,
      };
    }
    const to = str(after.room);
    const from = str(before.room);
    return {
      kind: 'room_change',
      priority: proximity === 'soon' ? 'critical' : 'high',
      title: `教室変更: ${name}`,
      body: this.roomSentence(`${when}${name}の教室`, from, to),
      dedupeKey: `room_change:${courseKey}:${dateKey}:${to ?? ''}`,
      ...common,
    };
  }

  private conflictDraft(ev: ChangeEvent): Draft | undefined {
    const predicate = ev.changedFields[0] ?? 'unknown';
    const course = this.courseOf(ev);
    if (!this.inScope(course?.id)) return undefined;
    const label = course?.title ?? this.entityTitle(ev.entityId) ?? ev.entityId;
    const values = str(ev.after?.[predicate]);
    return {
      kind: 'conflict',
      priority: 'high',
      title: `情報が食い違っています: ${label}`,
      body: `「${label}」の${predicateLabel(predicate)}で情報が食い違っています${values ? `: ${values}` : ''}`,
      dedupeKey: `conflict:${ev.entityId}:${predicate}`,
      entityId: ev.entityId,
      ...(course ? { courseOfferingId: course.id } : {}),
      citations: this.uc.context.citationsFor([ev.entityId]),
    };
  }

  private roomSentence(subject: string, from: string | undefined, to: string | undefined): string {
    if (to && from) return `${subject}が「${from}」から「${to}」に変更されました。`;
    if (to) return `${subject}が「${to}」に変更されました。`;
    return `${subject}が変更されました。`;
  }

  private authExpiredDraft(sourceId: string): Draft {
    const label = this.sourceLabel(sourceId);
    return {
      kind: 'auth_expired',
      priority: 'high',
      title: `ログインが切れました: ${label}`,
      body: `${label}の認証が切れたため同期できません。「unicontext login ${sourceId}」を実行して再ログインしてください。`,
      dedupeKey: `auth_expired:${sourceId}`,
      sourceId,
    };
  }

  private syncFailureDraft(sourceId: string, priority: NotificationPriority, error: string): Draft {
    const label = this.sourceLabel(sourceId);
    return {
      kind: 'sync_failure',
      priority,
      title: `同期に失敗しました: ${label}`,
      body: `${label}の同期に失敗しました。${safeText(error, 160)}`,
      dedupeKey: `sync_failure:${sourceId}:${priority === 'high' ? 'failed' : 'transient'}`,
      sourceId,
    };
  }

  // ---- lookups ------------------------------------------------------------------------

  private sessionOf(entityId: string): ClassSession | undefined {
    const e = this.uc.sync.stores.entities.get(entityId, { includeDeleted: true });
    return e?.kind === 'classSession' ? e : undefined;
  }

  private entityTitle(entityId: string): string | undefined {
    const e = this.uc.sync.stores.entities.get(entityId, { includeDeleted: true });
    return e ? entityLabel(e) : undefined;
  }

  private courseOf(
    ev: ChangeEvent,
    fallbackId?: string,
  ): { id: string; title: string } | undefined {
    let id: string | undefined = ev.courseOfferingId ?? fallbackId;
    if (!id) {
      const e = this.uc.sync.stores.entities.get(ev.entityId, { includeDeleted: true });
      const c = (e as { courseOfferingId?: string } | undefined)?.courseOfferingId;
      id = c;
    }
    const ref = this.uc.context.courseRef(id);
    return ref ? { id: ref.id, title: ref.title } : undefined;
  }

  private sourceLabel(sourceId: string): string {
    try {
      const s = this.uc.sync.getSource(sourceId);
      return s.sourceLabel ?? s.metadata.sourceLabel ?? sourceId;
    } catch {
      return sourceId;
    }
  }

  private resetSource(sourceId: string): void {
    this.log.resetKey(`auth_expired:${sourceId}`);
    this.log.resetKey(`sync_failure:${sourceId}:failed`);
    this.log.resetKey(`sync_failure:${sourceId}:transient`);
  }

  // ---- dispatch -----------------------------------------------------------------------

  /** Dedupe, log (synchronously, so concurrent callers cannot double-fire) and deliver. */
  private async publish(drafts: Draft[]): Promise<Notification[]> {
    const created: Notification[] = [];
    for (const d of drafts) {
      if (!meetsPriority(d.priority, this.minPriority)) continue;
      const last = this.log.lastCreatedAt(d.dedupeKey);
      const nowDate = this.uc.clock.now();
      if (last !== undefined) {
        if (!WINDOWED_KINDS.has(d.kind)) continue;
        if (nowDate.getTime() - Date.parse(last) < this.windowMs) continue;
      }
      const createdAt = nowDate.toISOString();
      const { citations, ...rest } = d;
      const n: Notification = {
        ...rest,
        id: `ntf_${sha256(`${d.dedupeKey}|${createdAt}`).slice(0, 20)}`,
        createdAt,
        citations: citations ?? [],
      };
      this.log.add(n);
      created.push(n);
    }
    await this.deliver(created);
    return created;
  }

  /**
   * Fans one batch out to the sinks. A sink that has a summary form and would show more than
   * FLOOD_LIMIT of the batch gets one summary instead (the details stay in the log).
   */
  private async deliver(batch: Notification[]): Promise<void> {
    if (batch.length === 0) return;
    await Promise.all(
      this.sinks.map(async (sink) => {
        const shown = sink.shows ? batch.filter((n) => sink.shows?.(n)) : batch;
        if (sink.sendSummary && shown.length > FLOOD_LIMIT) {
          try {
            await sink.sendSummary(shown);
          } catch (e) {
            this.logger.warn('notification sink failed', {
              sink: sink.id,
              kind: 'summary',
              error: errorMessage(e),
            });
          }
          return;
        }
        for (const n of batch) {
          try {
            await sink.send(n);
          } catch (e) {
            this.logger.warn('notification sink failed', {
              sink: sink.id,
              kind: n.kind,
              error: errorMessage(e),
            });
          }
        }
      }),
    );
  }

  private async guard(event: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.logger.warn('notification handler failed', { event, error: errorMessage(e) });
    }
  }

  private tick(): void {
    if (!this.running) return;
    this.timer = this.uc.clock.setTimeout(() => this.tick(), this.intervalMs);
    void this.guard('deadlines', () => this.checkDeadlines());
  }

  private parseLeads(values: string[]): Lead[] {
    const leads: Lead[] = [];
    for (const v of values) {
      try {
        const ms = parseDuration(v);
        if (ms > 0) leads.push({ label: v.trim(), hours: ms / HOUR_MS });
        else this.logger.warn('ignoring non-positive deadline lead time', { value: v });
      } catch {
        this.logger.warn('ignoring invalid deadline lead time', { value: v });
      }
    }
    if (leads.length === 0 && values !== DEFAULT_LEADS) return this.parseLeads(DEFAULT_LEADS);
    return leads.sort((a, b) => a.hours - b.hours);
  }
}
