import type { SecretStore } from '@unicontext/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exec, removeDir, tempDir, writeConfig } from './helpers.js';

class Keychain implements SecretStore {
  readonly backend = 'fake-keyring';
  readonly map = new Map<string, string>();
  get = (k: string) => Promise.resolve(this.map.get(k));
  set = (k: string, v: string) => Promise.resolve(void this.map.set(k, v));
  delete = (k: string) => Promise.resolve(this.map.delete(k));
}

describe('ai keys', () => {
  let dir: string;
  let base: string[];
  beforeAll(() => {
    dir = tempDir();
    base = ['--data-dir', dir, '--config', writeConfig(dir, 'sources: {}\n')];
  });
  afterAll(() => removeDir(dir));

  it('tells a Claude key from an OpenAI key and shows both', async () => {
    const keychain = new Keychain();
    const deps = { secretStore: async () => keychain };
    const setKey = (args: string[], value: string) =>
      exec([...base, 'ai', 'set-key', ...args, '--stdin'], {
        ...deps,
        promptSecret: async () => value,
      });
    const openai = await setKey([], 'sk-proj-abc');
    expect(openai.code, openai.stderr).toBe(0);
    expect(openai.stdout).toContain('ChatGPT（OpenAI）のAPIキーを保存しました');
    const claude = await setKey(['claude'], 'sk-ant-x');
    expect(claude.code, claude.stderr).toBe(0);
    expect([...keychain.map.keys()].sort()).toEqual(['ai/anthropic-api-key', 'ai/openai-api-key']);

    const wrong = await setKey(['claude'], 'sk-proj-y');
    expect(wrong.code).toBe(1);
    expect(keychain.map.get('ai/anthropic-api-key')).toBe('sk-ant-x');

    const status = await exec([...base, 'ai', 'status'], deps);
    expect(status.stdout).toContain('Claude:        使えます（claude-opus-5-5');
    expect(status.stdout).toContain('ChatGPT:       使えます（gpt-6.1-sol');
    expect(status.stdout).toContain('Claude → ChatGPT（OpenAI）');
    expect(status.stdout).not.toContain('sk-');

    const removed = await exec([...base, 'ai', 'remove-key', 'openai'], deps);
    expect(removed.stdout).toContain('ChatGPT（OpenAI）のAPIキーを消しました');
    expect(keychain.map.has('ai/openai-api-key')).toBe(false);
  });
});
