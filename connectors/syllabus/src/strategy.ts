import type { HttpSession } from './session.js';
import type {
  SyllabusDetail,
  SyllabusSearchResult,
  SyllabusSearchRow,
  SyllabusUnit,
} from './types.js';

/** What a strategy returns for one opened syllabus. */
export interface SyllabusDetailResult {
  detail: SyllabusDetail;
  /** URL a human can open to reach the syllabus (search entry point when no fixed URL exists). */
  url: string;
  /** The form `title` value used to reach it, when known. */
  titleCode?: string;
  warnings: string[];
}

/**
 * How one syllabus system is read. A strategy knows the screens of a system; the adapter only
 * decides WHICH courses to look up (targets / searches) and calls `search` then `detail`
 * sequentially (one request at a time per session).
 */
export interface SyllabusStrategy {
  readonly id: string;
  /** Site root; the session only talks to this origin. */
  readonly baseUrl: string;
  /** Search form `title` value for a year x faculty code, when the system has such a table. */
  titleCodeFor?(year: number, faculty: string): string | undefined;
  /** Reverse of `titleCodeFor`: the academic year a title value belongs to, when known. */
  yearOfTitleCode?(titleCode: string): number | undefined;
  /** Find candidate rows for a target or a search. Never opens details. */
  search(unit: SyllabusUnit, session: HttpSession): Promise<SyllabusSearchResult>;
  /** Open one row (as returned by `search`) and parse its syllabus. */
  detail(row: SyllabusSearchRow, session: HttpSession): Promise<SyllabusDetailResult | undefined>;
}
