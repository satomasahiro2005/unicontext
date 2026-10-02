import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  entityLabel,
  isEntityKind,
  isIdOf,
  JsonValueSchema,
  type JsonValue,
  type TaskStatus,
} from '@unicontext/canonical-model';
import {
  CONTEXT_VIEWS,
  formatPaceSlot,
  getView,
  normalizePaceSlots,
  PACE_PREDICATE,
  type ContextViewName,
  type UniContext,
} from '@unicontext/context-engine';
import {
  errorMessage,
  isUniContextError,
  NotFoundError,
  parseZonedDate,
  redact,
  silentLogger,
  ValidationError,
  type Logger,
} from '@unicontext/core';
import { toCitation, type Citation } from '@unicontext/provenance';
import { z } from 'zod';
import { ALL_TASK_STATUSES, buildAssignments, type AssignmentFilter } from './assignments.js';
import { listCourses, resolveCourse } from './courses.js';
import {
  buildEnvelope,
  predicateLabel,
  type EnvelopeOptions,
  type McpEnvelope,
} from './envelope.js';
import { HIGH_RISK_SUBJECT_KINDS, isHighRiskPredicate, type ProposalStore } from './proposals.js';
import {
  CREDIT_SUMMARY_DESCRIPTION,
  CREDIT_SUMMARY_TITLE,
  creditSummaryShape,
  GET_SYLLABUS_DESCRIPTION,
  GET_SYLLABUS_TITLE,
  getCreditSummary,
  getSyllabus,
  getSyllabusShape,
  SEARCH_SYLLABUS_DESCRIPTION,
  SEARCH_SYLLABUS_TITLE,
  searchSyllabus,
  searchSyllabusShape,
} from './syllabus.js';

export interface McpDeps {
  uc: UniContext;
  proposals: ProposalStore;
  logger?: Logger;
  version?: string;
  /** Extra, already-safe source information (e.g. connector health) the daemon adds to `get_source`. */
  sourcesInfo?: () => unknown;
  /**
   * `local` (default): every tool, including the propose-only writes. `remote`: the read-only
   * surface published through a tunnel to ChatGPT / claude.ai — tools that are not read-only are
   * not registered at all, and `get_source` leaves out raw payloads.
   */
  surface?: McpSurface;
  /** Called after every tool call (audit log of the remote surface). Never receives arguments. */
  onToolCall?: (event: ToolCallEvent) => void;
}

export type McpSurface = 'local' | 'remote';

export interface ToolCallEvent {
  tool: string;
  ok: boolean;
  ms: number;
}

export const MCP_SERVER_NAME = 'unicontext';
export const DEFAULT_MCP_VERSION = '1.0.0';
export const RAW_PAYLOAD_LIMIT = 4000;
export const DOCUMENT_EXCERPT_LIMIT = 8000;
export const HOW_TO_CONFIRM =
  'unicontext confirm <id> を実行するか Web UI の確認待ちで承認してください';

export const SERVER_INSTRUCTIONS = [
  'UniContext は学生本人の大学情報（時間割・課題・お知らせ・講義録など）を、情報源つきで返します。',
  '回答するときは、各結果の citations / answerHint に従い「根拠: 学務情報システム 10/1 09:42取得」のように必ず出典を添えてください。',
  'conflicts が空でないときは、情報源の間で食い違いがあります。どちらかに断定せず、両方の値と出典をユーザーに伝えてください。',
  '情報がない・見つからないときは推測で補わず、そう伝えてください。',
  '書き込みは propose-only です。correct_fact は提案を作るだけで、ユーザー本人が確認するまで何も変更されません。課題の提出・履修登録や削除・成績に関わる操作はできません（提出済み status は提出システムからのみ反映されます）。',
  'Answers must cite sources, must report conflicting sources instead of picking one, and writes are propose-only.',
].join('\n');

/** Instructions of the read-only remote surface (ChatGPT / claude.ai through the tunnel). */
export const REMOTE_SERVER_INSTRUCTIONS = [
  'UniContextは学生本人の大学の予定・課題・お知らせ・講義録・シラバスを、情報源つきで返す読み取り専用のサーバーです。',
  '回答するときは、各結果のcitations・answerHintに従い「根拠: 学務情報システム 10/1 09:42取得」のように出典を添えてください。',
  'conflictsが空でないときは情報源の間で食い違いがあります。どちらかに断定せず、両方の値と出典を伝えてください。',
  '情報がない・見つからないときは推測で補わず、そう伝えてください。',
  'この接続では何も変更できません。履修計画はsearch_syllabus・get_syllabus・get_credit_summaryで調べ、登録はユーザー本人が大学のシステムで行います。',
  'Read-only: answers must cite sources and report conflicting sources instead of picking one.',
].join('\n');

