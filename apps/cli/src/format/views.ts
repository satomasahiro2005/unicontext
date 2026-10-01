import type {
  AnnouncementItem,
  ChangeItem,
  ClassItem,
  ConflictItem,
  DeadlineItem,
  PreparationItem,
  TaskItem,
} from '@unicontext/context-engine';
import { formatDateJa, parseZonedDate } from '@unicontext/core';
import type {
  AssignmentItem,
  ChangesContext,
  CourseSummary,
  DeadlineContext,
  SearchResponse,
  SourceInfo,
  TodayContext,
  TomorrowContext,
  WeekContext,
} from '@unicontext/daemon/api-types';
import type { CliContext } from '../context.js';
import {
  citationText,
  CLASS_STATUS_LABELS,
  clockTime,
  colorState,
  distinctCandidates,
  KIND_LABELS,
  ORIGIN_LABELS,
  predicateLabel,
  remaining,
  resolvedText,
  shortTime,
  stateLabel,
  TASK_STATUS_LABELS,
  valueText,
} from './common.js';
import { renderTable, type TableColumn } from './table.js';

/** Print a table with the context's header style and a 2-space indent. */
export function printTable<Row>(
  ctx: CliContext,
  columns: readonly TableColumn<Row>[],
  rows: readonly Row[],
): void {
  for (const line of renderTable(columns, rows, {
    headerStyle: ctx.style.dim,
    indent: '  ',
  }))
    ctx.out(line);
}

export function printSection(ctx: CliContext, title: string, count?: number): void {
  ctx.out('');
  ctx.out(ctx.style.bold(count === undefined ? title : `${title}（${count}件）`));
}

function none(ctx: CliContext): void {
  ctx.out(`  ${ctx.style.dim('なし')}`);
}

// ---- conflicts ---------------------------------------------------------------------------------

/** Every candidate value with its source; the CLI never silently picks one (§12, §49). */
export function printConflict(ctx: CliContext, c: ConflictItem): void {
  const s = ctx.style;
  ctx.out(
    `  ${s.red(s.bold('競合'))} ${ctx.text(c.subjectLabel)}の${predicateLabel(c.predicate)}  ${s.dim(`ID: ${c.id}`)}`,
  );
  for (const cand of distinctCandidates(c.candidates)) {
    const source = ctx.text(cand.citation?.label ?? cand.source);
    ctx.out(
      `    - ${ctx.text(valueText(cand.value))}  ${source}  ${s.dim(`[${cand.origin} / ${cand.authority}]`)}`,
    );
  }
  ctx.out(
    `    ${s.dim(`情報源の間で食い違っています。確定するには「unicontext correct ${c.id} <値>」を実行してください`)}`,
  );
}

export function printConflicts(ctx: CliContext, conflicts: readonly ConflictItem[]): void {
  printSection(ctx, '競合', conflicts.length);
  if (conflicts.length === 0) return none(ctx);
  for (const c of conflicts) printConflict(ctx, c);
}

// ---- tables ------------------------------------------------------------------------------------

function classColumns(ctx: CliContext, tz: string): TableColumn<ClassItem>[] {
  return [
    { header: '時限', value: (c) => (c.period ? `${c.period}限` : '-') },
    {
      header: '時間',
      value: (c) => (c.startsAt ? `${clockTime(c.startsAt, tz)}-${clockTime(c.endsAt, tz)}` : '-'),
    },
    { header: '科目', value: (c) => ctx.text(c.course.title), max: 28 },
    {
      header: '教室',
      value: (c) => ctx.text(resolvedText(c.room)),
      style: (padded, c) => (c.room.status === 'conflict' ? ctx.style.red(padded) : padded),
    },
    {
      header: '状態',
      value: (c) => resolvedText(c.status, CLASS_STATUS_LABELS),
      style: (padded, c) => (c.cancelled ? ctx.style.red(padded) : padded),
    },
    { header: '根拠', value: (c) => ctx.text(citationText(c.citations, 1)) },
  ];
}

export function printClasses(ctx: CliContext, classes: readonly ClassItem[], tz: string): void {
  if (classes.length === 0) return none(ctx);
  printTable(ctx, classColumns(ctx, tz), classes);
}

