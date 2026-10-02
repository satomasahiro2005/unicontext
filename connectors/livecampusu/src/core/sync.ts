import type { RawItem, SyncInput, SyncResult } from '@unicontext/connector-sdk';
import {
  AuthRequiredError,
  type Clock,
  contentHash,
  type Logger,
  OfflineError,
  PolicyViolationError,
  RateLimitedError,
  sha256,
  zonedParts,
} from '@unicontext/core';
import type { ContactKind, LcuDeploymentProfile } from './deployment.js';
import { parseAssignmentList } from './parsers/assignments.js';
import { parseCalendarEvents } from './parsers/calendar.js';
import {
  type NoticeListRow,
  parseNoticeAttachments,
  parseNoticeDetail,
  parseNoticeList,
} from './parsers/notices.js';
import {
  type AttendanceRow,
  type ExamRow,
  parseAttendance,
  parseExamTimetable,
} from './parsers/records.js';
import {
  type CreditRequirements,
  type GradeRow,
  gradeTableColumns,
  gradeViewKind,
  parseCreditRequirements,
  parseGradeMarkers,
  parseGrades,
  selectedOption,
} from './parsers/grades.js';
import {
  activeSemesterLabel,
  type OffGridEntry,
  parseTimetablePage,
  type TimetableEntry,
} from './parsers/timetable.js';
import {
  type ClassSubject,
  type CoursePayload,
  type ImportantNotice,
  type NoticeDetailPayload,
  type NoticePayload,
  RAW_TYPES,
} from './schemas.js';
import { type LcuPage, type LcuSession, SessionRestartedError } from './session.js';
import { parseSubjectText, splitTitleClass, titleKey } from './text.js';
import {
  composeVersion,
  pluginFingerprint,
  type ScriptFingerprint,
  scriptFingerprint,
  scriptMatches,
  VERSION_PRODUCT,
} from './version.js';

export interface LcuSyncOptions {
  academicYear: number;
  /** Semester codes to read (timetable, exams, class subject lists). */
  semesters: string[];
  grades: boolean;
  attendance: boolean;
  noticeDetails: boolean;
  maxNoticeDetailsPerRun: number;
}

export interface NoticeCacheEntry {
  /** Hash of the list row (without row index / read state). */
  rowHash: string;
  detail?: NoticeDetailPayload;
}

export interface VersionState {
  plugins: string;
  script?: ScriptFingerprint;
  version: string;
}

/** Persisted in SyncCursor.extra. */
export interface LcuCursorExtra {
  notices?: Record<string, NoticeCacheEntry>;
  version?: VersionState;
}

export interface LcuSyncContext {
  session: LcuSession;
  deployment: LcuDeploymentProfile;
  options: LcuSyncOptions;
  clock: Clock;
  timezone: string;
  logger: Logger;
  /** Product name reported in SyncResult.productVersion. */
  product: string;
  /** Adapter-owned caches (seeded from the cursor). */
  noticeCache: Map<string, NoticeCacheEntry>;
  /** Called after each fetched notice detail (checkpoint: a cut-off backfill resumes from here). */
  onNoticeDetail?: ((key: string, entry: NoticeCacheEntry) => void | Promise<void>) | undefined;
  version: VersionState | undefined;
}

export interface LcuSyncOutcome {
  result: SyncResult;
  version: VersionState | undefined;
  stats: {
    noticeDetailsFetched: number;
    noticeDetails: NoticeDetailStats;
    steps: Record<string, 'ok' | 'failed' | 'skipped'>;
  };
}

export interface NoticeDetailStats {
  /** Details read this run (READ notices only). */
  fetched: number;
  failed: number;
  /** Notices without a body because they are unread in LCU (never opened). */
  unreadNotOpened: number;
  /** READ notices still without a body (over this run's budget). */
  pending: number;
  /** fileUpload/load calls that returned a file list. */
  attachmentLists: number;
}

const MAX_DETAIL_BODY = 20_000;

function shortHash(...parts: string[]): string {
  return sha256(parts.join('\u0000')).slice(0, 16);
}

