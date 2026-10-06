import type { Id, Importance } from '@unicontext/canonical-model';
import {
  type DriftFinding,
  detectSchemaDrift,
  type FactInput,
  type NormalizeContext,
  type NormalizedEntity,
  type NormalizeOutput,
  type Normalizer,
  type RawItemView,
} from '@unicontext/connector-sdk';
import { classifyNoticeImportance, findDatePhrase, resolveRoomChangeScope } from '@unicontext/core';
import { chunkText } from '@unicontext/local-files';
import {
  academicYearOf,
  ASSIGNMENTS_BOT_MRI,
  attachments,
  channelLink,
  cjkName,
  decodeAssignmentCard,
  driveFolder,
  extractRoomChange,
  firstLine,
  materialKindFor,
  mentions,
  messageLink,
  messageText,
  parseCardDue,
  parseClassTeamName,
  scrubUrl,
  teamLink,
  toIso,
  truthy,
  uniqueIdFromEtag,
} from './parse.js';
import {
  type AssignmentCardPayload,
  AssignmentCardPayloadSchema,
  type AssignmentPayload,
  AssignmentPayloadSchema,
  type DriveItemPayload,
  DriveItemPayloadSchema,
  type FileTextPayload,
  FileTextPayloadSchema,
  isRawType,
  RAW_TYPES,
  type ReplyChainPayload,
  ReplyChainPayloadSchema,
  SCHEMAS,
  type TeamPayload,
  TeamPayloadSchema,
  type TeamsMessage,
} from './schemas.js';

/**
 * 3: a room-change post is scoped to the day it names (本日 = the post's day). One that names no day
 * and is not permanent (以降/今後) gives no course-wide room fact any more, only news. Bumping
 * re-derives the stored posts, so the old course-wide hint facts disappear.
 */
export const NORMALIZER_VERSION = '4';
export const INSTRUCTOR_AUTHORITY = 'instructor-announcement';
export const SUBMISSION_AUTHORITY = 'submission-system';
const ROOM_HINT_CONFIDENCE = 0.6;
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 100;

function opt<K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } {
  return (value === null || value === undefined || value === '' ? {} : { [key]: value }) as {
    [P in K]?: V;
  };
}

/** Only missing fields and type changes matter: the client's objects carry many extra keys. */
function drift(type: keyof typeof SCHEMAS, payload: unknown): DriftFinding[] {
  return detectSchemaDrift(payload, SCHEMAS[type]).filter((f) => f.kind !== 'unknown');
}

// ---------------------------------------------------------------------------------------------
// Teams and channels

export function teamName(p: TeamPayload): string {
  return (
    p.threadProperties.spaceThreadTopic?.trim() || p.threadProperties.topic?.trim() || '(チーム)'
  );
}

function normalizeTeam(p: TeamPayload, ctx: NormalizeContext): NormalizeOutput {
  const tp = p.threadProperties;
  const groupId = tp.groupId;
  const name = teamName(p);
  const isClass = tp.spaceType === 'class';
  const entities: NormalizedEntity[] = [];
  const url = teamLink(p.id, groupId, tp.tenantid);
  let courseOfferingId: Id<'courseOffering'> | undefined;
  if (isClass) {
    const parsed = parseClassTeamName(name);
    const created = toIso(tp.createdat ?? undefined);
    const academicYear =
      parsed.academicYear ?? (created ? academicYearOf(created, ctx.timezone) : undefined);
    const teacher = cjkName(p.creatorName);
    courseOfferingId = ctx.id('courseOffering', groupId);
    entities.push({
      entity: {
        id: courseOfferingId,
        kind: 'courseOffering',
        title: parsed.title,
        ...opt('academicYear', academicYear),
        instructorIds: [],
        instructorNames: teacher ? [teacher] : [],
        schedule: [],
        url,
        extra: {
          platform: 'teams',
          teamGroupId: groupId,
          teamName: name,
          teamId: p.id,
          ...opt('section', parsed.section),
          ...opt('description', tp.description?.trim()),
          ...opt('sharepointSiteUrl', tp.sharepointSiteUrl),
        },
      },
      ref: { url },
    });
  }
  const channels = [...p.channels];
  if (!channels.some((c) => c.id === p.id))
    channels.unshift({ id: p.id, name: 'General', isGeneral: true });
  for (const c of channels) {
    if (truthy(c.isdeleted ?? undefined)) continue;
    const link = channelLink(c.id, c.name, groupId, tp.tenantid);
    entities.push({
      entity: {
        id: ctx.id('thread', 'channel', c.id),
        kind: 'thread',
        title: c.name,
        platform: 'teams',
        url: link,
        ...opt('courseOfferingId', courseOfferingId),
        extra: {
          platform: 'teams',
          teamName: name,
          teamGroupId: groupId,
          channelId: c.id,
          channelName: c.name,
          ...(c.id === p.id || c.isGeneral ? { isGeneral: true } : {}),
        },
      },
      ref: { url: link },
    });
  }
  return { entities };
}

