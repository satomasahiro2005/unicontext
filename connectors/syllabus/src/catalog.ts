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

/**
 * Resolve the configured terms (`current` / `next` / `year` / explicit) against the clock,
 * deduplicated. `year` = 前期 and 後期 of the academic year that runs at `now`.
 */
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
    else if (t === 'year') {
      add({ year: current.year, semester: '1' });
      add({ year: current.year, semester: '2' });
    } else add({ year: t.year, semester: t.semester });
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
  /** Row keys a user asked for that could not be read on the spot: opened first by the next run. */
  requested: z.record(z.string(), z.string()).optional(),
});

/**
 * Parsed syllabus details by row key, so a daily run only opens the few details that are missing
 * or old. Persisted as one JSON file under the source's cache directory (written atomically:
 * tmp file + rename); without a directory it only lives as long as the adapter.
 */
export class DetailCache {
  private entries = new Map<string, CachedDetail>();
  /** Row key -> ISO time it was queued (on-demand fetch that could not run). */
  private requested = new Map<string, string>();
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
      for (const [key, at] of Object.entries(file.data.requested ?? {}))
        if (!Number.isNaN(Date.parse(at))) this.requested.set(key, at);
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
    this.requested.delete(key);
    this.dirty = true;
  }

  /** Queue a row the user asked for (it is opened before every other row by the next run). */
  request(key: string, at: string): void {
    if (this.requested.has(key)) return;
    this.requested.set(key, at);
    this.dirty = true;
  }

  isRequested(key: string): boolean {
    return this.requested.has(key);
  }

  get requestedKeys(): string[] {
    return [...this.requested.keys()];
  }

  /** Forget every entry whose key is not in `keep` (rows the source no longer lists). */
  prune(keep: ReadonlySet<string>): number {
    let removed = 0;
    for (const key of [...this.entries.keys()])
      if (!keep.has(key)) {
        this.entries.delete(key);
        removed++;
      }
    for (const key of [...this.requested.keys()])
      if (!keep.has(key)) {
        this.requested.delete(key);
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
        JSON.stringify({
          version: 1,
          entries: Object.fromEntries(this.entries),
          ...(this.requested.size ? { requested: Object.fromEntries(this.requested) } : {}),
        }),
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
 * Detail priority of a catalog row, smallest first: rows a user asked for on the spot, then the
 * student's own courses, courses they still need for graduation, their department's electives,
 * the campus 全学教育 listing, and everything else.
 */
export const DETAIL_RANK = {
  requested: 0,
  enrolled: 1,
  needed: 2,
  department: 3,
  generalEducation: 4,
  other: 5,
} as const;
export type DetailRankName = keyof typeof DETAIL_RANK;

/** A row whose detail is missing or stale, waiting for the run's detail budget. */
export interface DetailCandidate {
  key: string;
  rank: number;
  /** Index of the catalog listing the row came from (round-robin between listings). */
  unit: number;
  /** ISO time of the cached (stale) detail; undefined = never fetched. */
  fetchedAt?: string | undefined;
}

/**
 * The order in which candidates get the run's budget: by rank; within a rank never-fetched rows
 * before stale ones (stalest first); and the listings take turns, so one big faculty cannot starve
 * the others. Listing order is kept within a listing.
 */
export function orderDetailCandidates<C extends DetailCandidate>(candidates: readonly C[]): C[] {
  const groups = new Map<string, C[]>();
  for (const c of candidates) {
    const g = `${c.rank}|${c.fetchedAt === undefined ? 0 : 1}|${c.unit}`;
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  const turn = new Map<C, number>();
  for (const list of groups.values()) {
    const sorted =
      list[0]?.fetchedAt === undefined
        ? list
        : [...list].sort((a, b) => Date.parse(a.fetchedAt ?? '') - Date.parse(b.fetchedAt ?? ''));
    sorted.forEach((c, i) => turn.set(c, i));
  }
  return [...candidates].sort(
    (a, b) =>
      a.rank - b.rank ||
      (a.fetchedAt === undefined ? 0 : 1) - (b.fetchedAt === undefined ? 0 : 1) ||
      (turn.get(a) ?? 0) - (turn.get(b) ?? 0) ||
      a.unit - b.unit,
  );
}

/** True when a cached detail is younger than `maxAgeMs`. */
export function isFresh(cached: CachedDetail, nowMs: number, maxAgeMs: number): boolean {
  return nowMs - Date.parse(cached.fetchedAt) < maxAgeMs;
}
