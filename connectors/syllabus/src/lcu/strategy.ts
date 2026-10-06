import { ConnectorError } from '@unicontext/core';
import { type HttpSession, SessionExpiredError } from '../session.js';
import type { LcuDeployment } from '../profiles/index.js';
import type { SyllabusDetailResult, SyllabusStrategy } from '../strategy.js';
import type {
  SyllabusSearch,
  SyllabusSearchResult,
  SyllabusSearchRow,
  SyllabusTarget,
  SyllabusUnit,
} from '../types.js';
import { isErrorPage, parseCsrf, parseDetail, parseResults, yearOfTitle } from './parse.js';

/** Fields of the search form (docs/research/shizuoka.md §3). */
export const SEARCH_FIELDS = [
  'title',
  'category',
  'jikanwariSubjectName',
  'staffName',
  'practitionerFlag',
  'semester',
  'term',
  'subjectCode',
  'numbering',
  'subjectName',
  'subjectType',
  'week',
  'period',
  'freeword',
] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number];

interface Query {
  fields: Record<SearchField, string>;
  year: number | undefined;
  /** Exact subject code filter (targets). */
  subjectCode: string | undefined;
  classCode: string | undefined;
  maxRows: number;
}

/** Strategy-private handle stored in SyllabusSearchRow.handle. */
interface RowHandle {
  query: Query;
  queryKey: string;
  index: number;
  titleCode: string | undefined;
}

interface View {
  csrf: string | undefined;
  /** What the server currently shows for this session. */
  screen: 'none' | 'results' | 'detail';
  queryKey?: string;
  /** Hidden inputs of the result form (replayed on linkselect). */
  formInputs?: Record<string, string>;
  /** Keys of the rows on the current result screen, by `_index`. */
  rowKeys?: Map<string, number>;
}

const STATE_KEY = 'lcu-public';

export interface LcuPublicOptions {
  deployment: LcuDeployment;
}