// ---------------------------------------------------------------------------------------------
// Posts and replies

const CONTENT_TYPES = /^(RichText|Text)/;

function isDeleted(m: TeamsMessage): boolean {
  const p = m.properties;
  return Boolean(p?.deletetime) || truthy(p?.systemdelete ?? undefined);
}

function teamsImportance(m: TeamsMessage): 'high' | 'urgent' | undefined {
  const v = (m.properties?.importance ?? '').toLowerCase();
  return v === 'high' || v === 'urgent' ? v : undefined;
}

function normalizeReplyChain(p: ReplyChainPayload, ctx: NormalizeContext): NormalizeOutput {
  const isClass = p.spaceType === 'class';
  const courseOfferingId = isClass ? ctx.id('courseOffering', p.teamGroupId) : undefined;
  const threadId = ctx.id('thread', 'channel', p.channelId);
  const instructors = new Set(p.instructorMris);
  const entities: NormalizedEntity[] = [];
  const facts: FactInput[] = [];
  for (const m of p.messages) {
    if (m.type && m.type !== 'Message') continue;
    if (!CONTENT_TYPES.test(m.messageType ?? '')) continue;
    if (isDeleted(m)) continue;
    const isRoot = (m.parentMessageId ?? m.id) === m.id || m.id === p.replyChainId;
    const creator = m.creator ?? '';
    const card = creator === ASSIGNMENTS_BOT_MRI ? decodeAssignmentCard(m.content) : undefined;
    const files = attachments(m.properties?.files);
    const ments = mentions(m.properties?.mentions);
    let text = messageText(m.content);
    if (card) text = `課題: ${card.title}${card.dueText ? `（${card.dueText}）` : ''}`;
    if (!text && files.length === 0) continue;
    const subject = m.properties?.subject?.trim() || m.properties?.title?.trim() || undefined;
    const importance = teamsImportance(m);
    const isInstructor = instructors.has(creator);
    const sentAt = toIso(m.originalArrivalTime ?? undefined);
    const url = messageLink({
      channelId: p.channelId,
      messageId: m.id,
      parentMessageId: p.replyChainId,
      groupId: p.teamGroupId,
      tenantId: p.tenantId,
    });
    const mentionsMe = p.selfMri ? ments.some((x) => x.mri === p.selfMri) : false;
    const extra = {
      platform: 'teams',
      teamName: p.teamName,
      teamGroupId: p.teamGroupId,
      channelId: p.channelId,
      channelName: p.channelName,
      replyChainId: p.replyChainId,
      isReply: !isRoot,
      ...opt('subject', subject),
      ...opt('importance', importance),
      ...(ments.length ? { mentions: ments.map((x) => ({ type: x.type, name: x.name })) } : {}),
      ...(mentionsMe ? { mentionsMe: true } : {}),
      ...(files.length
        ? {
            attachments: files.map((f) => ({
              name: f.name,
              ...opt('url', f.url),
              ...opt('uniqueId', f.uniqueId),
              ...opt('fileType', f.fileType),
            })),
          }
        : {}),
      ...(card ? { kindHint: 'assignment-card', assignmentId: card.assignmentId } : {}),
      ...(m.properties?.edittime ? { edited: true } : {}),
    };
    const ref = { url, location: { messageId: m.id } };
    if (isClass && isRoot && isInstructor && !card) {
      const title = subject ?? (firstLine(text) || '(無題の投稿)');
      const importanceLevel: Importance =
        importance === 'urgent'
          ? 'critical'
          : classifyNoticeImportance({
              title,
              body: text,
              courseLinked: true,
              flaggedImportant: importance === 'high',
            }).importance;
      const hint = courseOfferingId ? extractRoomChange(text) : undefined;
      // Which day the room is for: the post's own (本日), a named one, or the course from now on.
      const datePhrase = hint ? (hint.datePhrase ?? findDatePhrase(subject ?? '')) : undefined;
      const scope = hint
        ? resolveRoomChangeScope({ ...hint, datePhrase }, sentAt, ctx.timezone)
        : undefined;
      entities.push({
        entity: {
          id: ctx.id('announcement', p.channelId, m.id),
          kind: 'announcement',
          ...opt('courseOfferingId', courseOfferingId),
          title,
          body: text,
          ...opt('publishedAt', sentAt),
          ...opt('authorName', m.imDisplayName),
          importance: importanceLevel,
          scope: 'course',
          category: 'Teams',
          url,
          extra:
            hint && scope?.kind === 'unresolved'
              ? {
                  ...extra,
                  // The engine has the course's sessions: it resolves 次回 / 来週 / no day later.
                  roomHint: {
                    room: hint.room,
                    unresolved: true,
                    ...(datePhrase ? { datePhrase } : {}),
                    ...(sentAt ? { postedAt: sentAt } : {}),
                  },
                }
              : extra,
        },
        ref: { ...ref, authority: INSTRUCTOR_AUTHORITY },
      });
      if (hint && courseOfferingId && scope && scope.kind !== 'unresolved')
        facts.push({
          subject: courseOfferingId,
          predicate: 'room',
          value: hint.room,
          origin: 'extracted',
          confidence: ROOM_HINT_CONFIDENCE,
          evidence: hint.sentence,
          ...(scope.validFrom ? { validFrom: scope.validFrom } : {}),
          ...(scope.kind === 'dated' ? { validUntil: scope.validUntil } : {}),
          ref: { ...ref, authority: INSTRUCTOR_AUTHORITY },
        });
      continue;
    }
    entities.push({
      entity: {
        id: ctx.id('message', p.channelId, m.id),
        kind: 'message',
        threadId,
        ...opt('courseOfferingId', courseOfferingId),
        ...opt('authorName', m.imDisplayName),
        ...(isInstructor
          ? { authorRole: 'instructor' as const }
          : m.isSentByCurrentUser || (p.selfMri && creator === p.selfMri)
            ? { authorRole: 'student' as const }
            : {}),
        body: subject && isRoot && !card ? `${subject}\n${text}` : text,
        ...opt('sentAt', sentAt),
        url,
        isQuestion: /[?？]\s*$/.test(text.trim()),
        extra,
      },
      ref,
    });
  }
  return { entities, facts };
}

