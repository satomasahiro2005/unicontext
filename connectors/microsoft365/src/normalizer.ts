import type { Importance } from '@unicontext/canonical-model';
import {
  type FactInput,
  type NormalizeContext,
  type NormalizedEntity,
  type NormalizeOutput,
  type Normalizer,
  type RawItemView,
} from '@unicontext/connector-sdk';
import { findDatePhrase, resolveRoomChangeScope } from '@unicontext/core';
import {
  bodyToText,
  drivePath,
  extractRoomChange,
  graphDatePart,
  graphDateTimeToIso,
  localMidnightIso,
  looksLikeQuestion,
  materialKindFor,
  parseTeamName,
  threadSubject,
} from './parsers.js';
import { GraphSchemas, graphDrift, isRawType, RAW_TYPES, type RawType } from './schemas.js';
import type {
  GraphChannel,
  GraphChannelMessage,
  GraphDriveItem,
  GraphEvent,
  GraphMessage,
  GraphTeam,
} from './schemas.js';

export const ANNOUNCEMENT_AUTHORITY = 'instructor-announcement';
export const CALENDAR_AUTHORITY = 'calendar';
const ROOM_HINT_CONFIDENCE = 0.6;

const nz = <T>(v: T | null | undefined): T | undefined => v ?? undefined;
function opt<K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } {
  return (value === null || value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

const IMPORTANCE: Record<string, Importance> = { urgent: 'critical', high: 'high' };

function firstLine(text: string, max = 60): string {
  const line =
    text
      .split('\n')
      .find((l) => l.trim().length > 0)
      ?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

// ---------------------------------------------------------------------------------------------

function normalizeEvent(p: GraphEvent, ctx: NormalizeContext): NormalizeOutput {
  if (p.isCancelled) return { entities: [] };
  const allDay = p.isAllDay === true;
  let startsAt: string | undefined;
  let endsAt: string | undefined;
  if (allDay) {
    const s = graphDatePart(p.start);
    const e = p.end ? graphDatePart(p.end) : undefined;
    startsAt = s ? localMidnightIso(s, ctx.timezone) : undefined;
    endsAt = e ? localMidnightIso(e, ctx.timezone) : undefined;
  } else {
    startsAt = graphDateTimeToIso(p.start);
    endsAt = p.end ? graphDateTimeToIso(p.end) : undefined;
  }
  if (!startsAt) return { entities: [], warnings: [`event ${p.id}: unparsable start`] };
  const categories = (p.categories ?? []).join(', ');
  const entity: NormalizedEntity = {
    entity: {
      id: ctx.id('calendarEvent', p.id),
      kind: 'calendarEvent',
      title: p.subject?.trim() || '(無題の予定)',
      startsAt,
      ...opt('endsAt', endsAt),
      allDay,
      ...opt('location', p.location?.displayName?.trim() || undefined),
      ...opt('description', p.bodyPreview?.trim() || undefined),
      ...opt('url', p.webLink),
      ...(categories ? { category: categories } : {}),
      extra: {
        ...(p.isOnlineMeeting ? { isOnlineMeeting: true } : {}),
        ...(p.onlineMeetingUrl ? { onlineMeetingUrl: p.onlineMeetingUrl } : {}),
        ...(p.organizer?.emailAddress?.name ? { organizer: p.organizer.emailAddress.name } : {}),
        ...(p.seriesMasterId ? { seriesMasterId: p.seriesMasterId } : {}),
      },
    },
    ref: { authority: CALENDAR_AUTHORITY, ...opt('url', p.webLink) },
  };
  return { entities: [entity] };
}

function normalizeMail(p: GraphMessage, ctx: NormalizeContext): NormalizeOutput {
  const conversation = p.conversationId ?? p.id;
  const threadId = ctx.id('thread', 'mail', conversation);
  const body = bodyToText(p.body) || (p.bodyPreview ?? '').trim();
  const sentAt = nz(p.sentDateTime) ?? nz(p.receivedDateTime);
  const from = p.from?.emailAddress;
  const thread: NormalizedEntity = {
    entity: {
      id: threadId,
      kind: 'thread',
      title: threadSubject(p.subject),
      platform: 'outlook',
    },
  };
  const message: NormalizedEntity = {
    entity: {
      id: ctx.id('message', 'mail', p.id),
      kind: 'message',
      threadId,
      ...opt('authorName', from?.name ?? from?.address),
      body,
      ...opt('sentAt', sentAt),
      ...opt('url', p.webLink),
      extra: {
        ...(from?.address ? { fromAddress: from.address } : {}),
        ...(p.hasAttachments ? { hasAttachments: true } : {}),
        ...(p.isRead !== null && p.isRead !== undefined ? { isRead: p.isRead } : {}),
      },
    },
    ref: { ...opt('url', p.webLink), location: { messageId: p.id } },
  };
  return { entities: [thread, message] };
}

function normalizeDriveItem(p: GraphDriveItem, ctx: NormalizeContext): NormalizeOutput {
  if (p.folder || !p.file) return { entities: [] };
  const documentId = ctx.id('document', p.id);
  const hashes = p.file.hashes;
  const contentHash = hashes?.sha256Hash ?? hashes?.sha1Hash ?? hashes?.quickXorHash ?? undefined;
  const ref = { ...opt('url', p.webUrl) };
  const document: NormalizedEntity = {
    entity: {
      id: documentId,
      kind: 'document',
      title: p.name,
      ...opt('mimeType', p.file.mimeType),
      path: drivePath(p.parentReference?.path, p.name),
      ...opt('url', p.webUrl),
      ...(typeof p.size === 'number' ? { sizeBytes: Math.max(0, Math.round(p.size)) } : {}),
      ...opt('contentHash', contentHash),
      ...opt('modifiedAt', p.lastModifiedDateTime),
    },
    ref,
  };
  const material: NormalizedEntity = {
    entity: {
      id: ctx.id('material', 'drive', p.id),
      kind: 'material',
      title: p.name,
      materialKind: materialKindFor(p.name, p.file.mimeType),
      documentId,
      ...opt('url', p.webUrl),
      ...opt('publishedAt', p.createdDateTime),
    },
    ref,
  };
  return { entities: [document, material] };
}

function normalizeTeam(p: GraphTeam, ctx: NormalizeContext): NormalizeOutput {
  const parsed = parseTeamName(p.displayName);
  const entity: NormalizedEntity = {
    entity: {
      id: ctx.id('courseOffering', p.id),
      kind: 'courseOffering',
      title: parsed.title || p.displayName,
      ...(parsed.academicYear ? { academicYear: parsed.academicYear } : {}),
      instructorIds: [],
      instructorNames: [],
      schedule: [],
      ...opt('url', p.webUrl),
      extra: {
        teamId: p.id,
        teamName: p.displayName,
        ...(parsed.className ? { className: parsed.className } : {}),
        ...(parsed.structured ? { parsedFromName: true } : {}),
        ...(p.isArchived ? { isArchived: true } : {}),
      },
    },
    ref: { ...opt('url', p.webUrl) },
  };
  return { entities: [entity] };
}

function normalizeChannel(p: GraphChannel, ctx: NormalizeContext): NormalizeOutput {
  const entity: NormalizedEntity = {
    entity: {
      id: ctx.id('thread', 'channel', p.id),
      kind: 'thread',
      courseOfferingId: ctx.id('courseOffering', p._context.teamId),
      title: p.displayName,
      platform: 'teams',
      ...opt('url', p.webUrl),
      extra: { teamId: p._context.teamId, channelId: p.id },
    },
    ref: { ...opt('url', p.webUrl) },
  };
  return { entities: [entity] };
}

function normalizeChannelMessage(
  p: GraphChannelMessage,
  item: RawItemView,
  ctx: NormalizeContext,
): NormalizeOutput {
  if ((p.messageType ?? 'message') !== 'message' || p.deletedDateTime) return { entities: [] };
  const { teamId, channelId, selfUserId } = p._context;
  const courseOfferingId = ctx.id('courseOffering', teamId);
  const text = bodyToText(p.body);
  const author = p.from?.user;
  const sentAt = nz(p.createdDateTime);
  const isSelf = author?.id !== undefined && author.id !== null && author.id === selfUserId;
  const isTopLevel = !p.replyToId;
  const ref = { ...opt('url', p.webUrl), location: { messageId: p.id } };

  if (isTopLevel && author && !isSelf) {
    const title = p.subject?.trim() || firstLine(text) || '(無題の投稿)';
    const hint = extractRoomChange(text);
    // Which day the room is for: the post's own (本日), a named one, or the course from now on.
    const datePhrase = hint ? (hint.datePhrase ?? findDatePhrase(p.subject ?? '')) : undefined;
    const scope = hint
      ? resolveRoomChangeScope({ ...hint, datePhrase }, sentAt, ctx.timezone)
      : undefined;
    const announcement: NormalizedEntity = {
      entity: {
        id: ctx.id('announcement', item.externalId),
        kind: 'announcement',
        courseOfferingId,
        title,
        body: text,
        ...opt('publishedAt', sentAt),
        ...opt('authorName', author.displayName),
        importance: IMPORTANCE[p.importance ?? ''] ?? 'normal',
        scope: 'course',
        ...opt('url', p.webUrl),
        extra:
          hint && scope?.kind === 'unresolved'
            ? {
                teamId,
                channelId,
                // The engine has the course's sessions: it resolves 次回 / 来週 / no day later.
                roomHint: {
                  room: hint.room,
                  unresolved: true,
                  ...(datePhrase ? { datePhrase } : {}),
                  ...(sentAt ? { postedAt: sentAt } : {}),
                },
              }
            : { teamId, channelId },
      },
      ref: { ...ref, authority: ANNOUNCEMENT_AUTHORITY },
    };
    const facts: FactInput[] = [];
    if (hint && scope && scope.kind !== 'unresolved') {
      facts.push({
        subject: courseOfferingId,
        predicate: 'room',
        value: hint.room,
        origin: 'extracted',
        confidence: ROOM_HINT_CONFIDENCE,
        evidence: hint.sentence,
        ...(scope.validFrom ? { validFrom: scope.validFrom } : {}),
        ...(scope.kind === 'dated' ? { validUntil: scope.validUntil } : {}),
        ref: { ...ref, authority: ANNOUNCEMENT_AUTHORITY },
      });
    }
    return { entities: [announcement], facts };
  }

  const message: NormalizedEntity = {
    entity: {
      id: ctx.id('message', item.externalId),
      kind: 'message',
      threadId: ctx.id('thread', 'channel', channelId),
      courseOfferingId,
      ...opt('authorName', author?.displayName ?? p.from?.application?.displayName),
      body: text,
      ...opt('sentAt', sentAt),
      ...opt('url', p.webUrl),
      isQuestion: looksLikeQuestion(text),
      extra: {
        ...(p.replyToId ? { replyToId: p.replyToId } : {}),
        ...(isSelf ? { isSelf: true } : {}),
      },
    },
    ref,
  };
  return { entities: [message] };
}

// ---------------------------------------------------------------------------------------------

/**
 * 2: a room-change post is scoped to the day it names (本日 = the post's day). One that names no day
 * and is not permanent (以降/今後) gives no course-wide room fact any more, only news. Bumping
 * re-derives the stored posts, so the old course-wide hint facts disappear.
 */
export const NORMALIZER_VERSION = '3';

/** Graph raw items → canonical entities (+ the room-change hint fact). Pure and deterministic. */
export function createMicrosoft365Normalizer(): Normalizer {
  return {
    id: 'microsoft365-normalizer',
    version: NORMALIZER_VERSION,
    sourceTypes: [...RAW_TYPES],
    normalize(item: RawItemView, ctx: NormalizeContext): NormalizeOutput {
      if (!isRawType(item.sourceType)) return { entities: [] };
      const type: RawType = item.sourceType;
      const drift = graphDrift(type, item.payload);
      const parsed = GraphSchemas[type].safeParse(item.payload);
      if (!parsed.success) {
        return {
          entities: [],
          drift,
          warnings: [`invalid ${type} payload: ${parsed.error.issues[0]?.message ?? 'unknown'}`],
        };
      }
      let out: NormalizeOutput;
      switch (type) {
        case 'graph.event':
          out = normalizeEvent(parsed.data as GraphEvent, ctx);
          break;
        case 'graph.message':
          out = normalizeMail(parsed.data as GraphMessage, ctx);
          break;
        case 'graph.driveItem':
          out = normalizeDriveItem(parsed.data as GraphDriveItem, ctx);
          break;
        case 'graph.team':
          out = normalizeTeam(parsed.data as GraphTeam, ctx);
          break;
        case 'graph.channel':
          out = normalizeChannel(parsed.data as GraphChannel, ctx);
          break;
        case 'graph.channelMessage':
          out = normalizeChannelMessage(parsed.data as GraphChannelMessage, item, ctx);
          break;
      }
      return { ...out, drift };
    },
  };
}
