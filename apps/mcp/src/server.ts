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
  type AdditionResult,
  CONTEXT_VIEWS,
  downloadCourseFiles,
  type DownloadFilesReport,
  fileTextExcerpt,
  openAnnouncements as openAnnouncementsInProcess,
  type OpenAnnouncementsReport,
  formatPaceSlot,
  getView,
  normalizePaceSlots,
  PACE_PREDICATE,
  browseVpnFiles,
  searchVpnFiles,
  recentVpnFiles,
  type ContextViewName,
  type UniContext,
  type DeadlineCoverage,
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
import {
  type AdditionClient,
  addDeadlineShape,
  addNoteShape,
  addTaskShape,
  compactAddition,
  courseIdForWrite,
  GET_NOTES_TOOL,
  getNotesShape,
  INGEST_RESULT_SHAPE,
  ingestLectureShape,
  ingestOutput,
  LIST_RESULT_SHAPE,
  listAdditionsShape,
  OPEN_ANNOUNCEMENT_RESULT_SHAPE,
  openAnnouncementShape,
  recordLectureShape,
  retractAdditionShape,
  toStatuses as toAdditionStatuses,
  WRITE_RESULT_SHAPE,
  WRITE_TOOLS,
  writeOutput,
} from './additions.js';
import {
  ALL_TASK_STATUSES,
  buildAssignments,
  PAST_TERM_STATUS,
  type AssignmentFilter,
} from './assignments.js';
import { listCourses, resolveCourse } from './courses.js';
import { trimCourseForAi } from './trim.js';
import {
  buildEnvelope,
  compactEnvelope,
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
  /** Icons announced in `serverInfo` (absolute URLs); AI apps show them next to the connection. */
  icons?: { src: string; mimeType: string; sizes?: string[] }[];
  /**
   * `local` (default): every tool, including the propose-only writes. `remote`: the read-only
   * surface published through a tunnel to ChatGPT / claude.ai — tools that are not read-only are
   * not registered at all, and `get_source` leaves out raw payloads.
   */
  surface?: McpSurface;
  /**
   * Remote surface: the OAuth grant includes `unicontext.write`, so the record tools (ingest_lecture,
   * record_lecture, add_deadline, add_note, add_task, list_my_additions, retract_addition) are
   * registered. The propose-only tools never are. The local surface always has the record tools.
   */
  allowWrite?: boolean;
  /** Who is calling (remote: the OAuth client). Default `local:<MCP client name>`. */
  client?: AdditionClient;
  /**
   * Fetch notice bodies on request (open_announcement). The daemon runs it in-process (it holds the
   * LiveCampusU session); `unicontext mcp` routes it to the running daemon. Default: in-process.
   */
  openAnnouncements?: (ids: string[]) => Promise<OpenAnnouncementsReport>;
  /** `<data dir>/files` (download_course_file in-process). */
  filesDir?: string;
  /**
   * Download class files (download_course_file). The daemon runs it in-process (it holds the
   * browser profile); `unicontext mcp` routes it to the running daemon. Default: in-process with
   * `filesDir`.
   */
  downloadFiles?: (refs: string[], options: { extract: boolean }) => Promise<DownloadFilesReport>;
  /**
   * Remote surface: mint a short-lived link on the remote listener that serves the local copy of
   * a downloaded file to the calling OAuth client only. Undefined = links are not offered.
   */
  fileLink?: (documentId: string) => { url: string; expiresAt: string } | undefined;
  /** Called after every tool call (audit log of the remote surface). Never receives arguments. */
  onToolCall?: (event: ToolCallEvent) => void;
}

export type McpSurface = 'local' | 'remote';

export interface ToolCallEvent {
  tool: string;
  ok: boolean;
  ms: number;
  /** Write tools: what was written (ids only, never the text). */
  write?: {
    status: string;
    additionId: string;
    entityIds: string[];
    factIds: string[];
  };
}

export const MCP_SERVER_NAME = 'unicontext';
export const DEFAULT_MCP_VERSION = '1.0.0';
export const RAW_PAYLOAD_LIMIT = 4000;
export const DOCUMENT_EXCERPT_LIMIT = 8000;
export const HOW_TO_CONFIRM =
  'unicontext confirm <id> を実行するか Web UI の確認待ちで承認してください';

/**
 * Answer hint for a view with deadline coverage: an incomplete coverage is spelled out (the AI
 * must not read an empty list as "no deadline"); a complete one gets a one-line reminder.
 */
export function coverageHint(data: unknown): string | undefined {
  const cov = (data as { coverage?: DeadlineCoverage } | undefined)?.coverage;
  if (!cov) return undefined;
  if (cov.complete) return '締切の一覧に無いことは、締切が無いことを意味しません。';
  const more = cov.gaps.length > 3 ? ` ほか${cov.gaps.length - 3}件（coverage.gaps）。` : '';
  return `締切の取得に欠けがあります: ${cov.gaps
    .slice(0, 3)
    .map((g) => g.detail)
    .join(' ')}${more} 「締切はない」「余裕がある」とは言わないでください。`;
}

