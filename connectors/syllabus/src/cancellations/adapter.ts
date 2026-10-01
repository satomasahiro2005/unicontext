import type { Capability, HealthStatus } from '@unicontext/canonical-model';
import {
  type AuthResult,
  type ConnectorContext,
  createHttpClient,
  type RawItem,
  type SourceAdapter,
  type SyncInput,
  type SyncResult,
} from '@unicontext/connector-sdk';
import {
  ConnectorError,
  DEFAULT_TIMEZONE,
  errorMessage,
  zonedParts,
  zonedTime,
} from '@unicontext/core';
import { normalizeText, titleSimilarity } from '@unicontext/identity';
import { resolveDeployment } from '../profiles/index.js';
import { HttpSession } from '../session.js';
import { inferYear, parseCancellations, type CancellationRow } from './parse.js';
import {
  CANCELLATION_TYPE,
  CANCELLATIONS_PRODUCT,
  type CancellationPayload,
  type CancellationsConfig,
  type UserCourse,
  UserCourseSchema,
} from './types.js';

/** Supplies the user's courses (host-injected, e.g. from the livecampusu timetable). */
export type UserCourseProvider = () => Promise<readonly UserCourse[]> | readonly UserCourse[];

export interface CancellationsAdapterOptions {
  courseProvider?: UserCourseProvider;
}

const pad = (n: number): string => String(n).padStart(2, '0');

function classLabelsMatch(wanted: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const a = normalizeText(wanted);
  const b = normalizeText(actual);
  return a === b || a.includes(b) || b.includes(a);
}

/** Best matching user course for a row, or undefined. */
export function matchUserCourse(
  row: Pick<CancellationRow, 'courseTitle' | 'className'>,
  courses: readonly UserCourse[],
  threshold: number,
): UserCourse | undefined {
  let best: { course: UserCourse; score: number } | undefined;
  for (const course of courses) {
    const score = titleSimilarity(row.courseTitle, course.title);
    if (score < threshold) continue;
    if (course.classCode && !classLabelsMatch(course.classCode, row.className)) continue;
    if (!best || score > best.score) best = { course, score };
  }
  return best?.course;
}

/**
 * Public 休講案内 (whole university, no login). Every row becomes a raw item; the user's own
 * courses are marked (`matched`) so the normalizer can also emit cancelled class sessions.
 */
export class CancellationsAdapter implements SourceAdapter {
  readonly id = 'lcu-public-cancellations';
  readonly version = '1.0.0';
  /** Host-injected course feed; may be assigned after construction by the daemon. */
  courseProvider: UserCourseProvider | undefined;
  private readonly session: HttpSession;
  private readonly url: string;
  private readonly timezone: string;
  private lastSuccessAt: string | undefined;
  private lastError: string | undefined;
  private consecutiveFailures = 0;

  constructor(
    private readonly ctx: ConnectorContext<CancellationsConfig>,
    options: CancellationsAdapterOptions = {},
  ) {
    const deployment = resolveDeployment(
      ctx.config,
      ctx.profile?.products[CANCELLATIONS_PRODUCT] ?? ctx.profile?.products['syllabus'],
      { requireScreens: ['publicCancellations'] },
    );
    this.url = `${deployment.baseUrl}${deployment.screens.publicCancellations}`;
    this.courseProvider = options.courseProvider;
    this.timezone = ctx.profile?.academicCalendar.timezone ?? DEFAULT_TIMEZONE;
    const http = createHttpClient({
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
      rateLimiter: ctx.rateLimiter,
      clock: ctx.clock,
    });
    this.session = new HttpSession(http, deployment.baseUrl);
  }

  capabilities(): Promise<Capability[]> {
    return Promise.resolve(['timetable', 'announcements']);
  }

  authenticate(): Promise<AuthResult> {
    return Promise.resolve({ status: 'not_required' });
  }

  health(): Promise<HealthStatus> {
    return Promise.resolve({
      state: this.lastError ? (this.consecutiveFailures >= 3 ? 'failed' : 'degraded') : 'healthy',
      checkedAt: this.ctx.clock.now().toISOString(),
      ...(this.lastError ? { message: this.lastError } : {}),
      ...(this.lastSuccessAt ? { lastSuccessAt: this.lastSuccessAt } : {}),
      ...(this.consecutiveFailures ? { consecutiveFailures: this.consecutiveFailures } : {}),
    });
  }

