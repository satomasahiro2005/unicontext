import type {
  Citation,
  CourseRef,
  DetailFetchReport,
  UniContext,
} from '@unicontext/context-engine';
import { errorMessage, ValidationError } from '@unicontext/core';
import type { RawItemRecord } from '@unicontext/database';
import { z } from 'zod';
import {
  buildAssignmentDetail,
  ED_LESSON_TYPES,
  resolveAssignmentRef,
  type LessonView,
} from './assignment-detail.js';
import type { ToolRegistrar } from './refresh.js';

/*
 * verify_submission: right after the student says they handed something in, re-read that ONE
 * assignment's submission state from its submission system now (not the scheduled sync, and not
 * skipped because the source is "fresh") and say what was submitted: the answers and the names of
 * the files. A file's content is fetched only when get_document opens it (the documentId here).
 *
 * Read-only at every source: Ed (the lesson's progress, its quiz slides and the student's saved
 * answers, through the edstem-mcp read tools), LiveCampusU (the 課題・アンケートリスト row: 提出済 /
 * 未提出; the 課題提出 screen and every download stay denied), Teams (the Assignments app's list of
 * the student's work; assignments are never opened). One live read per assignment at a time: a
 * call while it runs waits for that same read (also after an earlier caller stopped waiting), and
 * the next read starts no sooner than VERIFY_SUBMISSION_INTERVAL_MS after the previous one
 * finished; a repeat inside that window answers with the read just made.
 */

/** The next live read of an assignment starts at least this long after the previous one finished. */
export const VERIFY_SUBMISSION_INTERVAL_MS = 30_000;
/** How long the tool waits for the live read before answering with what is stored. */
export const VERIFY_SUBMISSION_WAIT_MS = 45_000;
/**
 * A read still running after this long is no longer joined (its connector never answered), so the
 * assignment can be read again. Far above a Teams boot (90 s) plus a sync it waits behind.
 */
export const VERIFY_SUBMISSION_STALE_MS = 10 * 60_000;
/** Longest question prompt echoed next to an answer. */
const PROMPT_CHARS = 120;

/**
 * Raw types whose on-request read is only the submission state (no assignment content):
 * get_assignment does not read these live, verify_submission does.
 */
export const SUBMISSION_STATE_ONLY_TYPES: ReadonlySet<string> = new Set([
  'lcu.assignment',
  'teamsweb.assignment',
]);

export type SubmissionPlatform = 'edstem' | 'livecampusu' | 'teams' | 'other';

export type LiveReadStatus =
  | 'fetched'
  | 'alreadyFetched'
  | 'recent'
  | 'queued'
  | 'notFound'
  | 'unsupported'
  | 'timeout'
  | 'failed';

export interface SubmittedFileView {
  /** Open it with get_document (the content is fetched then, not before). */
  documentId: string;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  /** 質問<n> the file belongs to (Ed). */
  question?: number;
  savedAt?: string;
}

export interface SubmittedAnswerView {
  /** Slide position in the lesson (Ed). */
  slide: number;
  slideTitle?: string;
  /** 質問<n>. */
  question: number;
  prompt: string;
  text?: string;
  /** Chosen options (1-based) with their text. */
  choices?: { number: number; text?: string }[];
  savedAt?: string;
  /** Ed's marking, when it has marked it. */
  correct?: boolean;
}

