import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage } from '@unicontext/core';
import { z } from 'zod';
import { type SyllabusCatalogTerm, type SyllabusDetail, SyllabusDetailSchema } from './types.js';

/** An academic term: Japanese academic year (April start) + semester (1 = 前期, 2 = 後期). */
export interface AcademicTerm {
  year: number;
  semester: '1' | '2';
}

export const SEMESTER_LABEL: Record<AcademicTerm['semester'], string> = {
  '1': '前期',
  '2': '後期',
};

function localYearMonth(now: Date, timeZone: string): { year: number; month: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
    }).formatToParts(now);
    const year = Number(parts.find((p) => p.type === 'year')?.value);
    const month = Number(parts.find((p) => p.type === 'month')?.value);
    if (Number.isFinite(year) && Number.isFinite(month)) return { year, month };
  } catch {
    // unknown time zone: fall through to UTC+9
  }
  const jst = new Date(now.getTime() + 9 * 3_600_000);
  return { year: jst.getUTCFullYear(), month: jst.getUTCMonth() + 1 };
}

/**
 * The term that runs at `now`: April-September = 前期 of that academic year, October-March =
 * 後期 (January-March still belongs to the academic year that began the previous April).
 * 2026-10-01 -> 2026 後期; 2026-05-10 -> 2026 前期; 2027-02-01 -> 2026 後期.
 */
export function currentTerm(now: Date, timeZone = 'Asia/Tokyo'): AcademicTerm {
  const { year, month } = localYearMonth(now, timeZone);
  if (month >= 4 && month <= 9) return { year, semester: '1' };
  if (month >= 10) return { year, semester: '2' };
  return { year: year - 1, semester: '2' };
}

/** The term after `t`: 前期 -> 後期 of the same year, 後期 -> 前期 of the next year. */
export function nextTerm(t: AcademicTerm): AcademicTerm {
  return t.semester === '1' ? { year: t.year, semester: '2' } : { year: t.year + 1, semester: '1' };
}

/** Resolve the configured terms (`current` / `next` / explicit) against the clock, deduplicated. */
export function resolveCatalogTerms(
  terms: readonly SyllabusCatalogTerm[],
  now: Date,
  timeZone = 'Asia/Tokyo',
): AcademicTerm[] {
  const current = currentTerm(now, timeZone);
  const out: AcademicTerm[] = [];
  const add = (t: AcademicTerm): void => {
    if (!out.some((o) => o.year === t.year && o.semester === t.semester)) out.push(t);
  };
  for (const t of terms) {
    if (t === 'current') add(current);
    else if (t === 'next') add(nextTerm(current));
    else add({ year: t.year, semester: t.semester });
  }
  return out;
}

/* ------------------------------------------------------------------------------------------ */

export interface CachedDetail {
  detail: SyllabusDetail;
  url: string;
  titleCode?: string;
  /** ISO time the detail page was read. */
  fetchedAt: string;
}

const CachedDetailSchema = z.object({
  detail: SyllabusDetailSchema,
  url: z.string(),
  titleCode: z.string().optional(),
  fetchedAt: z.string(),
});

const CacheFileSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), z.unknown()),
});

/**
 * Parsed syllabus details by row key, so a daily run only opens the few details that are missing
 * or old. Persisted as one JSON file under the source's cache directory (written atomically:
 * tmp file + rename); without a directory it only lives as long as the adapter.
 */
export class DetailCache {
  private entries = new Map<string, CachedDetail>();
  private loaded = false;
  private dirty = false;

  constructor(private readonly file: string | undefined) {}

  /** Read the file once; a missing, unreadable or invalid file (or entry) starts empty. */
  async load(): Promise<string[]> {
    if (this.loaded) return [];
    this.loaded = true;
    if (!this.file) return [];
    const warnings: string[] = [];
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        warnings.push(`syllabus detail cache unreadable: ${errorMessage(e)}`);
      return warnings;
    }
    try {
      const file = CacheFileSchema.safeParse(JSON.parse(text));
      if (!file.success) {
        warnings.push('syllabus detail cache has an unknown format; starting empty');
        return warnings;
      }
      let dropped = 0;
      for (const [key, value] of Object.entries(file.data.entries)) {
        const entry = CachedDetailSchema.safeParse(value);
        if (entry.success && !Number.isNaN(Date.parse(entry.data.fetchedAt)))
          this.entries.set(key, {
            detail: entry.data.detail,
            url: entry.data.url,
            ...(entry.data.titleCode ? { titleCode: entry.data.titleCode } : {}),
            fetchedAt: entry.data.fetchedAt,
          });
        else dropped++;
      }
      if (dropped) warnings.push(`syllabus detail cache: ${dropped} invalid entries dropped`);
    } catch (e) {
      warnings.push(`syllabus detail cache is not valid JSON (${errorMessage(e)}); starting empty`);
    }
    return warnings;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): CachedDetail | undefined {
    return this.entries.get(key);
  }

  set(key: string, entry: CachedDetail): void {
    this.entries.set(key, entry);
    this.dirty = true;
  }

  /** Forget every entry whose key is not in `keep` (rows the source no longer lists). */
  prune(keep: ReadonlySet<string>): number {
    let removed = 0;
    for (const key of [...this.entries.keys()])
      if (!keep.has(key)) {
        this.entries.delete(key);
        removed++;
      }
    if (removed) this.dirty = true;
    return removed;
  }

  /** Write the file if anything changed. Returns a warning when writing failed (never throws). */
  async save(): Promise<string | undefined> {
    if (!this.file || !this.dirty) return undefined;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(
        tmp,
        JSON.stringify({ version: 1, entries: Object.fromEntries(this.entries) }),
        'utf8',
      );
      await rename(tmp, this.file);
      this.dirty = false;
      return undefined;
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      return `syllabus detail cache not saved: ${errorMessage(e)}`;
    }
  }
}

/** File name of the detail cache inside the source's cache directory. */
export const DETAIL_CACHE_FILE = 'syllabus-details.json';

/**
 * Which stale-or-missing rows to open: rows never fetched first (in listing order), then the
 * stalest cached ones; at most `limit`.
 */
export function pickDetailsToOpen<R extends { key: string }>(
  rows: readonly R[],
  cache: Pick<DetailCache, 'get'>,
  nowMs: number,
  maxAgeMs: number,
  limit: number,
): Set<string> {
  if (limit <= 0) return new Set();
  const never: R[] = [];
  const stale: { row: R; at: number }[] = [];
  for (const row of rows) {
    const cached = cache.get(row.key);
    if (!cached) never.push(row);
    else {
      const at = Date.parse(cached.fetchedAt);
      if (nowMs - at >= maxAgeMs) stale.push({ row, at });
    }
  }
  stale.sort((a, b) => a.at - b.at);
  return new Set([...never, ...stale.map((s) => s.row)].slice(0, limit).map((r) => r.key));
}

/** True when a cached detail is younger than `maxAgeMs`. */
export function isFresh(cached: CachedDetail, nowMs: number, maxAgeMs: number): boolean {
  return nowMs - Date.parse(cached.fetchedAt) < maxAgeMs;
}