// ---------- shared plumbing ----------

interface ToolOutput {
  data: unknown;
  options?: EnvelopeOptions;
}

const EnvelopeOutputShape = {
  data: z.unknown(),
  citations: z.array(z.looseObject({ sourceReferenceId: z.string(), label: z.string() })),
  conflicts: z.array(z.string()),
  answerHint: z.string(),
};

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function envelopeResult(envelope: McpEnvelope, compact = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, compact ? 0 : 2) }],
    structuredContent: envelope as unknown as Record<string, unknown>,
  };
}

function errorResult(
  e: unknown,
  logger: Logger,
  tool: string,
  ropts: { extraValuePatterns?: RegExp[] } = {},
): CallToolResult {
  let message: string;
  if (isUniContextError(e)) message = `${e.code}: ${e.message}`;
  else if (e instanceof z.ZodError)
    message = `validation: ${e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`;
  else {
    logger.error('mcp tool failed', { tool, error: errorMessage(e) });
    message = `internal: ${errorMessage(e)}`;
  }
  // Error text goes to the AI client: never let a token/cookie/student id inside it through (§60).
  return { isError: true, content: [{ type: 'text', text: redact(message, ropts) as string }] };
}

function redactionOptions(uc: UniContext): { extraValuePatterns?: RegExp[] } {
  const pattern = uc.profile?.privacy.studentIdPattern;
  if (!pattern) return {};
  try {
    return { extraValuePatterns: [new RegExp(pattern, 'g')] };
  } catch {
    return {};
  }
}

/** YYYY-MM-DD or any parseable instant -> ISO instant. */
function normalizeSince(uc: UniContext, since: string): string {
  const s = since.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    try {
      return parseZonedDate(s, uc.timezone).toISOString();
    } catch {
      throw new ValidationError(`since is not a valid date: ${since}`);
    }
  }
  const t = Date.parse(s);
  if (Number.isNaN(t))
    throw new ValidationError(`since must be an ISO-8601 date or datetime: ${since}`);
  return new Date(t).toISOString();
}

function opt<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

const courseIdField = z
  .string()
  .min(1)
  .describe(
    '科目の id（courseOffering:...）、または科目名・科目コードの一部 / Course offering id, or a (partial) course title or code',
  );

const TaskStatusSchema = z.enum(ALL_TASK_STATUSES as [TaskStatus, ...TaskStatus[]]);

const jsonValueInput = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

// ---------- server ----------

