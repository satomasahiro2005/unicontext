import { type CheerioAPI, load } from 'cheerio';
import { cleanText, htmlText } from '../html.js';

export interface TableColumn {
  /** `th#id` when present (DataTables column id), else ''. */
  id: string;
  /** Visible header text. */
  label: string;
  hidden: boolean;
}

export interface TableRow {
  /** DataTables `_index` attribute (row index used by rowSelect/linkselect). */
  index: number | undefined;
  classes: string[];
  /** Cell text (with <br> as newline) keyed by column id or label. */
  cells: Record<string, string>;
  /** Raw inner HTML per column key. */
  html: Record<string, string>;
}

export interface ParsedTable {
  columns: TableColumn[];
  rows: TableRow[];
}

function columnKey(c: TableColumn, i: number): string {
  return c.id || c.label || `col${i}`;
}

/** Parse a server-rendered table (header `th` → cell `td` by position, hidden columns included). */
export function parseTable($: CheerioAPI, tableSelector: string): ParsedTable | undefined {
  const table = $(tableSelector).first();
  if (table.length === 0) return undefined;
  let headerCells = table.find('thead tr').first().children('th,td');
  if (headerCells.length === 0) headerCells = table.find('tr').first().children('th');
  const columns: TableColumn[] = headerCells
    .map((_, th) => ({
      id: $(th).attr('id') ?? '',
      label: cleanText(htmlText($(th).html()).replace(/\n/g, ' ')),
      hidden: $(th).attr('_visible') === 'false',
    }))
    .get();
  const bodyRows = table.find('tbody tr').length
    ? table.find('tbody tr')
    : table.find('tr').slice(1);
  const rows: TableRow[] = [];
  bodyRows.each((_, tr) => {
    const tds = $(tr).children('td');
    if (tds.length === 0) return;
    const cells: Record<string, string> = {};
    const html: Record<string, string> = {};
    tds.each((i, td) => {
      const col = columns[i];
      const key = col ? columnKey(col, i) : $(td).attr('data-label') || `col${i}`;
      const inner = $(td).html() ?? '';
      html[key] = inner.trim();
      cells[key] = htmlText(inner);
    });
    const idx = $(tr).attr('_index');
    rows.push({
      index: idx !== undefined && /^\d+$/.test(idx) ? Number(idx) : undefined,
      classes: ($(tr).attr('class') ?? '').split(/\s+/).filter(Boolean),
      cells,
      html,
    });
  });
  return { columns, rows };
}

export function parseTableHtml(html: string, tableSelector: string): ParsedTable | undefined {
  return parseTable(load(html), tableSelector);
}

/** Find a value by trying column keys (ids first, then labels containing a word). */
export function pick(row: TableRow, ...keys: string[]): string | undefined {
  for (const k of keys) {
    if (row.cells[k] !== undefined) return row.cells[k];
  }
  for (const k of keys) {
    const hit = Object.keys(row.cells).find((c) => c.includes(k));
    if (hit !== undefined) return row.cells[hit];
  }
  return undefined;
}