export interface VerifySubmissionView {
  assignment: {
    id: string;
    title: string;
    course: CourseRef | undefined;
    dueAt: string | undefined;
    url: string | undefined;
    platform: SubmissionPlatform;
    citations: Citation[];
  };
  submission: {
    /** UniContext status: submitted / late / graded / returned / not_submitted (undefined: unknown). */
    status: string | undefined;
    submitted: boolean | undefined;
    submittedAt?: string;
    /** As the source shows it (Ed progress, LiveCampusU 提出済 / 未提出, Teams status). */
    sourceStatus?: string;
    /** When this state was read from the source. */
    checkedAt: string | undefined;
    /** Ed: questions with a saved answer / all questions of the lesson's quiz slides. */
    answeredQuestions?: { answered: number; total: number };
    /** Ed: the latest time an answer was saved. */
    lastAnswerAt?: string;
    /** LiveCampusU: 受付中 / 締切 and the 提出期間. */
    acceptance?: string;
    period?: string;
    score?: number;
  };
  /** How the live read went (`recent`: read again less than 30 s ago, that read is shown). */
  live: { status: LiveReadStatus; at?: string; error?: string; retryAfterSeconds?: number };
  /** What was submitted (Ed: the saved answers of each question). */
  answers?: SubmittedAnswerView[];
  /** Submitted files (names only; get_document opens one). */
  files: SubmittedFileView[];
  /** Ed: progress of each quiz slide. */
  slides?: { number: number; title?: string; status?: string }[];
  /** What this source does not let UniContext confirm. */
  limits: string[];
}

export const verifySubmissionShape = {
  id: z
    .string()
    .min(1)
    .max(200)
    .describe(
      '課題の id（assignment:… / task:…、または Ed の設問・スライドの document:…） / An assignment or task id',
    ),
};

export const VERIFY_SUBMISSION_TOOL = {
  title: '提出の確認',
  description:
    '課題1件の提出状態を、その提出先（Ed・学務情報システム・Teams）から今すぐ読み直して確かめる（自動の更新を待たない・新しさで飛ばさない）。提出済みか、提出日時、提出した内容（Ed なら各設問に保存された回答の本文・選んだ選択肢）、提出したファイルの名前・種類（files[].documentId を get_document に渡すと中身を開ける。中身はそのとき初めて取得）を返す。学生が「出した」「提出した」と言ったら、この課題の id でこれを呼ぶ。同じ課題を読み直すのは一度に1回で、前の読み直しが終わってから30秒たつまで次は読まない（それより早いと直前に読んだ結果を返す）。大学の画面には何も送信しない（提出・保存・既読化はしない）。 / Re-read ONE assignment’s submission state from its submission system now (Ed, LiveCampusU, Teams), regardless of the sync schedule: whether it is submitted, when, what was submitted (Ed: each question’s saved answer) and the submitted files’ names and types (pass files[].documentId to get_document to open one; content is fetched only then). Call it whenever the student says they handed something in. One live read per assignment at a time, and the next no sooner than 30 s after it finished (a repeat returns that read). Read-only: never submits, saves or marks anything.',
} as const;

/** One sentence for the server instructions. */
export const VERIFY_SUBMISSION_INSTRUCTION_JA =
  '学生が課題を「出した」「提出した」と言ったら、その課題の id で verify_submission を呼び、提出先から読み直した提出状態（提出済みか・提出日時）と、提出した内容（回答の本文・ファイル名）を見せてください。ファイルの中身を確かめたいと言われたら files[].documentId を get_document で開きます。verify_submission を呼ばずに「提出を確認できません」と言わないでください（呼んでも分からないことは limits のとおり伝え、提出先の URL を添える）。提出・再提出は本人が提出先で行います。';
export const VERIFY_SUBMISSION_INSTRUCTION_EN =
  'When the student says they submitted an assignment, call verify_submission with its id and show the re-read state (submitted or not, when) and what was submitted (answer text, file names); open a file with get_document (files[].documentId) when they want to check its content. Never say a submission cannot be confirmed without having called verify_submission; state its limits and the source URL instead. Submitting is done by the student at the source.';

interface LiveOutcome {
  status: LiveReadStatus;
  at: string;
  error?: string;
}

/** The read of one assignment that is running now (the connector's own promise, not a wait). */
interface InflightRead {
  seq: number;
  /** Settles when the connector's read settles, however long that takes. */
  done: Promise<LiveOutcome>;
  startedAt: string;
  startedMs: number;
}

interface VerifyState {
  /** The last finished read of each assignment; atMs is when it finished. */
  last: Map<string, { atMs: number; outcome: LiveOutcome }>;
  inflight: Map<string, InflightRead>;
  seq: number;
}

