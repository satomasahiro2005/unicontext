import type {
  AnnouncementItem,
  ChangeItem,
  ClassItem,
  ConflictItem,
  EnrollmentNote,
  DeadlineItem,
  EstimatedDeadlineItem,
  EstimatedDue,
  NextAction,
  NextActionsContext,
  PaceItem,
  PreparationItem,
  TaskItem,
} from '@unicontext/context-engine';
import { formatDateJa, parseZonedDate } from '@unicontext/core';
import type {
  AssignmentItem,
  ChangesContext,
  CourseSummary,
  CoursesResponse,
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
    {
      header: '科目',
      value: (c) =>
        ctx.text(`${c.course.title}${c.sessionKind === 'self_study' ? '（自習）' : ''}`),
      max: 28,
    },
    {
      header: '教室',
      value: (c) => (c.sessionKind === 'self_study' ? '-' : ctx.text(resolvedText(c.room))),
      style: (padded, c) => (c.room.status === 'conflict' ? ctx.style.red(padded) : padded),
    },
    {
      header: '状態',
      value: (c) => classStateText(c),
      style: (padded, c) =>
        c.cancelled
          ? ctx.style.red(padded)
          : c.effectiveSchedule.status !== 'attending'
            ? ctx.style.yellow(padded)
            : padded,
    },
    { header: '根拠', value: (c) => ctx.text(citationText(c.citations, 1)) },
  ];
}

