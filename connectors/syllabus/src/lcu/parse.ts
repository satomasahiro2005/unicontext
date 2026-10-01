import { load, type CheerioAPI } from 'cheerio';
import { parseDayPeriod } from '../schedule.js';
import type { SyllabusDetail } from '../types.js';

export { parseDayPeriod };

type Selection = ReturnType<CheerioAPI>;

/* HTML parsers for the public LiveCampusU syllabus screens (SC_06001B00_21 / _22). */

export function cleanBlock(s: string): string {
  return s
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t\r]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Text of an element with <br> turned into line breaks and whitespace normalized. */
export function textOf(el: Selection): string {
  const clone = el.clone();
  clone.find('br').replaceWith('\n');
  return cleanBlock(clone.text());
}

function key(label: string): string {
  return label.normalize('NFKC').replace(/\s+/g, '');
}

export function parseCsrf(html: string): string | undefined {
  const value = load(html)('input[name="_csrf"]').first().attr('value');
  return value && value.length > 0 ? value : undefined;
}

/** The server's generic failure screen (session expired, double submit, stale csrf). */
export function isErrorPage(html: string): boolean {
  const $ = load(html);
  const title = $('title').first().text().trim();
  return /^(error|エラー)/i.test(title) || html.includes('処理を続行することができませんでした');
}

export interface ParsedResultRow {
  /** `_index` of the <tr>: the value `linkselect` expects as `rowIndex`. */
  index: number;
  columns: Record<string, string>;
}

export interface ParsedResults {
  /** False when the result table is absent (no hits, or an unexpected screen). */
  hasTable: boolean;
  rows: ParsedResultRow[];
  csrf: string | undefined;
  /** Hidden inputs of the result form (rowIndex, viewRowIndexArray, _csrf) to replay on linkselect. */
  formInputs: Record<string, string>;
}

/** Parse `#dataTable01` of the search result screen. */
export function parseResults(html: string): ParsedResults {
  const $ = load(html);
  const csrf = parseCsrf(html);
  const formInputs: Record<string, string> = {};
  $('#TableForm input[name]').each((_, el) => {
    const name = $(el).attr('name');
    if (name) formInputs[name] = $(el).attr('value') ?? '';
  });
  const table = $('#dataTable01');
  if (table.length === 0) return { hasTable: false, rows: [], csrf, formInputs };
  const ids = table
    .find('thead th')
    .map((_, th) => $(th).attr('id') ?? '')
    .get();
  const rows: ParsedResultRow[] = [];
  table.find('tbody tr').each((position, tr) => {
    const attr = $(tr).attr('_index');
    const index = attr !== undefined && /^\d+$/.test(attr) ? Number(attr) : position;
    const columns: Record<string, string> = {};
    $(tr)
      .children('td')
      .each((i, td) => {
        const label = $(td).attr('data-label') || ids[i] || `col${i}`;
        columns[label] = textOf($(td));
      });
    rows.push({ index, columns });
  });
  return { hasTable: true, rows, csrf, formInputs };
}

/** "データベース論\n（Database）" -> { ja, en }. */
export function splitBilingual(text: string): { ja: string; en: string | undefined } {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  if (lines.length >= 2 && last && /^[（(].*[）)]$/.test(last))
    return { ja: lines.slice(0, -1).join(' '), en: last.slice(1, -1).trim() };
  const joined = lines.join(' ');
  const m = /^(.*?)\s*[（(]([A-Za-z][^（()）]*)[）)]$/.exec(joined);
  if (m?.[1]) return { ja: m[1].trim(), en: m[2]?.trim() };
  return { ja: joined, en: undefined };
}