/** Lecture recordings are stored without being asked (local and remote write surfaces). */
export const RECORDING_INSTRUCTION_JA =
  '講義の録音・文字起こし（ChatGPT Record など）が入力として与えられ、科目と日付を合理的に特定できる場合は、ユーザーから保存依頼がなくても ingest_lecture を呼んでください。質問への回答はいつもどおり行い、それとは別に1回呼びます。保存してよいか確かめたり、会話・録音・時間割から分かる科目・日付・時限を聞き直したりしないでください（本人が確認するまで「録音から」の未確認情報として保存され、大学側の値は上書きしません）。要約・要点は後で検索・復習するのに要ることに絞って文字起こしをそのまま入れず、雑談や他の学生どうしの会話も入れません。締切は先生が実際に言ったものだけ（「次回までに〜」は根拠になるが、次の授業があるというだけでは締切にしない）、やることは学生がやらなければならないこと、メモは締切ではないが後で要る情報（教室・出席・提出の方法、グループ分け、特別な手順、先生の大事な注意）です。各項目には発言の引用（evidence）と録音の位置（recordingTimestamp）を付けます。';
export const RECORDING_INSTRUCTION_EN =
  'When a lecture recording or transcript is given as input and the course and date can reasonably be determined, call ingest_lecture even without a request to save, in addition to answering. Do not ask the user to confirm, or to restate a course, date or period that the conversation, the recording or the timetable tells; it is stored as unconfirmed and never overrides university data.';

export const SERVER_INSTRUCTIONS = [
  'UniContext は学生本人の大学情報（時間割・課題・お知らせ・講義録など）を、情報源つきで返します。',
  '回答するときは、各結果の citations / answerHint に従い「根拠: 学務情報システム 10/1 09:42取得」のように必ず出典を添えてください。',
  'conflicts が空でないときは、情報源の間で食い違いがあります。どちらかに断定せず、両方の値と出典をユーザーに伝えてください。',
  '情報がない・見つからないときは推測で補わず、そう伝えてください。',
  '締切について: UniContextに締切が載っていないことは、締切が無いことを意味しません。get_deadlines・get_today・get_week・get_course の coverage に、締切をどの情報源から取ったか、各情報源の状態（ok / auth_required / stale / failing / never_synced）、欠け（gaps: 止まっている情報源・課題を同期していない場所にもある科目・期限不明の課題）が入っています。coverage.complete が false なら必ずそのことを伝え、分からない締切はすぐ来るかもしれないものとして扱い、gaps の確認先（例: Ed Discussionを直接見る）を伝えてください。coverage を確かめずに「期限はない」「余裕がある」と言ってはいけません。',
  '書き込みは propose-only です。correct_fact は提案を作るだけで、ユーザー本人が確認するまで何も変更されません。課題の提出・履修登録や削除・成績に関わる操作はできません（提出済み status は提出システムからのみ反映されます）。',
  'ユーザーが会話の中で言った締切・試験の日程・やること・覚えておきたいこと（例「レポートの締切10/20って登録しといて」）や、ユーザーと一緒に決めた勉強のTODOは add_deadline / add_task / add_note で、UniContextに登録できます。登録した内容は他の会話・クライアントからも get_today・get_week・get_deadlines・get_tasks・get_notes で見えます（大学のシステムには送られず、「チャットで登録」「録音から」と表示され、大学側の値は上書きしません）。',
  RECORDING_INSTRUCTION_JA,
  'Deadlines: absence in UniContext does not mean there is none. Read coverage (sources, health, gaps); when it is incomplete say so, treat unknown deadlines as possibly imminent, tell the student where to check, and never say there is no deadline or plenty of time without complete coverage.',
  'Answers must cite sources, must report conflicting sources instead of picking one, and corrections are propose-only. Deadlines, to-dos and notes the student mentions in any chat can be registered with add_deadline / add_task / add_note so every other session sees them; they never override a university system.',
  RECORDING_INSTRUCTION_EN,
].join('\n');

