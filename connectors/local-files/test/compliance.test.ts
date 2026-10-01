import { instantiateConnector } from '@unicontext/connector-sdk';
import { testConnectorCompliance } from '@unicontext/connector-sdk/testing';
import { afterAll, describe, expect, it } from 'vitest';
import connector, { createLocalFilesNormalizer, metadata } from '../src/index.js';
import {
  buildUniversityTree,
  createAdapter,
  makeTempDir,
  memorySecrets,
  removeDir,
} from './helpers.js';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map(removeDir));
});

testConnectorCompliance('local-files', {
  metadata,
  normalizer: createLocalFilesNormalizer(),
  createAdapter: async () => {
    const root = await makeTempDir();
    dirs.push(root);
    await buildUniversityTree(root);
    return createAdapter({ roots: [root], pageSize: 4 });
  },
});

describe('connector module', () => {
  it('validates config with defaults and rejects bad values', () => {
    const inst = instantiateConnector(connector, {
      sourceId: 'files',
      config: { roots: ['/x'] },
      secrets: memorySecrets,
    });
    expect(inst.context.config).toMatchObject({
      maxFileSizeMb: 50,
      chunkSize: 1200,
      courseFolderDepth: 1,
      watch: true,
    });
    expect(inst.context.config.exclude).toContain('node_modules');
    expect(() =>
      instantiateConnector(connector, {
        sourceId: 'files',
        config: { maxFileSizeMb: -1 },
        secrets: memorySecrets,
      }),
    ).toThrow(/Invalid config/);
    expect(() =>
      instantiateConnector(connector, {
        sourceId: 'files',
        config: { termFolderPattern: '(' },
        secrets: memorySecrets,
      }),
    ).toThrow(/termFolderPattern/);
  });

  it('declares the spec metadata', () => {
    expect(metadata).toMatchObject({
      name: '@unicontext/local-files',
      product: 'local-files',
      defaultAuthority: 'local-file',
      sourceLabel: 'ローカルファイル',
      adapter: 'filesystem',
    });
  });
});