const STATES = new WeakMap<UniContext, VerifyState>();

function stateOf(uc: UniContext): VerifyState {
  let s = STATES.get(uc);
  if (!s) {
    s = { last: new Map(), inflight: new Map(), seq: 0 };
    STATES.set(uc, s);
  }
  return s;
}

type Json = Record<string, unknown>;
function obj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** The raw item the assignment came from (its submission system), newest first. */
function primaryRaw(uc: UniContext, assignmentId: string): RawItemRecord | undefined {
  const stores = uc.sync.stores;
  const raws = stores.sourceRefs
    .forEntity(assignmentId)
    .map((r) => (r.rawItemId ? stores.raw.get(r.rawItemId) : undefined))
    .filter((r): r is RawItemRecord => r !== undefined && !r.deletedAt);
  const known = raws.find(
    (r) => r.sourceType === ED_LESSON_TYPES.lesson || SUBMISSION_STATE_ONLY_TYPES.has(r.sourceType),
  );
  return known ?? raws[0];
}

function platformOf(raw: RawItemRecord | undefined): SubmissionPlatform {
  if (!raw) return 'other';
  if (raw.sourceType === ED_LESSON_TYPES.lesson) return 'edstem';
  if (raw.sourceType === 'lcu.assignment') return 'livecampusu';
  if (raw.sourceType === 'teamsweb.assignment') return 'teams';
  return 'other';
}

/**
 * Start the connector's read of one assignment. The entry stays in `inflight` until that read
 * settles (also after every caller stopped waiting for it), and `last` records when it finished.
 */
function startRead(
  uc: UniContext,
  state: VerifyState,
  assignmentId: string,
  fetchDetails: (ids: string[]) => Promise<DetailFetchReport>,
): InflightRead {
  const startedMs = uc.clock.now().getTime();
  state.seq += 1;
  const seq = state.seq;
  const read = async (): Promise<LiveOutcome> => {
    let outcome: LiveOutcome;
    try {
      // started a tick later, so the entry is in `inflight` even when fetchDetails throws at once
      const report = await Promise.resolve().then(() => fetchDetails([assignmentId]));
      const r = report.results.find((x) => x.id === assignmentId);
      outcome = {
        status: r?.status ?? 'failed',
        at: uc.clock.now().toISOString(),
        ...(r?.error ? { error: r.error } : {}),
      };
    } catch (e) {
      outcome = { status: 'failed', at: uc.clock.now().toISOString(), error: errorMessage(e) };
    }
    state.last.set(assignmentId, { atMs: uc.clock.now().getTime(), outcome });
    // a read that went stale may finish after a newer one started: leave that one in place
    if (state.inflight.get(assignmentId)?.seq === seq) state.inflight.delete(assignmentId);
    return outcome;
  };
  const entry = { seq, done: read(), startedAt: new Date(startedMs).toISOString(), startedMs };
  state.inflight.set(assignmentId, entry);
  return entry;
}

/**
 * Live read of one assignment through its connector, rate-limited per assignment: one read at a
 * time (a call while one runs waits for that same read), and the next one no sooner than
 * VERIFY_SUBMISSION_INTERVAL_MS after the previous one finished. The caller waits at most waitMs;
 * the read goes on in the background after that.
 */
