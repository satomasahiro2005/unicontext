import { type ConnectorContext, defineConnector } from '@unicontext/connector-sdk';
import { deploymentFor, LiveCampusUAdapter } from './adapter.js';
import { type LiveCampusUConfig, LiveCampusUConfigSchema } from './config.js';
import { createLiveCampusUNormalizer } from './core/normalizer.js';
import { metadata } from './metadata.js';

export { metadata, PRODUCT } from './metadata.js';
export { LiveCampusUConfigSchema, type LiveCampusUConfig } from './config.js';
export {
  LiveCampusUAdapter,
  currentAcademicYear,
  deploymentFor,
  type LiveCampusUAdapterOptions,
} from './adapter.js';
export * from './auth/index.js';
export type { LcuAuthStrategy, LcuCookieJar } from './core/auth.js';
export * from './core/deployment.js';
export * from './core/html.js';
export * from './core/policy.js';
export * from './core/schemas.js';
export * from './core/session.js';
export * from './core/sync.js';
export * from './core/text.js';
export * from './core/version.js';
export {
  createLiveCampusUNormalizer,
  examDate,
  NORMALIZER_VERSION,
  SELF_PERSON_KEY,
  type LiveCampusUNormalizerOptions,
} from './core/normalizer.js';
export * from './core/parsers/assignments.js';
export * from './core/parsers/calendar.js';
export * from './core/parsers/notices.js';
export * from './core/parsers/records.js';
export * from './core/parsers/table.js';
export * from './core/parsers/timetable.js';
export { DEPLOYMENTS, SHIZUOKA_DEPLOYMENT } from './profiles/index.js';

/** @unicontext/livecampusu connector module (§26). */
const connector = defineConnector<LiveCampusUConfig>({
  metadata,
  configSchema: LiveCampusUConfigSchema,
  createAdapter: (ctx: ConnectorContext<LiveCampusUConfig>) => new LiveCampusUAdapter(ctx),
  createNormalizer: (ctx: ConnectorContext<LiveCampusUConfig>) =>
    createLiveCampusUNormalizer({ deployment: deploymentFor(ctx) }),
});

export default connector;
export { connector };