/** Instructions of the read-only remote surface (ChatGPT / claude.ai through the tunnel). */
export const REMOTE_SERVER_INSTRUCTIONS = [
  'UniContextは学生本人の大学の予定・課題・お知らせ・講義録・シラバスを、情報源つきで返す読み取り専用のサーバーです。',
  '回答するときは、各結果のcitations・answerHintに従い「根拠: 学務情報システム 10/1 09:42取得」のように出典を添えてください。',
  'conflictsが空でないときは情報源の間で食い違いがあります。どちらかに断定せず、両方の値と出典を伝えてください。',
  '情報がない・見つからないときは推測で補わず、そう伝えてください。',
  '締切について: UniContextに締切が載っていないことは、締切が無いことを意味しません。get_deadlines・get_today・get_week・get_course の coverage に、締切をどの情報源から取ったか、各情報源の状態（ok / auth_required / stale / failing / never_synced）、欠け（gaps: 止まっている情報源・課題を同期していない場所にもある科目・期限不明の課題）が入っています。coverage.complete が false なら必ずそのことを伝え、分からない締切はすぐ来るかもしれないものとして扱い、gaps の確認先（例: Ed Discussionを直接見る）を伝えてください。coverage を確かめずに「期限はない」「余裕がある」と言ってはいけません。',
  'この接続では何も変更できません。履修計画はsearch_syllabus・get_syllabus・get_credit_summaryで調べ、登録はユーザー本人が大学のシステムで行います。',
  'Read-only: answers must cite sources and report conflicting sources instead of picking one.',
  'Deadlines: absence in UniContext does not mean there is none. Read coverage (sources, health, gaps); when it is incomplete say so, treat unknown deadlines as possibly imminent, tell the student where to check, and never say there is no deadline or plenty of time without complete coverage.',
].join('\n');

