import { isReexamLabel, type JsonValue, type ScheduleSlot } from '@unicontext/canonical-model';
import {
  detectSchemaDrift,
  type DriftFinding,
  type FactInput,
  type NormalizeContext,
  type NormalizedEntity,
  type NormalizeOutput,
  type Normalizer,
  type RawItemView,
  type SourceRefSpec,
} from '@unicontext/connector-sdk';
import { classifyNoticeImportance, findPeriod, zonedTime } from '@unicontext/core';
import type { z } from 'zod';
import { type ContactKind, type LcuDeploymentProfile, lcuUrl } from './deployment.js';
import { lcuGradeOutcome, parseLcuReportTerm } from './parsers/grades.js';
import {
  ALL_RAW_TYPES,
  type AssignmentPayload,
  AttendancePayloadSchema,
  CalendarEventPayloadSchema,
  type CoursePayload,
  ExamPayloadSchema,
  CreditRequirementsPayloadSchema,
  GradePayloadSchema,
  type LcuRawType,
  type NoticePayload,
  PAYLOAD_SCHEMAS,
  SubmissionInformationSchema,
  WarningNoticePayloadSchema,
  WarningNoticeSchema,
} from './schemas.js';
import {
  extractRoomChange,
  firstTimeOfDay,
  type LocalDateTimeParts,
  lcuWeekToDayOfWeek,
  parseSlashDateTime,
  parseSubjectText,
  parseTermRange,
  periodFromLabel,
  slashDateToIso,
  uniquePeriodOnDay,
} from './text.js';

export const NORMALIZER_VERSION = '4';
export const SELF_PERSON_KEY = 'self';

export interface LiveCampusUNormalizerOptions {
  deployment: LcuDeploymentProfile;
}

function iso(parts: LocalDateTimeParts | undefined, tz: string): string | undefined {
  if (!parts) return undefined;
  return zonedTime(parts, tz).toISOString();
}

function dateParts(date: string): { year: number; month: number; day: number } | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return undefined;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function dayOfWeekOf(date: string): number | undefined {
  const p = dateParts(date);
  return p ? new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() : undefined;
}

function pad2(s: string): string {
  const [h = '0', m = '0'] = s.split(':');
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
}

function periodTimes(
  ctx: NormalizeContext,
  period: number | undefined,
): { start?: string; end?: string } {
  if (!period || !ctx.profile) return {};
  const def = findPeriod(ctx.profile, period);
  return def ? { start: pad2(def.start), end: pad2(def.end) } : {};
}

function at(date: string, time: string | undefined, tz: string): string | undefined {
  const p = dateParts(date);
  if (!p) return undefined;
  const [h, m] = (time ?? '00:00').split(':').map(Number);
  return zonedTime({ ...p, hour: h ?? 0, minute: m ?? 0 }, tz).toISOString();
}

function nextDay(date: string, tz: string): string | undefined {
  const p = dateParts(date);
  return p ? zonedTime({ ...p, day: p.day + 1 }, tz).toISOString() : undefined;
}

function prefixDrift(findings: DriftFinding[], prefix: string): DriftFinding[] {
  return findings.map((f) => ({ ...f, path: f.path === '$' ? prefix : `${prefix}.${f.path}` }));
}