async function liveRead(
  uc: UniContext,
  assignmentId: string,
  fetchDetails: (ids: string[]) => Promise<DetailFetchReport>,
  waitMs: number,
): Promise<LiveOutcome & { retryAfterSeconds?: number }> {
  const state = stateOf(uc);
  const nowMs = uc.clock.now().getTime();
  let entry = state.inflight.get(assignmentId);
  if (entry && nowMs - entry.startedMs >= VERIFY_SUBMISSION_STALE_MS) {
    // the connector never answered: stop joining it so the assignment can be read again
    state.inflight.delete(assignmentId);
    entry = undefined;
  }
  if (!entry) {
    const last = state.last.get(assignmentId);
    if (last && nowMs - last.atMs < VERIFY_SUBMISSION_INTERVAL_MS) {
      const retry = Math.ceil((VERIFY_SUBMISSION_INTERVAL_MS - (nowMs - last.atMs)) / 1000);
      return last.outcome.status === 'fetched' || last.outcome.status === 'alreadyFetched'
        ? { ...last.outcome, status: 'recent', retryAfterSeconds: retry }
        : { ...last.outcome, retryAfterSeconds: retry };
    }
    entry = startRead(uc, state, assignmentId, fetchDetails);
  }
  const { done, startedAt } = entry;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      done,
      new Promise<LiveOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'timeout', at: startedAt }), waitMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Files and images the student put into the lesson's saved answers (mapping: edKind response-file). */
function edResponseFiles(uc: UniContext, lessonRaw: RawItemRecord): SubmittedFileView[] {
  const stores = uc.sync.stores;
  const lessonId = Number(lessonRaw.externalId);
  const out = new Map<string, SubmittedFileView>();
  const responses = stores.raw
    .list({ sourceId: lessonRaw.sourceId, sourceTypes: [ED_LESSON_TYPES.response] })
    .filter((r) => !r.deletedAt && num(obj(obj(r.payload)._parent).lessonId) === lessonId);
  const questionNumbers = new Map<number, number>();
  for (const q of stores.raw
    .list({ sourceId: lessonRaw.sourceId, sourceTypes: [ED_LESSON_TYPES.question] })
    .filter((r) => num(obj(obj(r.payload)._parent).lessonId) === lessonId)) {
    const p = obj(q.payload);
    const id = num(p.id);
    const n = num(p.number);
    if (id !== undefined && n !== undefined) questionNumbers.set(id, n);
  }
  for (const r of responses) {
    for (const ref of stores.sourceRefs.byRawItem(r.id)) {
      if (!ref.entityId) continue;
      const doc = stores.entities.getOfKind('document', ref.entityId);
      if (!doc || obj(doc.extra).edKind !== 'response-file') continue;
      const qid = num(obj(r.payload).questionId);
      const question = qid !== undefined ? questionNumbers.get(qid) : undefined;
      const savedAt = str(obj(r.payload).createdAt);
      out.set(doc.id, {
        documentId: doc.id,
        name: doc.title,
        ...(doc.mimeType ? { mimeType: doc.mimeType } : {}),
        ...(doc.sizeBytes !== undefined ? { sizeBytes: doc.sizeBytes } : {}),
        ...(question !== undefined ? { question } : {}),
        ...(savedAt ? { savedAt } : {}),
      });
    }
  }
  return [...out.values()];
}

function edAnswers(lesson: LessonView): {
  answers: SubmittedAnswerView[];
  total: number;
  lastAnswerAt: string | undefined;
} {
  const answers: SubmittedAnswerView[] = [];
  let total = 0;
  let lastAnswerAt: string | undefined;
  for (const s of lesson.slides) {
    for (const q of s.questions ?? []) {
      total += 1;
      const a = q.myAnswer;
      if (!a) continue;
      if (a.savedAt && (!lastAnswerAt || a.savedAt > lastAnswerAt)) lastAnswerAt = a.savedAt;
      answers.push({
        slide: s.number,
        ...(s.title ? { slideTitle: s.title } : {}),
        question: q.number,
        prompt: truncate(q.prompt, PROMPT_CHARS),
        ...(a.text ? { text: a.text } : {}),
        ...(a.choices
          ? {
              choices: a.choices.map((n) => {
                const text = q.choices?.[n - 1];
                return { number: n, ...(text ? { text } : {}) };
              }),
            }
          : {}),
        ...(a.savedAt ? { savedAt: a.savedAt } : {}),
        ...(a.correct !== undefined ? { correct: a.correct } : {}),
      });
    }
  }
  return { answers, total, lastAnswerAt };
}

