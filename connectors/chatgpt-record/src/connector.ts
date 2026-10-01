import { defineConnector, defineMetadata } from '@unicontext/connector-sdk';
import { ChatGptRecordAdapter } from './adapter.js';
import { type ChatGptRecordConfig, ChatGptRecordConfigSchema } from './config.js';
import { RAW_TYPE_TRANSCRIPT } from './importer.js';
import { createChatGptRecordNormalizer } from './normalizer.js';

export const metadata = defineMetadata({
  name: '@unicontext/chatgpt-record',
  product: 'chatgpt-record',
  version: '1.0.0',
  license: 'MIT',
  description:
    'Imports lecture transcripts (ChatGPT Record, Zoom, Whisper, VTT/SRT) from a watched folder or manually',
  capabilities: ['lectures'],
  adapter: 'filesystem',
  // No public ChatGPT Record API is assumed: transcripts arrive as files (manual import / folder).
  apiStability: 'official',
  risk: 'supported',
  defaultAuthority: 'transcript',
  sourceLabel: 'ChatGPT Record',
  // A folder scan is cheap; watch() and manual import give immediate updates on top.
  defaultSchedule: '30m',
  rawTypes: [RAW_TYPE_TRANSCRIPT],
});

export default defineConnector<ChatGptRecordConfig>({
  metadata,
  configSchema: ChatGptRecordConfigSchema,
  createAdapter: (ctx) => new ChatGptRecordAdapter(ctx),
  createNormalizer: (ctx) => createChatGptRecordNormalizer({ importer: ctx.config.importer }),
});