function splitNames(s: string | undefined): string[] {
  return (s ?? '')
    .split(/[,、，\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * LCU raw items → canonical entities (+ facts). Pure and deterministic: ids from ctx.id(), times
 * in ctx.timezone, period times from ctx.profile. Never emits student id/name.
 */
export function createLiveCampusUNormalizer(options: LiveCampusUNormalizerOptions): Normalizer {
  const d = options.deployment;
  const refFor = (
    screen: string,
    selector?: string,
    extra: Partial<SourceRefSpec> = {},
  ): SourceRefSpec => ({
    url: lcuUrl(d, screen),
    ...extra,
    location: { selector: selector ? `${screen} ${selector}` : screen, ...(extra.location ?? {}) },
  });

  return {
    id: 'livecampusu-normalizer',
    version: NORMALIZER_VERSION,
    sourceTypes: ALL_RAW_TYPES,
    normalize(item: RawItemView, ctx: NormalizeContext): NormalizeOutput {
      const type = item.sourceType as LcuRawType;
      const schema = PAYLOAD_SCHEMAS[type] as z.ZodType | undefined;
      if (!schema) return { entities: [], warnings: [`unhandled raw type ${item.sourceType}`] };
      const drift = detectSchemaDrift(item.payload, schema);
      const entities: NormalizedEntity[] = [];
      const facts: FactInput[] = [];
      const warnings: string[] = [];
      const self = ctx.id('person', SELF_PERSON_KEY);
      const offering = (key: string | undefined) =>
        key ? ctx.id('courseOffering', key) : undefined;

      switch (type) {
        case 'lcu.course': {
          const p = item.payload as CoursePayload;
          const courseId = ctx.id('course', p.subjectCode);
          const offeringId = ctx.id('courseOffering', p.key);
          const tt = p.timetable;
          const credits = tt?.credits;
          entities.push({
            entity: {
              id: courseId,
              kind: 'course',
              title: p.title,
              courseCode: p.subjectCode,
              ...(credits !== undefined ? { credits } : {}),
            },
            ref: refFor(p.source.screen, p.source.selector),
          });
          const schedule: ScheduleSlot[] = [];
          for (const s of tt?.slots ?? []) {
            const dow = lcuWeekToDayOfWeek(s.week);
            if (dow === undefined) continue;
            const times = periodTimes(ctx, s.period);
            schedule.push({
              dayOfWeek: dow,
              ...(s.period > 0 ? { period: s.period } : {}),
              ...(times.start ? { startTime: times.start } : {}),
              ...(times.end ? { endTime: times.end } : {}),
              ...(s.room ? { room: s.room } : {}),
            });
          }
          const room = tt?.room ?? tt?.slots.find((s) => s.room)?.room;
          entities.push({
            entity: {
              id: offeringId,
              kind: 'courseOffering',
              courseId,
              academicYear: p.year,
              ...(p.termName ? { term: p.termName } : {}),
              title: p.title,
              courseCode: p.subjectCode,
              instructorNames: splitNames(tt?.teacher),
              schedule,
              ...(p.scheduleType ? { scheduleType: p.scheduleType } : {}),
              ...(room ? { room } : {}),
              url: lcuUrl(d, p.source.screen),
              extra: {
                classCode: p.classCode,
                ...(p.className ? { className: p.className } : {}),
                ...(p.semesterCode ? { semesterCode: p.semesterCode } : {}),
                ...(tt?.numbering ? { numbering: tt.numbering } : {}),
                ...(credits !== undefined ? { credits } : {}),
                ...(tt?.campus ? { campus: tt.campus } : {}),
                ...(tt?.flags.length ? { flags: tt.flags } : {}),
                ...(p.retake ? { retake: true } : {}),
              },
            },
            ref: refFor(p.source.screen, p.source.selector),
          });
          entities.push({
            entity: {
              id: self,
              kind: 'person',
              name: '本人',
              roles: ['student'],
              isSelf: true,
            },
            deriveFacts: false,
          });
          entities.push({
            entity: {
              id: ctx.id('enrollment', p.key),
              kind: 'enrollment',
              personId: self,
              courseOfferingId: offeringId,
              role: 'student',
              status: 'active',
            },
            ref: refFor(p.source.screen, p.source.selector),
          });
          // getClassSubjectList JSON drift is covered by CoursePayloadSchema.subjectList.
          break;
        }

        case 'lcu.notice': {
          const p = item.payload as NoticePayload;
          const kind = p.kind as ContactKind;
          const imp = p.important;
          const row = p.listRow;
          // The list/JSON title is canonical; the detail heading is only a fallback.
          const title = imp?.title || row?.title || p.detail?.title || '(無題)';
          const published =
            parseSlashDateTime(imp?.contactDate, imp?.contactTime) ??
            parseSlashDateTime(row?.contactDateTime) ??
            parseSlashDateTime(p.detail?.contactDateTime);
          const publishedAt = iso(published, ctx.timezone);
          const subjectText = imp?.subjectClassSemesterWeekHour || row?.subjectText || '';
          const subject = subjectText ? parseSubjectText(subjectText) : undefined;
          const coId = offering(p.context.offeringKey);
          const category = imp?.contactTypeTitle || p.typeTitle || row?.category || undefined;
          const ref = refFor(p.source.screen, p.source.selector, {
            ...(imp?.contactSeq ? { location: { messageId: imp.contactSeq } } : {}),
          });
          entities.push({
            entity: {
              id: ctx.id('announcement', p.key),
              kind: 'announcement',
              title,
              body: p.detail?.body ?? '',
              ...(publishedAt ? { publishedAt } : {}),
              ...(p.detail?.sender ? { authorName: p.detail.sender } : {}),
              importance: classifyNoticeImportance({
                title,
                kind,
                courseLinked: coId !== undefined || subject !== undefined,
              }).importance,
              scope: subject || coId ? 'course' : 'university',
              ...(category ? { category } : {}),
              ...(coId ? { courseOfferingId: coId } : {}),
              url: lcuUrl(d, p.source.screen),
              extra: {
                ...(imp?.contactTypeCode || row?.typeCode
                  ? { contactTypeCode: imp?.contactTypeCode ?? row?.typeCode ?? '' }
                  : {}),
                ...(imp?.contactSeq ? { contactSeq: imp.contactSeq } : {}),
                ...(subjectText ? { subject: subjectText } : {}),
              },
            },
            ref,
          });
          const targetDate = slashDateToIso(imp?.targetDate || row?.targetDate);
          if (kind === 'cancellation' || kind === 'makeup' || kind === 'roomChange') {
            if (!targetDate) {
              warnings.push(`${kind} notice without 対象日: ${title}`);
              break;
            }
            if (!coId) {
              warnings.push(`${kind} notice not matched to a course: ${title}`);
              break;
            }
            const dow = dayOfWeekOf(targetDate);
            const period =
              subject && dow !== undefined ? uniquePeriodOnDay(subject.slots, dow) : undefined;
            const times = periodTimes(ctx, period);
            const sessionId = ctx.id(
              'classSession',
              p.context.offeringKey ?? '',
              targetDate,
              period ? String(period) : 'day',
            );
            const room = kind === 'roomChange' ? extractRoomChange(title) : undefined;
            const startsAt = times.start ? at(targetDate, times.start, ctx.timezone) : undefined;
            const endsAt = times.end ? at(targetDate, times.end, ctx.timezone) : undefined;
            entities.push({
              entity: {
                id: sessionId,
                kind: 'classSession',
                courseOfferingId: coId,
                date: targetDate,
                ...(period ? { period } : {}),
                ...(startsAt ? { startsAt } : {}),
                ...(endsAt ? { endsAt } : {}),
                ...(room ? { room: room.to } : {}),
                status:
                  kind === 'cancellation' ? 'cancelled' : kind === 'makeup' ? 'makeup' : 'changed',
                note: title,
              },
              ref,
              // Status comes from the official contact type; the room is parsed from free text.
              origin: kind === 'roomChange' ? 'extracted' : 'authoritative',
            });
            if (kind === 'roomChange') {
              if (!room) {
                warnings.push(`講義室変更 without a recognizable room: ${title}`);
              } else {
                const validFrom = at(targetDate, undefined, ctx.timezone);
                const validUntil = nextDay(targetDate, ctx.timezone);
                facts.push({
                  subject: coId,
                  predicate: 'room',
                  value: room.to,
                  origin: 'extracted',
                  confidence: 0.8,
                  ...(publishedAt ? { observedAt: publishedAt } : {}),
                  ...(validFrom ? { validFrom } : {}),
                  ...(validUntil ? { validUntil } : {}),
                  evidence: title,
                  ref,
                });
              }
            }
          } else if (kind === 'exam') {
            const time = firstTimeOfDay(title);
            const startsAt = targetDate
              ? at(
                  targetDate,
                  time ? `${time.hour}:${String(time.minute).padStart(2, '0')}` : undefined,
                  ctx.timezone,
                )
              : undefined;
            entities.push({
              entity: {
                id: ctx.id('exam', 'notice', p.key),
                kind: 'exam',
                title,
                examKind: /期末/.test(title)
                  ? 'final'
                  : /中間/.test(title)
                    ? 'midterm'
                    : /小テスト/.test(title)
                      ? 'quiz'
                      : 'other',
                ...(coId ? { courseOfferingId: coId } : {}),
                ...(startsAt ? { startsAt } : {}),
                ...(p.detail?.body ? { notes: p.detail.body } : {}),
              },
              ref,
            });
          }
          break;
        }

        case 'lcu.assignment': {
          const p = item.payload as AssignmentPayload;
          const coId = offering(p.context.offeringKey);
          const term = parseTermRange(p.submittalTerm);
          const availableFrom = iso(term.from, ctx.timezone);
          const dueAt = iso(term.to, ctx.timezone);
          const assignmentId = ctx.id('assignment', p.submissionSeq);
          // LCU is the submission system for its own assignments (§19).
          const ref = refFor(p.source.screen, p.source.selector, {
            authority: 'submission-system',
          });
          entities.push({
            entity: {
              id: assignmentId,
              kind: 'assignment',
              title: p.title,
              ...(coId ? { courseOfferingId: coId } : {}),
              ...(availableFrom ? { availableFrom } : {}),
              ...(dueAt ? { dueAt } : {}),
              ...(p.submissionType ? { submissionType: p.submissionType } : {}),
              extra: {
                submissionSeq: p.submissionSeq,
                ...(p.statusName ? { statusName: p.statusName } : {}),
                ...(p.subjectText ? { subject: p.subjectText } : {}),
              },
            },
            ref,
          });
          const st = p.submittalStatus;
          const status = /提出済|提出完了/.test(st)
            ? 'submitted'
            : /未提出/.test(st)
              ? 'not_submitted'
              : undefined;
          if (status)
            entities.push({
              entity: {
                id: ctx.id('submission', p.submissionSeq),
                kind: 'submission',
                assignmentId,
                personId: self,
                status,
              },
              ref,
            });
          else warnings.push(`unknown submission status "${st}" for ${p.submissionSeq}`);
          break;
        }

        case 'lcu.submissionInfo': {
          // Shape unobserved: keep raw + drift only. The assignment list (lcu.assignment) is the
          // full listing, so no entity is derived here (avoids two raw items owning one entity).
          const p = item.payload as { item: unknown };
          drift.push(
            ...prefixDrift(detectSchemaDrift(p.item, SubmissionInformationSchema), 'item'),
          );
          break;
        }

        case 'lcu.warningNotice': {
          const parsed = WarningNoticePayloadSchema.safeParse(item.payload);
          if (!parsed.success) break;
          const p = parsed.data;
          drift.push(...prefixDrift(detectSchemaDrift(p.item, WarningNoticeSchema), 'item'));
          const w = WarningNoticeSchema.partial().safeParse(p.item);
          if (!w.success) break;
          const name = w.data.warningNoticeName ?? '期限';
          const id = w.data.warningNoticeId ?? item.externalId;
          const lines: string[] = [];
          (w.data.warningNoticeInformationDateList ?? []).forEach((e, i) => {
            const month = Number(e.warningNoticeContentMonth);
            const day = Number(e.warningNoticeContentDay);
            if (!month || !day) return;
            const date = `${p.year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const startsAt = at(date, undefined, ctx.timezone);
            if (!startsAt) return;
            const label = e.warningNoticeContentDateTitle
              ? `${name}（${e.warningNoticeContentDateTitle}）`
              : name;
            const status = e.warningNoticeStatusName ?? '';
            lines.push(`${label}: ${month}月${day}日まで${status ? `（${status}）` : ''}`);
            entities.push({
              entity: {
                id: ctx.id('calendarEvent', 'warning', id, String(i)),
                kind: 'calendarEvent',
                title: label,
                startsAt,
                allDay: true,
                category: '期限',
                ...(status ? { description: `状態: ${status}` } : {}),
              },
              ref: refFor(p.source.screen, p.source.selector),
            });
          });
          if (lines.length)
            entities.push({
              entity: {
                id: ctx.id('announcement', 'warning', id),
                kind: 'announcement',
                title: name,
                body: lines.join('\n'),
                importance: 'high',
                scope: 'university',
                category: '期限',
                url: lcuUrl(d, p.source.screen),
              },
              ref: refFor(p.source.screen, p.source.selector),
            });
          break;
        }

        case 'lcu.calendarEvent': {
          const parsed = CalendarEventPayloadSchema.safeParse(item.payload);
          if (!parsed.success) break;
          const p = parsed.data;
          const toInstant = (v: string | undefined): string | undefined => {
            if (!v) return undefined;
            const date = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
            if (date) return at(date, undefined, ctx.timezone);
            if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(v)) {
              const t = Date.parse(v);
              return Number.isNaN(t) ? undefined : new Date(t).toISOString();
            }
            const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(v);
            return m
              ? zonedTime(
                  {
                    year: Number(m[1]),
                    month: Number(m[2]),
                    day: Number(m[3]),
                    hour: Number(m[4]),
                    minute: Number(m[5]),
                  },
                  ctx.timezone,
                ).toISOString()
              : undefined;
          };
          const startsAt = toInstant(p.start);
          if (!startsAt) {
            warnings.push(`calendar event with unreadable start "${p.start}"`);
            break;
          }
          const endsAt = toInstant(p.end);
          const allDay = p.allDay ?? /^\d{4}-\d{2}-\d{2}$/.test(p.start);
          entities.push({
            entity: {
              id: ctx.id('calendarEvent', item.externalId),
              kind: 'calendarEvent',
              title: p.title,
              startsAt,
              ...(endsAt ? { endsAt } : {}),
              allDay,
              ...(p.listType ? { category: p.listType } : {}),
            },
            ref: refFor(p.source.screen, p.source.selector),
          });
          break;
        }

        case 'lcu.exam': {
          const parsed = ExamPayloadSchema.safeParse(item.payload);
          if (!parsed.success) break;
          const p = parsed.data;
          const coId = offering(p.context.offeringKey);
          const date = examDate(p.date, p.year);
          const period = p.period ? periodFromLabel(p.period.replace(/限$/, '')) : undefined;
          const times = periodTimes(ctx, period);
          const explicit = p.time
            ? /(\d{1,2}):(\d{2})\s*[~〜～-]\s*(\d{1,2}):(\d{2})/.exec(p.time.normalize('NFKC'))
            : null;
          const start = explicit ? `${explicit[1]}:${explicit[2]}` : times.start;
          const end = explicit ? `${explicit[3]}:${explicit[4]}` : times.end;
          const startsAt = date ? at(date, start, ctx.timezone) : undefined;
          const endsAt = date && end ? at(date, end, ctx.timezone) : undefined;
          entities.push({
            entity: {
              id: ctx.id('exam', 'timetable', item.externalId),
              kind: 'exam',
              title: p.subject,
              examKind: 'final',
              ...(coId ? { courseOfferingId: coId } : {}),
              ...(startsAt ? { startsAt } : {}),
              ...(endsAt ? { endsAt } : {}),
              ...(p.room ? { room: p.room } : {}),
              extra: { ...p.cells },
            },
            ref: refFor(p.source.screen, p.source.selector),
          });
          break;
        }

        case 'lcu.attendance': {
          const parsed = AttendancePayloadSchema.safeParse(item.payload);
          if (!parsed.success) break;
          const p = parsed.data;
          const coId = offering(p.context.offeringKey);
          if (!coId) {
            warnings.push(`attendance row not matched to a course: ${p.subject}`);
            break;
          }
          facts.push({
            subject: coId,
            predicate: 'attendance',
            value: { ...p.counts, ...(p.published ? { published: p.published } : {}) },
            origin: 'authoritative',
            ref: refFor(p.source.screen, p.source.selector),
          });
          break;
        }

        case 'lcu.grade': {
          const parsed = GradePayloadSchema.safeParse(item.payload);
          if (!parsed.success) break;
          const p = parsed.data;
          const coId = offering(p.context.offeringKey);
          const finalized = slashDateToIso(p.reportDate);
          const finalizedAt = finalized ? at(finalized, undefined, ctx.timezone) : undefined;
          const rt = p.academicYear === undefined ? parseLcuReportTerm(p.reportTerm) : {};
          const academicYear = p.academicYear ?? rt.academicYear;
          const term = p.term ?? rt.term;
          const termPart = p.termPart ?? rt.termPart;
          const outcome = lcuGradeOutcome(p);
          // One entity per attempt; a re-exam row gets its own id so it never overwrites the
          // regular exam row of the same 成績報告時期.
          const reexam = p.examType && p.examType !== '本試験' ? [p.examType] : [];
          entities.push({
            entity: {
              id: ctx.id('grade', p.subjectCode, p.reportTerm ?? '', ...reexam),
              kind: 'grade',
              ...(coId ? { courseOfferingId: coId } : {}),
              ...(p.score !== undefined ? { score: p.score } : {}),
              ...(p.mark ? { letter: p.mark } : {}),
              ...(p.gradePoint !== undefined ? { gradePoint: p.gradePoint } : {}),
              ...(finalizedAt ? { finalizedAt } : {}),
              extra: {
                subjectCode: p.subjectCode,
                subjectName: p.subjectName,
                ...(p.markers?.length ? { markers: p.markers } : {}),
                ...(p.credits !== undefined ? { credits: p.credits } : {}),
                ...(p.category ? { category: p.category } : {}),
                ...(p.categoryOrder !== undefined ? { categoryOrder: p.categoryOrder } : {}),
                ...(p.creditType ? { creditType: p.creditType } : {}),
                ...(p.staffName ? { staffName: p.staffName } : {}),
                // The evaluation label exactly as LCU shows it ('' while in progress) + outcome.
                evaluation: p.mark ?? '',
                ...(p.markCode ? { evaluationCode: p.markCode } : {}),
                outcome,
                ...(isReexamLabel(p.mark) ? { pendingReexam: true } : {}),
                ...(p.interim ? { interim: true } : {}),
                ...(p.reportTerm ? { reportTerm: p.reportTerm } : {}),
                ...(academicYear !== undefined ? { academicYear } : {}),
                ...(term ? { term } : {}),
                ...(termPart ? { termPart } : {}),
                ...(p.reportDate ? { reportDate: p.reportDate } : {}),
                ...(p.examType ? { examType: p.examType } : {}),
                ...(p.replacedSubjectName ? { replacedSubjectName: p.replacedSubjectName } : {}),
                ...(p.view ? { view: p.view } : {}),
              },
            },
            ref: refFor(p.source.screen, p.source.selector),
          });
          break;
        }

        case 'lcu.creditRequirements': {
          const parsed = CreditRequirementsPayloadSchema.safeParse(item.payload);
          if (!parsed.success) break;
          const { source, ...value } = parsed.data;
          entities.push({
            entity: { id: self, kind: 'person', name: '本人', roles: ['student'], isSelf: true },
            deriveFacts: false,
          });
          facts.push({
            subject: self,
            predicate: 'credit_requirements',
            value: value as unknown as JsonValue,
            origin: 'authoritative',
            ref: refFor(source.screen, source.selector),
          });
          break;
        }
      }
      return { entities, facts, drift, ...(warnings.length ? { warnings } : {}) };
    },
  };
}

/** "2026/07/30", "7/30(木)", "07月30日" → ISO date (academic year: Jan–Mar belong to year+1). */
export function examDate(text: string | undefined, academicYear: number): string | undefined {
  if (!text) return undefined;
  const full = slashDateToIso(text);
  if (full) return full;
  const m = /(\d{1,2})\s*[/月]\s*(\d{1,2})/.exec(text.normalize('NFKC'));
  if (!m) return undefined;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const year = month <= 3 ? academicYear + 1 : academicYear;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