const SUBMITTED = new Set(['submitted', 'late', 'graded', 'returned']);

/**
 * The submission state and what was submitted, from what is stored (call after the live read).
 * `live` describes how the live read went.
 */
export function buildSubmissionView(
  uc: UniContext,
  assignmentId: string,
  live: VerifySubmissionView['live'],
): VerifySubmissionView {
  const stores = uc.sync.stores;
  const detail = buildAssignmentDetail(uc, assignmentId);
  const raw = primaryRaw(uc, assignmentId);
  const platform = platformOf(raw);
  const submission = stores.entities
    .list('submission', { where: { assignmentId } })
    .sort((x, y) => (y.submittedAt ?? '').localeCompare(x.submittedAt ?? ''))[0];
  const status = submission?.status ?? detail.assignment.submissionStatus;
  const liveOk =
    live.status === 'fetched' || live.status === 'alreadyFetched' || live.status === 'recent';
  const checkedAt = liveOk && live.at ? live.at : (raw?.fetchedAt ?? undefined);
  const view: VerifySubmissionView = {
    assignment: {
      id: detail.assignment.id,
      title: detail.assignment.title,
      course: detail.assignment.course,
      dueAt: detail.assignment.dueAt,
      url: detail.assignment.url,
      platform,
      citations: detail.assignment.citations,
    },
    submission: {
      status,
      submitted: status === undefined ? undefined : SUBMITTED.has(status),
      ...(submission?.submittedAt ? { submittedAt: submission.submittedAt } : {}),
      ...(submission?.score !== undefined ? { score: submission.score } : {}),
      checkedAt,
    },
    live,
    files: [],
    limits: [],
  };
  const p = obj(raw?.payload);

  if (platform === 'edstem' && raw && detail.lesson) {
    const lesson = detail.lesson;
    if (lesson.progress) view.submission.sourceStatus = lesson.progress;
    const { answers, total, lastAnswerAt } = edAnswers(lesson);
    view.answers = answers;
    if (total > 0) view.submission.answeredQuestions = { answered: answers.length, total };
    if (lastAnswerAt) view.submission.lastAnswerAt = lastAnswerAt;
    view.files = edResponseFiles(uc, raw);
    const quiz = lesson.slides.filter((s) => s.questions?.length || s.type === 'quiz');
    if (quiz.length > 0)
      view.slides = quiz.map((s) => ({
        number: s.number,
        ...(s.title ? { title: s.title } : {}),
        ...(s.status ? { status: s.status } : {}),
      }));
    view.limits.push(
      'Ed はレッスンを提出した日時を返しません（回答ごとの保存日時 savedAt / lastAnswerAt はあります）。',
    );
    if (lesson.slides.some((s) => s.type === 'code' || s.type === 'postgres'))
      view.limits.push(
        'コード・SQL のスライドに提出したプログラムは読めません（Ed のレッスン画面で確認してください）。',
      );
    if (!view.submission.submitted && total > 0 && answers.length === total)
      view.limits.push(
        'すべての設問に回答が保存されていますが、Ed ではレッスンがまだ完了（completed）になっていません（未閲覧のスライドがあるなど）。',
      );
  } else if (platform === 'livecampusu') {
    const st = str(p.submittalStatus);
    if (st) view.submission.sourceStatus = st;
    const acceptance = str(p.statusName);
    if (acceptance) view.submission.acceptance = acceptance;
    const period = str(p.submittalTerm);
    if (period) view.submission.period = period;
    view.limits.push(
      '学務情報システムで分かるのは課題一覧の「提出済 / 未提出」だけです。提出日時・提出した本文やファイルは、課題提出画面を開かない方針（提出画面とファイル取得はコネクタ方針で禁止）のため確かめられません。中身は本人が学務情報システムの課題提出画面で確認してください。',
    );
  } else if (platform === 'teams') {
    const sub = obj(Array.isArray(p.submissions) ? p.submissions[0] : undefined);
    const st = str(sub.status);
    if (st) view.submission.sourceStatus = st;
    const submittedAt = str(sub.submittedDateTime);
    if (submittedAt && !view.submission.submittedAt) view.submission.submittedAt = submittedAt;
    view.limits.push(
      'Teams の課題一覧には提出したファイルの一覧が含まれず、UniContext は課題を開きません（開くと先生側に閲覧の記録が残るため）。提出したファイルは Teams の課題画面（assignment.url）で確認してください。',
    );
  } else {
    view.limits.push(
      'この課題は提出先のシステムから取り込んだものではないため、提出状態を読み直せません。提出先で確認してください。',
    );
  }
  return view;
}