export function noticeKey(contactDateTime: string, typeCode: string, title: string): string {
  return `n-${shortHash(contactDateTime.replace(/\s+/g, ' ').trim(), typeCode, titleKey(title))}`;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isFatal(e: unknown): boolean {
  return (
    e instanceof AuthRequiredError ||
    e instanceof PolicyViolationError ||
    e instanceof RateLimitedError ||
    e instanceof OfflineError ||
    (e instanceof Error && e.name === 'AbortError')
  );
}

interface OfferingRec {
  key: string;
  year: number;
  subjectCode: string;
  classCode: string;
  title: string;
  className?: string;
  semesterCode?: string;
  subjectList?: ClassSubject;
  entries: TimetableEntry[];
  /** From the 時間割外講義 / 集中講義 lists. */
  offGrid?: OffGridEntry;
}

/** Title → offering resolution inside this source (deterministic, best effort). */
class OfferingIndex {
  private readonly byTitle = new Map<string, OfferingRec[]>();
  constructor(readonly recs: OfferingRec[]) {
    for (const r of recs) {
      const k = titleKey(r.title);
      this.byTitle.set(k, [...(this.byTitle.get(k) ?? []), r]);
    }
  }

  resolve(
    title: string | undefined,
    className?: string,
    semesterCode?: string,
  ): OfferingRec | undefined {
    if (!title) return undefined;
    let list = this.byTitle.get(titleKey(title)) ?? [];
    if (list.length > 1 && semesterCode) {
      const sameTerm = list.filter((r) => r.semesterCode === semesterCode);
      if (sameTerm.length) list = sameTerm;
    }
    if (list.length === 1) return list[0];
    if (list.length > 1 && className) {
      const hits = list.filter((r) => r.className && titleKey(r.className) === titleKey(className));
      if (hits.length === 1) return hits[0];
    }
    return undefined;
  }

  /** Resolve 「科目名(クラス)\n学期/曜日・時限…」. */
  resolveSubjectText(text: string | undefined): OfferingRec | undefined {
    const s = text ? parseSubjectText(text) : undefined;
    return s ? this.resolve(s.title, s.className) : undefined;
  }

  bySubjectCode(code: string, semesterCode?: string): OfferingRec | undefined {
    let hits = this.recs.filter((r) => r.subjectCode === code);
    if (hits.length > 1 && semesterCode) {
      const sameTerm = hits.filter((r) => r.semesterCode === semesterCode);
      if (sameTerm.length) hits = sameTerm;
    }
    return hits.length === 1 ? hits[0] : undefined;
  }
}

/**
 * One sync run over LCU-Web: JSON endpoints first, then the HTML screens, all through the single
 * serial session. Each step restarts once after a mid-step re-authentication; a step that fails
 * otherwise is reported as a warning and its types are not marked complete (no false deletions).
 */
export async function runLcuSync(ctx: LcuSyncContext, input: SyncInput): Promise<LcuSyncOutcome> {
  const { session, deployment: d, options: o } = ctx;
  const items = new Map<string, RawItem>();
  const warnings: string[] = [];
  const steps: Record<string, 'ok' | 'failed' | 'skipped'> = {};
  const add = (item: RawItem): void => {
    items.set(`${item.sourceType}\u0000${item.externalId}`, item);
  };

  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const v = await fn();
        steps[name] = 'ok';
        return v;
      } catch (e) {
        if (e instanceof SessionRestartedError && attempt === 0) continue;
        if (isFatal(e)) throw e;
        steps[name] = 'failed';
        warnings.push(`${name}: ${errorMessage(e)}`);
        ctx.logger.warn('LiveCampusU step failed', { step: name, error: errorMessage(e) });
        return undefined;
      }
    }
  };

  session.beginRun(input.signal);

  // 0. Landing page: tokens + product version (§72).
  const landing = await session.bootstrap();
  const version = await detectVersion(ctx, landing, warnings);

  const now = ctx.clock.now();
  const zp = zonedParts(now, ctx.timezone);

  // 1. JSON endpoints (research §1.7).
  const important =
    (await step('importantNotice', async () => {
      const v = await session.getJson(d.endpoints.importantNotice);
      if (!Array.isArray(v)) throw new Error('importantNotice did not return an array');
      return v as unknown[];
    })) ?? undefined;

  const submissionInfo = await step('submissionInformation', async () => {
    const v = await session.getJson(d.endpoints.submissionInformation);
    if (!Array.isArray(v)) throw new Error('submissionInformation did not return an array');
    return v as unknown[];
  });
  if (submissionInfo) {
    for (const raw of submissionInfo) {
      const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const seq = rec.submissionSeq;
      const title = typeof rec.title === 'string' ? rec.title : undefined;
      const deadline = [rec.submittalEndDate, rec.deadline, rec.submittalTerm].find(
        (x): x is string => typeof x === 'string',
      );
      const externalId =
        typeof seq === 'string' || typeof seq === 'number'
          ? String(seq)
          : `h-${contentHash(raw).slice(0, 16)}`;
      add({
        sourceType: RAW_TYPES.submissionInfo,
        externalId,
        payload: {
          item: raw,
          extracted: {
            ...(seq !== undefined ? { submissionSeq: String(seq) } : {}),
            ...(title ? { title } : {}),
            ...(deadline ? { deadline } : {}),
          },
          source: {
            screen: d.screens.home,
            selector: `submissionInformation[submissionSeq=${externalId}]`,
          },
        },
      });
    }
  }

  const warningNotices = await step('warningNoticeInformation', async () => {
    const v = await session.getJson(d.endpoints.warningNotice);
    if (!Array.isArray(v)) throw new Error('warningNoticeInformation did not return an array');
    return v as unknown[];
  });
  if (warningNotices) {
    for (const raw of warningNotices) {
      if (!raw || typeof raw !== 'object') continue;
      // warningNoticeRequestPath is an opaque, session-bound request path: never stored.
      const { warningNoticeRequestPath: _drop, ...item } = raw as Record<string, unknown>;
      const id =
        typeof item.warningNoticeId === 'string' && item.warningNoticeId
          ? item.warningNoticeId
          : `h-${contentHash(item.warningNoticeName ?? item).slice(0, 16)}`;
      const months = Array.isArray(item.warningNoticeInformationDateList)
        ? (item.warningNoticeInformationDateList as Record<string, unknown>[])
            .map((e) => Number(e.warningNoticeContentMonth))
            .filter((m) => m >= 1 && m <= 12)
        : [];
      add({
        sourceType: RAW_TYPES.warningNotice,
        externalId: id,
        payload: {
          item,
          year: inferYear(months[0] ?? zp.month, zp.year, zp.month),
          source: {
            screen: d.screens.home,
            selector: `warningNoticeInformation[warningNoticeId=${id}]`,
          },
        },
      });
    }
  }

  // 2. スケジュール → 時間割 (both semesters) → 試験時間割.
  const calendar: Record<string, unknown>[] = [];
  const timetable = new Map<string, TimetableEntry[]>();
  const offGrid = new Map<string, OffGridEntry[]>();
  const exams = new Map<string, ExamRow[]>();
  let examsOk = false;
  let semestersVerified = true;
  const semesterName = (code: string | undefined): string | undefined =>
    d.semesters.find((s) => s.code === code)?.name;
  /** False when the page shows another semester than the one requested (switch did not apply). */
  const showsSemester = (html: string, sem: string, screen: string): boolean => {
    const shown = activeSemesterLabel(html);
    const want = semesterName(sem);
    if (!shown || !want || shown === want) return true;
    semestersVerified = false;
    warnings.push(
      `${screen}: asked for semester ${want} but the page shows ${shown}; its rows were skipped`,
    );
    return false;
  };
  await step('timetable', async () => {
    calendar.length = 0;
    timetable.clear();
    offGrid.clear();
    exams.clear();
    examsOk = false;
    semestersVerified = true;
    const sched = await session.open(d.screens.scheduler);
    const cal = parseCalendarEvents(sched.html);
    if (cal.error) warnings.push(`calendar events: ${cal.error}`);
    calendar.push(...(cal.events as Record<string, unknown>[]));
    await session.post(d.actions.schedulerToTimetable);
    for (const sem of o.semesters) {
      const page = await session.post(d.actions.timetableChangeSemester, [
        [d.actions.semesterField, sem],
      ]);
      if (!showsSemester(page.html, sem, 'timetable')) continue;
      const parsed = parseTimetablePage(page.html);
      timetable.set(sem, parsed.entries);
      offGrid.set(sem, parsed.offGrid);
    }
    try {
      await session.post(d.actions.timetableToExams);
      for (const sem of o.semesters) {
        const page = await session.post(d.actions.examChangeSemester, [
          [d.actions.semesterField, sem],
        ]);
        if (!showsSemester(page.html, sem, 'examTimetable')) continue;
        exams.set(sem, parseExamTimetable(page.html));
      }
      examsOk = semestersVerified;
    } catch (e) {
      if (e instanceof SessionRestartedError || isFatal(e)) throw e;
      warnings.push(`examTimetable: ${errorMessage(e)}`);
    }
  });
  const timetableOk = steps.timetable === 'ok' && semestersVerified;

  // 3. 課題・アンケートリスト (full list) + getClassSubjectList (JSON, X-CSRF-TOKEN).
  let assignmentRows: ReturnType<typeof parseAssignmentList> = [];
  const subjectLists = new Map<string, ClassSubject[]>();
  let subjectListsOk = false;
  await step('assignments', async () => {
    subjectLists.clear();
    subjectListsOk = false;
    const listPage = await session.open(d.screens.assignmentList);
    const fields = d.forms.assignmentSearch.map(
      ([k, v]) => [k, v.replaceAll('{year}', String(o.academicYear))] as const,
    );
    const page = fields.length ? await session.post(d.actions.assignmentSearch, fields) : listPage;
    assignmentRows = parseAssignmentList(page.html);
    const f = d.forms.classSubjectList;
    for (const sem of o.semesters) {
      const v = await session.postJson(d.endpoints.classSubjectList, {
        ...f.extra,
        [f.yearField]: String(o.academicYear),
        [f.semesterField]: sem,
      });
      if (!Array.isArray(v)) throw new Error('getClassSubjectList did not return an array');
      subjectLists.set(
        sem,
        v.filter(
          (x): x is ClassSubject =>
            !!x && typeof x === 'object' && typeof (x as ClassSubject).value === 'string',
        ),
      );
    }
    subjectListsOk = true;
  });
  const assignmentsOk = steps.assignments === 'ok';

  // Courses: union of timetable cells, off-grid lists and enrolled class subjects.
  const offerings = buildOfferings(o, timetable, offGrid, subjectLists);
  const index = new OfferingIndex([...offerings.values()]);
  for (const rec of offerings.values()) {
    add({
      sourceType: RAW_TYPES.course,
      externalId: rec.key,
      payload: coursePayload(d, rec, semesterName(rec.semesterCode)),
    });
  }

  for (const r of assignmentRows) {
    const off = index.resolveSubjectText(r.subjectText);
    add({
      sourceType: RAW_TYPES.assignment,
      externalId: r.submissionSeq,
      payload: {
        submissionSeq: r.submissionSeq,
        year: o.academicYear,
        submissionType: r.submissionType,
        subjectText: r.subjectText,
        title: r.title,
        statusName: r.statusName,
        statusCode: r.statusCode,
        submittalTerm: r.submittalTerm,
        submittalStatus: r.submittalStatus,
        context: off ? { offeringKey: off.key, offeringTitle: off.title } : {},
        source: {
          screen: d.screens.assignmentList,
          selector: `tr[submissionSeq=${r.submissionSeq}]`,
        },
      },
    });
  }

  for (const ev of calendar) {
    const title = String(ev.title);
    const start = String(ev.start);
    const listType = typeof ev.listType === 'string' ? ev.listType : undefined;
    const externalId = `c-${shortHash(listType ?? '', start, title)}`;
    add({
      sourceType: RAW_TYPES.calendarEvent,
      externalId,
      payload: {
        title,
        start,
        ...(typeof ev.end === 'string' ? { end: ev.end } : {}),
        ...(typeof ev.allDay === 'boolean' ? { allDay: ev.allDay } : {}),
        ...(listType ? { listType } : {}),
        event: ev,
        source: { screen: d.screens.scheduler, selector: `events[start=${start}]` },
      },
    });
  }

  for (const [sem, rows] of exams) {
    for (const r of rows) add(examItem(d, o.academicYear, sem, r, index));
  }

  // 4. 出欠 (counts per course).
  let attendanceOk = false;
  if (o.attendance) {
    const rows = await step('attendance', async () => {
      const page = await session.open(d.screens.attendance);
      const action = d.actions.attendanceSearch;
      const form = d.forms.attendanceSearch;
      // The screen opens on the current semester only; search each configured semester.
      if (!action || form.length === 0)
        return parseAttendance(page.html).map((r) => ({ r, sem: undefined }));
      const out: { r: AttendanceRow; sem: string | undefined }[] = [];
      for (const sem of o.semesters) {
        const fields = form.map(
          ([k, v]) =>
            [
              k,
              v.replaceAll('{year}', String(o.academicYear)).replaceAll('{semester}', sem),
            ] as const,
        );
        const res = await session.post(action, fields);
        out.push(...parseAttendance(res.html).map((r) => ({ r, sem })));
      }
      return out;
    });
    if (rows) {
      attendanceOk = true;
      for (const { r, sem } of rows) add(attendanceItem(d, r, index, sem));
    }
  } else steps.attendance = 'skipped';

  // 5. 連絡: importantNotice JSON + 連絡一覧 HTML, details only for READ rows that changed.
  const noticeOutcome = await syncNotices(
    ctx,
    important as ImportantNotice[] | undefined,
    index,
    step,
    warnings,
  );
  for (const it of noticeOutcome.items) add(it);

  // 6. 成績 (opt-in): every graded attempt of every year (failed ones and re-exams included),
  // in the 履修中含む view when the deployment has it, then 単位修得情報 (requirement status).
  let gradesOk = false;
  let requirementsOk = false;
  if (o.grades) {
    const got = await step('grades', async () => {
      await session.open(d.screens.gradeDashboard);
      let page = await session.post(d.actions.gradesFromDashboard);
      const markers = parseGradeMarkers(page.html);
      let view = gradeViewKind(page.html);
      const a = d.actions;
      if (a.gradesChangeKind && a.gradesKindIncludingInProgress && view !== 'includingInProgress') {
        const req = selectedOption(page.html, 'requirementTypeCode');
        const switched = await session.post(a.gradesChangeKind, [
          [a.gradesKindField, a.gradesKindIncludingInProgress],
          ...(req ? ([['requirementTypeCode', req.value]] as const) : []),
        ]);
        const switchedView = gradeViewKind(switched.html);
        if (switchedView === 'includingInProgress' || gradeTableColumns(switched.html).length) {
          page = switched;
          view = switchedView;
        }
        if (switchedView !== 'includingInProgress')
          warnings.push(
            'grades: the 履修中含む view did not open; registered courses without a grade may be missing',
          );
      }
      const rows = parseGrades(page.html, markers);
      if (rows.length === 0 && gradeTableColumns(page.html).length === 0)
        throw new Error('the grade table (th#subjectCode) was not found on the grade screen');
      let requirements: CreditRequirements | undefined;
      if (a.gradesToRequirements && d.screens.creditRequirements) {
        try {
          const req = await session.post(a.gradesToRequirements, [
            ['rowIndex', ''],
            ['viewRowIndexArray', ''],
          ]);
          requirements = parseCreditRequirements(req.html);
          if (!requirements) throw new Error('the requirement table was not found');
        } catch (e) {
          if (e instanceof SessionRestartedError || isFatal(e)) throw e;
          warnings.push(`creditRequirements: ${errorMessage(e)}`);
        }
      }
      return { rows, markers, view, requirements };
    });
    if (got) {
      gradesOk = true;
      for (const r of got.rows) add(gradeItem(d, r, index, got.view));
      if (got.requirements) {
        requirementsOk = true;
        add({
          sourceType: RAW_TYPES.creditRequirements,
          externalId: got.requirements.requirementType?.code ?? 'default',
          payload: {
            ...got.requirements,
            ...(got.markers.length ? { markers: got.markers } : {}),
            source: { screen: d.screens.creditRequirements ?? d.screens.grades },
          },
        });
      }
    }
  } else steps.grades = 'skipped';

  try {
    await session.persistCookies();
  } catch (e) {
    warnings.push(`could not persist rotated session cookies: ${errorMessage(e)}`);
  }

  const complete: string[] = [];
  if (timetableOk && assignmentsOk && subjectListsOk) complete.push(RAW_TYPES.course);
  if (assignmentsOk) complete.push(RAW_TYPES.assignment);
  if (timetableOk && examsOk) complete.push(RAW_TYPES.exam);
  if (submissionInfo) complete.push(RAW_TYPES.submissionInfo);
  if (warningNotices) complete.push(RAW_TYPES.warningNotice);
  if (noticeOutcome.listOk) complete.push(RAW_TYPES.notice);
  // Disabled opt-in types are complete with zero items: previously synced rows are removed.
  if (attendanceOk || !o.attendance) complete.push(RAW_TYPES.attendance);
  if (gradesOk || !o.grades) complete.push(RAW_TYPES.grade);
  if (requirementsOk || !o.grades) complete.push(RAW_TYPES.creditRequirements);

  const notices: Record<string, NoticeCacheEntry> = {};
  for (const [k, v] of ctx.noticeCache) notices[k] = v;
  const extra: LcuCursorExtra = { notices, ...(version ? { version } : {}) };

  return {
    result: {
      items: [...items.values()],
      cursor: { lastModified: now.toISOString(), extra: extra as Record<string, unknown> },
      hasMore: false,
      ...(complete.length ? { complete: { sourceTypes: complete } } : {}),
      ...(version ? { productVersion: { product: ctx.product, version: version.version } } : {}),
      ...(warnings.length ? { warnings } : {}),
    },
    version,
    stats: {
      noticeDetailsFetched: noticeOutcome.details.fetched,
      noticeDetails: noticeOutcome.details,
      steps,
    },
  };
}

