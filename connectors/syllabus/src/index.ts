import type { ConnectorFactoryInput, ConnectorModule } from '@unicontext/connector-sdk';
import { ConfigError } from '@unicontext/core';
import { cancellationsConnector } from './cancellations/connector.js';
import { syllabusConnector } from './connector.js';

export { SyllabusAdapter } from './adapter.js';
export type { SyllabusAdapterOptions, SyllabusTargetProvider } from './adapter.js';
export { createSyllabusNormalizer, syllabusSections } from './normalizer.js';
export { createSyllabusConnector, metadata, syllabusConnector } from './connector.js';
export { HttpSession, SessionExpiredError } from './session.js';
export type { SessionRequest, SessionResponse } from './session.js';
export { createStrategy, registerSyllabusStrategy, SYLLABUS_PRODUCT } from './strategies.js';
export type { StrategyFactory } from './strategies.js';
export type { SyllabusDetailResult, SyllabusStrategy } from './strategy.js';
export { LcuPublicStrategy, SEARCH_FIELDS, rowKey } from './lcu/strategy.js';
export {
  isErrorPage,
  parseCsrf,
  parseDetail,
  parseResults,
  splitBilingual,
  yearOfTitle,
} from './lcu/parse.js';
export { parseDayPeriod } from './schedule.js';
export * from './types.js';
export * from './profiles/index.js';

export { CancellationsAdapter, matchUserCourse } from './cancellations/adapter.js';
export type { CancellationsAdapterOptions, UserCourseProvider } from './cancellations/adapter.js';
export { cancellationTitle, createCancellationNormalizer } from './cancellations/normalizer.js';
export {
  cancellationsConnector,
  cancellationsMetadata,
  createCancellationsConnector,
} from './cancellations/connector.js';
export { inferYear, parseCancellations, splitTitleAndClass } from './cancellations/parse.js';
export type { AsOf, CancellationRow, ParsedCancellations } from './cancellations/parse.js';
export * from './cancellations/types.js';

/** Connector modules of this package, by name (host registries look them up here). */
export const connectors = {
  syllabus: syllabusConnector,
  'public-cancellations': cancellationsConnector,
};

export type SyllabusPackageModule = keyof typeof connectors;

/**
 * Package entry for hosts (default / named `connector`): one package, two modules. A source picks
 * the public 休講 module with `module: public-cancellations`; anything else gets the syllabus
 * connector.
 */
export async function connector(input: ConnectorFactoryInput): Promise<ConnectorModule<unknown>> {
  const name = (input.config as { module?: unknown } | undefined)?.module;
  if (name === undefined || name === 'syllabus')
    return syllabusConnector as ConnectorModule<unknown>;
  if (name === 'public-cancellations') return cancellationsConnector as ConnectorModule<unknown>;
  throw new ConfigError(
    `Source ${input.sourceId}: unknown syllabus module "${String(name)}" (syllabus | public-cancellations)`,
  );
}

export default connector;