  dispose(): Promise<void> {
    this.session.reset();
    return Promise.resolve();
  }

  /**
   * The user's courses. A failing provider fails the run: storing the rows without their `matched`
   * marks would delete the user's cancelled class sessions until the next good run.
   */
  private async userCourses(): Promise<UserCourse[]> {
    const courses = [...this.ctx.config.courses];
    if (this.courseProvider) {
      let provided: readonly UserCourse[];
      try {
        provided = await this.courseProvider();
      } catch (e) {
        throw new ConnectorError(`courseProvider failed: ${errorMessage(e)}`, { cause: e });
      }
      for (const c of provided) {
        const parsed = UserCourseSchema.safeParse(c);
        if (parsed.success) courses.push(parsed.data);
      }
    }
    return courses;
  }

  async sync(input: SyncInput): Promise<SyncResult> {
    const warnings: string[] = [];
    try {
      const res = await this.session.exclusive(() => this.session.fetch(this.url));
      const parsed = parseCancellations(res.html);
      if (!parsed.recognized)
        throw new ConnectorError('The page is not the 休講案内 screen (layout changed?)');
      if (parsed.headerMismatch)
        throw new ConnectorError('The 休講案内 table has unexpected columns (layout changed?)');
      input.signal?.throwIfAborted();

      const now = this.ctx.clock.now();
      const asOf = parsed.asOf;
      if (!asOf)
        warnings.push('no "as of" timestamp on the page; using the current date for years');
      const asOfDate = asOf ?? zonedParts(now, this.timezone);
      const asOfIso = asOf
        ? zonedTime(
            {
              year: asOf.year,
              month: asOf.month,
              day: asOf.day,
              hour: asOf.hour,
              minute: asOf.minute,
            },
            this.timezone,
          ).toISOString()
        : now.toISOString();
      const courses = await this.userCourses();
      const threshold = this.ctx.config.matchThreshold;

      const byKey = new Map<string, RawItem>();
      for (const row of parsed.rows) {
        const year = inferYear(row.month, row.day, asOfDate);
        const date = `${year}-${pad(row.month)}-${pad(row.day)}`;
        const externalId = [row.courseTitle, row.className ?? '', date, row.period].join('|');
        const existing = byKey.get(externalId);
        if (existing) {
          // Same course/class/date/period listed twice (e.g. two teachers): merge teachers.
          const p = existing.payload as CancellationPayload;
          for (const t of row.instructors) if (!p.instructors.includes(t)) p.instructors.push(t);
          continue;
        }
        const matched = matchUserCourse(row, courses, threshold);
        const payload: CancellationPayload = {
          title: row.title,
          courseTitle: row.courseTitle,
          ...(row.className ? { className: row.className } : {}),
          dateText: `${pad(row.month)}/${pad(row.day)}`,
          date,
          period: row.period,
          ...(row.periodIndex !== undefined ? { periodIndex: row.periodIndex } : {}),
          instructors: [...row.instructors],
          ...(matched
            ? {
                matched: {
                  title: matched.title,
                  ...(matched.classCode ? { classCode: matched.classCode } : {}),
                },
              }
            : {}),
          url: this.url,
        };
        byKey.set(externalId, {
          sourceType: CANCELLATION_TYPE,
          externalId,
          payload,
          sourceUpdatedAt: asOfIso,
        });
      }
      this.lastError = undefined;
      this.consecutiveFailures = 0;
      this.lastSuccessAt = now.toISOString();
      return {
        items: [...byKey.values()],
        cursor: { lastModified: asOfIso },
        // The page is a full listing: rows that disappeared are marked deleted.
        complete: { sourceTypes: [CANCELLATION_TYPE] },
        ...(warnings.length ? { warnings } : {}),
      };
    } catch (e) {
      this.lastError = errorMessage(e);
      this.consecutiveFailures++;
      throw e;
    }
  }
}