/** Year for a month/day without a year: the one closest to now. */
export function inferYear(month: number, nowYear: number, nowMonth: number): number {
  if (month - nowMonth > 6) return nowYear - 1;
  if (nowMonth - month > 6) return nowYear + 1;
  return nowYear;
}

async function detectVersion(
  ctx: LcuSyncContext,
  landing: LcuPage,
  warnings: string[],
): Promise<VersionState | undefined> {
  const plugins = pluginFingerprint(landing.html);
  if (!plugins) return ctx.version;
  const prev = ctx.version;
  if (prev && prev.plugins === plugins && prev.script) return prev;
  // Fingerprint missing or changed: check the static script once (an extra GET).
  const path = ctx.deployment.endpoints.commonScript;
  const known = ctx.deployment.version.scripts.find((s) => s.path === path);
  let script: ScriptFingerprint | undefined;
  try {
    script = scriptFingerprint(path, await ctx.session.getBytes(path));
  } catch (e) {
    // A static file; a failure (or a session restart) only skips the extra check.
    if (isFatal(e)) throw e;
    warnings.push(`version check (${path}): ${errorMessage(e)}`);
  }
  const state: VersionState = {
    plugins,
    ...(script ? { script } : {}),
    version: composeVersion(plugins, script, script ? scriptMatches(script, known) : true),
  };
  return state;
}