// ---------------------------------------------------------------------------------------------
// Assignments

type SubmissionStatus = 'not_submitted' | 'submitted' | 'late' | 'graded' | 'returned';

function publishedPoints(
  sub: NonNullable<AssignmentPayload['submissions']>[number],
): number | undefined {
  for (const o of sub.outcomes ?? []) {
    const v = o.publishedPoints?.points;
    if (typeof v === 'number') return v;
  }
  return undefined;
}

export function submissionStatus(
  teamsStatus: string | null | undefined,
  submittedAt: string | undefined,
  dueAt: string | undefined,
  score: number | undefined,
): SubmissionStatus {
  switch ((teamsStatus ?? '').toLowerCase()) {
    case 'submitted':
      return dueAt && submittedAt && submittedAt > dueAt ? 'late' : 'submitted';
    case 'returned':
      return score !== undefined ? 'graded' : 'returned';
    case 'excused':
      return 'returned';
    default:
      // working, reassigned, and anything new: not handed in (yet / again)
      return 'not_submitted';
  }
}

function normalizeAssignment(p: AssignmentPayload, ctx: NormalizeContext): NormalizeOutput {
  const id = ctx.id('assignment', p.id);
  const courseOfferingId = p.classId ? ctx.id('courseOffering', p.classId) : undefined;
  const dueAt = toIso(p.dueDateTime ?? undefined);
  const url = p.webUrl ? scrubUrl(p.webUrl) : undefined;
  const description = p.instructions?.content ? messageText(p.instructions.content) : undefined;
  const ref = { ...opt('url', url), authority: SUBMISSION_AUTHORITY };
  const entities: NormalizedEntity[] = [
    {
      entity: {
        id,
        kind: 'assignment',
        ...opt('courseOfferingId', courseOfferingId),
        title: p.displayName?.trim() || '(無題の課題)',
        ...opt('description', description),
        ...opt('dueAt', dueAt),
        ...opt('availableFrom', toIso(p.assignedDateTime ?? undefined)),
        ...opt('points', p.grading?.maxPoints ?? undefined),
        submissionType: 'teams-assignments',
        ...opt('url', url),
        extra: {
          platform: 'teams-assignments',
          source: 'assignments-api',
          ...opt('classId', p.classId),
          ...opt('closeAt', toIso(p.closeDateTime ?? undefined)),
          ...opt('status', p.status),
          ...(typeof p.isCompleted === 'boolean' ? { isCompleted: p.isCompleted } : {}),
          ...(typeof p.allowLateSubmissions === 'boolean'
            ? { allowLateSubmissions: p.allowLateSubmissions }
            : {}),
        },
      },
      ref,
    },
  ];
  const sub = p.submissions?.[0];
  if (sub) {
    const submittedAt = toIso(sub.submittedDateTime ?? undefined);
    const score = publishedPoints(sub);
    entities.push({
      entity: {
        id: ctx.id('submission', p.id),
        kind: 'submission',
        assignmentId: id,
        status: submissionStatus(sub.status, submittedAt, dueAt, score),
        ...opt('submittedAt', submittedAt),
        ...opt('score', score),
        extra: { platform: 'teams-assignments', ...opt('teamsStatus', sub.status) },
      },
      ref,
    });
  }
  return { entities };
}

