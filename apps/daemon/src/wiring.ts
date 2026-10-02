import { isWatchable, supportsFileDownloads, type WatchHandle } from '@unicontext/connector-sdk';
import { mirrorFiles, type UniContext } from '@unicontext/context-engine';
import { errorMessage, type Logger, zonedParts } from '@unicontext/core';

/** Product name of the LiveCampusU connector (its metadata.product). */
export const LCU_PRODUCT = 'livecampusu';

/** One enrolled course as LiveCampusU lists it (getClassSubjectList / timetable). */
export interface EnrolledCourse {
  title: string;
  /** クラス名 as printed by LCU (e.g. "情"), matched against the 休講 page's "(クラス名)". */
  className?: string;
  subjectCode?: string;
  academicYear?: number;
}

/** Academic year (April start) of `now` in the given timezone. */
export function academicYearOf(now: Date, timezone: string): number {
  const p = zonedParts(now, timezone);
  return p.month >= 4 ? p.year : p.year - 1;
}

/**
 * The student's own courses from every registered LiveCampusU source: the CourseOfferings its
 * normalizer stored (they come from the enrolled-course list, so every one is the user's own).
 * Only the current academic year is used once LCU has data for it, so an old course with the same
 * title does not match this year's notices.
 */
export function enrolledCourses(uc: UniContext): EnrolledCourse[] {
  const lcuSources = uc.sync
    .sources()
    .filter((s) => s.metadata.product === LCU_PRODUCT)
    .map((s) => s.sourceId);
  const all: EnrolledCourse[] = [];
  for (const sourceId of lcuSources)
    for (const o of uc.sync.stores.entities.list('courseOffering', { sourceId })) {
      const className = (o.extra as { className?: unknown } | undefined)?.className;
      all.push({
        title: o.title,
        ...(typeof className === 'string' && className ? { className } : {}),
        ...(o.courseCode ? { subjectCode: o.courseCode } : {}),
        ...(o.academicYear !== undefined ? { academicYear: o.academicYear } : {}),
      });
    }
  const year = academicYearOf(uc.clock.now(), uc.timezone);
  const current = all.filter((c) => c.academicYear === year || c.academicYear === undefined);
  return current.some((c) => c.academicYear === year) ? current : all;
}

interface CourseFed {
  courseProvider?: unknown;
}
interface TargetFed {
  targetProvider?: unknown;
}

/**
 * Feed LiveCampusU's enrolled courses to the modules that filter by "my courses" (§54, research
 * §5): the public 休講 module (`courseProvider`) so own-course cancellations become cancelled class
 * sessions on Today, and the syllabus module (`targetProvider`) so it reads the syllabi of the
 * student's courses. Config `courses:` / `targets:` are still merged by the modules themselves.
 * Providers read the database at sync time, so a later LCU sync is picked up without rewiring.
 */
export function wireCourseProviders(uc: UniContext): string[] {
  const wired: string[] = [];
  for (const source of uc.sync.sources()) {
    const adapter = source.adapter as CourseFed & TargetFed;
    if (source.metadata.product === 'lcu-public-cancellations' && 'courseProvider' in adapter) {
      adapter.courseProvider = () =>
        enrolledCourses(uc).map((c) => ({
          title: c.title,
          ...(c.className ? { classCode: c.className } : {}),
        }));
      wired.push(source.sourceId);
    } else if (source.metadata.product === 'syllabus' && 'targetProvider' in adapter) {
      adapter.targetProvider = () => {
        const seen = new Set<string>();
        const targets: { year: number; subjectCode: string }[] = [];
        for (const c of enrolledCourses(uc)) {
          if (!c.subjectCode || c.academicYear === undefined) continue;
          const key = `${c.academicYear}|${c.subjectCode}`;
          if (seen.has(key)) continue;
          seen.add(key);
          targets.push({ year: c.academicYear, subjectCode: c.subjectCode });
        }
        return targets;
      };
      wired.push(source.sourceId);
    }
  }
  return wired;
}

/**
 * Start `watch()` on every event-driven source (local-files, chatgpt-record) and feed each result
 * into `SyncEngine.ingest`, one at a time per source. Returns the handles to close on shutdown.
 */
export async function startWatchers(uc: UniContext, logger: Logger): Promise<WatchHandle[]> {
  const handles: WatchHandle[] = [];
  for (const source of uc.sync.sources()) {
    const { adapter, sourceId } = source;
    if (!isWatchable(adapter)) continue;
    let queue: Promise<unknown> = Promise.resolve();
    try {
      handles.push(
        await adapter.watch({
          onResult: (result) => {
            queue = queue
              .then(() => uc.sync.ingest(sourceId, result))
              .catch((e: unknown) =>
                logger.warn('watch ingest failed', { sourceId, error: errorMessage(e) }),
              );
            return queue.then(() => undefined);
          },
          onError: (e) => logger.warn('watch error', { sourceId, error: errorMessage(e) }),
        }),
      );
    } catch (e) {
      logger.warn('watch not started', { sourceId, error: errorMessage(e) });
    }
  }
  return handles;
}

/**
 * After every successful sync of a source whose file mirror is enabled, run one mirror pass in the
 * background (new/changed files downloaded, removed ones moved to the trash). Never inside the
 * sync itself: the pass needs the source's lock to ingest the extracted texts.
 */
export function startFileMirror(
  uc: UniContext,
  filesDir: string,
  logger: Logger,
): { stop(): Promise<void> } {
  const abort = new AbortController();
  const running = new Set<Promise<unknown>>();
  const off = uc.bus.on('sync:completed', (report) => {
    if (!report.ok || abort.signal.aborted) return;
    let adapter;
    try {
      adapter = uc.sync.getSource(report.sourceId).adapter;
    } catch {
      return;
    }
    if (!supportsFileDownloads(adapter) || !adapter.fileSettings().mirror?.enabled) return;
    const run = new Promise((resolve) => setImmediate(resolve))
      .then(() => mirrorFiles(uc, { filesDir, sourceId: report.sourceId, signal: abort.signal }))
      .then((r) => {
        for (const s of r.sources)
          if (s.downloaded || s.trashed || s.renamed || s.failed)
            logger.info('file mirror pass', { ...s, root: undefined });
        for (const w of r.warnings) logger.warn('file mirror', { warning: w });
      })
      .catch((e: unknown) => logger.warn('file mirror pass failed', { error: errorMessage(e) }))
      .finally(() => running.delete(run));
    running.add(run);
  });
  return {
    async stop() {
      off();
      abort.abort();
      await Promise.allSettled([...running]);
    },
  };
}