function deadlineColumns(ctx: CliContext, tz: string): TableColumn<DeadlineItem>[] {
  return [
    { header: '期限', value: (d) => shortTime(d.dueAt, tz) },
    {
      header: '残り',
      value: (d) => remaining(d.hoursLeft),
      style: (padded, d) => (d.overdue ? ctx.style.red(padded) : padded),
    },
    { header: '内容', value: (d) => ctx.text(d.title), max: 40 },
    { header: '科目', value: (d) => ctx.text(d.course?.title), max: 22 },
    { header: '状態', value: (d) => TASK_STATUS_LABELS[d.status] },
    { header: '由来', value: (d) => ORIGIN_LABELS[d.origin] },
    { header: '根拠', value: (d) => ctx.text(citationText(d.citations, 1)) },
  ];
}

export function printDeadlines(
  ctx: CliContext,
  deadlines: readonly DeadlineItem[],
  tz: string,
): void {
  if (deadlines.length === 0) return none(ctx);
  printTable(ctx, deadlineColumns(ctx, tz), deadlines);
}

function printChanges(ctx: CliContext, changes: readonly ChangeItem[], tz: string): void {
  if (changes.length === 0) return none(ctx);
  printTable(
    ctx,
    [
      { header: '日時', value: (c) => shortTime(c.occurredAt, tz) },
      { header: '内容', value: (c) => ctx.text(c.summary), max: 72 },
      { header: '根拠', value: (c) => ctx.text(citationText(c.citations, 1)) },
    ],
    changes,
  );
}

function printTasks(ctx: CliContext, tasks: readonly TaskItem[], tz: string): void {
  if (tasks.length === 0) return none(ctx);
  printTable(
    ctx,
    [
      { header: '期限', value: (t) => shortTime(t.dueAt, tz) || '-' },
      { header: '内容', value: (t) => ctx.text(t.title), max: 40 },
      { header: '科目', value: (t) => ctx.text(t.course?.title), max: 22 },
      { header: '状態', value: (t) => TASK_STATUS_LABELS[t.status] },
      { header: '由来', value: (t) => ORIGIN_LABELS[t.origin] },
      { header: '根拠', value: (t) => ctx.text(citationText(t.citations, 1)) },
    ],
    tasks,
  );
}

function printAnnouncements(ctx: CliContext, items: readonly AnnouncementItem[], tz: string): void {
  if (items.length === 0) return none(ctx);
  printTable(
    ctx,
    [
      { header: '日時', value: (a) => shortTime(a.publishedAt, tz) },
      { header: '重要度', value: (a) => a.importance },
      { header: 'タイトル', value: (a) => ctx.text(a.title), max: 44 },
      { header: '科目', value: (a) => ctx.text(a.course?.title), max: 22 },
      { header: '根拠', value: (a) => ctx.text(citationText(a.citations, 1)) },
    ],
    items,
  );
}

function printPreparation(ctx: CliContext, items: readonly PreparationItem[], tz: string): void {
  if (items.length === 0) return none(ctx);
  for (const p of items) {
    ctx.out(
      `  ${ctx.text(p.course.title)}  ${clockTime(p.startsAt, tz)}  ${ctx.style.dim(citationText(p.citations, 1))}`,
    );
    for (const m of p.materials)
      ctx.out(`    資料: ${ctx.text(m.title)}  ${ctx.style.dim(citationText(m.citations, 1))}`);
    for (const d of p.dueBeforeClass)
      ctx.out(
        `    締切: ${ctx.text(d.title)}（${shortTime(d.dueAt, tz)}）  ${ctx.style.dim(citationText(d.citations, 1))}`,
      );
    for (const a of p.announcements)
      ctx.out(`    お知らせ: ${ctx.text(a.title)}  ${ctx.style.dim(citationText(a.citations, 1))}`);
  }
}

// ---- views -------------------------------------------------------------------------------------