/** Instructions of the remote surface when the grant includes unicontext.write. */
export const REMOTE_WRITE_SERVER_INSTRUCTIONS = [
  'UniContextは学生本人の大学の予定・課題・お知らせ・講義録・シラバスを、情報源つきで返すサーバーです。',
  '回答するときは、各結果のcitations・answerHintに従い「根拠: 学務情報システム 10/1 09:42取得」のように出典を添えてください。',
  'conflictsが空でないときは情報源の間で食い違いがあります。どちらかに断定せず、両方の値と出典を伝えてください。',
  '情報がない・見つからないときは推測で補わず、そう伝えてください。',
  '締切について: UniContextに締切が載っていないことは、締切が無いことを意味しません。get_deadlines・get_today・get_week・get_course の coverage に、締切をどの情報源から取ったか、各情報源の状態（ok / auth_required / stale / failing / never_synced）、欠け（gaps: 止まっている情報源・課題を同期していない場所にもある科目・期限不明の課題）が入っています。coverage.complete が false なら必ずそのことを伝え、分からない締切はすぐ来るかもしれないものとして扱い、gaps の確認先（例: Ed Discussionを直接見る）を伝えてください。coverage を確かめずに「期限はない」「余裕がある」と言ってはいけません。',
  'どの会話でも、ユーザーが締切・試験の日程（例「レポートの締切10/20って登録しといて」「来週の金曜に小テスト」）、やること、覚えておきたいことを言ったら、add_deadline・add_task・add_note で登録してください。ユーザーと一緒に立てた勉強計画のTODOも add_task で登録できます。科目に関係ないものは course を省略します。',
  '登録した内容は、ChatGPTの他の会話やClaudeなど、UniContextにつながる全てのセッションから get_today・get_week・get_deadlines・get_tasks・get_course・get_notes で見えます。登録の前に get_deadlines などで既にあるか確かめると二重登録を避けられます（同じ科目・題名・近い締切は自動で1件にまとまります）。',
  'evidence にはユーザーの言葉をそのまま引用してください。締切は言われたままの表現（10月20日17時・来週の金曜など）でよく、解決した日時が返るのでユーザーに伝えてください。',
  RECORDING_INSTRUCTION_JA,
  '保存先はUniContextだけで、大学のシステムには何も送りません。会話で登録したものは「チャットで登録」、録音からのものは「録音から」と表示され、学務情報システムなどの値は変えられません（食い違えば食い違いとして表示）。課題の提出状態・成績・履修も変更できません。誤りは retract_addition で取り消せます（自分が追加したものだけ）。',
  'Register deadlines, to-dos and notes the student mentions or plans in any chat (add_deadline / add_task / add_note) so every other session and client sees them. Writes go to UniContext only (never to a university system) and cannot change authoritative data, task status or grades.',
  'Deadlines: absence in UniContext does not mean there is none. Read coverage (sources, health, gaps); when it is incomplete say so, treat unknown deadlines as possibly imminent, tell the student where to check, and never say there is no deadline or plenty of time without complete coverage.',
  RECORDING_INSTRUCTION_EN,
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
    {
      name: MCP_SERVER_NAME,
      title: 'UniContext',
      version: deps.version ?? DEFAULT_MCP_VERSION,
      description:
        '大学の時間割・課題・お知らせ・講義録を出典つきでまとめて渡す / One student’s university life, with sources',
      websiteUrl: 'https://github.com/satomasahiro2005/unicontext',
      ...(deps.icons ? { icons: deps.icons } : {}),
    },
    {
      instructions: remote
        ? deps.allowWrite
          ? REMOTE_WRITE_SERVER_INSTRUCTIONS
          : REMOTE_SERVER_INSTRUCTIONS
        : SERVER_INSTRUCTIONS,
    },
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
        return envelopeResult(compactEnvelope(buildEnvelope(out.data, out.options)), remote);
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

  /** Record tools (UniContext-only writes). Remote: only with the unicontext.write scope. */
  function writeTool<S extends z.ZodRawShape>(
    name: keyof typeof WRITE_TOOLS,
    meta: { outputShape: z.ZodRawShape; destructive?: boolean; openWorld?: boolean },
    shape: S,
    run: (
      args: z.infer<z.ZodObject<S>>,
    ) => Promise<{ structured: Record<string, unknown>; write?: ToolCallEvent['write'] }>,
  ): void {
    if (remote && !deps.allowWrite) return;
    const callback = async (args: unknown): Promise<CallToolResult> => {
      const started = Date.now();
      let write: ToolCallEvent['write'];
      let ok = false;
      try {
        const out = await run(args as z.infer<z.ZodObject<S>>);
        write = out.write;
        ok = true;
        if (write)
          logger.info('mcp write', {
            tool: name,
            status: write.status,
            additionId: write.additionId,
            entities: write.entityIds.length,
            facts: write.factIds.length,
          });
        return {
          content: [{ type: 'text', text: JSON.stringify(out.structured, null, remote ? 0 : 2) }],
          structuredContent: out.structured,
        };
      } catch (e) {
        return errorResult(e, logger, name, redactionOptions(uc));
      } finally {
        try {
          deps.onToolCall?.({
            tool: name,
            ok,
            ms: Date.now() - started,
            ...(write ? { write } : {}),
          });
        } catch (e) {
          logger.warn('mcp audit hook failed', { tool: name, error: errorMessage(e) });
        }
      }
    };
    server.registerTool(
      name,
      {
        title: WRITE_TOOLS[name].title,
        description: WRITE_TOOLS[name].description,
        inputSchema: shape,
        outputSchema: meta.outputShape,
        annotations: {
          readOnlyHint: false,
          destructiveHint: meta.destructive === true,
          idempotentHint: true,
          openWorldHint: meta.openWorld === true,
        },
      },
      callback as unknown as Parameters<typeof server.registerTool>[2],
    );
  }

  const caller = (): AdditionClient => {
    if (deps.client) return deps.client;
    const name = server.server.getClientVersion()?.name;
    return { id: `local:${name ?? 'unknown'}`, ...(name ? { name } : {}) };
  };
  const written = (r: AdditionResult) => ({
    structured: writeOutput(r),
    write: { status: r.status, ...r.audit },
  });

  const view = (name: ContextViewName, params: unknown = {}): ToolOutput => {
    const data = getView(uc.context, name, params);
    const hint = coverageHint(data);
    return { data, ...(hint ? { options: { hint } } : {}) };
  };

  // ----- views -----

  tool(
    'get_today',
    {
      title: '今日の予定',
      description:
        '今日の授業（教室・状態）、昨日以降の変更、締切、未提出の課題、重要なお知らせ、授業準備、情報源の食い違いをまとめて返す。「今日の授業は？」「今日やることは？」に使う。学期（前期・後期）は約8週ずつの前半・後半に分かれる: term.part は今が後期前半か後期後半か、各授業の termPart はその科目の期間（後期前半・後期後半だけの科目と、後期（前半・後半）の通しの科目がある）。 / Everything for today: classes (with room), changes, deadlines, tasks, important announcements, preparation and conflicts. Every item carries citations. Each term is split into halves of about 8 weeks (前半/後半): term.part is the current half, termPart on a class is the half(s) the course meets in. 締切の coverage（情報源・状態・欠け gaps）も返す: 欠けがあれば伝え、載っていないことを締切なしと扱わない。 / Includes deadline coverage (sources, health, gaps): an empty list is not "no deadline".',
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
        '今週（月曜始まり）の時間割・締切・試験・変更・食い違いを返す。学期（前期・後期）は約8週ずつの前半・後半に分かれる: term.part は今が後期前半か後期後半か、各授業の termPart はその科目の期間（後期前半・後期後半だけの科目と、後期（前半・後半）の通しの科目がある）。 / This week\'s timetable, deadlines, exams, changes and conflicts. Each term is split into halves of about 8 weeks (前半/後半): term.part is the current half, termPart on a class is the half(s) the course meets in. 締切の coverage（情報源・状態・欠け gaps）も返す: 欠けがあれば伝え、載っていないことを締切なしと扱わない。 / Includes deadline coverage (sources, health, gaps): an empty list is not "no deadline".',
    },
    {},
    () => view('week'),
  );

  tool(
    'get_course',
    {
      title: '科目の全体像',
      description:
        '1科目の全体像（担当・教室・授業のある期間 termPart（後期前半・後期後半・後期（前半・後半））・今後の授業・直近の講義・締切・お知らせ・資料・Teamsの投稿・フォルダごとのファイル・課題と提出状況・変更・食い違い）を全ソース統合で返す。courseOfferingId には id のほか「データベース」のような科目名や科目コードも使える。 / One course across all sources, including Teams posts (discussion), files with folders, and assignments with submission status. Accepts an id or a fuzzy title / course code. 締切の coverage（情報源・状態・欠け gaps）も返す: 欠けがあれば伝え、載っていないことを締切なしと扱わない。 / Includes deadline coverage (sources, health, gaps): an empty list is not "no deadline".',
    },
    { courseOfferingId: courseIdField },
    (a) => {
      const t = trimCourseForAi(
        getView(uc.context, 'course', { courseOfferingId: courseId(a.courseOfferingId) }),
      );
      const hint = [t.hint, coverageHint(t.data)].filter(Boolean).join(' ');
      return { data: t.data, ...(hint ? { options: { hint } } : {}) };
    },
  );

  tool(
    'get_teams_activity',
    {
      title: 'Teamsの最近の動き',
      description:
        'Teamsの最近の投稿・更新されたファイル・課題を返す（since 以降、既定は7日前から。course で科目を絞れる）。「Teamsで新しい投稿は？」「先生が資料を上げた？」に使う。 / Recent Teams posts, changed files and assignments since `since` (default 7 days ago), optionally for one course.',
    },
    {
      since: z
        .string()
        .optional()
        .describe(
          'ISO-8601 日時または YYYY-MM-DD。省略時は7日前 / ISO datetime or YYYY-MM-DD (default: 7 days ago)',
        ),
      course: courseIdField.optional(),
    },
    (a) =>
      view(
        'teams-activity',
        opt({
          since: a.since === undefined ? undefined : normalizeSince(uc, a.since),
          courseOfferingId: courseId(a.course),
        }),
      ),
  );

  tool(
    'list_course_files',
    {
      title: '科目のファイル一覧',
      description:
        '1科目の共有ファイル（Teamsのファイルなど）を、フォルダ単位で返す。path を省略するとルート、path にフォルダ名（例: 00_講義資料）を渡すとその中のサブフォルダとファイルを返す。 / Files of one course (e.g. the Teams file library) by folder: subfolders with file counts and the files directly in `path` (default: root).',
    },
    {
      course: courseIdField,
      path: z
        .string()
        .optional()
        .describe(
          'フォルダのパス（例: 00_講義資料/sub）。省略時はルート / Folder path (default: root)',
        ),
    },
    (a) => view('course-files', opt({ courseOfferingId: courseId(a.course), path: a.path })),
  );

  tool(
    'get_deadlines',
    {
      title: '締切一覧',
      description:
        '期限切れと今後の締切を返す（days 日先まで、既定15日）。「今週の締切は？」「レポートはいつまで？」に使う。 / Overdue and upcoming deadlines. 締切の coverage（情報源・状態・欠け gaps）も返す: 欠けがあれば伝え、載っていないことを締切なしと扱わない。 / Includes deadline coverage (sources, health, gaps): an empty list is not "no deadline".',
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
        'お知らせ1件の全文（本文・差出人・分類・添付ファイル名・本文中のリンク・対象講義・対象日・既読/未読）を返す。id は get_announcements や search の結果の id（announcement:...）。LiveCampusUの未読のお知らせは本文を取得していないことがあり（bodyStatus が notOpened）、その場合 body は空。本人がLiveCampusUで読むか、本人の了承を得て open_announcement で取得する（LiveCampusUで既読になる）と読める。 / Full text of one announcement by id (announcement:...), with sender, category, attachments, links, target courses and date, read state. Unread LiveCampusU notices may have an empty body (bodyStatus "notOpened") until the student reads them there.',
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
    .describe(
      'pending | in_progress | submitted | completed | cancelled | unknown | expired_past_term（配列可）',
    );
  const includePastField = z
    .boolean()
    .optional()
    .describe(
      '終了した学期の未提出課題（expired_past_term）も含める。既定は含めない / Include unfinished work of terms that have ended (default: no)',
    );
  const toStatuses = (s: TaskStatus | TaskStatus[] | undefined): TaskStatus[] | undefined =>
    s === undefined ? undefined : Array.isArray(s) ? s : [s];

  tool(
    'get_assignments',
    {
      title: '課題一覧',
      description:
        '課題・レポート・提出物の一覧（締切順）。既定は未完了のみで、includeCompleted=true で提出済み・完了も含める。status "submitted" は提出システムが確認した場合にのみ付く（AI は提出済みにできない）。終了した学期の未提出課題（expired_past_term）は既定で出さず、includePast=true で含める。 / Assignments sorted by due date. Default: open only, without unfinished work of ended terms (includePast=true adds it). Task status `submitted` can only come from the submission system.',
    },
    {
      courseOfferingId: courseIdField.optional(),
      status: statusInput,
      includeCompleted: z.boolean().optional(),
      includePast: includePastField,
    },
    (a) => {
      const filter: AssignmentFilter = opt({
        courseOfferingId: courseId(a.courseOfferingId),
        statuses: toStatuses(a.status),
        includeCompleted: a.includeCompleted,
        includePast: a.includePast,
      });
      return { data: { assignments: buildAssignments(uc, filter) } };
    },
  );

  tool(
    'get_tasks',
    {
      title: 'タスク一覧',
      description:
        'やること全般（課題・試験準備・お知らせから抽出した締切・本人が作ったタスク）。status で絞れる。省略時は取り消しと終了した学期（expired_past_term）以外すべて。 / All tasks (assignments, exam preparation, extracted deadlines, manual). Default: everything except cancelled and ended-term work (includePast=true adds it).',
    },
    {
      status: statusInput,
      courseOfferingId: courseIdField.optional(),
      includePast: includePastField,
    },
    (a) => {
      const filter: AssignmentFilter = opt({
        courseOfferingId: courseId(a.courseOfferingId),
        statuses:
          toStatuses(a.status) ??
          ALL_TASK_STATUSES.filter(
            (s) => s !== 'cancelled' && (a.includePast === true || s !== PAST_TERM_STATUS),
          ),
        includePast: a.includePast,
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

  // ----- class files (Teams/SharePoint): download on request -----

  tool(
    'download_course_file',
    {
      title: '授業ファイルのダウンロード',
      description:
        '授業のTeams/SharePointのファイル（get_courseやsearchの結果のdocument:…のid、または「科目名/フォルダ/ファイル名」）を本人のPCにダウンロードし、保存先のパス・サイズ・更新日時と、抽出した本文（PDF/Word/PowerPoint/テキスト、[p.N]・[スライドN]の印つき）を返す。大学側には何も変更しない（読み取りのみ）。本文は検索（search）でも引けるようになる。 / Download a class file (document id or "<course>/<path>") to the student’s computer; returns the local path, metadata and the extracted text with page/slide markers. Read-only at the source; the text becomes searchable.',
      remoteDescription:
        '授業のTeams/SharePointのファイル（get_courseやsearchの結果のdocument:…のid、または「科目名/フォルダ/ファイル名」）を取得し、抽出した本文（PDF/Word/PowerPoint/テキスト、[p.N]・[スライドN]の印つき、maxCharsで打ち切り）を返す。link=trueのときは、この接続（同じOAuthクライアント）だけが約10分間ダウンロードできるリンクも返す。大学側には何も変更しない。 / Fetch a class file and return its extracted text (page/slide markers, truncated at maxChars); link=true also returns a ~10-minute download link valid for this OAuth client only. Read-only at the source.',
    },
    {
      file: z
        .string()
        .min(1)
        .max(1000)
        .describe('document:…/material:…のid、または「科目名/フォルダ/ファイル名」'),
      includeText: z
        .boolean()
        .optional()
        .describe('抽出した本文を返す（既定true） / Return the extracted text (default true)'),
      maxChars: z
        .number()
        .int()
        .min(200)
        .max(100_000)
        .optional()
        .describe('本文の最大文字数（既定20000） / Max characters of text (default 20000)'),
      ...(remote
        ? {
            link: z
              .boolean()
              .optional()
              .describe(
                '約10分有効のダウンロードリンクも返す（この接続のみ） / Also return a ~10-minute download link (this client only)',
              ),
          }
        : {}),
    },
    async (a) => {
      const includeText = a.includeText !== false;
      const run =
        deps.downloadFiles ??
        ((refs: string[], o: { extract: boolean }) => {
          if (!deps.filesDir) throw new ValidationError('file downloads are not available here');
          return downloadCourseFiles(uc, refs, { filesDir: deps.filesDir, extract: o.extract });
        });
      const report = await run([a.file.trim()], { extract: true });
      const r = report.results[0];
      if (!r || r.status === 'notFound') throw new NotFoundError(r?.error ?? `file ${a.file}`);
      const ok = r.status === 'downloaded' || r.status === 'cached';
      // The remote client cannot use a path on this computer.
      const { path: localPath, ref: _ref, ...meta } = r;
      const file = remote ? meta : { ...meta, ...(localPath ? { path: localPath } : {}) };
      const text = ok && includeText ? fileTextExcerpt(uc, r.id, a.maxChars ?? 20_000) : undefined;
      const wantsLink = remote && (a as { link?: boolean }).link === true;
      const link = ok && wantsLink ? deps.fileLink?.(r.id) : undefined;
      return {
        data: {
          file,
          ...(text
            ? {
                text: {
                  excerpt: text.text,
                  truncated: text.truncated,
                  chunks: text.chunks,
                  totalChars: text.totalChars,
                },
              }
            : {}),
          ...(link ? { link } : {}),
          ...(wantsLink && !link ? { linkUnavailable: true } : {}),
          ...(report.warnings.length ? { warnings: report.warnings } : {}),
          citations: uc.context.citationsFor([r.id]),
        },
      };
    },
  );

  // ----- VPN file share (Ivanti portal): browse / search / recent from the local index -----

  const vpnCitations = (ids: string[]): Citation[] =>
    ids.length ? uc.context.citationsFor(ids) : [];

  tool(
    'browse_vpn_files',
    {
      title: 'VPNファイル共有をたどる',
      description:
        '静岡大学 情報学部の SSL-VPN ファイル共有を、UniContext のローカル索引から（ライブのポータルに触れずに）たどる。root を省略すると最上位（共有の一覧）、root と path を渡すとそのフォルダの直下のサブフォルダ（各フォルダの最後に一覧できた時刻つき）とファイル（document:… の id は download_course_file でダウンロードできる）を返す。path は共有ルートからの相対パス。 / Browse the VPN file share from the local index (never the live portal). Omit root for the top level; pass root and path for a folder’s subfolders (with each folder’s last-listed time) and files (document ids are downloadable via download_course_file).',
    },
    {
      root: z.string().optional().describe('ルートのキー（例: fs-share）。省略時は最上位'),
      path: z
        .string()
        .optional()
        .describe('共有ルートからの相対パス（例: class/2026…）。省略時はルート直下'),
      source: z.string().optional().describe('ソースID（複数のVPNソースがあるとき）'),
      limit: z.number().int().positive().max(1000).optional().describe('最大件数（既定200）'),
      offset: z.number().int().nonnegative().optional().describe('ページング用オフセット'),
    },
    (a) => {
      const r = browseVpnFiles(
        uc,
        opt({ source: a.source, root: a.root, path: a.path, limit: a.limit, offset: a.offset }),
      );
      return { data: { ...r, citations: vpnCitations(r.files.map((f) => f.id)) } };
    },
  );

  tool(
    'search_vpn_files',
    {
      title: 'VPNファイル共有を検索',
      description:
        'VPNファイル共有の索引を、ファイル名・フォルダ名・パスの部分一致で検索する（ローカル索引・ライブに触れない）。year で年度、course で科目名（best-effortで対応づけた科目）で絞れる。各ファイルの id は download_course_file でダウンロード・本文取得できる。 / Search the VPN file-share index by file/folder name or path substring (local index). Optional year and course filters. File ids download via download_course_file.',
    },
    {
      query: z.string().min(1).max(200).describe('名前・パスの一部'),
      year: z.number().int().optional().describe('年度（例: 2026）'),
      course: z.string().optional().describe('科目名の一部（best-effortで対応づけた科目で絞る）'),
      root: z.string().optional(),
      source: z.string().optional(),
      limit: z.number().int().positive().max(200).optional().describe('最大件数（既定30）'),
    },
    (a) => {
      const r = searchVpnFiles(
        uc,
        opt({ query: a.query, year: a.year, course: a.course, root: a.root, source: a.source, limit: a.limit }),
      );
      return { data: { ...r, citations: vpnCitations(r.files.map((f) => f.id)) } };
    },
  );

  tool(
    'list_recent_vpn_files',
    {
      title: 'VPNファイル共有の最近のファイル',
      description:
        'VPNファイル共有で最近追加・更新されたファイルを新しい順に返す（ローカル索引・ライブに触れない）。 / Recently added or updated files in the VPN file share, newest first (local index).',
    },
    {
      since: z
        .string()
        .optional()
        .describe('ISO-8601 日時または YYYY-MM-DD 以降 / ISO datetime or YYYY-MM-DD'),
      root: z.string().optional(),
      source: z.string().optional(),
      limit: z.number().int().positive().max(200).optional().describe('最大件数（既定20）'),
    },
    (a) => {
      const r = recentVpnFiles(
        uc,
        opt({
          since: a.since === undefined ? undefined : normalizeSince(uc, a.since),
          root: a.root,
          source: a.source,
          limit: a.limit,
        }),
      );
      return { data: { ...r, citations: vpnCitations(r.files.map((f) => f.id)) } };
    },
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

  tool('get_notes', GET_NOTES_TOOL, getNotesShape, (a): ToolOutput => ({
    data: uc.additions.notes(
      opt({
        courseOfferingId: courseId(a.course),
        personal: a.personal,
        query: a.query,
        id: a.id?.trim(),
        limit: a.limit,
      }),
    ),
  }));

  // ----- record tools: deadlines, to-dos and notes from any chat or a recording, UniContext only -----

  writeTool(
    'ingest_lecture',
    { outputShape: INGEST_RESULT_SHAPE },
    ingestLectureShape,
    async (a) => {
      const r = await uc.additions.ingestLecture(caller(), {
        courseOfferingId: courseIdForWrite(uc, a.course),
        lectureDate: a.lectureDate,
        period: a.period,
        title: a.title,
        summary: a.summary,
        keyPoints: a.keyPoints,
        segments: a.segments,
        recordingRef: a.recordingRef,
        source: a.source,
        deadlines: a.deadlines,
        tasks: a.tasks,
        notes: a.notes,
      });
      const ropts = redactionOptions(uc);
      const structured = ingestOutput(r, (s) => redact(s, ropts) as string);
      const parts = [r.lecture, ...r.items];
      return {
        structured,
        write: {
          status: String(structured.outcome),
          additionId: r.lecture.result?.addition.id ?? '',
          entityIds: [...new Set(parts.flatMap((x) => x.result?.audit.entityIds ?? []))],
          factIds: [...new Set(parts.flatMap((x) => x.result?.audit.factIds ?? []))],
        },
      };
    },
  );

  writeTool('record_lecture', { outputShape: WRITE_RESULT_SHAPE }, recordLectureShape, async (a) =>
    written(
      await uc.additions.recordLecture(caller(), {
        courseOfferingId: courseIdForWrite(uc, a.course),
        date: a.date,
        period: a.period,
        title: a.title,
        summary: a.summary,
        keyPoints: a.keyPoints,
        transcriptExcerpt: a.transcriptExcerpt,
        segments: a.segments,
        recordingTimestamp: a.recordingTimestamp,
        via: a.via,
        source: a.source,
        idempotencyKey: a.idempotencyKey,
      }),
    ),
  );

  writeTool('add_deadline', { outputShape: WRITE_RESULT_SHAPE }, addDeadlineShape, async (a) =>
    written(
      await uc.additions.addDeadline(caller(), {
        courseOfferingId: courseIdForWrite(uc, a.course),
        title: a.title,
        dueAt: a.dueAt,
        kind: a.kind,
        evidence: a.evidence,
        via: a.via,
        recordingTimestamp: a.recordingTimestamp,
        lectureDate: a.lectureDate,
        notes: a.notes,
        source: a.source,
        idempotencyKey: a.idempotencyKey,
      }),
    ),
  );

  writeTool('add_note', { outputShape: WRITE_RESULT_SHAPE }, addNoteShape, async (a) =>
    written(
      await uc.additions.addNote(caller(), {
        courseOfferingId: courseIdForWrite(uc, a.course),
        title: a.title,
        text: a.text,
        evidence: a.evidence,
        via: a.via,
        lectureDate: a.lectureDate,
        recordingTimestamp: a.recordingTimestamp,
        source: a.source,
        idempotencyKey: a.idempotencyKey,
      }),
    ),
  );

  writeTool('add_task', { outputShape: WRITE_RESULT_SHAPE }, addTaskShape, async (a) =>
    written(
      await uc.additions.addTask(caller(), {
        courseOfferingId: courseIdForWrite(uc, a.course),
        title: a.title,
        dueAt: a.dueAt,
        notes: a.notes,
        evidence: a.evidence,
        via: a.via,
        lectureDate: a.lectureDate,
        recordingTimestamp: a.recordingTimestamp,
        source: a.source,
        idempotencyKey: a.idempotencyKey,
      }),
    ),
  );

  writeTool(
    'list_my_additions',
    { outputShape: LIST_RESULT_SHAPE },
    listAdditionsShape,
    async (a) => {
      const statuses = toAdditionStatuses(a.status);
      const list = uc.additions.listFor(caller(), {
        ...(statuses ? { statuses } : {}),
        ...(a.limit ? { limit: a.limit } : {}),
        ...(a.ingestionId ? { ingestionId: a.ingestionId } : {}),
      });
      return {
        structured: {
          additions: list.map(compactAddition),
          answerHint:
            list.length === 0
              ? 'この接続から追加した内容はありません。'
              : 'この接続から追加した内容です。unconfirmed は本人がまだ確認していないもの、confirmed は本人が確認したものです。',
        },
      };
    },
  );

  // Changes state in LiveCampusU (read mark): destructive, open world, never during a sync.
  writeTool(
    'open_announcement',
    { outputShape: OPEN_ANNOUNCEMENT_RESULT_SHAPE, destructive: true, openWorld: true },
    openAnnouncementShape,
    async (a) => {
      const ids = a.ids.map((x) => x.trim());
      for (const id of ids)
        if (!isIdOf('announcement', id))
          throw new ValidationError(`not an announcement id: ${id} (use get_announcements)`);
      const report = await (deps.openAnnouncements ?? ((x) => openAnnouncementsInProcess(uc, x)))(
        ids,
      );
      const marked = report.markedReadAtSource;
      return {
        structured: {
          results: report.results,
          opened: report.opened,
          markedReadAtSource: marked,
          answerHint:
            report.opened === 0
              ? '本文を取得したお知らせはありません（status を確認してください）。'
              : `${report.opened}件の本文を取得しました${marked > 0 ? `（うち${marked}件はLiveCampusUで既読になりました）` : ''}。get_announcement で本文を読めます。UniContextでは本人が読むまで未読のままです。`,
        },
        write: {
          status: 'opened',
          additionId: '',
          entityIds: report.results.filter((r) => r.status === 'opened').map((r) => r.id),
          factIds: [],
        },
      };
    },
  );

  writeTool(
    'retract_addition',
    { outputShape: WRITE_RESULT_SHAPE, destructive: true },
    retractAdditionShape,
    async (a) => written(await uc.additions.retract(caller(), a.additionId.trim())),
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
