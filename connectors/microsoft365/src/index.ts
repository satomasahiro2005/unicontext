import { defineConnector, defineMetadata } from '@unicontext/connector-sdk';
import { Microsoft365Adapter } from './adapter.js';
import { Microsoft365ConfigSchema, type Microsoft365Config } from './config.js';
import { createMicrosoft365Normalizer } from './normalizer.js';
import { RAW_TYPES } from './schemas.js';

export const PACKAGE_NAME = '@unicontext/microsoft365';

export const metadata = defineMetadata({
  name: PACKAGE_NAME,
  product: 'microsoft365',
  version: '1.0.0',
  license: 'MIT',
  description: 'Microsoft 365 via Microsoft Graph: calendar, Outlook mail, OneDrive files, Teams',
  capabilities: ['courses', 'announcements', 'messages', 'materials', 'calendar', 'files'],
  adapter: 'native',
  apiStability: 'official',
  risk: 'supported',
  defaultAuthority: 'collaboration',
  sourceLabel: 'Microsoft 365',
  // Delta polling. Change notifications need a public HTTPS endpoint (see GraphChangeNotifications).
  defaultSchedule: '15m',
  rawTypes: [...RAW_TYPES],
  homepage: 'https://learn.microsoft.com/graph/overview',
});

const connector = defineConnector<Microsoft365Config>({
  metadata,
  configSchema: Microsoft365ConfigSchema,
  createAdapter: (ctx) => new Microsoft365Adapter(ctx),
  createNormalizer: () => createMicrosoft365Normalizer(),
});

export default connector;
export { connector };

export { Microsoft365Adapter, idTokenAccount, type Microsoft365AdapterOptions } from './adapter.js';
export {
  ALWAYS_SCOPES,
  buildOAuthConfig,
  CHANNEL_MESSAGE_SCOPE,
  DEFAULT_AUTHORITY,
  DEFAULT_GRAPH_BASE_URL,
  DEFAULT_SCOPES,
  Microsoft365ConfigSchema,
  resolveScopes,
  resolveTenant,
  type Microsoft365Config,
} from './config.js';
export {
  CONSENT_MESSAGE,
  describeError,
  isConsentBlockedError,
  isConsentBlockedText,
  isGraphDeniedText,
  MISSING_CLIENT_ID_MESSAGE,
} from './consent.js';
export {
  GraphChangeNotifications,
  generateClientState,
  maxSubscriptionMinutes,
  subscriptionResource,
  validationResponse,
  type ChangeNotification,
  type ChangeNotificationsOptions,
  type ChangeSubscription,
  type NotificationCheck,
  type SubscriptionResource,
  type WebhookRequest,
  type WebhookResponse,
  type WebhookResult,
} from './notifications.js';
export {
  ANNOUNCEMENT_AUTHORITY,
  CALENDAR_AUTHORITY,
  createMicrosoft365Normalizer,
  NORMALIZER_VERSION,
} from './normalizer.js';
export {
  bodyToText,
  decodeEntities,
  drivePath,
  extractRoomChange,
  graphDatePart,
  graphDateTimeToIso,
  localMidnightIso,
  looksLikeQuestion,
  materialKindFor,
  parseTeamName,
  resolveTimeZone,
  stripHtml,
  threadSubject,
  type GraphDateTime,
  type MaterialKind,
  type ParsedTeamName,
  type RoomChangeHint,
} from './parsers.js';
export {
  GraphChannelMessageSchema,
  GraphChannelSchema,
  GraphDriveItemSchema,
  GraphEventSchema,
  GraphMessageSchema,
  GraphSchemas,
  GraphTeamSchema,
  graphDrift,
  RAW_TYPES,
  type GraphChannel,
  type GraphChannelMessage,
  type GraphDriveItem,
  type GraphEvent,
  type GraphMessage,
  type GraphTeam,
  type RawType,
} from './schemas.js';