export function printDay(
  ctx: CliContext,
  label: '今日' | '明日',
  b: TodayContext | TomorrowContext,
): void {
  const tz = b.timezone;
  ctx.out(
    ctx.style.bold(`${label}（${formatDateJa(parseZonedDate(b.date, tz), tz)}）`) +
      ctx.style.dim(`  （${shortTime(b.generatedAt, tz)}時点）`),
  );
  printSection(ctx, '授業', b.classes.length);
  printClasses(ctx, b.classes, tz);
  printConflicts(ctx, b.conflicts);
  printSection(ctx, '昨日からの変更', b.changes.length);
  printChanges(ctx, b.changes, tz);
  printSection(ctx, '締切', b.deadlines.length);
  printDeadlines(ctx, b.deadlines, tz);
  const listed = new Set(b.deadlines.map((d) => d.taskId));
  const others = b.tasks.filter((t) => !listed.has(t.taskId));
  printSection(ctx, 'その他のタスク', others.length);
  printTasks(ctx, others, tz);
  printSection(ctx, '大学からのお知らせ', b.importantAnnouncements.length);
  printAnnouncements(ctx, b.importantAnnouncements, tz);
  printSection(ctx, '授業の準備', b.preparation.length);
  printPreparation(ctx, b.preparation, tz);
}

export function printWeek(ctx: CliContext, b: WeekContext): void {
  const tz = b.timezone;
  // from/to are instants (to is exclusive); the days list carries the local dates to show
  const first = b.days[0]?.date;
  const last = b.days[b.days.length - 1]?.date;
  const fromText = first
    ? formatDateJa(parseZonedDate(first, tz), tz)
    : formatDateJa(new Date(b.from), tz);
  const toText = last
    ? formatDateJa(parseZonedDate(last, tz), tz)
    : formatDateJa(new Date(b.to), tz);
  ctx.out(ctx.style.bold(`今週（${fromText}〜${toText}）`));
  for (const day of b.days) {
    printSection(ctx, formatDateJa(parseZonedDate(day.date, tz), tz), day.classes.length);
    printClasses(ctx, day.classes, tz);
  }
  printSection(ctx, '締切', b.deadlines.length);
  printDeadlines(ctx, b.deadlines, tz);
  printSection(ctx, '試験', b.exams.length);
  printDeadlines(ctx, b.exams, tz);
  printSection(ctx, '変更', b.changes.length);
  printChanges(ctx, b.changes, tz);
  printConflicts(ctx, b.conflicts);
}

const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

export function printCourses(ctx: CliContext, courses: readonly CourseSummary[]): void {
  if (courses.length === 0) {
    ctx.out('科目はまだありません');
    return;
  }
  printTable(
    ctx,
    [
      { header: '科目', value: (c) => ctx.text(c.title), max: 30 },
      { header: 'コード', value: (c) => c.courseCode ?? '-' },
      { header: '担当', value: (c) => ctx.text(c.instructors.join('、')), max: 20 },
      {
        header: '時間割',
        value: (c) =>
          c.schedule
            .map((s) => `${DAY_NAMES[s.dayOfWeek % 7] ?? '?'}${s.period ? `${s.period}限` : ''}`)
            .join(' '),
      },
      {
        header: '教室',
        value: (c) => ctx.text(resolvedText(c.room)),
        style: (padded, c) => (c.room.status === 'conflict' ? ctx.style.red(padded) : padded),
      },
      {
        header: '競合',
        value: (c) => (c.openConflicts > 0 ? `${c.openConflicts}件` : '-'),
        style: (padded, c) => (c.openConflicts > 0 ? ctx.style.red(padded) : padded),
      },
      { header: 'ID', value: (c) => c.id },
    ],
    courses,
  );
}

export function printAssignments(
  ctx: CliContext,
  items: readonly AssignmentItem[],
  tz: string,
): void {
  if (items.length === 0) {
    ctx.out('該当する課題はありません');
    return;
  }
  printTable(
    ctx,
    [
      { header: '期限', value: (a) => shortTime(a.dueAt, tz) || '-' },
      {
        header: '残り',
        value: (a) => remaining(a.hoursLeft),
        style: (padded, a) => (a.overdue ? ctx.style.red(padded) : padded),
      },
      { header: '課題', value: (a) => ctx.text(a.title), max: 44 },
      { header: '科目', value: (a) => ctx.text(a.course?.title), max: 22 },
      { header: '状態', value: (a) => TASK_STATUS_LABELS[a.status] },
      { header: '由来', value: (a) => ORIGIN_LABELS[a.origin] },
      { header: '根拠', value: (a) => ctx.text(citationText(a.citations, 1)) },
    ],
    items,
  );
}

