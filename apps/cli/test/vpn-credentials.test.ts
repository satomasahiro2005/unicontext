import type { SavedCredentialsAdapter } from '@unicontext/connector-sdk';
import type { SecretStore } from '@unicontext/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { offerSavedCredentials } from '../src/commands/secrets.js';
import { CliContext } from '../src/context.js';
import { exec, json, makeDeps, removeDir, tempDir, writeConfig } from './helpers.js';

/* Saving the VPN portal password for automatic re-login (opt-in, OS keychain only). */

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

function fakeAdapter(): SavedCredentialsAdapter & { changed: number } {
  const a = {
    id: 'fake',
    version: '0',
    changed: 0,
    capabilities: () => Promise.resolve([]),
    authenticate: () => Promise.resolve({ status: 'auth_required' as const }),
    sync: () => Promise.resolve({ items: [] }),
    health: () => Promise.resolve({ state: 'healthy' as const, checkedAt: '' }),
    dispose: () => Promise.resolve(),
    credentialSecrets: () => [
      { secret: 'username', label: 'VPN ポータルのユーザー名', echo: true },
      { secret: 'password', label: 'VPN ポータルのパスワード', echo: false },
    ],
    credentialsChanged: () => {
      a.changed++;
    },
  };
  return a;
}

function context(answers: string[], keychain: SecretStore, opts: { json?: boolean; interactive?: boolean } = {}) {
  const secretPrompts: string[] = [];
  const t = makeDeps(
    {
      interactive: opts.interactive ?? true,
      secretStore: async () => keychain,
      promptSecret: async (q) => {
        secretPrompts.push(q);
        return 'S3cret-pass!';
      },
    },
    answers,
  );
  const ctx = new CliContext(t.deps, { ...(opts.json ? { json: true } : {}) });
  return { ctx, t, secretPrompts };
}

describe('login offers to save the VPN password (opt-in)', () => {
  it('asks y/N; on yes the user name is echoed, the password is not, both go to the keychain', async () => {
    const keychain = new FakeKeychain();
    const adapter = fakeAdapter();
    const { ctx, t, secretPrompts } = context(['y', 'cs-user'], keychain);
    const stored = await offerSavedCredentials(ctx, 'shizuoka-vpn-files', adapter, undefined);
    expect(stored).toEqual(['username', 'password']);
    expect(keychain.map.get('shizuoka-vpn-files/username')).toBe('cs-user');
    expect(keychain.map.get('shizuoka-vpn-files/password')).toBe('S3cret-pass!');
    expect(t.prompts[0]).toMatch(/自動でサインインし直す.*\[y\/N\]/);
    expect(t.prompts[1]).toMatch(/ユーザー名を入力/);
    expect(secretPrompts[0]).toMatch(/パスワードを入力.*表示されません/);
    expect(adapter.changed).toBe(1);
    // Nothing secret on the terminal.
    expect(t.stdout() + t.stderr()).not.toContain('S3cret-pass!');
  });

  it('no (the default) stores nothing', async () => {
    const keychain = new FakeKeychain();
    const adapter = fakeAdapter();
    const { ctx } = context([''], keychain);
    expect(await offerSavedCredentials(ctx, 'shizuoka-vpn-files', adapter, undefined)).toEqual([]);
    expect(keychain.map.size).toBe(0);
    expect(adapter.changed).toBe(0);
  });

  it('--no-save-password, --json or no terminal never ask', async () => {
    for (const [choice, o] of [
      [false, {}],
      [undefined, { json: true }],
      [undefined, { interactive: false }],
    ] as const) {
      const keychain = new FakeKeychain();
      const { ctx, t } = context(['y', 'u'], keychain, o);
      expect(await offerSavedCredentials(ctx, 'shizuoka-vpn-files', fakeAdapter(), choice)).toEqual([]);
      expect(t.prompts).toEqual([]);
    }
  });

  it('--save-password skips the question; already saved → nothing asked', async () => {
    const keychain = new FakeKeychain();
    const { ctx, t } = context(['cs-user'], keychain);
    expect(await offerSavedCredentials(ctx, 'shizuoka-vpn-files', fakeAdapter(), true)).toEqual([
      'username',
      'password',
    ]);
    expect(t.prompts[0]).toMatch(/ユーザー名/);
    const again = context([], keychain);
    expect(await offerSavedCredentials(again.ctx, 'shizuoka-vpn-files', fakeAdapter(), undefined)).toEqual([]);
    expect(again.t.prompts).toEqual([]);
  });

  it('a memory-only secret store (no keychain) never stores the password', async () => {
    const memory: SecretStore = { ...new FakeKeychain(), backend: 'memory', get: () => Promise.resolve(undefined), set: () => Promise.reject(new Error('must not store')), delete: () => Promise.resolve(false) };
    const { ctx, t } = context(['y'], memory);
    expect(await offerSavedCredentials(ctx, 'shizuoka-vpn-files', fakeAdapter(), undefined)).toEqual([]);
    expect(t.stderr()).toMatch(/キーチェーンを使えない/);
  });
});

describe('unicontext secrets for the VPN source', () => {
  let dir: string;
  let base: string[];
  beforeAll(() => {
    dir = tempDir();
    writeConfig(
      dir,
      ['profile: shizuoka-university', 'sources:', '  shizuoka-vpn-files: { enabled: true }', ''].join('\n'),
    );
    base = ['--data-dir', dir];
  });
  afterAll(() => removeDir(dir));

  it('lists the sign-in credentials (never their values); set --from-env stores one; delete removes it', async () => {
    const keychain = new FakeKeychain();
    const deps = { secretStore: async () => keychain };
    const list = json<{ entries: { sourceId: string; name: string; via: string; stored: boolean }[] }>(
      await exec([...base, '--json', 'secrets', 'list', 'shizuoka-vpn-files'], deps),
    );
    expect(list.entries.map((e) => [e.name, e.via, e.stored])).toEqual([
      ['username', 'login', false],
      ['password', 'login', false],
    ]);
    const set = await exec(
      [...base, 'secrets', 'set', 'shizuoka-vpn-files', 'password', '--from-env', 'UC_VPN_PW'],
      { ...deps, env: { UC_VPN_PW: 'Env-Pass-1' } },
    );
    expect(set.code, set.stderr).toBe(0);
    expect(set.stdout + set.stderr).not.toContain('Env-Pass-1');
    expect(keychain.map.get('shizuoka-vpn-files/password')).toBe('Env-Pass-1');
    const del = await exec([...base, 'secrets', 'delete', 'shizuoka-vpn-files', 'password'], deps);
    expect(del.code).toBe(0);
    expect(keychain.map.has('shizuoka-vpn-files/password')).toBe(false);
  }, 60_000);
});