function hintFor(v: VerifySubmissionView): string {
  const parts: string[] = [];
  const live = v.live;
  if (live.status === 'timeout')
    parts.push(
      '提出先からの読み直しが時間内に終わりませんでした（読み直しは裏で続いていて、終われば取り込まれます）。下は前に読んだ時点（submission.checkedAt）の状態です。1分ほどおいて verify_submission をもう一度呼ぶと、その読み直しの結果を返します。',
    );
  else if (live.status === 'failed' || live.status === 'queued' || live.status === 'notFound')
    parts.push(
      `提出先から今は読み直せませんでした（${live.status}${live.error ? `: ${live.error}` : ''}）。下は前に読んだ時点（submission.checkedAt）の状態です。そのことを伝え、提出先の URL を添えてください。`,
    );
  else if (live.status === 'recent')
    parts.push('30秒以内に読み直したばかりなので、その結果を返しています。');
  const content = (v.answers?.length ?? 0) > 0 || v.files.length > 0;
  const files =
    v.files.length > 0
      ? 'ファイルの中身を確かめたいときは files[].documentId を get_document で開いてください（中身はそのとき取得）。'
      : '';
  if (v.submission.submitted === true)
    parts.push(
      content
        ? `提出先では提出済みです。提出した内容（answers の回答・files のファイル名）を見せてください。${files}`
        : '提出先では提出済みです（この提出先から読めるのは提出状態だけです）。',
    );
  else if (v.submission.submitted === false)
    parts.push(
      `提出先ではまだ提出済みになっていません。${content ? '保存済みの回答・ファイルを見せ、' : ''}提出の操作が終わっているか本人に提出先（assignment.url）で確かめてもらってください。${files}`,
    );
  if (v.limits.length > 0) parts.push('確かめられないことは limits のとおり伝えてください。');
  return parts.join(' ');
}

interface RegisterDeps {
  uc: UniContext;
  fetchDetails: (ids: string[]) => Promise<DetailFetchReport>;
  waitMs?: number;
}

export function registerVerifySubmissionTool(tool: ToolRegistrar, deps: RegisterDeps): void {
  const { uc } = deps;
  tool('verify_submission', VERIFY_SUBMISSION_TOOL, verifySubmissionShape, async (a) => {
    const { assignmentId } = resolveAssignmentRef(uc, a.id);
    if (!assignmentId)
      throw new ValidationError(
        `${a.id.trim()} は提出先の課題に結びついていません（get_assignments の assignmentId を使ってください） / not an assignment of a submission system`,
      );
    const raw = primaryRaw(uc, assignmentId);
    let live: VerifySubmissionView['live'];
    if (platformOf(raw) === 'other') live = { status: 'unsupported' };
    else {
      const o = await liveRead(
        uc,
        assignmentId,
        deps.fetchDetails,
        deps.waitMs ?? VERIFY_SUBMISSION_WAIT_MS,
      );
      live = {
        status: o.status,
        at: o.at,
        ...(o.error ? { error: o.error } : {}),
        ...(o.retryAfterSeconds !== undefined ? { retryAfterSeconds: o.retryAfterSeconds } : {}),
      };
    }
    const data = buildSubmissionView(uc, assignmentId, live);
    return {
      data: { ...data, citations: data.assignment.citations },
      options: { hint: hintFor(data) },
    };
  });
}
