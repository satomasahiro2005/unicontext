import { defineConnector, defineMetadata } from '@unicontext/connector-sdk';
import { CancellationsAdapter, type CancellationsAdapterOptions } from './adapter.js';
import { createCancellationNormalizer } from './normalizer.js';
import { CANCELLATION_TYPE, type CancellationsConfig, CancellationsConfigSchema } from './types.js';

export const cancellationsMetadata = defineMetadata({
  name: '@unicontext/syllabus/public-cancellations',
  product: 'lcu-public-cancellations',
  version: '1.0.0',
  license: 'MIT',
  description:
    'Public (no login) LiveCampusU cancellation notices: whole-university announcements plus cancelled class sessions for the user’s own courses.',
  capabilities: ['timetable', 'announcements'],
  adapter: 'native',
  apiStability: 'unofficial',
  risk: 'unsupported',
  testedVersion: 'lcu-web public 2026-10',
  defaultAuthority: 'academic-system',
  sourceLabel: '休講案内',
  defaultSchedule: '15m',
  rawTypes: [CANCELLATION_TYPE],
});

/** `options.courseProvider` lets the daemon feed the user's courses (config `courses:` is merged). */
export function createCancellationsConnector(options: CancellationsAdapterOptions = {}) {
  return defineConnector<CancellationsConfig>({
    metadata: cancellationsMetadata,
    configSchema: CancellationsConfigSchema,
    createAdapter: (ctx) => new CancellationsAdapter(ctx, options),
    createNormalizer: () => createCancellationNormalizer(),
  });
}

export const cancellationsConnector = createCancellationsConnector();
