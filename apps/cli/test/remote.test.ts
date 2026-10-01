import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { RemoteStateStore, verifyPassphrase } from '@unicontext/daemon/lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exec, json, removeDir, tempDir, writeConfig } from './helpers.js';

describe('unicontext remote', () => {
  let dir: string;
  let config: string;
  const run = (args: string[], over: Parameters<typeof exec>[1] = {}, answers: string[] = []) =>
    exec(['--data-dir', dir, '--config', config, ...args], over, answers);

  beforeAll(() => {
    dir = tempDir('unicontext-cli-remote-');
    config = writeConfig(
      dir,
      'remote:\n  enabled: true\n  publicUrl: https://uc.example.test\n  port: 17999\n',
    );
  });
  afterAll(() => removeDir(dir));

  it('set-passphrase stores only a scrypt hash', async () => {
    const short = await run(['remote', 'set-passphrase', '--from-env', 'UC_PASS'], {
      env: { UC_PASS: 'short' },
    });
    expect(short.code).toBe(1);
    expect(short.stderr).toContain('12文字以上');
    const ok = await run(['remote', 'set-passphrase', '--from-env', 'UC_PASS'], {
      env: { UC_PASS: 'a long enough passphrase' },
    });
    expect(ok.code, ok.stderr).toBe(0);
    const file = path.join(dir, 'remote', 'oauth-state.json');
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('a long enough passphrase');
    const hash = new RemoteStateStore(file).read().owner.passphrase;
    expect(hash?.alg).toBe('scrypt');
    expect(await verifyPassphrase('a long enough passphrase', hash!)).toBe(true);
  });

  it('set-passphrase asks twice without echo and refuses a mismatch', async () => {
    const asked: string[] = [];
    const answers = ['first passphrase 123', 'second passphrase 456'];
    const r = await run(['remote', 'set-passphrase'], {
      interactive: true,
      promptSecret: async (q) => {
        asked.push(q);
        return answers.shift() ?? '';
      },
    });
    expect(r.code).toBe(1);
    expect(asked).toHaveLength(2);
    expect(r.stderr).toContain('一致しません');
    const noTty = await run(['remote', 'set-passphrase']);
    expect(noTty.code).toBe(2);
  });

  it('status, clients and revoke', async () => {
    const store = RemoteStateStore.forPaths({ root: dir });
    store.update((s) => {
      s.clients.ucc_a = {
        clientId: 'ucc_a',
        type: 'dcr',
        name: 'ChatGPT',
        redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
        tokenEndpointAuthMethod: 'none',
        createdAt: '2026-10-01T00:00:00.000Z',
      };
      s.grants.ucg_1 = {
        grantId: 'ucg_1',
        clientId: 'ucc_a',
        scope: 'unicontext.read',
        resource: 'https://uc.example.test/mcp',
        createdAt: '2026-10-01T00:00:00.000Z',
        refreshHash: 'x'.repeat(64),
        refreshExpiresAt: '2099-01-01T00:00:00.000Z',
        rotatedRefreshHashes: [],
      };
      s.accessTokens['y'.repeat(64)] = {
        grantId: 'ucg_1',
        clientId: 'ucc_a',
        scope: 'unicontext.read',
        resource: 'https://uc.example.test/mcp',
        expiresAt: '2099-01-01T00:00:00.000Z',
      };
    });
    const status = await run(['--json', 'remote', 'status']);
    expect(status.code, status.stderr).toBe(0);
    expect(json(status)).toMatchObject({
      enabled: true,
      mcpUrl: 'https://uc.example.test/mcp',
      listen: 'http://127.0.0.1:17999',
      unlockConfigured: true,
      clients: 1,
      activeGrants: 1,
    });
    const clients = await run(['--json', 'remote', 'clients']);
    expect(json(clients)).toEqual([
      expect.objectContaining({ clientId: 'ucc_a', type: 'dcr', name: 'ChatGPT', activeGrants: 1 }),
    ]);
    const table = await run(['remote', 'clients']);
    expect(table.stdout).toContain('ucc_a');

    expect((await run(['remote', 'revoke'])).code).toBe(2);
    expect((await run(['remote', 'revoke', 'ucc_missing'])).code).toBe(1);
    const revoked = await run(['remote', 'revoke', 'ucc_a']);
    expect(revoked.code, revoked.stderr).toBe(0);
    const after = store.read();
    expect(after.clients.ucc_a).toBeUndefined();
    expect(after.grants.ucg_1?.revokedAt).toBeTruthy();
    expect(Object.keys(after.accessTokens)).toHaveLength(0);
    expect((await run(['remote', 'revoke', '--all'])).code).toBe(2); // needs --yes without a TTY
    expect((await run(['remote', 'revoke', '--all', '--yes'])).code).toBe(0);
  });

  it('tunnel-config prints a config that exposes only the remote port', async () => {
    const r = await run(['remote', 'tunnel-config']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('hostname: uc.example.test');
    expect(r.stdout).toContain('service: http://127.0.0.1:17999');
    expect(r.stdout).not.toContain('17878');
    expect(r.stdout).toContain('http_status:404');

    const out = path.join(dir, 'cloudflared', 'config.yml');
    expect((await run(['remote', 'tunnel-config', '--write', out])).code).toBe(2);
    const w = await run([
      'remote',
      'tunnel-config',
      '--hostname',
      'uc.nemut.ai',
      '--credentials-file',
      path.join(dir, 'cred.json'),
      '--write',
      out,
    ]);
    expect(w.code, w.stderr).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, 'utf8')).toContain('hostname: uc.nemut.ai');
    expect(w.stderr).toContain('remote.publicUrlをhttps://uc.nemut.ai');
    expect(
      (await run(['remote', 'tunnel-config', '--credentials-file', 'c.json', '--write', out])).code,
    ).toBe(1);
  });
});
