import { isIdOf } from '@unicontext/canonical-model';
import type { Citation, CourseRef, UniContext } from '@unicontext/context-engine';
import { markupToText, NotFoundError, ValidationError } from '@unicontext/core';
import type { RawItemRecord } from '@unicontext/database';
import { ALL_TASK_STATUSES, buildAssignments, type AssignmentItem } from './assignments.js';

/*
 * get_assignment: one assignment with everything needed to actually work on it — for an Ed lesson
 * (edstem-mcp mapping), every slide in order with its text, each quiz question's full prompt and
 * choices, the slide files, and the student's own saved answers. Built from the raw items the
 * mapping stores (lesson detail, slide questions, and — read only on request — slide responses and
 * lesson files). Answer keys are never returned. Read-only: nothing is saved or submitted on Ed.
 */

/** Raw source types of the edstem-mcp mapping (packages/adapter-mcp/mappings/edstem-mcp.yaml). */
export const ED_LESSON_TYPES = {
  lesson: 'edstem.lesson',
  detail: 'edstem.lesson_detail',
  question: 'edstem.slide_question',
  response: 'edstem.slide_response',
  file: 'edstem.lesson_file',
} as const;

export interface LessonAnswerView {
  /** Free-text answer (Ed document → text). */
  text?: string;
  /** Chosen options, 1-based like `choices`. */
  choices?: number[];
  savedAt?: string;
  /** Ed's marking, when it has marked it. */
  correct?: boolean;
}

export interface LessonQuestionView {
  /** 質問<number> in Ed's order within the slide. */
  number: number;
  id: number;
  type: string | undefined;
  prompt: string;
  /** Options of a multiple-choice question, in order (answer with their 1-based number). */
  choices?: string[];
  multipleSelection?: boolean;
  /** The student's own saved answer (from Ed), when there is one. */
  myAnswer?: LessonAnswerView;
}

export interface LessonSlideView {
  /** Position in the lesson (1-based, Ed's order). */
  number: number;
  id: number;
  title: string | undefined;
  /** Ed slide type: document, quiz, pdf, code, postgres (SQL challenge), ... */
  type: string | undefined;
  /** Ed's progress for the slide (seen / completed / ...). */
  status: string | undefined;
  url: string;
  text?: string;
  file?: { name: string; url: string; mimeType?: string };
  questions?: LessonQuestionView[];
}

export interface LessonView {
  platform: 'edstem';
  lessonId: number;
  title: string;
  module: string | undefined;
  url: string;
  /** Ed's lesson progress for the student: unattempted / attempted / completed. */
  progress: string | undefined;
  /** No submissions after this (Ed's hard close), when set. */
  lockedAt: string | undefined;
  /** When UniContext last read the lesson from Ed. */
  fetchedAt: string | undefined;
  slides: LessonSlideView[];
  attachments: { name: string; url: string; mimeType?: string; slideTitle?: string }[];
  /** When the saved answers were read from Ed (undefined: not read yet). */
  answersFetchedAt: string | undefined;
}