function normKey(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function classMatches(
  wanted: string,
  className: string,
  rowClassCode: string | undefined,
): boolean {
  const w = normKey(wanted).replace(/クラス$/, '');
  const c = normKey(className).replace(/クラス$/, '');
  return w === c || (rowClassCode !== undefined && normKey(rowClassCode) === w);
}

/**
 * LiveCampusU public syllabus (no login). One session = one JSESSIONID; every step replays the
 * server's PRG flow with the `_csrf` of the latest HTML:
 *   GET  <screen>/init            -> 302 -> GET <screen>          (cookie + csrf)
 *   POST <screen>/search          -> 302 -> GET <screen>          (#dataTable01)
 *   POST <screen>/linkselect      -> 302 -> GET <detail screen>   (syllabus detail)
 * There is no fixed URL for one course: the detail depends on the previous search of the same
 * session, so a detail is always "search, then linkselect" (re-searching when the session
 * already moved on to a detail screen).
 */
export class LcuPublicStrategy implements SyllabusStrategy {
  readonly id = 'lcu-public';
  readonly baseUrl: string;
  private readonly search_: string;

  constructor(private readonly options: LcuPublicOptions) {
    this.baseUrl = options.deployment.baseUrl;
    this.search_ = `${this.baseUrl}${options.deployment.screens.syllabusSearch}`;
  }

  private view(session: HttpSession): View {
    let v = session.state.get(STATE_KEY) as View | undefined;
    if (!v) {
      v = { csrf: undefined, screen: 'none' };
      session.state.set(STATE_KEY, v);
    }
    return v;
  }

  titleCodeFor(year: number, faculty: string): string | undefined {
    return this.options.deployment.titles[String(year)]?.[faculty];
  }

  generalEducationFor(faculty: string): string | undefined {
    return this.options.deployment.generalEducation?.[faculty];
  }

  yearOfTitleCode(titleCode: string): number | undefined {
    for (const [year, codes] of Object.entries(this.options.deployment.titles))
      if (Object.values(codes).includes(titleCode) && /^\d+$/.test(year)) return Number(year);
    return undefined;
  }

  private titleCode(year: number | undefined, faculty: string | undefined): string | undefined {
    if (year === undefined || !faculty) return undefined;
    return this.titleCodeFor(year, faculty);
  }

  private queryFor(unit: SyllabusUnit): Query {
    const fields = Object.fromEntries(SEARCH_FIELDS.map((f) => [f, ''])) as Record<
      SearchField,
      string
    >;
    if (unit.kind === 'target') {
      const t: SyllabusTarget = unit.target;
      fields.title = t.titleCode ?? this.titleCode(t.year, t.faculty) ?? '';
      fields.subjectCode = t.subjectCode;
      return {
        fields,
        year: t.year,
        subjectCode: t.subjectCode,
        classCode: t.classCode,
        maxRows: 20,
      };
    }
    if (unit.kind === 'catalog') {
      const c = unit.catalog;
      fields.title = c.titleCode;
      fields.semester = c.semester;
      return {
        fields,
        year: c.year,
        subjectCode: undefined,
        classCode: undefined,
        maxRows: c.maxRows,
      };
    }
    const s: SyllabusSearch = unit.search;
    for (const f of SEARCH_FIELDS) {
      const v = s[f as keyof SyllabusSearch];
      if (typeof v === 'string') fields[f] = v;
    }
    if (!fields.title) fields.title = this.titleCode(s.year, s.faculty) ?? '';
    return {
      fields,
      year: s.year,
      subjectCode: undefined,
      classCode: undefined,
      maxRows: s.maxRows,
    };
  }

  private async openForm(session: HttpSession): Promise<View> {
    const v = this.view(session);
    const res = await session.fetch(`${this.search_}/init`);
    if (isErrorPage(res.html)) throw new SessionExpiredError('init returned an error screen');
    const csrf = parseCsrf(res.html);
    if (!csrf)
      throw new ConnectorError(
        `Syllabus search form has no _csrf (screen ${this.options.deployment.screens.syllabusSearch} changed?)`,
      );
    v.csrf = csrf;
    v.screen = 'none';
    return v;
  }

  /** init -> POST search -> results. Updates the session view. */
  private async runSearch(
    session: HttpSession,
    query: Query,
  ): Promise<{ rows: { index: number; columns: Record<string, string> }[]; warnings: string[] }> {
    const v = await this.openForm(session);
    const res = await session.fetch(`${this.search_}/search`, {
      method: 'POST',
      form: { ...query.fields, _csrf: v.csrf ?? '' },
    });
    if (isErrorPage(res.html)) throw new SessionExpiredError('search returned an error screen');
    const parsed = parseResults(res.html);
    const warnings: string[] = [];
    v.csrf = parsed.csrf ?? v.csrf;
    v.screen = 'results';
    v.queryKey = JSON.stringify(query.fields);
    v.formInputs = parsed.formInputs;
    if (!parsed.hasTable) {
      // A page with neither the table nor the search form is not the syllabus screen.
      if (!parseCsrf(res.html))
        throw new ConnectorError('Syllabus search result screen has neither a table nor a form');
      v.rowKeys = new Map();
      return { rows: [], warnings };
    }
    const first = parsed.rows[0];
    if (first && !('科目コード' in first.columns))
      warnings.push('result table has no 科目コード column (layout changed?)');
    v.rowKeys = new Map(parsed.rows.map((r) => [rowKey(r.columns), r.index] as const).reverse());
    return { rows: parsed.rows, warnings };
  }

  /** Retry once with a fresh session when the server shows its error screen. */
  private async recovering<T>(session: HttpSession, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof SessionExpiredError)) throw e;
      session.reset();
      return fn();
    }
  }

  search(unit: SyllabusUnit, session: HttpSession): Promise<SyllabusSearchResult> {
    const query = this.queryFor(unit);
    return session.exclusive(() =>
      this.recovering(session, async () => {
        const { rows, warnings } = await this.runSearch(session, query);
        const merged = new Map<string, SyllabusSearchRow>();
        const queryKey = JSON.stringify(query.fields);
        for (const r of rows) {
          const c = r.columns;
          const subjectCode = c['科目コード'] ?? '';
          const className = c['クラス'] ?? '';
          const title = c['タイトル'] ?? '';
          if (!subjectCode) continue;
          const year = yearOfTitle(title);
          if (query.subjectCode && normKey(subjectCode) !== normKey(query.subjectCode)) continue;
          if (query.year !== undefined && year !== undefined && year !== query.year) continue;
          if (query.classCode && !classMatches(query.classCode, className, c['classCode']))
            continue;
          const key = rowKey(c);
          const category = c['カテゴリ'] ?? '';
          const existing = merged.get(key);
          if (existing) {
            if (category && !existing.categories.includes(category))
              existing.categories.push(category);
            continue;
          }
          merged.set(key, {
            key,
            subjectCode,
            className,
            title,
            year,
            categories: category ? [category] : [],
            columns: c,
            url: `${this.search_}/init`,
            ...(query.fields.title ? { titleCode: query.fields.title } : {}),
            handle: {
              query,
              queryKey,
              index: r.index,
              titleCode: query.fields.title || undefined,
            } satisfies RowHandle,
          });
        }
        const out = [...merged.values()];
        if (out.length === 0)
          warnings.push(
            unit.kind === 'target'
              ? `no syllabus found for ${unit.target.year}/${unit.target.subjectCode}`
              : 'search returned no rows',
          );
        let truncated = false;
        if (out.length > query.maxRows) {
          warnings.push(`search returned ${out.length} rows, limited to ${query.maxRows}`);
          out.length = query.maxRows;
          truncated = true;
        }
        return { rows: out, warnings, ...(truncated ? { truncated } : {}) };
      }),
    );
  }

  detail(row: SyllabusSearchRow, session: HttpSession): Promise<SyllabusDetailResult | undefined> {
    const handle = row.handle as RowHandle;
    return session.exclusive(() =>
      this.recovering(session, async () => {
        const warnings: string[] = [];
        let v = this.view(session);
        if (v.screen !== 'results' || v.queryKey !== handle.queryKey) {
          const re = await this.runSearch(session, handle.query);
          warnings.push(...re.warnings);
          v = this.view(session);
        }
        // The row may sit at another index after a re-search: find it again by identity.
        const index = v.rowKeys?.get(row.key) ?? handle.index;
        if (!v.rowKeys?.has(row.key)) {
          warnings.push(`row ${row.key} not found in the repeated search; skipped`);
          return undefined;
        }
        const res = await session.fetch(`${this.search_}/linkselect`, {
          method: 'POST',
          form: {
            ...(v.formInputs ?? {}),
            rowIndex: String(index),
            viewRowIndexArray: v.formInputs?.['viewRowIndexArray'] ?? '',
            _csrf: v.formInputs?.['_csrf'] || v.csrf || '',
          },
        });
        v.screen = 'detail';
        if (isErrorPage(res.html))
          throw new SessionExpiredError('linkselect returned an error screen');
        const csrf = parseCsrf(res.html);
        if (csrf) v.csrf = csrf;
        const parsed = parseDetail(res.html);
        if (parsed.recognized === 0)
          throw new ConnectorError(
            `Syllabus detail screen not recognized (${this.options.deployment.screens.syllabusDetail} changed?)`,
          );
        return {
          detail: parsed.detail,
          url: `${this.search_}/init`,
          ...(handle.titleCode ? { titleCode: handle.titleCode } : {}),
          warnings,
        };
      }),
    );
  }
}

/** Dedupe key of a result row: subject code + class + title (research §3). */
export function rowKey(columns: Record<string, string>): string {
  return [columns['科目コード'] ?? '', columns['クラス'] ?? '', columns['タイトル'] ?? '']
    .map(normKey)
    .join('|');
}
