import { detectSchemaDrift, type DriftFinding } from '@unicontext/connector-sdk';
import { z } from 'zod';

/*
 * Expected shapes of the Graph payloads (schema drift detection, §73). Everything except the few
 * fields the normalizer cannot work without is optional/nullable: Graph returns explicit nulls for
 * absent values. Raw payloads themselves are stored unmodified.
 */

const str = z.string().nullish();
const bool = z.boolean().nullish();
const any = z.unknown().optional();

const DateTimeTimeZone = z.object({ dateTime: z.string(), timeZone: str });
const EmailAddress = z.object({ name: str, address: str });
const Recipient = z.object({ emailAddress: EmailAddress.nullish() });
const ItemBody = z.object({ contentType: str, content: str });

export const GraphEventSchema = z.object({
  '@odata.etag': z.string().optional(),
  id: z.string(),
  createdDateTime: str,
  lastModifiedDateTime: str,
  changeKey: str,
  categories: z.array(z.string()).nullish(),
  transactionId: str,
  originalStartTimeZone: str,
  originalEndTimeZone: str,
  iCalUId: str,
  reminderMinutesBeforeStart: z.number().nullish(),
  isReminderOn: bool,
  hasAttachments: bool,
  subject: str,
  bodyPreview: str,
  importance: str,
  sensitivity: str,
  isAllDay: bool,
  isCancelled: bool,
  isDraft: bool,
  isOrganizer: bool,
  responseRequested: bool,
  seriesMasterId: str,
  showAs: str,
  type: str,
  webLink: str,
  onlineMeetingUrl: str,
  isOnlineMeeting: bool,
  onlineMeetingProvider: str,
  allowNewTimeProposals: bool,
  occurrenceId: str,
  hideAttendees: bool,
  recurrence: any,
  responseStatus: any,
  body: ItemBody.nullish(),
  start: DateTimeTimeZone,
  end: DateTimeTimeZone.nullish(),
  location: z
    .object({
      displayName: str,
      locationType: str,
      uniqueId: str,
      uniqueIdType: str,
      locationEmailAddress: str,
      address: any,
      coordinates: any,
    })
    .nullish(),
  locations: z.array(any).nullish(),
  attendees: z.array(any).nullish(),
  organizer: Recipient.nullish(),
  onlineMeeting: any,
});

export const GraphMessageSchema = z.object({
  '@odata.etag': z.string().optional(),
  id: z.string(),
  subject: str,
  from: Recipient.nullish(),
  toRecipients: z.array(Recipient).nullish(),
  receivedDateTime: str,
  sentDateTime: str,
  lastModifiedDateTime: str,
  bodyPreview: str,
  body: ItemBody.nullish(),
  conversationId: str,
  webLink: str,
  isRead: bool,
  isDraft: bool,
  importance: str,
  hasAttachments: bool,
});

export const GraphDriveItemSchema = z.object({
  '@odata.etag': z.string().optional(),
  id: z.string(),
  name: z.string(),
  size: z.number().nullish(),
  webUrl: str,
  createdDateTime: str,
  lastModifiedDateTime: str,
  eTag: str,
  cTag: str,
  parentReference: z
    .object({ driveId: str, driveType: str, id: str, name: str, path: str, siteId: str })
    .nullish(),
  file: z
    .object({
      mimeType: str,
      hashes: z.object({ quickXorHash: str, sha1Hash: str, sha256Hash: str }).nullish(),
    })
    .nullish(),
  folder: z.object({ childCount: z.number().nullish() }).nullish(),
  fileSystemInfo: any,
  createdBy: any,
  lastModifiedBy: any,
  root: any,
  package: any,
  shared: any,
  specialFolder: any,
});

export const GraphTeamSchema = z.object({
  '@odata.etag': z.string().optional(),
  id: z.string(),
  createdDateTime: str,
  displayName: z.string(),
  description: str,
  internalId: str,
  classification: str,
  specialization: str,
  visibility: str,
  webUrl: str,
  isArchived: bool,
  tenantId: str,
  isMembershipLimitedToOwners: bool,
  memberSettings: any,
  guestSettings: any,
  messagingSettings: any,
  funSettings: any,
  discoverySettings: any,
  summary: any,
});

export const GraphChannelSchema = z.object({
  '@odata.etag': z.string().optional(),
  id: z.string(),
  createdDateTime: str,
  displayName: z.string(),
  description: str,
  isFavoriteByDefault: bool,
  email: str,
  tenantId: str,
  webUrl: str,
  membershipType: str,
  isArchived: bool,
  /** Added by the connector (the team the channel was listed under). Not part of Graph. */
  _context: z.object({ teamId: z.string() }),
});

const ChatIdentity = z.object({ id: str, displayName: str, userIdentityType: str, tenantId: str });
export const GraphChannelMessageSchema = z.object({
  '@odata.etag': z.string().optional(),
  id: z.string(),
  replyToId: str,
  etag: str,
  messageType: str,
  createdDateTime: str,
  lastModifiedDateTime: str,
  lastEditedDateTime: str,
  deletedDateTime: str,
  subject: str,
  summary: str,
  chatId: str,
  importance: str,
  locale: str,
  webUrl: str,
  policyViolation: any,
  eventDetail: any,
  from: z
    .object({ user: ChatIdentity.nullish(), application: ChatIdentity.nullish(), device: any })
    .nullish(),
  body: ItemBody.nullish(),
  channelIdentity: z.object({ teamId: str, channelId: str }).nullish(),
  attachments: z.array(any).nullish(),
  mentions: z.array(any).nullish(),
  reactions: z.array(any).nullish(),
  messageHistory: z.array(any).nullish(),
  /** Added by the connector so the normalizer stays pure. No secrets. */
  _context: z.object({
    teamId: z.string(),
    channelId: z.string(),
    selfUserId: z.string().optional(),
  }),
});

export const RAW_TYPES = [
  'graph.event',
  'graph.message',
  'graph.driveItem',
  'graph.team',
  'graph.channel',
  'graph.channelMessage',
] as const;
export type RawType = (typeof RAW_TYPES)[number];

export const GraphSchemas = {
  'graph.event': GraphEventSchema,
  'graph.message': GraphMessageSchema,
  'graph.driveItem': GraphDriveItemSchema,
  'graph.team': GraphTeamSchema,
  'graph.channel': GraphChannelSchema,
  'graph.channelMessage': GraphChannelMessageSchema,
} as const satisfies Record<RawType, z.ZodType>;

export type GraphEvent = z.infer<typeof GraphEventSchema>;
export type GraphMessage = z.infer<typeof GraphMessageSchema>;
export type GraphDriveItem = z.infer<typeof GraphDriveItemSchema>;
export type GraphTeam = z.infer<typeof GraphTeamSchema>;
export type GraphChannel = z.infer<typeof GraphChannelSchema>;
export type GraphChannelMessage = z.infer<typeof GraphChannelMessageSchema>;

export function isRawType(value: string): value is RawType {
  return (RAW_TYPES as readonly string[]).includes(value);
}

/** Drift findings for one raw payload (e.g. a field Graph stopped sending). */
export function graphDrift(type: RawType, payload: unknown): DriftFinding[] {
  return detectSchemaDrift(payload, GraphSchemas[type]);
}