function normalizeCard(p: AssignmentCardPayload, ctx: NormalizeContext): NormalizeOutput {
  const dueAt = parseCardDue(p.dueText, p.postedAt ?? undefined, ctx.timezone);
  const url = p.url ? scrubUrl(p.url) : undefined;
  return {
    entities: [
      {
        entity: {
          id: ctx.id('assignment', 'card', p.assignmentId),
          kind: 'assignment',
          courseOfferingId: ctx.id('courseOffering', p.classId),
          title: p.title,
          ...opt('dueAt', dueAt),
          ...opt('availableFrom', p.postedAt),
          ...opt('url', url),
          extra: {
            platform: 'teams-assignments',
            source: 'bot-card',
            classId: p.classId,
            ...opt('dueDateText', p.dueText),
          },
        },
        // The card shows a date without year/time: an inference, not the Assignments service.
        origin: 'extracted',
        ref: { ...opt('url', url), location: { messageId: p.messageId } },
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Files

function normalizeDriveItem(p: DriveItemPayload, ctx: NormalizeContext): NormalizeOutput {
  const it = p.item;
  if (it.folder || !it.file || it.deleted || !it.name) return { entities: [] };
  const key = [p.teamGroupId, it.id] as const;
  const documentId = ctx.id('document', 'sp', ...key);
  const courseOfferingId =
    p.spaceType === 'class' ? ctx.id('courseOffering', p.teamGroupId) : undefined;
  const folder = driveFolder(it.parentReference?.path);
  const url = it.webUrl ? scrubUrl(it.webUrl) : undefined;
  const ref = { ...opt('url', url) };
  const fileExtra = {
    platform: 'teams',
    teamName: p.teamName,
    teamGroupId: p.teamGroupId,
    folder,
    ...opt('channelName', p.channelName),
    ...opt('modifiedBy', it.lastModifiedBy?.user?.displayName),
    ...opt('createdAt', toIso(it.createdDateTime ?? undefined)),
    ...opt('uniqueId', uniqueIdFromEtag(it.eTag)),
  };
  const entities: NormalizedEntity[] = [
    {
      entity: {
        id: documentId,
        kind: 'document',
        title: it.name,
        ...opt('mimeType', it.file.mimeType),
        path: `/${folder ? `${folder}/` : ''}${it.name}`,
        ...opt('url', url),
        ...(typeof it.size === 'number' ? { sizeBytes: Math.max(0, Math.round(it.size)) } : {}),
        ...opt('contentHash', it.file.hashes?.quickXorHash),
        ...opt('courseOfferingId', courseOfferingId),
        ...opt('modifiedAt', toIso(it.lastModifiedDateTime ?? undefined)),
        extra: fileExtra,
      },
      ref,
    },
    {
      entity: {
        id: ctx.id('material', 'sp', ...key),
        kind: 'material',
        ...opt('courseOfferingId', courseOfferingId),
        title: it.name,
        materialKind: materialKindFor(it.name, it.file.mimeType),
        documentId,
        ...opt('url', url),
        ...opt('publishedAt', toIso(it.createdDateTime ?? undefined)),
        extra: { platform: 'teams', folder, ...opt('channelName', p.channelName) },
      },
      ref,
    },
  ];
  return { entities };
}

function normalizeFileText(p: FileTextPayload, ctx: NormalizeContext): NormalizeOutput {
  const documentId = ctx.id('document', 'sp', p.teamGroupId, p.itemId);
  const pieces: { text: string; page?: number }[] = [];
  if (p.pages?.length)
    for (const pg of p.pages)
      for (const text of chunkText(pg.text, CHUNK_SIZE, CHUNK_OVERLAP))
        pieces.push({ text, page: pg.page });
  else for (const text of chunkText(p.text, CHUNK_SIZE, CHUNK_OVERLAP)) pieces.push({ text });
  return {
    entities: pieces.map((piece, ordinal) => ({
      entity: {
        id: ctx.id('documentChunk', p.teamGroupId, p.itemId, String(ordinal)),
        kind: 'documentChunk',
        documentId,
        ordinal,
        text: piece.text,
        ...(piece.page && piece.page > 0 ? { page: piece.page } : {}),
      },
      ref: piece.page ? { location: { page: piece.page } } : {},
    })),
  };
}

// ---------------------------------------------------------------------------------------------

/** Teams web raw items → canonical entities. Pure and deterministic. */
export function createTeamsWebNormalizer(): Normalizer {
  return {
    id: 'teams-web-normalizer',
    version: NORMALIZER_VERSION,
    sourceTypes: [...RAW_TYPES],
    normalize(item: RawItemView, ctx: NormalizeContext): NormalizeOutput {
      const type = item.sourceType;
      if (!isRawType(type)) return { entities: [] };
      const findings = drift(type, item.payload);
      const fail = (msg: string): NormalizeOutput => ({
        entities: [],
        drift: findings,
        warnings: [`invalid ${type} payload: ${msg}`],
      });
      switch (type) {
        case 'teamsweb.team': {
          const r = TeamPayloadSchema.safeParse(item.payload);
          return r.success
            ? { ...normalizeTeam(r.data, ctx), drift: findings }
            : fail(r.error.message);
        }
        case 'teamsweb.replychain': {
          const r = ReplyChainPayloadSchema.safeParse(item.payload);
          return r.success
            ? { ...normalizeReplyChain(r.data, ctx), drift: findings }
            : fail(r.error.message);
        }
        case 'teamsweb.assignment': {
          const r = AssignmentPayloadSchema.safeParse(item.payload);
          return r.success
            ? { ...normalizeAssignment(r.data, ctx), drift: findings }
            : fail(r.error.message);
        }
        case 'teamsweb.assignmentCard': {
          const r = AssignmentCardPayloadSchema.safeParse(item.payload);
          return r.success
            ? { ...normalizeCard(r.data, ctx), drift: findings }
            : fail(r.error.message);
        }
        case 'teamsweb.driveItem': {
          const r = DriveItemPayloadSchema.safeParse(item.payload);
          return r.success
            ? { ...normalizeDriveItem(r.data, ctx), drift: findings }
            : fail(r.error.message);
        }
        case 'teamsweb.fileText': {
          const r = FileTextPayloadSchema.safeParse(item.payload);
          return r.success
            ? { ...normalizeFileText(r.data, ctx), drift: findings }
            : fail(r.error.message);
        }
        default:
          return { entities: [] };
      }
    },
  };
}