function buildOfferings(
  o: LcuSyncOptions,
  timetable: Map<string, TimetableEntry[]>,
  offGrid: Map<string, OffGridEntry[]>,
  subjectLists: Map<string, ClassSubject[]>,
): Map<string, OfferingRec> {
  const out = new Map<string, OfferingRec>();
  const get = (year: number, code: string, cls: string, title: string): OfferingRec => {
    const key = `${year}-${code}-${cls}`;
    let rec = out.get(key);
    if (!rec) {
      rec = { key, year, subjectCode: code, classCode: cls, title, entries: [] };
      out.set(key, rec);
    }
    return rec;
  };
  for (const [sem, entries] of timetable) {
    for (const e of entries) {
      const rec = get(e.year ?? o.academicYear, e.subjectCode, e.classCode, e.title);
      rec.semesterCode ??= e.semesterCode ?? sem;
      if (!rec.entries.some((x) => x.week === e.week && x.period === e.period)) rec.entries.push(e);
    }
  }
  for (const [sem, list] of offGrid) {
    for (const e of list) {
      const rec = get(e.year ?? o.academicYear, e.subjectCode, e.classCode, e.title);
      rec.semesterCode ??= e.semesterCode ?? sem;
      rec.offGrid ??= e;
    }
  }
  for (const [sem, list] of subjectLists) {
    for (const s of list) {
      const [code, cls] = s.value.split('_');
      if (!code || !/^\w+$/.test(code)) continue;
      const tc = splitTitleClass(s.label);
      const rec = get(o.academicYear, code, cls ?? '', tc.title);
      rec.subjectList = s;
      rec.semesterCode ??= sem;
      if (tc.className) rec.className = tc.className;
    }
  }
  for (const rec of out.values())
    rec.entries.sort((a, b) => a.week - b.week || a.period - b.period);
  return out;
}

