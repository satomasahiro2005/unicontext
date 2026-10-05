import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemorySecretStore } from '@unicontext/auth';
import type { SecretStore } from '@unicontext/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exec, json, removeDir, tempDir, writeConfig } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Tiny real stdio MCP server (adapter-mcp's test fixture) that echoes UC_TEST_SECRET back. */
const stdioServer = path.resolve(
  here,
  '../../../packages/adapter-mcp/test/fixtures/stdio-server.mjs',
);

/** Stands in for the OS keychain: persistent across CLI invocations of one test. */
class FakeKeychain implements SecretStore {
  readonly backend = 'fake-keyring';
  readonly map = new Map<string, string>();
  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.map.get(key));
  }
  set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.map.delete(key));
  }
}

const CONFIG = [
  'sources:',
  '  ed:',
  '    adapter: mcp',
  `    command: ${JSON.stringify(process.execPath)}`,
  `    args: [${JSON.stringify(stdioServer)}]`,
  '    envSecrets:',
  '      - { name: UC_TEST_SECRET, secret: ed-token }',
  '    timeoutMs: 20000',
  '    mapping:',
  '      id: stdio',
  '      product: stdio',
  '      capabilities: [courses]',
  '      resources:',
  '        - { name: env, call: { tool: echo_env }, sourceType: stdio.env, externalId: id }',
  '  plain:',
  '    enabled: false',
  '    connector: "@unicontext/definitely-not-installed"',
  '',
].join('\n');

interface SecretsJson {
  backend: string;
  entries: { sourceId: string; name: string; target: string; key: string; stored: boolean }[];
}

describe('secrets and token entry on login', () => {
  let dir: string;
  let base: string[];
  beforeAll(() => {
    dir = tempDir();
    writeConfig(dir, CONFIG);
    base = ['--data-dir', dir];
  });
  afterAll(() => removeDir(dir));

  it('list shows the named secrets without values; set stores one; delete removes it', async () => {
    const keychain = new FakeKeychain();
    const deps = { secretStore: async () => keychain };
    const before = json<SecretsJson>(await exec([...base, '--json', 'secrets', 'list'], deps));
    expect(before.entries).toEqual([
      {
        sourceId: 'ed',
        name: 'ed-token',
        target: 'UC_TEST_SECRET',
        via: 'envSecrets',
        key: 'ed/ed-token',
        stored: false,
      },
    ]);

    // no terminal and no --from-env: usage error, nothing stored
    const noTty = await exec([...base, 'secrets', 'set', 'ed'], deps);
    expect(noTty.code).toBe(2);
    expect(keychain.map.size).toBe(0);

    const unknown = await exec([...base, 'secrets', 'set', 'ed', 'nope'], deps);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('ed-token');

    const asked: string[] = [];
    const typed = await exec([...base, 'secrets', 'set', 'ed'], {
      ...deps,
      interactive: true,
      promptSecret: async (q) => {
        asked.push(q);
        return '  typed-value-123  ';
      },
    });
    expect(typed.code, typed.stderr).toBe(0);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('UC_TEST_SECRET');
    expect(keychain.map.get('ed/ed-token')).toBe('typed-value-123');
    expect(typed.stdout + typed.stderr).not.toContain('typed-value-123');
    expect(typed.stdout).toContain('unicontext login ed');

    const fromEnv = await exec([...base, 'secrets', 'set', 'ed', 'ed-token', '--from-env', 'X'], {
      ...deps,
      env: { X: 'from-env-456' },
    });
    expect(fromEnv.code, fromEnv.stderr).toBe(0);
    expect(keychain.map.get('ed/ed-token')).toBe('from-env-456');

    const listed = await exec([...base, 'secrets', 'list', 'ed'], deps);
    expect(listed.stdout).toContain('保存済み');
    expect(listed.stdout).not.toContain('from-env-456');

    const del = await exec([...base, 'secrets', 'delete', 'ed'], deps);
    expect(del.code).toBe(0);
    expect(keychain.map.has('ed/ed-token')).toBe(false);
  });

  it('refuses to "store" into a memory-only secret store, and sources without secrets', async () => {
    const memory = await exec([...base, 'secrets', 'set', 'ed', '--from-env', 'X'], {
      env: { X: 'v' },
      secretStore: async () => new MemorySecretStore(),
    });
    expect(memory.code).toBe(1);
    expect(memory.stderr).toContain('キーチェーン');
    const none = await exec([...base, 'secrets', 'set', 'plain', '--from-env', 'X'], {
      env: { X: 'v' },
      secretStore: async () => new FakeKeychain(),
    });
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('envSecrets');
  });

  it('login asks for a missing token without echo, stores it and connects', async () => {
    const keychain = new FakeKeychain();
    const offline = await exec([...base, 'login', 'ed'], { secretStore: async () => keychain });
    expect(offline.code).toBe(1);
    expect(offline.stderr).toContain('unicontext secrets set ed ed-token');

    const asked: string[] = [];
    const r = await exec([...base, 'login', 'ed'], {
      secretStore: async () => keychain,
      interactive: true,
      promptSecret: async (q) => {
        asked.push(q);
        return 'tok-from-login';
      },
    });
    expect(r.code, r.stderr).toBe(0);
    expect(asked).toHaveLength(1);
    expect(keychain.map.get('ed/ed-token')).toBe('tok-from-login');
    expect(r.stdout).toContain('秘密情報を保存しました（ed-token）');
    expect(r.stdout).toContain('ed: 認証できました');
    expect(r.stdout + r.stderr).not.toContain('tok-from-login');

    // a second login does not ask again
    const again = await exec([...base, 'login', 'ed'], {
      secretStore: async () => keychain,
      interactive: true,
      promptSecret: async () => {
        throw new Error('must not prompt');
      },
    });
    expect(again.code, again.stderr).toBe(0);
  }, 60_000);
});
