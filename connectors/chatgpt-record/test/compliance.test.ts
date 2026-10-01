import { instantiateConnector } from '@unicontext/connector-sdk';
import { testConnectorCompliance } from '@unicontext/connector-sdk/testing';
import { loadProfile } from '@unicontext/core';
import { afterAll, describe, expect, it } from 'vitest';
import connector, { createChatGptRecordNormalizer, metadata } from '../src/index.js';
import { createAdapter, lectureTree, makeTempDir, memorySecrets, removeDir } from './helpers.js';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map(removeDir));
});

testConnectorCompliance('chatgpt-record', {
  metadata,
  normalizer: createChatGptRecordNormalizer(),
  profile: loadProfile('shizuoka-university'),
  createAdapter: async () => {
    const dir = await makeTempDir();
    dirs.push(dir);
    await lectureTree(dir);
    return createAdapter({ watchDir: dir, pageSize: 2 });
  },
});

describe('connector module', () => {
  it('validates config and applies defaults', () => {
    const inst = instantiateConnector(connector, {
      sourceId: 'record',
      config: {},
      secrets: memorySecrets,
    });
    expect(inst.context.config).toMatchObject({
      watch: true,
      importer: 'chatgpt-record',
      extensions: ['txt', 'md', 'vtt', 'srt', 'json'],
    });
    expect(() =>
      instantiateConnector(connector, {
        sourceId: 'record',
        config: { maxFileSizeMb: 0 },
        secrets: memorySecrets,
      }),
    ).toThrow(/Invalid config/);
  });

  it('declares the spec metadata', () => {
    expect(metadata).toMatchObject({
      name: '@unicontext/chatgpt-record',
      product: 'chatgpt-record',
      sourceLabel: 'ChatGPT Record',
      defaultAuthority: 'transcript',
      adapter: 'filesystem',
    });
  });
});