function coursePayload(
  d: LcuDeploymentProfile,
  rec: OfferingRec,
  termName: string | undefined,
): CoursePayload {
  const first = rec.entries[0];
  const og = rec.offGrid;
  const rooms = [...new Set(rec.entries.map((e) => e.room).filter((r): r is string => !!r))];
  const scheduleType: CoursePayload['scheduleType'] = first ? 'regular' : og ? og.kind : undefined;
  const retake = /再履修/.test(rec.className ?? '') || undefined;
  const info = first ?? og;
  return {
    key: rec.key,
    year: rec.year,
    ...(rec.semesterCode ? { semesterCode: rec.semesterCode } : {}),
    ...(termName ? { termName } : {}),
    subjectCode: rec.subjectCode,
    classCode: rec.classCode,
    title: rec.title,
    ...(rec.className ? { className: rec.className } : {}),
    ...(rec.subjectList ? { subjectList: rec.subjectList } : {}),
    ...(scheduleType ? { scheduleType } : {}),
    ...(retake ? { retake } : {}),
    ...(info
      ? {
          timetable: {
            ...(info.teacher ? { teacher: info.teacher } : {}),
            ...(info.credits !== undefined ? { credits: info.credits } : {}),
            ...(info.numbering ? { numbering: info.numbering } : {}),
            ...(info.campus ? { campus: info.campus } : {}),
            ...(first
              ? rooms.length === 1 && rooms[0]
                ? { room: rooms[0] }
                : {}
              : og?.room
                ? { room: og.room }
                : {}),
            flags: info.flags,
            slots: rec.entries.map((e) => ({
              week: e.week,
              period: e.period,
              ...(e.room ? { room: e.room } : {}),
              ...(e.campus ? { campus: e.campus } : {}),
              selector: e.selector,
            })),
          },
        }
      : {}),
    source: info
      ? { screen: d.screens.timetable, selector: info.selector }
      : {
          screen: d.screens.assignmentList,
          selector: `getClassSubjectList[value=${rec.subjectCode}_${rec.classCode}]`,
        },
  };
}