export interface AssignmentDetailView {
  assignment: {
    id: string;
    title: string;
    course: CourseRef | undefined;
    dueAt: string | undefined;
    availableFrom: string | undefined;
    description: string | undefined;
    submissionType: string | undefined;
    /** Status of the submission system (Ed progress → submitted / not_submitted). */
    submissionStatus: string | undefined;
    url: string | undefined;
    citations: Citation[];
  };
  /** The task view (deadline incl. estimates, status) as in get_assignments. */
  task: AssignmentItem | undefined;
  lesson?: LessonView;
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export interface AssignmentRef {
  assignmentId: string | undefined;
  taskId: string | undefined;
  /** The Ed lesson (raw `edstem.lesson`) when the reference is one of its documents. */
  lessonRaw?: RawItemRecord | undefined;
}

/**
 * Resolve `assignment:…`, `task:…`, or a `document:…` of an Ed lesson (the lesson text, one of its
 * quiz questions or files, as `search` / get_course return them) to the assignment and lesson.
 */
export function resolveAssignmentRef(uc: UniContext, ref: string): AssignmentRef {
  const id = ref.trim();
  if (isIdOf('assignment', id)) return { assignmentId: id, taskId: undefined };
  if (isIdOf('task', id)) {
    const task = uc.tasks.get(id);
    if (!task) throw new NotFoundError(`task ${id}`);
    return { assignmentId: task.assignmentId, taskId: id };
  }
  if (isIdOf('document', id)) {
    const stores = uc.sync.stores;
    const doc = stores.entities.getOfKind('document', id);
    const lessonId = num(obj(doc?.extra).lessonId);
    const sourceId = stores.entities.meta(id)?.sourceId;
    const lessonRaw =
      lessonId !== undefined && sourceId
        ? stores.raw.find(sourceId, ED_LESSON_TYPES.lesson, String(lessonId))
        : undefined;
    if (!doc || !lessonRaw || lessonRaw.deletedAt)
      throw new ValidationError(
        `${id} is not part of an Ed lesson; give an assignment id (assignment:…) or task id (task:…)`,
      );
    const assignmentId = stores.sourceRefs
      .byRawItem(lessonRaw.id)
      .map((r) => r.entityId)
      .find(
        (e): e is string =>
          e !== undefined && isIdOf('assignment', e) && stores.entities.get(e) !== undefined,
      );
    return { assignmentId, taskId: undefined, lessonRaw };
  }
  throw new ValidationError(
    `give an assignment id (assignment:…) or task id (task:…) from get_assignments, not "${id}"`,
  );
}

/** An Ed lesson that is not an assignment (lecture material), as stored by the last sync. */
export function buildLessonOnly(uc: UniContext, lessonRaw: RawItemRecord): LessonView {
  return edLessonView(uc, lessonRaw, undefined);
}

function answerOf(payload: Json): LessonAnswerView | undefined {
  const data = payload.data;
  const out: LessonAnswerView = {};
  const choices = Array.isArray(data)
    ? data
    : Array.isArray(obj(data).choices)
      ? obj(data).choices
      : undefined;
  if (Array.isArray(choices)) {
    const picked = choices.map(num).filter((n): n is number => n !== undefined);
    if (picked.length > 0) out.choices = picked.map((n) => n + 1);
  }
  const text =
    typeof data === 'string'
      ? markupToText(data)
      : markupToText(obj(data).content ?? obj(data).text);
  if (text) out.text = text;
  const savedAt = str(payload.createdAt);
  if (savedAt) out.savedAt = savedAt;
  if (typeof payload.correct === 'boolean') out.correct = payload.correct;
  return out.text !== undefined || out.choices !== undefined ? out : undefined;
}

function latestFetch(items: RawItemRecord[]): string | undefined {
  return items
    .map((i) => i.fetchedAt)
    .sort()
    .at(-1);
}

/** The Ed lesson of an assignment stored by the edstem-mcp mapping, if it is one. */
function edLessonView(
  uc: UniContext,
  lessonRaw: RawItemRecord,
  lessonUrl: string | undefined,
): LessonView {
  const raw = uc.sync.stores.raw;
  const lessonId = Number(lessonRaw.externalId);
  const summary = obj(lessonRaw.payload);
  const detailRaw = raw.find(lessonRaw.sourceId, ED_LESSON_TYPES.detail, lessonRaw.externalId);
  const detail = obj(detailRaw?.payload);
  const ofLesson = (type: string): RawItemRecord[] =>
    raw
      .list({ sourceId: lessonRaw.sourceId, sourceTypes: [type] })
      .filter((i) => num(obj(obj(i.payload)._parent).lessonId) === lessonId);
  const questions = ofLesson(ED_LESSON_TYPES.question);
  const responses = ofLesson(ED_LESSON_TYPES.response);
  const files = ofLesson(ED_LESSON_TYPES.file);
  // The lesson's web link as the mapping built it (it knows the account's region).
  const mappedUrl = (): string | undefined =>
    detailRaw
      ? uc.sync.stores.sourceRefs
          .byRawItem(detailRaw.id)
          .map((r) =>
            r.entityId ? uc.sync.stores.entities.getOfKind('document', r.entityId)?.url : undefined,
          )
          .find((u) => u?.endsWith(`/lessons/${lessonId}`))
      : undefined;
  const base =
    lessonUrl ??
    mappedUrl() ??
    `https://edstem.org/au/courses/${String(num(summary.courseId) ?? '')}/lessons/${lessonId}`;

  const answers = new Map<number, LessonAnswerView>();
  for (const r of responses) {
    const p = obj(r.payload);
    const qid = num(p.questionId);
    const a = answerOf(p);
    if (qid !== undefined && a) answers.set(qid, a);
  }
  const questionsBySlide = new Map<number, LessonQuestionView[]>();
  for (const q of questions) {
    const p = obj(q.payload);
    const slideId = num(p.slideId) ?? num(obj(p._parent).slideId);
    const id = num(p.id);
    if (slideId === undefined || id === undefined) continue;
    const choices = Array.isArray(p.answers)
      ? p.answers.map((a) => markupToText(a) ?? '').filter((a) => a !== '')
      : [];
    const view: LessonQuestionView = {
      number: num(p.number) ?? (num(p.index) ?? 0) + 1,
      id,
      type: str(p.type),
      prompt: markupToText(p.content) ?? '',
      ...(choices.length > 0 ? { choices } : {}),
      ...(p.multipleSelection === true ? { multipleSelection: true } : {}),
    };
    const mine = answers.get(id);
    if (mine) view.myAnswer = mine;
    const list = questionsBySlide.get(slideId) ?? [];
    list.push(view);
    questionsBySlide.set(slideId, list);
  }

  const slides = (Array.isArray(detail.slides) ? detail.slides : [])
    .map(obj)
    .sort((a, b) => (num(a.index) ?? 0) - (num(b.index) ?? 0))
    .map((s, i): LessonSlideView => {
      const id = num(s.id) ?? 0;
      const type = str(s.type);
      const text = markupToText(s.content);
      const fileUrl = str(s.fileUrl);
      const title = str(s.title);
      const qs = questionsBySlide.get(id)?.sort((a, b) => a.number - b.number);
      return {
        number: i + 1,
        id,
        title,
        type,
        status: str(s.status),
        url: `${base}/slides/${id}`,
        ...(text ? { text } : {}),
        ...(fileUrl
          ? {
              file: {
                name:
                  type === 'pdf' && title && !/\.pdf$/i.test(title)
                    ? `${title}.pdf`
                    : (title ?? 'file'),
                url: fileUrl,
                ...(type === 'pdf' ? { mimeType: 'application/pdf' } : {}),
              },
            }
          : {}),
        ...(qs?.length ? { questions: qs } : {}),
      };
    });

  const attachments = new Map<string, LessonView['attachments'][number]>();
  for (const s of slides)
    if (s.file)
      attachments.set(s.file.url, {
        name: s.file.name,
        url: s.file.url,
        ...(s.file.mimeType ? { mimeType: s.file.mimeType } : {}),
        ...(s.title ? { slideTitle: s.title } : {}),
      });
  for (const f of files) {
    const p = obj(f.payload);
    const url = str(p.url);
    if (!url) continue;
    const mimeType = str(p.mediaType);
    const slideTitle = str(p.slideTitle);
    attachments.set(url, {
      name: str(p.filename) ?? attachments.get(url)?.name ?? 'file',
      url,
      ...(mimeType ? { mimeType } : {}),
      ...(slideTitle ? { slideTitle } : {}),
    });
  }

  return {
    platform: 'edstem',
    lessonId,
    title: str(detail.title) ?? str(summary.title) ?? '',
    module: str(summary.moduleName) ?? str(obj(detail._parent).moduleName),
    url: base,
    progress: str(summary.status) ?? str(detail.status),
    lockedAt: str(detail.lockedAt),
    fetchedAt: detailRaw?.fetchedAt,
    slides,
    attachments: [...attachments.values()],
    answersFetchedAt: latestFetch(responses),
  };
}

/** The assignment with its task view and, for an Ed lesson, the whole lesson. */
export function buildAssignmentDetail(uc: UniContext, assignmentId: string): AssignmentDetailView {
  const stores = uc.sync.stores;
  const a = stores.entities.getOfKind('assignment', assignmentId);
  if (!a) throw new NotFoundError(`assignment ${assignmentId}`);
  const submission = stores.entities
    .list('submission', { where: { assignmentId } })
    .sort((x, y) => (y.submittedAt ?? '').localeCompare(x.submittedAt ?? ''))[0];
  const task = buildAssignments(uc, { statuses: ALL_TASK_STATUSES }).find(
    (t) => t.assignmentId === assignmentId,
  );
  const lessonRaw = stores.sourceRefs
    .forEntity(assignmentId)
    .map((r) => (r.rawItemId ? stores.raw.get(r.rawItemId) : undefined))
    .find((r) => r !== undefined && !r.deletedAt && r.sourceType === ED_LESSON_TYPES.lesson);
  return {
    assignment: {
      id: a.id,
      title: a.title,
      course: uc.context.courseRef(a.courseOfferingId),
      dueAt: a.dueAt ?? task?.dueAt,
      availableFrom: a.availableFrom,
      description: a.description,
      submissionType: a.submissionType,
      submissionStatus: submission?.status,
      url: a.url,
      citations: uc.context.citationsFor([a.id]),
    },
    task,
    ...(lessonRaw ? { lesson: edLessonView(uc, lessonRaw, a.url) } : {}),
  };
}
