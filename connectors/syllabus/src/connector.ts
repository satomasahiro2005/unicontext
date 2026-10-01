import { defineConnector, defineMetadata } from '@unicontext/connector-sdk';
import { SyllabusAdapter, type SyllabusAdapterOptions } from './adapter.js';
import { createSyllabusNormalizer } from './normalizer.js';
import { SYLLABUS_ENTRY, type SyllabusConfig, SyllabusConfigSchema } from './types.js';

export const metadata = defineMetadata({
  name: '@unicontext/syllabus',
  product: 'syllabus',
  version: '1.0.0',
  license: 'MIT',
  description:
    'Course syllabus connector: generic strategy interface with a LiveCampusU public syllabus strategy (no login).',
  capabilities: ['courses', 'timetable', 'rooms'],
  adapter: 'native',
  // The public LiveCampusU screens are server-rendered HTML without a documented interface (§27).
  apiStability: 'unofficial',
  risk: 'unsupported',
  testedVersion: 'lcu-web public 2026-10',
  defaultAuthority: 'syllabus',
  sourceLabel: 'シラバス',
  defaultSchedule: '1d',
  rawTypes: [SYLLABUS_ENTRY],
  referenceOnly: true,
});

/**
 * Build the syllabus connector module. `options` are passed to every adapter it creates; the daemon
 * uses `targetProvider` to feed the student's LCU course codes:
 *   createSyllabusConnector({ targetProvider: () => targetsFromLcuCourses() })
 */
export function createSyllabusConnector(options: SyllabusAdapterOptions = {}) {
  return defineConnector<SyllabusConfig>({
    metadata,
    configSchema: SyllabusConfigSchema,
    createAdapter: (ctx) => new SyllabusAdapter(ctx, options),
    createNormalizer: () => createSyllabusNormalizer(),
  });
}

export const syllabusConnector = createSyllabusConnector();