export function createMcpServer(deps: McpDeps): McpServer {
  const { uc, proposals } = deps;
  const logger = deps.logger ?? silentLogger;
  const remote = deps.surface === 'remote';
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: deps.version ?? DEFAULT_MCP_VERSION },
    { instructions: remote ? REMOTE_SERVER_INSTRUCTIONS : SERVER_INSTRUCTIONS },
  );

  const courseId = (input: string | undefined): string | undefined =>
    input === undefined ? undefined : resolveCourse(uc, input).ref.id;

  function tool<S extends z.ZodRawShape>(
    name: string,
    meta: { title: string; description: string; remoteDescription?: string; readOnly?: boolean },
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>) => ToolOutput | Promise<ToolOutput>,
  ): void {
    // The remote surface is read-only by construction: a write tool is never registered there.
    if (remote && meta.readOnly === false) return;
    const audit = (ok: boolean, started: number): void => {
      try {
        deps.onToolCall?.({ tool: name, ok, ms: Date.now() - started });
      } catch (e) {
        logger.warn('mcp audit hook failed', { tool: name, error: errorMessage(e) });
      }
    };
    const callback = async (args: unknown): Promise<CallToolResult> => {
      const started = Date.now();
      try {
        const out = await run(args as z.infer<z.ZodObject<S>>);
        logger.debug('mcp tool', { tool: name, ms: Date.now() - started });
        audit(true, started);
        return envelopeResult(buildEnvelope(out.data, out.options), remote);
      } catch (e) {
        logger.debug('mcp tool error', { tool: name, ms: Date.now() - started });
        audit(false, started);
        return errorResult(e, logger, name, redactionOptions(uc));
      }
    };
    server.registerTool(
      name,
      {
        title: meta.title,
        description: remote ? (meta.remoteDescription ?? meta.description) : meta.description,
        inputSchema: shape,
        outputSchema: EnvelopeOutputShape,
        annotations:
          meta.readOnly === false
            ? {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
              }
            : READ_ONLY,
      },
      callback as unknown as Parameters<typeof server.registerTool>[2],
    );
  }

  const view = (name: ContextViewName, params: unknown = {}): ToolOutput => ({
    data: getView(uc.context, name, params),
  });

  // ----- views -----

  tool(
    'get_today',
    {
      title: '今日の予定',
      description:
        '今日の授業（教室・状態）、昨日以降の変更、締切、未提出の課題、重要なお知らせ、授業準備、情報源の食い違いをまとめて返す。「今日の授業は？」「今日やることは？」に使う。 / Everything for today: classes (with room), changes, deadlines, tasks, important announcements, preparation and conflicts. Every item carries citations.',
    },
    {},
    () => view('today'),
  );

  tool(
    'get_tomorrow',
    {
      title: '明日の予定',
      description:
        "明日の授業・準備・締切を返す。「明日の2限は？」に使う。 / Tomorrow's classes, preparation and deadlines.",
    },
    {},
    () => view('tomorrow'),
  );

  tool(
    'get_week',
    {
      title: '今週の予定',
      description:
        "今週（月曜始まり）の時間割・締切・試験・変更・食い違いを返す。 / This week's timetable, deadlines, exams, changes and conflicts.",
    },
    {},
    () => view('week'),
  );

  tool(
    'get_course',
    {
      title: '科目の全体像',
      description:
        '1科目の全体像（担当・教室・今後の授業・直近の講義・締切・お知らせ・資料・変更・食い違い）を全ソース統合で返す。courseOfferingId には id のほか「データベース」のような科目名や科目コードも使える。 / One course across all sources. Accepts an id or a fuzzy title / course code.',
    },
    { courseOfferingId: courseIdField },
    (a) => view('course', { courseOfferingId: courseId(a.courseOfferingId) }),
  );

  tool(
    'get_deadlines',
    {
      title: '締切一覧',
      description:
        '期限切れと今後の締切を返す（days 日先まで、既定15日）。「今週の締切は？」「レポートはいつまで？」に使う。 / Overdue and upcoming deadlines.',
    },
    {
      days: z
        .number()
        .int()
        .positive()
        .max(365)
        .optional()
        .describe('何日先まで / Look-ahead in days (default 15)'),
      courseOfferingId: courseIdField.optional(),
    },
    (a) => view('deadline', opt({ days: a.days, courseOfferingId: courseId(a.courseOfferingId) })),
  );

  tool(
    'get_recent_changes',
    {
      title: '最近の変更',
      description:
        '昨日から（または since 以降）に変わったこと（教室変更・締切変更・休講・新規資料・食い違いの発生）を返す。 / What changed since yesterday (or `since`).',
    },
    {
      since: z
        .string()
        .optional()
        .describe(
          'ISO-8601 日時または YYYY-MM-DD。省略時は昨日の0時 / ISO datetime or YYYY-MM-DD (default: start of yesterday)',
        ),
      courseOfferingId: courseIdField.optional(),
    },
    (a) =>
      view(
        'changes',
        opt({
          since: a.since === undefined ? undefined : normalizeSince(uc, a.since),
          courseOfferingId: courseId(a.courseOfferingId),
        }),
      ),
  );

  tool(
    'prepare_for_class',
    {
      title: '授業の準備',
      description:
        '次の授業（または sessionId の授業）の準備: 資料・授業前の締切・お知らせ・前回の講義。「次の授業までに何をすべき？」に使う。 / Preparation for the next (or a given) class.',
    },
    {
      sessionId: z.string().min(1).optional().describe('classSession:... の id'),
      courseOfferingId: courseIdField.optional(),
    },
    (a) =>
      view(
        'class-preparation',
        opt({ sessionId: a.sessionId, courseOfferingId: courseId(a.courseOfferingId) }),
      ),
  );

  tool(
    'review_class',
    {
      title: '授業の振り返り',
      description:
        '直近（または指定）の講義の振り返り: スライド・録音・文字起こし（タイムスタンプ付き）・質問・次の締切。「前回の授業で何をやった？」に使う。 / Review of a recent or given lecture, with transcript timestamps.',
    },
    {
      lectureId: z.string().min(1).optional().describe('lecture:... の id'),
      sessionId: z.string().min(1).optional().describe('classSession:... の id'),
      courseOfferingId: courseIdField.optional(),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('YYYY-MM-DD'),
    },
    (a) =>
      view(
        'class-review',
        opt({
          lectureId: a.lectureId,
          sessionId: a.sessionId,
          courseOfferingId: courseId(a.courseOfferingId),
          date: a.date,
        }),
      ),
  );

  // ----- announcements -----

  tool(
    'get_announcements',
    {
      title: 'お知らせ一覧',
      description:
        'お知らせ（大学・学部・授業）を新しい順に返す。件名・差出人・分類・既読/未読（read）・添付・本文の冒頭を含む。unreadOnly=true で未読だけ。LiveCampusUの未読のお知らせは、開くと既読になってしまうため本文を取得していないことがある（bodyStatus が notOpened）。その場合は本文がないことをそのまま伝える。全文は get_announcement で読む。 / Announcements newest first with read state, category, attachments and a body excerpt. Unread LiveCampusU notices may have no body (bodyStatus "notOpened": opening them would mark them read). Use get_announcement for the full text.',
    },
    {
      since: z
        .string()
        .optional()
        .describe('ISO-8601 日時または YYYY-MM-DD 以降 / ISO datetime or YYYY-MM-DD'),
      unreadOnly: z.boolean().optional().describe('未読だけ / Unread only'),
      courseOfferingId: courseIdField.optional(),
      limit: z.number().int().positive().max(100).optional().describe('最大100件（既定30）'),
    },
    (a) => ({
      data: {
        announcements: uc.context.listAnnouncements(
          opt({
            since: a.since === undefined ? undefined : normalizeSince(uc, a.since),
            unreadOnly: a.unreadOnly,
            courseOfferingId: courseId(a.courseOfferingId),
            limit: a.limit ?? 30,
          }),
        ),
      },
    }),
  );

  tool(
    'get_announcement',
    {
      title: 'お知らせの全文',
      description:
        'お知らせ1件の全文（本文・差出人・分類・添付ファイル名・本文中のリンク・対象講義・対象日・既読/未読）を返す。id は get_announcements や search の結果の id（announcement:...）。LiveCampusUの未読のお知らせは本文を取得していないことがあり（bodyStatus が notOpened）、その場合 body は空。本人がLiveCampusUで読んだあとの同期で取得される。 / Full text of one announcement by id (announcement:...), with sender, category, attachments, links, target courses and date, read state. Unread LiveCampusU notices may have an empty body (bodyStatus "notOpened") until the student reads them there.',
    },
    { id: z.string().min(1).describe('announcement:... の id') },
    (a) => {
      const detail = isIdOf('announcement', a.id) ? uc.context.getAnnouncement(a.id) : undefined;
      if (!detail) throw new NotFoundError(`announcement ${a.id}`);
      return { data: { announcement: detail } };
    },
  );

  // ----- assignments / tasks -----

  const statusInput = z
    .union([TaskStatusSchema, z.array(TaskStatusSchema)])
    .optional()
    .describe('pending | in_progress | submitted | completed | cancelled | unknown（配列可）');
  const toStatuses = (s: TaskStatus | TaskStatus[] | undefined): TaskStatus[] | undefined =>
    s === undefined ? undefined : Array.isArray(s) ? s : [s];

  tool(
    'get_assignments',
    {
      title: '課題一覧',
      description:
        '課題・レポート・提出物の一覧（締切順）。既定は未完了のみで、includeCompleted=true で提出済み・完了も含める。status "submitted" は提出システムが確認した場合にのみ付く（AI は提出済みにできない）。 / Assignments sorted by due date. Default: open only. Task status `submitted` can only come from the submission system.',
    },
    {
      courseOfferingId: courseIdField.optional(),
      status: statusInput,
      includeCompleted: z.boolean().optional(),
    },
    (a) => {
      const filter: AssignmentFilter = opt({
        courseOfferingId: courseId(a.courseOfferingId),
        statuses: toStatuses(a.status),
        includeCompleted: a.includeCompleted,
      });
      return { data: { assignments: buildAssignments(uc, filter) } };
    },
  );

  tool(
    'get_tasks',
    {
      title: 'タスク一覧',
      description:
        'やること全般（課題・試験準備・お知らせから抽出した締切・本人が作ったタスク）。status で絞れる。省略時は取り消し以外すべて。 / All tasks (assignments, exam preparation, extracted deadlines, manual). Default: everything except cancelled.',
    },
    { status: statusInput, courseOfferingId: courseIdField.optional() },
    (a) => {
      const filter: AssignmentFilter = opt({
        courseOfferingId: courseId(a.courseOfferingId),
        statuses: toStatuses(a.status) ?? ALL_TASK_STATUSES.filter((s) => s !== 'cancelled'),
      });
      return { data: { tasks: buildAssignments(uc, filter) } };
    },
  );

  // ----- syllabus / course planning (read-only) -----

  tool(
    'search_syllabus',
    { title: SEARCH_SYLLABUS_TITLE, description: SEARCH_SYLLABUS_DESCRIPTION },
    searchSyllabusShape,
    (a) => searchSyllabus(uc, a),
  );

  tool(
    'get_syllabus',
    { title: GET_SYLLABUS_TITLE, description: GET_SYLLABUS_DESCRIPTION },
    getSyllabusShape,
    (a) => getSyllabus(uc, a),
  );

  tool(
    'get_credit_summary',
    { title: CREDIT_SUMMARY_TITLE, description: CREDIT_SUMMARY_DESCRIPTION },
    creditSummaryShape,
    (a) => getCreditSummary(uc, a),
  );

  // ----- search / sources / conflicts -----

  tool(
    'search',
    {
      title: '検索',
      description:
        '授業資料・お知らせ・メッセージ・講義の文字起こし・課題などを横断検索する（「ERモデルの説明どこ？」「先生は試験について何て言った？」）。各ヒットに出典がつく。お知らせ（kind が announcement）のヒットは id で get_announcement に渡すと全文が読める。 / Search materials, announcements, messages, transcripts and deadlines. Hits carry citations. For an announcement hit, pass its id to get_announcement for the full text.',
    },
    {
      query: z.string().min(1).max(500).describe('検索語または質問文 / Query'),
      limit: z.number().int().positive().max(50).optional(),
      courseOfferingId: courseIdField.optional(),
    },
    async (a) => ({
      data: await uc.search.search(
        a.query,
        opt({ limit: a.limit, courseOfferingId: courseId(a.courseOfferingId) }),
      ),
    }),
  );

  tool(
    'get_source',
    {
      title: '出典の詳細',
      description:
        '回答の根拠をたどる。citations の sourceReferenceId（または rawItemId）から、出典の情報（システム・取得時刻・URL・位置）と、取得した元データの要約（機密は伏せ字、4000文字まで）を返す。 / Resolve a citation to its source reference and a redacted, truncated raw payload summary.',
      remoteDescription:
        '回答の根拠をたどる。citations の sourceReferenceId（または rawItemId）から、出典の情報（システム・取得時刻・URL・位置）と、その出典から得た事実の一覧を返す。 / Resolve a citation to its source reference and the facts it supports.',
    },
    {
      sourceReferenceId: z.string().min(1).optional().describe('citations[].sourceReferenceId'),
      citationId: z.string().min(1).optional().describe('sourceReferenceId の別名 / alias'),
      rawItemId: z.string().min(1).optional().describe('raw:... の id'),
    },
    (a) => getSource(a),
  );

  tool(
    'get_conflicts',
    {
      title: '情報源の食い違い',
      description:
        '情報源の間で値が食い違っている項目（例: 学務情報システムと Teams で教室が違う）の一覧。どちらが正しいか断定せず両方をユーザーに伝えること。 / Open conflicts between sources. Report both values; never pick one.',
    },
    {},
    () => ({
      data: {
        conflicts: uc.resolver
          .listConflicts({ status: 'open' })
          .map((c) => uc.context.conflictItem(c)),
      },
    }),
  );

  // ----- propose-only write -----

  tool(
    'correct_fact',
    {
      title: '事実の訂正を提案',
      readOnly: false,
      description:
        '【提案のみ・何も書き換えない】事実（例: 教室）の訂正を「提案」として保存する。返ってくる proposalId をユーザーに伝え、ユーザー本人が `unicontext confirm <id>` または Web UI で承認して初めて、本人入力（user）の事実として保存される（§50, §74）。subject は courseOffering:... などのエンティティ id（科目名でも可）、predicate は room / assignment_due など。履修登録・削除、課題の提出、成績に関わる操作はできず、この tool でも扱わない。タスクの status `submitted` は提出システムからのみ反映される。 / PROPOSE-ONLY: creates a pending proposal; nothing changes until the user confirms it. Submitting assignments, enrolment changes and grades are not possible; task status `submitted` can only come from the submission system.',
    },
    {
      subject: z
        .string()
        .min(1)
        .describe(
          'エンティティ id（例 courseOffering:...）または科目名 / Entity id or course title',
        ),
      predicate: z.string().min(1).max(64).describe('例: room, assignment_due, class_status'),
      value: jsonValueInput.describe('訂正後の値 / The corrected value'),
      note: z.string().max(1000).optional().describe('訂正の理由・根拠 / Why'),
    },
    (a) => proposeCorrection(a),
  );

  tool(
    'propose_pace_slot',
    {
      title: '自習時間の設定を提案',
      readOnly: false,
      description:
        '【提案のみ・何も書き換えない】時間割外・集中講義の科目に、本人の毎週の自習時間を設定する「提案」を保存する。slots は "土 10:00-11:30" / "土2限" のような文字列の配列（空配列で解除の提案）。返ってくる proposalId をユーザーに伝え、ユーザー本人が `unicontext confirm <id>` または Web UI で承認して初めて反映される。 / PROPOSE-ONLY: creates a pending proposal for the weekly self-study slots of a course; nothing changes until the user confirms it.',
    },
    {
      course: courseIdField,
      slots: z
        .array(z.string().min(1).max(60))
        .max(14)
        .describe('例: ["土 10:00-11:30", "水2限"]。空配列で自習時間の解除 / Slots; [] clears'),
    },
    (a) => proposePaceSlot(a),
  );

  function subjectEntity(input: string): { id: string; label: string } {
    const text = input.trim();
    const colon = text.indexOf(':');
    const kind = colon > 0 ? text.slice(0, colon) : '';
    if (isEntityKind(kind)) {
      const e = uc.sync.stores.entities.get(text);
      if (!e) throw new NotFoundError(`subject ${text}`);
      return { id: e.id, label: entityLabel(e) };
    }
    const c = resolveCourse(uc, text);
    return { id: c.ref.id, label: c.ref.title };
  }

  function proposeCorrection(a: {
    subject: string;
    predicate: string;
    value: unknown;
    note?: string | undefined;
  }): ToolOutput {
    const predicate = a.predicate.trim();
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(predicate))
      throw new ValidationError(
        'predicate must be a short identifier such as room or assignment_due',
      );
    if (isHighRiskPredicate(predicate))
      throw new ValidationError(
        `predicate "${predicate}" is not allowed: grades, submissions and enrolment are high-risk and cannot be changed through MCP (§51)`,
      );
    const parsed = JsonValueSchema.safeParse(a.value);
    if (!parsed.success) throw new ValidationError('value must be valid JSON');
    const value: JsonValue = parsed.data;
    const subject = subjectEntity(a.subject);
    const subjectKind = subject.id.slice(0, subject.id.indexOf(':'));
    if (HIGH_RISK_SUBJECT_KINDS.has(subjectKind))
      throw new ValidationError(
        `subject "${subject.id}" is not allowed: grades and submissions are high-risk and cannot be changed through MCP (§51)`,
      );

    const current = uc.resolver.resolve(subject.id, predicate);
    const candidates = current.candidates.map((c) => ({
      value: c.fact.value,
      origin: c.fact.origin,
      authority: c.authority,
      source: c.source?.sourceLabel ?? c.source?.sourceSystem ?? 'unknown',
      observedAt: c.fact.observedAt,
      citation: c.source ? toCitation(c.source, uc.timezone) : undefined,
    }));
    const shown = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v) ?? ''));
    const now =
      current.status === 'conflict'
        ? `現在は情報源の間で食い違い中（${candidates.map((c) => `${shown(c.value)}: ${c.citation?.label ?? c.source}`).join(' / ')}）`
        : current.status === 'resolved'
          ? `現在の値: ${shown(current.value)}`
          : '現在の値: 未登録';
    const preview = `「${subject.label}」の${predicateLabel(predicate)}を「${shown(value)}」に訂正（${now}）。承認すると本人入力の事実として保存され、各情報源の値より優先されます。`;

    const clientName = server.server.getClientVersion()?.name;
    const proposal = proposals.create({
      kind: 'correct_fact',
      subject: subject.id,
      predicate,
      value,
      ...(a.note ? { note: a.note } : {}),
      createdBy: clientName ? `mcp:${clientName}` : 'mcp',
      preview,
    });
    logger.info('mcp proposal created', { proposalId: proposal.id, predicate });
    return {
      data: {
        proposalId: proposal.id,
        status: 'pending',
        preview: proposal.preview,
        howToConfirm: HOW_TO_CONFIRM,
        expiresAt: proposal.expiresAt,
        applied: false,
        current: {
          subject: subject.id,
          subjectLabel: subject.label,
          predicate,
          status: current.status,
          value: current.value ?? null,
          candidates,
        },
      },
      options: {
        hint: 'この時点では何も変更されていません。承認の方法（howToConfirm）をユーザーに伝えてください。',
      },
    };
  }

  function proposePaceSlot(a: { course: string; slots: string[] }): ToolOutput {
    const { ref } = resolveCourse(uc, a.course);
    const slots = normalizePaceSlots(a.slots, uc.profile);
    const value: JsonValue = { slots: slots.map((s) => ({ ...s })) };
    const was = uc.tasks.schedule.paceSlots(ref.linkedIds).map(formatPaceSlot);
    const shown = slots.map(formatPaceSlot);
    const preview = `「${ref.title}」の自習時間を${
      shown.length > 0 ? `「${shown.join('、')}」に設定` : '解除'
    }（現在: ${was.length > 0 ? was.join('、') : '未設定'}）。承認すると毎週の自習として予定に載り、「今週分」のタスクが作られます。`;
    const clientName = server.server.getClientVersion()?.name;
    const proposal = proposals.create({
      kind: 'correct_fact',
      subject: ref.id,
      predicate: PACE_PREDICATE,
      value,
      createdBy: clientName ? `mcp:${clientName}` : 'mcp',
      preview,
    });
    logger.info('mcp proposal created', { proposalId: proposal.id, predicate: PACE_PREDICATE });
    return {
      data: {
        proposalId: proposal.id,
        status: 'pending',
        preview: proposal.preview,
        howToConfirm: HOW_TO_CONFIRM,
        expiresAt: proposal.expiresAt,
        applied: false,
        current: { subject: ref.id, subjectLabel: ref.title, slots: was },
        proposed: { slots: shown },
      },
      options: {
        hint: 'この時点では何も変更されていません。承認の方法（howToConfirm）をユーザーに伝えてください。',
      },
    };
  }

  function getSource(a: {
    sourceReferenceId?: string | undefined;
    citationId?: string | undefined;
    rawItemId?: string | undefined;
  }): ToolOutput {
    const stores = uc.sync.stores;
    const refId = a.sourceReferenceId ?? a.citationId;
    if (!refId && !a.rawItemId)
      throw new ValidationError('give one of sourceReferenceId, citationId or rawItemId');
    const ropts = redactionOptions(uc);
    let reference = refId ? stores.sourceRefs.get(refId) : undefined;
    if (refId && !reference) throw new NotFoundError(`source reference ${refId}`);
    let rawItemId = reference?.rawItemId ?? a.rawItemId;
    const related = rawItemId ? stores.sourceRefs.byRawItem(rawItemId) : [];
    if (!reference && related.length > 0) reference = related[0];
    rawItemId = reference?.rawItemId ?? rawItemId;
    const rawItem = rawItemId ? stores.raw.get(rawItemId) : undefined;
    if (a.rawItemId && !rawItem && !reference) throw new NotFoundError(`raw item ${a.rawItemId}`);

    let rawView: Record<string, unknown> | undefined;
    if (rawItem && remote) {
      // The remote surface never ships raw source payloads, only what was read and when.
      rawView = {
        id: rawItem.id,
        sourceId: rawItem.sourceId,
        sourceType: rawItem.sourceType,
        fetchedAt: rawItem.fetchedAt,
        sourceUpdatedAt: rawItem.sourceUpdatedAt,
        deletedAt: rawItem.deletedAt,
      };
    } else if (rawItem) {
      const payload = redact(rawItem.payload, ropts);
      const text = JSON.stringify(payload) ?? 'null';
      rawView = {
        id: rawItem.id,
        sourceId: rawItem.sourceId,
        sourceType: rawItem.sourceType,
        externalId: rawItem.externalId,
        fetchedAt: rawItem.fetchedAt,
        sourceUpdatedAt: rawItem.sourceUpdatedAt,
        deletedAt: rawItem.deletedAt,
        payloadFields:
          payload && typeof payload === 'object' && !Array.isArray(payload)
            ? Object.keys(payload)
            : undefined,
        ...(text.length > RAW_PAYLOAD_LIMIT
          ? {
              payloadTruncated: true,
              payloadChars: text.length,
              payloadPreview: text.slice(0, RAW_PAYLOAD_LIMIT),
            }
          : { payloadTruncated: false, payload }),
      };
    }
    const src = rawItem ? stores.raw.getSource(rawItem.sourceId) : undefined;
    const facts = rawItem
      ? uc.resolver.facts
          .getMany(uc.resolver.facts.activeIdsForRawItem(rawItem.id))
          .filter((f) => !reference || f.sourceReferenceId === reference.id)
          .map((f) => ({
            id: f.id,
            subject: f.subject,
            predicate: f.predicate,
            value: f.value,
            origin: f.origin,
            observedAt: f.observedAt,
          }))
      : [];
    const extra = remote ? undefined : deps.sourcesInfo?.();
    const citation: Citation | undefined = reference
      ? toCitation(reference, uc.timezone)
      : undefined;
    return {
      data: {
        reference: redact(reference, ropts),
        citation,
        relatedReferences: related
          .filter((r) => r.id !== reference?.id)
          .map((r) => toCitation(r, uc.timezone)),
        rawItem: rawView,
        source: src
          ? redact({ id: src.id, connector: src.connector, displayName: src.displayName }, ropts)
          : undefined,
        facts: redact(facts, ropts),
        ...(extra !== undefined ? { sourcesInfo: redact(extra, ropts) } : {}),
      },
    };
  }

  // ---------- resources (§40) ----------

  function documentBundle(id: string): ToolOutput {
    const entities = uc.sync.stores.entities;
    const doc = isIdOf('document', id) ? entities.getOfKind('document', id) : undefined;
    if (!doc) throw new NotFoundError(`document ${id}`);
    const chunks = entities
      .list('documentChunk', { where: { documentId: id } })
      .sort((a, b) => a.ordinal - b.ordinal);
    let text = chunks.map((c) => c.text).join('\n\n');
    if (!text && doc.text) text = doc.text;
    const truncated = text.length > DOCUMENT_EXCERPT_LIMIT;
    return {
      data: {
        document: {
          id: doc.id,
          title: doc.title,
          mimeType: doc.mimeType,
          url: doc.url,
          pageCount: doc.pageCount,
          modifiedAt: doc.modifiedAt,
          course: uc.context.courseRef(doc.courseOfferingId),
        },
        chunkCount: chunks.length,
        excerpt: truncated ? text.slice(0, DOCUMENT_EXCERPT_LIMIT) : text,
        excerptTruncated: truncated,
        chunks: chunks.slice(0, 50).map((c) => ({
          id: c.id,
          ordinal: c.ordinal,
          page: c.page,
          heading: c.heading,
        })),
      },
      options: {
        citations: uc.context.citationsFor([doc.id, ...chunks.slice(0, 50).map((c) => c.id)]),
      },
    };
  }

  const mimeType = 'application/json';
  const read = (uri: URL, produce: () => ToolOutput) => {
    try {
      const out = produce();
      const envelope = buildEnvelope(out.data, out.options);
      return { contents: [{ uri: uri.href, mimeType, text: JSON.stringify(envelope, null, 2) }] };
    } catch (e) {
      if (isUniContextError(e))
        throw new McpError(
          ErrorCode.InvalidParams,
          e.code === 'not_found' ? `Resource not found: ${e.message}` : e.message,
        );
      throw e;
    }
  };
  const idOf = (v: string | string[] | undefined): string => {
    const raw = Array.isArray(v) ? v[0] : v;
    if (!raw) throw new ValidationError('resource id is missing');
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  };

  const fixed: { name: string; view: ContextViewName; description: string }[] = [
    { name: 'today', view: 'today', description: '今日の授業・変更・締切・準備・食い違い' },
    { name: 'week', view: 'week', description: '今週の時間割・締切・試験・変更' },
    ...CONTEXT_VIEWS.filter((v) =>
      ['tomorrow', 'deadline', 'changes', 'admin'].includes(v.name),
    ).map((v) => ({ name: v.name, view: v.name as ContextViewName, description: v.description })),
  ];
  for (const f of fixed)
    server.registerResource(
      f.name,
      `unicontext://${f.name}`,
      { title: f.name, description: f.description, mimeType },
      (uri) => read(uri, () => view(f.view)),
    );

  server.registerResource(
    'course',
    new ResourceTemplate('unicontext://course/{id}', {
      list: () => ({
        resources: listCourses(uc).map((c) => ({
          uri: `unicontext://course/${encodeURIComponent(c.ref.id)}`,
          name: c.ref.title,
          description: `${c.ref.courseCode ? `${c.ref.courseCode} ` : ''}科目の全体像`,
          mimeType,
        })),
      }),
    }),
    { title: '科目', description: '1科目の全体像（全ソース統合）', mimeType },
    (uri, v) =>
      read(uri, () => view('course', { courseOfferingId: resolveCourse(uc, idOf(v.id)).ref.id })),
  );

  server.registerResource(
    'lecture',
    new ResourceTemplate('unicontext://lecture/{id}', {
      list: () => ({
        resources: uc.sync.stores.entities
          .list('lecture', { orderBy: 'date', limit: 200 })
          .map((l) => ({
            uri: `unicontext://lecture/${encodeURIComponent(l.id)}`,
            name: l.title ?? l.date,
            description: `${l.date} の講義`,
            mimeType,
          })),
      }),
    }),
    { title: '講義', description: '講義1回分（スライド・録音・文字起こし・質問）', mimeType },
    (uri, v) =>
      read(uri, () => {
        const id = idOf(v.id);
        const bundle = isIdOf('classSession', id)
          ? uc.context.lecture({ sessionId: id })
          : uc.context.lecture({ lectureId: id });
        if (!bundle) throw new NotFoundError(`lecture ${id}`);
        return { data: bundle };
      }),
  );

  server.registerResource(
    'document',
    new ResourceTemplate('unicontext://document/{id}', {
      list: () => ({
        resources: uc.sync.stores.entities.list('document', { limit: 200 }).map((d) => ({
          uri: `unicontext://document/${encodeURIComponent(d.id)}`,
          name: d.title,
          ...(d.mimeType ? { mimeType: d.mimeType } : {}),
        })),
      }),
    }),
    { title: '文書', description: '文書のメタデータと本文の抜粋（出典つき）', mimeType },
    (uri, v) => read(uri, () => documentBundle(idOf(v.id))),
  );

  return server;
}