function examItem(
  d: LcuDeploymentProfile,
  year: number,
  sem: string,
  r: ExamRow,
  index: OfferingIndex,
): RawItem {
  const tc = splitTitleClass(r.subject);
  const off = index.resolve(tc.title, tc.className, sem);
  return {
    sourceType: RAW_TYPES.exam,
    externalId: `x-${shortHash(sem, r.subject, r.date ?? '', r.period ?? '', r.time ?? '')}`,
    payload: {
      year,
      semesterCode: sem,
      subject: r.subject,
      ...(r.date ? { date: r.date } : {}),
      ...(r.period ? { period: r.period } : {}),
      ...(r.time ? { time: r.time } : {}),
      ...(r.room ? { room: r.room } : {}),
      ...(r.teacher ? { teacher: r.teacher } : {}),
      cells: r.cells,
      context: off ? { offeringKey: off.key, offeringTitle: off.title } : {},
      source: { screen: d.screens.examTimetable, selector: `tr[subject="${r.subject}"]` },
    },
  };
}

function attendanceItem(
  d: LcuDeploymentProfile,
  r: AttendanceRow,
  index: OfferingIndex,
  sem: string | undefined,
): RawItem {
  const tc = splitTitleClass(r.subject);
  const off =
    (r.subjectCode ? index.bySubjectCode(r.subjectCode, sem) : undefined) ??
    index.resolve(tc.title, tc.className, sem);
  return {
    sourceType: RAW_TYPES.attendance,
    externalId: `a-${shortHash(r.subject, r.schedule)}`,
    payload: {
      subject: r.subject,
      ...(r.subjectCode ? { subjectCode: r.subjectCode } : {}),
      ...(sem ? { semesterCode: sem } : {}),
      schedule: r.schedule,
      ...(r.published ? { published: r.published } : {}),
      counts: r.counts,
      context: off ? { offeringKey: off.key, offeringTitle: off.title } : {},
      source: { screen: d.screens.attendance, selector: `tr[講義名="${r.subject}"]` },
    },
  };
}