export function printDeadlineContext(ctx: CliContext, b: DeadlineContext): void {
  const tz = b.timezone;
  printSection(ctx, '期限切れ', b.overdue.length);
  printDeadlines(ctx, b.overdue, tz);
  printSection(ctx, 'これからの締切', b.upcoming.length);
  printDeadlines(ctx, b.upcoming, tz);
}

export function printChangesContext(ctx: CliContext, b: ChangesContext): void {
  const tz = b.timezone;
  ctx.out(ctx.style.bold(`${shortTime(b.since, tz)}以降の変更`));
  printSection(ctx, '変更', b.changes.length);
  printChanges(ctx, b.changes, tz);
  printConflicts(ctx, b.conflicts);
}

const ROUTE_LABELS: Record<string, string> = {
  structured: '構造化検索',
  lexical: '全文検索',
  transcript: '講義録検索',
};

export function printSearch(ctx: CliContext, r: SearchResponse, tz: string): void {
  const route = ROUTE_LABELS[r.query.route] ?? r.query.route;
  ctx.out(`「${ctx.text(r.query.original)}」の検索結果（${route}、${r.hits.length}件）`);
  if (r.hits.length === 0) {
    ctx.out('一致するものは見つかりませんでした');
    return;
  }
  const idLike = (title: string, kind: string): boolean => title.startsWith(`${kind}:`);
  printTable(
    ctx,
    [
      { header: '種別', value: (h) => KIND_LABELS[h.kind] ?? h.kind },
      {
        header: 'タイトル',
        value: (h) => (idLike(h.title, h.kind) ? '' : ctx.text(h.title)),
        max: 30,
      },
      { header: '抜粋', value: (h) => ctx.text(h.snippet), max: 44 },
      { header: '日時', value: (h) => shortTime(h.at, tz) },
      { header: '根拠', value: (h) => ctx.text(citationText(h.citations, 1)) },
    ],
    r.hits,
  );
}

export function printSources(ctx: CliContext, sources: readonly SourceInfo[], tz: string): void {
  if (sources.length === 0) {
    ctx.out('ソースは設定されていません');
    ctx.out(ctx.style.dim('config.yamlのsourcesに追加してください'));
    return;
  }
  printTable(
    ctx,
    [
      { header: 'ソース', value: (s) => s.sourceId },
      { header: '名前', value: (s) => ctx.text(s.displayName), max: 24 },
      {
        header: '状態',
        value: (s) => (s.enabled ? stateLabel(s.state) : '無効'),
        style: (padded, s) =>
          s.enabled ? colorState(ctx.style, s.state, padded) : ctx.style.dim(padded),
      },
      { header: '最終同期', value: (s) => shortTime(s.lastSyncAt, tz) || '-' },
      { header: '最終成功', value: (s) => shortTime(s.lastSuccessAt, tz) || '-' },
      {
        header: 'バージョン',
        value: (s) =>
          s.detectedVersion
            ? `${s.detectedVersion}${s.versionKnown === false ? '（未検証）' : ''}`
            : '-',
      },
      {
        header: 'ドリフト',
        value: (s) => (s.openDrift > 0 ? `${s.openDrift}件` : '-'),
        style: (padded, s) => (s.openDrift > 0 ? ctx.style.yellow(padded) : padded),
      },
      { header: 'コネクタ', value: (s) => ctx.text(s.connector), max: 30 },
    ],
    sources,
  );
  for (const s of sources) {
    if (s.loadError) ctx.out(`  ${ctx.style.red(s.sourceId)}: ${ctx.text(s.loadError)}`);
    else if (s.enabled && s.state !== 'healthy' && s.state !== 'unknown' && s.message)
      ctx.out(`  ${s.sourceId}: ${ctx.text(s.message)}`);
    if (s.enabled && s.state === 'auth_required')
      ctx.out(`  ${ctx.style.yellow(`「${s.loginCommand}」でログインしてください`)}`);
  }
}
