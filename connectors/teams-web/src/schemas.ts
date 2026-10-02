import { z } from 'zod';

/**
 * Raw item types. Payloads are what the official Teams web client already holds or receives
 * (docs/research/teams-web.md), trimmed to the fields a normalizer needs; secrets never appear
 * (see `scrubSecrets`). The zod schemas are loose: they drive schema-drift reports, they do not
 * reject data.
 */
export const RAW_TYPES = [
  'teamsweb.team',
  'teamsweb.replychain',
  'teamsweb.assignment',
  'teamsweb.assignmentCard',
  'teamsweb.driveItem',
  'teamsweb.fileText',
] as const;
export type RawType = (typeof RAW_TYPES)[number];
export function isRawType(t: string): t is RawType {
  return (RAW_TYPES as readonly string[]).includes(t);
}

const str = z.string();
const optStr = z.string().nullish();

/** A channel of a team, from the client's conversation cache (Space `topics` + Topic rows). */
export const TeamChannelSchema = z.looseObject({
  id: str,
  name: str,
  isGeneral: z.boolean().optional(),
  createdat: z.union([str, z.number()]).nullish(),
  isdeleted: z.union([z.boolean(), str]).nullish(),
  /** `/sites/<site>/Shared Documents/<channel>` */
  channelDocsFolderRelativeUrl: optStr,
});
export type TeamChannel = z.infer<typeof TeamChannelSchema>;

/** `teamsweb.team`: one team (Space row of the client's `conversation-manager` cache). */
export const TeamPayloadSchema = z.looseObject({
  /** Team thread id (= General channel id), `19:<hex>@thread.tacv2`. */
  id: str,
  threadProperties: z.looseObject({
    spaceThreadTopic: optStr,
    topic: optStr,
    spaceType: optStr,
    description: optStr,
    groupId: str,
    tenantid: optStr,
    creator: optStr,
    createdat: z.union([str, z.number()]).nullish(),
    sharepointSiteUrl: optStr,
    sharepointRootLibrary: optStr,
    channelDocsFolderRelativeUrl: optStr,
    isdeleted: z.union([z.boolean(), str]).nullish(),
  }),
  channels: z.array(TeamChannelSchema),
  /** Display name of the team creator, when one of their posts is cached (teacher hint). */
  creatorName: optStr,
});
export type TeamPayload = z.infer<typeof TeamPayloadSchema>;

export const MentionSchema = z.looseObject({
  itemid: z.union([z.number(), str]).nullish(),
  mri: optStr,
  mentionType: optStr,
  displayName: optStr,
});

/** One message of a reply chain (the client's `replychain-manager` message shape). */
export const MessageSchema = z.looseObject({
  id: str,
  parentMessageId: optStr,
  version: z.union([str, z.number()]).nullish(),
  type: optStr,
  messageType: optStr,
  contentType: optStr,
  originalArrivalTime: z.union([str, z.number()]).nullish(),
  imDisplayName: optStr,
  creator: optStr,
  content: optStr,
  isSentByCurrentUser: z.boolean().nullish(),
  properties: z
    .looseObject({
      subject: optStr,
      title: optStr,
      importance: optStr,
      mentions: z.union([str, z.array(MentionSchema)]).nullish(),
      files: z.union([str, z.array(z.unknown())]).nullish(),
      links: z.union([str, z.array(z.unknown())]).nullish(),
      edittime: z.union([str, z.number()]).nullish(),
      deletetime: z.union([str, z.number()]).nullish(),
      systemdelete: z.union([z.boolean(), str]).nullish(),
    })
    .nullish(),
});
export type TeamsMessage = z.infer<typeof MessageSchema>;

/** `teamsweb.replychain`: one root post with its cached replies, plus the channel context. */
export const ReplyChainPayloadSchema = z.looseObject({
  teamGroupId: str,
  teamId: str,
  teamName: str,
  spaceType: optStr,
  tenantId: optStr,
  channelId: str,
  channelName: str,
  /** MRIs treated as instructors: the team creator and authors of the class's assignments. */
  instructorMris: z.array(str).default([]),
  selfMri: optStr,
  replyChainId: str,
  latestDeliveryTime: z.union([z.number(), str]).nullish(),
  messages: z.array(MessageSchema),
});
export type ReplyChainPayload = z.infer<typeof ReplyChainPayloadSchema>;

const IdentitySetSchema = z
  .looseObject({ user: z.looseObject({ id: optStr, displayName: optStr }).nullish() })
  .nullish();