export function splitNames(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(/[、,，／/\n]/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function emptyDetail(): SyllabusDetail {
  return {
    instructors: [],
    instructorsEn: [],
    coInstructors: [],
    slots: [],
    keywords: [],
    plan: [],
    activeLearning: [],
    practicalExperience: [],
    delivery: [],
    extra: {},
  };
}

export interface ParsedDetail {
  detail: SyllabusDetail;
  /** Number of labels/sections the parser knew; 0 means the screen layout changed. */
  recognized: number;
  /** "タイトル「…」、カテゴリ「…」" description under the heading, when present. */
  description: string | undefined;
}

const MARK = /[●◯○]/;

type Rows = Record<string, string>[];

interface Section {
  heading: string;
  headers: string[];
  rows: Rows;
  text: string;
}

function readSections($: CheerioAPI): Section[] {
  const out: Section[] = [];
  $('div.c-expand.-small').each((_, el) => {
    const sec = $(el);
    const heading = textOf(sec.find('h3').first());
    const table = sec.find('table.c-table').first();
    const headers = table
      .find('thead th')
      .map((_i, th) => textOf($(th)))
      .get();
    const rows: Rows = [];
    if (headers.length > 0) {
      table.find('tbody tr').each((_i, tr) => {
        const row: Record<string, string> = {};
        $(tr)
          .children('td')
          .each((i, td) => {
            row[$(td).attr('data-label') || headers[i] || `col${i}`] = textOf($(td));
          });
        rows.push(row);
      });
    }
    const text = headers.length > 0 ? '' : textOf(table.find('tbody td').first());
    out.push({ heading, headers, rows, text });
  });
  return out;
}

type TextField =
  | 'goals'
  | 'content'
  | 'planNote'
  | 'prerequisites'
  | 'textbook'
  | 'references'
  | 'preparation'
  | 'evaluation'
  | 'officeHours'
  | 'message'
  | 'practicalExperienceNote'
  | 'teacherTraining'
  | 'onlineDetail';

/** Section heading (NFKC, no spaces) prefix -> plain text field. */
const TEXT_SECTIONS: [string, TextField][] = [
  ['授業の目標', 'goals'],
  ['学修内容', 'content'],
  ['授業計画', 'planNote'],
  ['受講要件', 'prerequisites'],
  ['テキスト', 'textbook'],
  ['参考書', 'references'],
  ['予習・復習', 'preparation'],
  ['成績評価', 'evaluation'],
  ['オフィスアワー', 'officeHours'],
  ['担当教員からのメッセージ', 'message'],
  ['実務経験のある教員の経歴', 'practicalExperienceNote'],
  ['教職科目区分', 'teacherTraining'],
  ['オンライン授業', 'onlineDetail'],
];

function markedRows(rows: Rows, column: string): string[] {
  return rows
    .filter((r) => MARK.test(r['対象'] ?? ''))
    .map((r) => r[column] ?? '')
    .filter(Boolean);
}

/** Parse the syllabus detail screen (SC_06001B00_22). */
export function parseDetail(html: string): ParsedDetail {
  const $ = load(html);
  const detail = emptyDetail();
  let recognized = 0;
  const extra = detail.extra;

  // Top table: skip the duplicated print layout (its headers carry *InPrint classes).
  $('table.c-table-line tr').each((_, tr) => {
    const th = $(tr).children('th').first();
    if (th.length === 0 || /InPrint/.test(th.attr('class') ?? '')) return;
    const rawLabel = textOf(th);
    const label = key(rawLabel);
    const value = textOf($(tr).children('td').first());
    switch (label) {
      case '科目ナンバリング':
      case 'ナンバリング':
        if (value) detail.numbering = value;
        break;
      case '授業科目名(英文)':
      case '授業科目名': {
        const { ja, en } = splitBilingual(value);
        if (ja) detail.name = ja;
        if (en) detail.nameEn = en;
        break;
      }
      case 'クラス':
        if (value) detail.className = value;
        break;
      case '担当教員名(英文)':
      case '担当教員名': {
        const { ja, en } = splitBilingual(value);
        detail.instructors = splitNames(ja);
        detail.instructorsEn = splitNames(en);
        break;
      }
      case '所属':
        if (value) detail.department = value;
        break;
      case '研究室':
        if (value) detail.laboratory = value;
        break;
      case '分担教員名':
        detail.coInstructors = splitNames(value);
        break;
      case '対象学年':
        if (value) detail.grade = value;
        break;
      case '開講キャンパス':
        if (value) detail.campus = value;
        break;
      case '開講学期':
        if (value) detail.semester = value;
        break;
      case '開講時期':
        if (value) detail.termSpan = value;
        break;
      case '曜日・時限':
        if (value) {
          detail.dayPeriod = value;
          detail.slots = parseDayPeriod(value);
        }
        break;
      case '教室':
      case '講義室':
        if (value) detail.room = value;
        break;
      case '必修選択区分':
        if (value) detail.requirement = value;
        break;
      case '単位数': {
        const n = Number(value.normalize('NFKC'));
        if (value && Number.isFinite(n)) detail.credits = n;
        else if (value) extra[rawLabel] = value;
        break;
      }
      default:
        if (value) extra[rawLabel] = value;
        return;
    }
    recognized++;
  });

  const description = textOf($('p.c-heading-description').first()) || undefined;

  for (const sec of readSections($)) {
    const k = key(sec.heading);
    if (sec.headers.length === 2 && sec.headers[0] === '回' && sec.headers[1] === '内容') {
      detail.plan = sec.rows
        .map((r) => ({ no: r['回'] ?? '', content: r['内容'] ?? '' }))
        .filter((r) => r.content !== '');
      recognized++;
      continue;
    }
    const textField = TEXT_SECTIONS.find(([prefix]) => k.startsWith(prefix))?.[1];
    if (textField) {
      if (sec.text) detail[textField] = sec.text;
    } else if (k.startsWith('キーワード')) {
      detail.keywords = sec.rows.map((r) => r['キーワード'] ?? '').filter(Boolean);
    } else if (k.startsWith('アクティブ・ラーニング')) {
      detail.activeLearning = sec.rows
        .filter((r) => MARK.test(r['対象'] ?? ''))
        .map((r) => ({ type: r['種別'] ?? '', ...(r['補足説明'] ? { note: r['補足説明'] } : {}) }));
    } else if (k.startsWith('実務経験のある教員の有無')) {
      detail.practicalExperience = markedRows(sec.rows, '内容');
    } else if (k.startsWith('授業実施形態')) {
      detail.delivery = markedRows(sec.rows, '形態');
    } else {
      if (sec.heading && (sec.text || sec.rows.length > 0))
        extra[sec.heading] =
          sec.text || sec.rows.map((r) => Object.values(r).filter(Boolean).join(' / ')).join('\n');
      continue;
    }
    recognized++;
  }
  return { detail, recognized, description };
}

/** Extract the academic year from a title such as "2026年度 情報学部 [IN-B]". */
export function yearOfTitle(title: string): number | undefined {
  const m = /(\d{4})\s*年度/.exec(title.normalize('NFKC'));
  return m ? Number(m[1]) : undefined;
}