export function printClasses(
  ctx: CliContext,
  classes: readonly ClassItem[],
  tz: string,
  emptyReason?: string,
): void {
  if (classes.length === 0) {
    if (emptyReason) ctx.out(`  なし（${ctx.text(emptyReason)}）`);
    else none(ctx);
    return;
  }
  printTable(ctx, classColumns(ctx, tz), classes);
  // Why a meeting is not plainly the student's (group unknown, another group's day): once per
  // course and reason, under the table.
  const seen = new Set<string>();
  for (const c of classes) {
    const e = c.effectiveSchedule;
    if (c.cancelled || e.status === 'attending' || !e.reason) continue;
    const key = `${c.course.id}|${e.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ctx.out(ctx.style.dim(`  ※ ${ctx.text(c.course.title)}: ${ctx.text(e.reason)}`));
  }
}

/** The class's state for the student: 休講 etc. from the sources, else the effective status. */
export function classStateText(c: ClassItem): string {
  if (c.cancelled || c.status.status === 'conflict')
    return resolvedText(c.status, CLASS_STATUS_LABELS);
  if (c.effectiveSchedule.status === 'not_attending') return '出席なし';
  if (c.effectiveSchedule.status === 'unknown') return '未確定';
  return resolvedText(c.status, CLASS_STATUS_LABELS);
}

/** 「履修の食い違い」: the student's unconfirmed word against the academic system, one line each. */
function printEnrollmentNotes(ctx: CliContext, notes: readonly EnrollmentNote[] | undefined): void {
  if (!notes?.length) return;
  printSection(ctx, '履修の食い違い', notes.length);
  for (const n of notes)
    ctx.out(
      `  ${ctx.style.yellow(ctx.text(n.note))}  ${ctx.style.dim(citationText(n.citations, 1))}`,
    );
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
    {
      header: '由来',
      value: (d) => (d.recorded ? recordedLabel(d.recorded) : ORIGIN_LABELS[d.origin]),
    },
    {
      header: '根拠',
      value: (d) =>
        ctx.text(
          d.recorded?.evidence
            ? `「${d.recorded.evidence}」${citationText(d.citations, 1)}`
            : citationText(d.citations, 1),
        ),
      max: 60,
    },
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

/** 「録音から（未確認）」 / 「チャットで登録」 */
function recordedLabel(r: { label: string; via: string }): string {
  return r.via === 'chat' ? r.label : `${r.label}（未確認）`;
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

/** 「推定 10/8 10:20」 for an unknown due date with an estimate (never shown as the deadline). */
function estimateCell(e: EstimatedDue | undefined, tz: string): string {
  return e ? `推定 ${shortTime(e.at, tz)}` : '';
}

function printTasks(ctx: CliContext, tasks: readonly TaskItem[], tz: string): void {
  if (tasks.length === 0) return none(ctx);
  printTable(
    ctx,
    [
      {
        header: '期限',
        value: (t) => shortTime(t.dueAt, tz) || estimateCell(t.estimatedDue, tz) || '-',
      },
      { header: '内容', value: (t) => ctx.text(t.title), max: 40 },
      { header: '科目', value: (t) => ctx.text(t.course?.title), max: 22 },
      { header: '状態', value: (t) => TASK_STATUS_LABELS[t.status] },
      {
        header: '由来',
        value: (t) => (t.recorded ? recordedLabel(t.recorded) : ORIGIN_LABELS[t.origin]),
      },
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

/** 「ペース（遅れ）」: only when the student is behind in a 時間割外 / 集中講義 course. */
function printPacing(ctx: CliContext, items: readonly PaceItem[]): void {
  if (items.length === 0) return;
  ctx.out('');
  ctx.out(ctx.style.bold('ペース（遅れ）'));
  for (const p of items) {
    const line = ctx.text(p.message);
    ctx.out(
      `  ${p.behindWeeks >= 2 ? ctx.style.red(ctx.style.bold(line)) : ctx.style.yellow(line)}`,
    );
    if (p.slots.length > 0) ctx.out(`    ${ctx.style.dim(`自習時間: ${p.slots.join('、')}`)}`);
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
  if ('next' in b && b.next) ctx.out(ctx.style.bold(`→ ${ctx.text(b.next.line)}`));
  printSection(ctx, '授業', b.classes.length);
  printClasses(ctx, b.classes, tz, b.noClassesReason);
  printEnrollmentNotes(ctx, b.enrollmentNotes);
  printConflicts(ctx, b.conflicts);
  printSection(ctx, '昨日からの変更', b.changes.length);
  printChanges(ctx, b.changes, tz);
  printSection(ctx, '締切', b.deadlines.length);
  printDeadlines(ctx, b.deadlines, tz);
  if ('pacing' in b) printPacing(ctx, b.pacing);
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
    printClasses(ctx, day.classes, tz, day.noClassesReason);
  }
  printSection(ctx, '締切', b.deadlines.length);
  printDeadlines(ctx, b.deadlines, tz);
  printSection(ctx, '試験', b.exams.length);
  printDeadlines(ctx, b.exams, tz);
  printSection(ctx, '変更', b.changes.length);
  printChanges(ctx, b.changes, tz);
  printEnrollmentNotes(ctx, b.enrollmentNotes);
  printConflicts(ctx, b.conflicts);
}

const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

const SCHEDULE_TYPE_LABEL: Record<CourseSummary['scheduleType'], string> = {
  regular: '時間割',
  unscheduled: '時間割外',
  intensive: '集中講義',
};

function courseTable(ctx: CliContext, courses: readonly CourseSummary[], regular: boolean): void {
  printTable(
    ctx,
    [
      {
        header: '科目',
        value: (c) => ctx.text(`${c.title}${c.retake ? '（再履修）' : ''}`),
        max: 30,
      },
      { header: 'コード', value: (c) => c.courseCode ?? '-' },
      { header: '担当', value: (c) => ctx.text(c.instructors.join('、')) || '-', max: 20 },
      regular
        ? {
            header: '時間割',
            value: (c: CourseSummary) =>
              c.schedule
                .map(
                  (s) => `${DAY_NAMES[s.dayOfWeek % 7] ?? '?'}${s.period ? `${s.period}限` : ''}`,
                )
                .join(' ') || '-',
          }
        : { header: '種別', value: (c: CourseSummary) => SCHEDULE_TYPE_LABEL[c.scheduleType] },
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

export function printCourses(ctx: CliContext, body: CoursesResponse): void {
  const { courses, term, terms = [] } = body;
  if (term) ctx.out(ctx.style.bold(`${term.name}${term.current ? '（今の学期）' : ''}`));
  const others = terms.filter((t) => t.id !== term?.id && t.courses > 0);
  const hint = others.length
    ? `他の学期: ${others.map((t) => `${t.name} ${t.courses}件（--term ${t.id}）`).join('、')}。すべて: --all`
    : undefined;
  if (courses.length === 0) {
    ctx.out(
      term
        ? `${term.name}に登録した科目はまだありません（履修登録の後に同期すると表示されます）`
        : '科目はまだありません',
    );
    if (hint) ctx.out(ctx.style.dim(hint));
    return;
  }
  // Group by term when several terms are shown (--all), then weekly vs off-timetable.
  const groups = new Map<string, CourseSummary[]>();
  for (const c of courses) {
    const key = term ? '' : `${c.academicYear ?? ''} ${c.term ?? ''}`.trim();
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  let first = true;
  for (const [label, list] of groups) {
    if (!first) ctx.out('');
    first = false;
    if (label) ctx.out(ctx.style.bold(label.replace(/^(\d{4}) /, '$1年度 ')));
    const regular = list.filter((c) => c.scheduleType === 'regular');
    const off = list.filter((c) => c.scheduleType !== 'regular');
    if (regular.length) courseTable(ctx, regular, true);
    if (off.length) {
      if (regular.length) ctx.out('');
      ctx.out(`時間割外・集中講義（${off.length}件）`);
      courseTable(ctx, off, false);
    }
  }
  if (hint) {
    ctx.out('');
    ctx.out(ctx.style.dim(hint));
  }
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
      {
        header: '期限',
        value: (a) => shortTime(a.dueAt, tz) || estimateCell(a.estimatedDue, tz) || '-',
      },
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
  for (const a of items)
    if (a.estimatedDue)
      ctx.out(
        `  ${ctx.style.yellow('推定')} ${ctx.text(a.title)}: ${ctx.text(a.estimatedDue.text)}`,
      );
}

export function printDeadlineContext(ctx: CliContext, b: DeadlineContext): void {
  const tz = b.timezone;
  printSection(ctx, '期限切れ', b.overdue.length);
  printDeadlines(ctx, b.overdue, tz);
  printSection(ctx, 'これからの締切', b.upcoming.length);
  printDeadlines(ctx, b.upcoming, tz);
  printEstimated(ctx, b.estimated ?? [], tz);
}

/** Unknown due dates with their estimates, apart from the stated deadlines and marked 推定. */
function printEstimated(
  ctx: CliContext,
  items: readonly EstimatedDeadlineItem[],
  tz: string,
): void {
  if (items.length === 0) return;
  printSection(ctx, '締切不明（推定・要確認）', items.length);
  printTable(
    ctx,
    [
      { header: '推定', value: (d) => shortTime(d.estimatedDue.at, tz) },
      {
        header: '範囲',
        value: (d) => (d.estimatedDue.latest ? `〜${shortTime(d.estimatedDue.latest, tz)}` : '-'),
      },
      {
        header: '残り',
        value: (d) => remaining(d.hoursLeft),
        style: (padded, d) => (d.hoursLeft < 0 ? ctx.style.red(padded) : padded),
      },
      { header: '内容', value: (d) => ctx.text(d.title), max: 40 },
      { header: '科目', value: (d) => ctx.text(d.course?.title), max: 22 },
      { header: '確度', value: (d) => (d.estimatedDue.confidence === 'medium' ? '中' : '低') },
      { header: '確認先', value: (d) => ctx.text(d.estimatedDue.checkWhere), max: 30 },
    ],
    items,
  );
  for (const d of items)
    ctx.out(`  ${ctx.style.dim(ctx.text(`${d.title}: 根拠 ${d.estimatedDue.basis}`))}`);
  ctx.out(
    `  ${ctx.style.yellow('推定は確定した締切ではありません。早めの推定に合わせて動き、確認先で本当の締切を確かめてください。')}`,
  );
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

function printAction(ctx: CliContext, a: NextAction, lead: string): void {
  ctx.out(`${lead}${ctx.text(a.what)}`);
  const due = a.dueText && a.dueText !== '—' ? `締切 ${a.dueText}` : '';
  const meta = [a.why, due, a.course?.title].filter(Boolean).map((x) => ctx.text(x));
  if (meta.length) ctx.out(`    ${ctx.style.dim(meta.join(' / '))}`);
  if (a.estimatedDue)
    ctx.out(`    ${ctx.style.dim(ctx.text(`推定の根拠: ${a.estimatedDue.basis}`))}`);
  if (a.link) ctx.out(`    ${ctx.style.dim(ctx.text(a.link.url))}`);
}

/** `unicontext next`: the one thing to do now, then the next few. */
export function printNext(ctx: CliContext, r: NextActionsContext): void {
  if (!r.top) {
    ctx.out(ctx.text(r.line));
    return;
  }
  ctx.out(ctx.style.bold('今やること'));
  printAction(ctx, r.top, '  ');
  if (r.next.length) {
    printSection(ctx, 'その次', r.next.length);
    for (const a of r.next) printAction(ctx, a, '  ・');
  }
  if (!r.coverage.trusted) {
    printSection(ctx, '要確認', r.coverage.gaps.length);
    for (const g of r.coverage.gaps) ctx.out(`  ${ctx.text(g.detail)}`);
  }
}