function gradeItem(
  d: LcuDeploymentProfile,
  r: GradeRow,
  index: OfferingIndex,
  view: 'earned' | 'includingInProgress' | undefined,
): RawItem {
  const off = index.bySubjectCode(r.subjectCode);
  const { outcome: _derived, ...row } = r;
  return {
    sourceType: RAW_TYPES.grade,
    // Stable across views: code + 成績報告時期 + 試験種別 (one row per attempt).
    externalId: `g-${shortHash(r.subjectCode, r.reportTerm ?? '', r.examType ?? '')}`,
    payload: {
      ...row,
      ...(view ? { view } : {}),
      context: off ? { offeringKey: off.key, offeringTitle: off.title } : {},
      source: { screen: d.screens.grades, selector: `tr[subjectCode=${r.subjectCode}]` },
    },
  };
}

function rowHash(row: NoticeListRow): string {
  const { rowIndex: _i, unread: _u, ...rest } = row;
  return contentHash(rest);
}

async function syncNotices(
  ctx: LcuSyncContext,
  important: ImportantNotice[] | undefined,
  index: OfferingIndex,
  step: <T>(name: string, fn: () => Promise<T>) => Promise<T | undefined>,
  warnings: string[],
): Promise<{ items: RawItem[]; listOk: boolean; details: NoticeDetailStats }> {
  const { session, deployment: d, options: o } = ctx;
  const details: NoticeDetailStats = {
    fetched: 0,
    failed: 0,
    unreadNotOpened: 0,
    pending: 0,
    attachmentLists: 0,
  };
  const rows = await step('noticeList', async () => {
    let list = await session.open(d.screens.noticeList);
    const parsed = parseNoticeList(list.html);
    // Details only for rows that are READ in LCU: opening an unread notice marks it read and LCU
    // has no way to set it back to unread (readMark only marks read). Incremental: only rows whose
    // detail is missing or whose list row changed; newest first, at most maxNoticeDetailsPerRun.
    const keyed = parsed.map((r) => ({
      r,
      key: noticeKey(r.contactDateTime ?? '', r.typeCode ?? '', r.title),
      hash: rowHash(r),
    }));
    const needs = keyed.filter(({ key, hash }) => {
      const c = ctx.noticeCache.get(key);
      return !c?.detail || c.rowHash !== hash;
    });
    details.unreadNotOpened = needs.filter(({ r }) => r.unread).length;
    const candidates = needs
      .filter(({ r }) => !r.unread)
      .sort((a, b) => (b.r.contactDateTime ?? '').localeCompare(a.r.contactDateTime ?? ''));
    const enabled = o.noticeDetails && o.maxNoticeDetailsPerRun > 0;
    const wanted = enabled ? candidates.slice(0, o.maxNoticeDetailsPerRun) : [];
    details.pending = candidates.length - wanted.length;
    for (const { key, hash, r: listed } of wanted) {
      // Row indexes belong to the list page we are on; find the row again on the current list.
      const current = parseNoticeList(list.html).find(
        (r) => noticeKey(r.contactDateTime ?? '', r.typeCode ?? '', r.title) === key,
      );
      if (!current || current.unread || list.noticeListVersion === undefined) {
        details.pending++;
        continue;
      }
      let opened = false;
      try {
        const detailPage = await session.openNoticeDetail({
          rowIndex: current.rowIndex,
          unread: current.unread,
          listVersion: list.noticeListVersion,
        });
        opened = true;
        const detail = parseNoticeDetail(detailPage.html);
        if (!detail) throw new Error('the detail screen had no notice heading');
        let attachments = detail.attachments;
        let attachmentsComplete = true;
        if (listed.hasAttachment) {
          try {
            const parsedFiles = parseNoticeAttachments(await session.loadNoticeAttachments());
            if (parsedFiles) {
              attachments = parsedFiles;
              details.attachmentLists++;
            } else attachmentsComplete = false;
          } catch (e) {
            if (e instanceof SessionRestartedError || isFatal(e)) throw e;
            attachmentsComplete = false;
            warnings.push(`notice attachments (${detail.title}): ${errorMessage(e)}`);
          }
        }
        const entry: NoticeCacheEntry = {
          rowHash: hash,
          detail: {
            ...detail,
            body: detail.body.slice(0, MAX_DETAIL_BODY),
            attachments,
            ...(attachmentsComplete ? {} : { attachmentsComplete: false }),
            fetchedAt: ctx.clock.now().toISOString(),
            openedWhileRead: true,
          },
        };
        ctx.noticeCache.set(key, entry);
        details.fetched++;
        try {
          await ctx.onNoticeDetail?.(key, entry);
        } catch (e) {
          warnings.push(`notice detail checkpoint: ${errorMessage(e)}`);
        }
      } catch (e) {
        if (e instanceof SessionRestartedError || isFatal(e)) throw e;
        details.failed++;
        warnings.push(`notice detail: ${errorMessage(e)}`);
      }
      list = opened
        ? await session.post(d.actions.noticeDetailBack)
        : list.screenId === d.screens.noticeList
          ? list
          : await session.open(d.screens.noticeList);
      if (list.screenId !== d.screens.noticeList) list = await session.open(d.screens.noticeList);
    }
    return parsed;
  });

  const byKey = new Map<string, { important?: ImportantNotice; row?: NoticeListRow }>();
  for (const n of important ?? []) {
    if (!n || typeof n !== 'object' || typeof n.title !== 'string') continue;
    const key = noticeKey(
      `${n.contactDate ?? ''} ${n.contactTime ?? ''}`,
      n.contactTypeCode ?? '',
      n.title,
    );
    byKey.set(key, { ...byKey.get(key), important: n });
  }
  for (const r of rows ?? []) {
    const key = noticeKey(r.contactDateTime ?? '', r.typeCode ?? '', r.title);
    byKey.set(key, { ...byKey.get(key), row: r });
  }

  const items: RawItem[] = [];
  for (const [key, { important: imp, row }] of byKey) {
    const typeCode = imp?.contactTypeCode || row?.typeCode || '';
    const type = d.contactTypes[typeCode];
    const kind: ContactKind = type?.kind ?? 'notice';
    let offeringKey: string | undefined;
    let offeringTitle: string | undefined;
    if (row?.subjectKey) {
      offeringKey = `${row.subjectKey.year}-${row.subjectKey.subjectCode}-${row.subjectKey.classCode}`;
      offeringTitle = parseSubjectText(row.subjectText)?.title;
    } else {
      const off = index.resolveSubjectText(imp?.subjectClassSemesterWeekHour || row?.subjectText);
      offeringKey = off?.key;
      offeringTitle = off?.title;
    }
    const cached = ctx.noticeCache.get(key);
    if (row && cached && cached.rowHash !== rowHash(row) && !cached.detail)
      ctx.noticeCache.delete(key);
    const { rowIndex: _ri, ...listRow } = row ?? ({} as NoticeListRow);
    const bodyStatus: NoticePayload['bodyStatus'] = cached?.detail
      ? 'fetched'
      : row?.unread
        ? 'notOpened'
        : row
          ? 'pending'
          : undefined;
    const dt = row?.contactDateTime ?? `${imp?.contactDate ?? ''} ${imp?.contactTime ?? ''}`.trim();
    const payload: NoticePayload = {
      key,
      kind,
      ...(type?.title ? { typeTitle: type.title } : {}),
      ...(imp ? { important: imp } : {}),
      ...(row ? { listRow } : {}),
      ...(cached?.detail ? { detail: cached.detail } : {}),
      ...(bodyStatus ? { bodyStatus } : {}),
      context: {
        ...(offeringKey ? { offeringKey } : {}),
        ...(offeringTitle ? { offeringTitle } : {}),
      },
      source: row
        ? { screen: d.screens.noticeList, selector: `tr[contactDateTime="${dt}"]` }
        : {
            screen: d.screens.landing,
            selector: `importantNotice[contactSeq=${imp?.contactSeq ?? ''}]`,
          },
    };
    items.push({ sourceType: RAW_TYPES.notice, externalId: key, payload });
  }

  // Prune cache entries of notices that disappeared from a complete listing.
  if (rows)
    for (const k of [...ctx.noticeCache.keys()]) if (!byKey.has(k)) ctx.noticeCache.delete(k);

  return { items, listOk: rows !== undefined, details };
}

export { VERSION_PRODUCT };
