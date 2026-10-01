import { AuthRequiredError, ManualClock, secretKey } from '@unicontext/core';
import { describe, expect, it } from 'vitest';
import {
  authorizeWithPkce,
  buildAuthorizationUrl,
  createSecretStore,
  generatePkce,
  KeyringSecretStore,
  MemorySecretStore,
  OAuthTokenStore,
  pkceChallenge,
  startLoopbackListener,
  type OAuthClientConfig,
} from '../src/index.js';

const config: OAuthClientConfig = {
  authorizationEndpoint: 'https://login.example.com/oauth2/v2.0/authorize',
  tokenEndpoint: 'https://login.example.com/oauth2/v2.0/token',
  clientId: 'client-123',
  scopes: ['offline_access', 'User.Read'],
};

describe('SecretStore', () => {
  it('memory store round-trips', async () => {
    const s = new MemorySecretStore();
    await s.set(secretKey('m365', 'refresh_token'), 'r');
    expect(await s.get('m365/refresh_token')).toBe('r');
    expect(await s.delete('m365/refresh_token')).toBe(true);
    expect(await s.get('m365/refresh_token')).toBeUndefined();
  });

  it('createSecretStore("memory") never touches the keychain', async () => {
    expect((await createSecretStore({ backend: 'memory' })).backend).toBe('memory');
  });

  // Touches the real OS keychain; opt in with UNICONTEXT_TEST_KEYRING=1.
  it.runIf(process.env.UNICONTEXT_TEST_KEYRING === '1')(
    'keyring store round-trips in the OS keychain',
    async () => {
      const s = await KeyringSecretStore.create('unicontext-test');
      const key = `test/${Date.now()}`;
      await s.set(key, 'value-1');
      expect(await s.get(key)).toBe('value-1');
      expect(await s.delete(key)).toBe(true);
      expect(await s.get(key)).toBeUndefined();
    },
  );
});

describe('PKCE (RFC 7636)', () => {
  it('matches the RFC 7636 appendix B vector', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('generates a 43+ char unreserved verifier', () => {
    const p = generatePkce();
    expect(p.verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(p.challenge).toBe(pkceChallenge(p.verifier));
  });

  it('builds an authorization URL with S256 challenge', () => {
    const url = new URL(
      buildAuthorizationUrl(config, {
        redirectUri: 'http://127.0.0.1:5000/callback',
        state: 's',
        codeChallenge: 'c',
      }),
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('offline_access User.Read');
    expect(url.searchParams.get('response_type')).toBe('code');
  });
});

describe('loopback authorization flow (RFC 8252)', () => {
  it('listens on 127.0.0.1 with a random port and exchanges the code', async () => {
    let tokenBody: URLSearchParams | undefined;
    const tokens = await authorizeWithPkce(config, {
      openBrowser: async (authUrl) => {
        const u = new URL(authUrl);
        const redirect = new URL(u.searchParams.get('redirect_uri') ?? '');
        expect(redirect.hostname).toBe('127.0.0.1');
        expect(Number(redirect.port)).toBeGreaterThan(0);
        redirect.searchParams.set('code', 'auth-code');
        redirect.searchParams.set('state', u.searchParams.get('state') ?? '');
        const res = await fetch(redirect);
        expect(res.status).toBe(200);
      },
      fetch: async (_url, init) => {
        tokenBody = new URLSearchParams(String(init?.body));
        return new Response(
          JSON.stringify({
            access_token: 'at',
            refresh_token: 'rt',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200 },
        );
      },
    });
    expect(tokens.accessToken).toBe('at');
    expect(tokenBody?.get('grant_type')).toBe('authorization_code');
    expect(tokenBody?.get('code')).toBe('auth-code');
    expect(tokenBody?.get('code_verifier')).toMatch(/^[A-Za-z0-9\-._~]{43,}$/);
  });

  it('rejects a callback with the wrong state', async () => {
    const listener = await startLoopbackListener();
    const assertion = expect(listener.waitForCode('expected')).rejects.toThrow(/state mismatch/);
    const res = await fetch(`${listener.redirectUri}?code=x&state=attacker`);
    expect(res.status).toBe(400);
    await assertion;
    await listener.close();
  });

  it('closes the listener and clears its timeout when the browser cannot be opened', async () => {
    const clock = new ManualClock('2026-10-01T00:00:00Z');
    let redirectUri = '';
    await expect(
      authorizeWithPkce(config, {
        clock,
        openBrowser: (authUrl) => {
          redirectUri = new URL(authUrl).searchParams.get('redirect_uri') ?? '';
          return Promise.reject(new Error('xdg-open not found'));
        },
        fetch: () => Promise.reject(new Error('token endpoint must not be called')),
      }),
    ).rejects.toThrow(/xdg-open not found/);
    // No timer is left behind to reject an orphaned promise minutes later.
    expect(clock.pending).toBe(0);
    // The loopback port is closed.
    await expect(fetch(redirectUri)).rejects.toThrow();
  });

  it('reports an authorization error from the provider', async () => {
    const listener = await startLoopbackListener();
    const assertion = expect(listener.waitForCode('s')).rejects.toThrow(/access_denied/);
    await fetch(`${listener.redirectUri}?error=access_denied&state=s`);
    await assertion;
    await listener.close();
  });
});

describe('OAuthTokenStore', () => {
  it('stores tokens in the SecretStore and refreshes expired ones', async () => {
    const clock = new ManualClock('2026-10-01T00:00:00Z');
    const secrets = new MemorySecretStore();
    const store = new OAuthTokenStore(secrets, secretKey('microsoft365', 'oauth'), clock);
    await expect(store.getAccessToken(config)).rejects.toBeInstanceOf(AuthRequiredError);
    await store.save({
      accessToken: 'old',
      tokenType: 'Bearer',
      refreshToken: 'rt',
      expiresAt: '2026-10-01T00:30:00Z',
    });
    expect(await store.getAccessToken(config)).toBe('old');
    clock.set('2026-10-01T01:00:00Z');
    const fresh = await store.getAccessToken(config, {
      fetch: async () =>
        new Response(JSON.stringify({ access_token: 'new', expires_in: 3600 }), { status: 200 }),
    });
    expect(fresh).toBe('new');
    expect((await store.load())?.refreshToken).toBe('rt');
    expect(secrets.keys()).toEqual(['microsoft365/oauth']);
  });

  it('turns a rejected refresh into AuthRequiredError', async () => {
    const clock = new ManualClock('2026-10-01T01:00:00Z');
    const store = new OAuthTokenStore(new MemorySecretStore(), 'm/oauth', clock);
    await store.save({
      accessToken: 'old',
      tokenType: 'Bearer',
      refreshToken: 'rt',
      expiresAt: '2026-10-01T00:30:00Z',
    });
    await expect(
      store.getAccessToken(config, {
        fetch: async () =>
          new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
      }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
  });
});
