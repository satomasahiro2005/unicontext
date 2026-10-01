import { defineConnector, defineMetadata } from '@unicontext/connector-sdk';
import { LocalFilesAdapter } from './adapter.js';
import { type LocalFilesConfig, LocalFilesConfigSchema } from './config.js';
import { createLocalFilesNormalizer } from './normalizer.js';
import { RAW_TYPE_DOCUMENT } from './types.js';

export const metadata = defineMetadata({
  name: '@unicontext/local-files',
  product: 'local-files',
  version: '1.0.0',
  license: 'MIT',
  description: 'Watches local folders (~/University) and extracts text from course files',
  capabilities: ['files', 'materials'],
  adapter: 'filesystem',
  apiStability: 'official',
  risk: 'supported',
  defaultAuthority: 'local-file',
  sourceLabel: 'ローカルファイル',
  // The diff is cheap (size + mtime); watch() gives immediate updates on top.
  defaultSchedule: '30m',
  rawTypes: [RAW_TYPE_DOCUMENT],
});

export default defineConnector<LocalFilesConfig>({
  metadata,
  configSchema: LocalFilesConfigSchema,
  createAdapter: (ctx) => new LocalFilesAdapter(ctx),
  createNormalizer: (ctx) =>
    createLocalFilesNormalizer({
      chunkSize: ctx.config.chunkSize,
      chunkOverlap: ctx.config.chunkOverlap,
    }),
});