export const OutcomeSchema = z.looseObject({
  '@odata.type': optStr,
  points: z.looseObject({ points: z.number().nullish() }).nullish(),
  publishedPoints: z.looseObject({ points: z.number().nullish() }).nullish(),
  feedback: z.unknown().nullish(),
  publishedFeedback: z.unknown().nullish(),
});

export const SubmissionSchema = z.looseObject({
  id: optStr,
  status: optStr,
  submittedDateTime: optStr,
  returnedDateTime: optStr,
  reassignedDateTime: optStr,
  excusedDateTime: optStr,
  webUrl: optStr,
  outcomes: z.array(OutcomeSchema).nullish(),
});

/** `teamsweb.assignment`: one item of `/api/v1.0/edu/me/work`, as the Assignments app received it. */
export const AssignmentPayloadSchema = z.looseObject({
  id: str,
  classId: optStr,
  displayName: optStr,
  instructions: z.looseObject({ content: optStr, contentType: optStr }).nullish(),
  dueDateTime: optStr,
  assignedDateTime: optStr,
  closeDateTime: optStr,
  createdDateTime: optStr,
  lastModifiedDateTime: optStr,
  status: optStr,
  isCompleted: z.boolean().nullish(),
  allowLateSubmissions: z.boolean().nullish(),
  webUrl: optStr,
  grading: z.looseObject({ maxPoints: z.number().nullish() }).nullish(),
  createdBy: IdentitySetSchema,
  submissions: z.array(SubmissionSchema).nullish(),
});
export type AssignmentPayload = z.infer<typeof AssignmentPayloadSchema>;

/** `teamsweb.assignmentCard`: what the Assignments bot posted in a channel (fallback only). */
export const AssignmentCardPayloadSchema = z.looseObject({
  assignmentId: str,
  classId: str,
  title: str,
  dueText: optStr,
  postedAt: optStr,
  teamGroupId: str,
  channelId: str,
  messageId: str,
  url: optStr,
});
export type AssignmentCardPayload = z.infer<typeof AssignmentCardPayloadSchema>;

/** A SharePoint drive item (`/_api/v2.0/drive/root/delta`), download URLs removed. */
export const DriveItemSchema = z.looseObject({
  id: str,
  name: optStr,
  size: z.number().nullish(),
  webUrl: optStr,
  eTag: optStr,
  cTag: optStr,
  createdDateTime: optStr,
  lastModifiedDateTime: optStr,
  createdBy: IdentitySetSchema,
  lastModifiedBy: IdentitySetSchema,
  parentReference: z
    .looseObject({ driveId: optStr, id: optStr, path: optStr, name: optStr })
    .nullish(),
  file: z
    .looseObject({
      mimeType: optStr,
      hashes: z.looseObject({ quickXorHash: optStr }).nullish(),
    })
    .nullish(),
  folder: z.looseObject({ childCount: z.number().nullish() }).nullish(),
  deleted: z.unknown().nullish(),
});
export type DriveItem = z.infer<typeof DriveItemSchema>;

/** `teamsweb.driveItem`: one file of a team's document library. */
export const DriveItemPayloadSchema = z.looseObject({
  teamGroupId: str,
  teamName: str,
  spaceType: optStr,
  tenantId: optStr,
  siteUrl: str,
  /** Channel whose folder holds the file (top-level folder name match). */
  channelName: optStr,
  item: DriveItemSchema,
});
export type DriveItemPayload = z.infer<typeof DriveItemPayloadSchema>;

/**
 * `teamsweb.fileText`: opt-in extracted text of one file (searchable chunks). Kept apart from the
 * drive item so a later metadata-only listing does not drop the text.
 */
export const FileTextPayloadSchema = z.looseObject({
  teamGroupId: str,
  itemId: str,
  name: str,
  /** Version of the file the text was read from (SharePoint cTag/eTag). */
  version: optStr,
  text: str,
  pages: z.array(z.looseObject({ page: z.number(), text: str })).nullish(),
});
export type FileTextPayload = z.infer<typeof FileTextPayloadSchema>;

export const SCHEMAS: Record<RawType, z.ZodType> = {
  'teamsweb.team': TeamPayloadSchema,
  'teamsweb.replychain': ReplyChainPayloadSchema,
  'teamsweb.assignment': AssignmentPayloadSchema,
  'teamsweb.assignmentCard': AssignmentCardPayloadSchema,
  'teamsweb.driveItem': DriveItemPayloadSchema,
  'teamsweb.fileText': FileTextPayloadSchema,
};
