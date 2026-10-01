import { secretKey } from '@unicontext/auth';
import { parseProfile } from '@unicontext/core';
import { describe, expect, it } from 'vitest';
import {
  buildOAuthConfig,
  DEFAULT_SCOPES,
  Microsoft365ConfigSchema,
  resolveScopes,
  resolveTenant,
} from '../src/index.js';
import { FakeGraph, ID_TOKEN, json, setup, SOURCE_ID } from './helpers.js';

const parse = (config: Record<string, unknown> = {}) => Microsoft365ConfigSchema.parse(config);

describe('config → OAuth endpoints and scopes', () => {
  it('defaults: organizations tenant, default scopes + offline_access openid profile', () => {
    const oauth = buildOAuthConfig(parse({ clientId: 'abc' }), undefined);
    expect(oauth.authorizationEndpoint).toBe(
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
    );
    expect(oauth.tokenEndpoint).toBe(
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
    );
    expect(oauth.clientId).toBe('abc');
    expect(oauth.scopes).toEqual([...DEFAULT_SCOPES, 'offline_access', 'openid', 'profile']);
    expect(oauth.scopes).not.toContain('ChannelMessage.Read.All');
  });

  it('tenant: config value, then profile tenant/tenantHint, then organizations', () => {
    const profile = parseProfile(
      'id: x\nacademicCalendar: { timezone: Asia/Tokyo, periods: [], terms: [] }\nproducts:\n  microsoft365:\n    tenantHint: shizuoka.ac.jp\n',
    );
    expect(resolveTenant(parse(), profile)).toBe('shizuoka.ac.jp');
    expect(resolveTenant(parse({ tenant: 'e0d7dc00-4621-4fe0-90b1-df7b1b40b351' }), profile)).toBe(
      'e0d7dc00-4621-4fe0-90b1-df7b1b40b351',
    );
    expect(resolveTenant(parse(), undefined)).toBe('organizations');
    expect(buildOAuthConfig(parse({ clientId: 'abc' }), profile).tokenEndpoint).toBe(
      'https://login.microsoftonline.com/shizuoka.ac.jp/oauth2/v2.0/token',
    );
  });

  it('custom authority and scopes; ChannelMessage.Read.All only with channelMessages', () => {
    const cfg = parse({
      clientId: 'abc',
      authority: 'https://login.microsoftonline.us/',
      scopes: 'User.Read, Mail.Read',
      resources: { channelMessages: true },
    });
    const oauth = buildOAuthConfig(cfg, undefined);
    expect(
      oauth.authorizationEndpoint.startsWith('https://login.microsoftonline.us/organizations/'),
    ).toBe(true);
    expect(resolveScopes(cfg)).toEqual([
      'User.Read',
      'Mail.Read',
      'offline_access',
      'openid',
      'profile',
      'ChannelMessage.Read.All',
    ]);
  });

  it('requires a clientId to log in', () => {
    expect(() => buildOAuthConfig(parse(), undefined)).toThrow(/clientId/);
  });

  it('applies resource defaults (channelMessages off)', () => {
    expect(parse().resources).toEqual({
      calendar: true,
      mail: true,
      drive: true,
      teams: true,
      channelMessages: false,
    });
    expect(parse().calendar).toEqual({ pastDays: 30, futureDays: 180 });
    expect(parse().mail.folder).toBe('inbox');
  });
});

/** Fake browser: follows the authorization URL by calling the loopback redirect itself. */
function browser(
  calls: URL[],
  result: (u: URL) => Record<string, string>,
): (url: string) => Promise<void> {
  return (url) => {
    const u = new URL(url);
    calls.push(u);
    const redirect = new URL(u.searchParams.get('redirect_uri') ?? '');
    for (const [k, v] of Object.entries({ state: u.searchParams.get('state') ?? '', ...result(u) }))
      redirect.searchParams.set(k, v);
    // Real loopback request to 127.0.0.1, issued after openBrowser returns (like a real browser).
    void fetch(redirect).catch(() => undefined);
    return Promise.resolve();
  };
}

describe('InteractiveAuthAdapter.login()', () => {
  it('runs Authorization Code + PKCE through the loopback and stores the tokens', async () => {
    const graph = new FakeGraph();
    graph.tokenHandler = (body) =>
      json({
        access_token: `at-for-${body.get('code')}`,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'rt-1',
        id_token: ID_TOKEN,
        scope: body.get('scope'),
      });
    graph.validTokens.add('at-for-the-code');
    const { adapter, secrets } = await setup({ graph, seed: false });
    expect((await adapter.authenticate()).status).toBe('auth_required');

    const opened: URL[] = [];
    const res = await adapter.login({
      openBrowser: browser(opened, () => ({ code: 'the-code' })),
      loginHint: 'test.hanako.26@example.ac.jp',
      timeoutMs: 5000,
    });

    expect(res).toMatchObject({ status: 'authenticated', account: 'test.hanako.26@example.ac.jp' });
    expect(JSON.stringify(res)).not.toContain('at-for-the-code');
    // authorization request
    const auth = opened[0];
    expect(`${auth?.origin ?? ''}${auth?.pathname ?? ''}`).toBe(
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
    );
    expect(auth?.searchParams.get('client_id')).toBe('test-client-id');
    expect(auth?.searchParams.get('response_type')).toBe('code');
    expect(auth?.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth?.searchParams.get('login_hint')).toBe('test.hanako.26@example.ac.jp');
    expect(auth?.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(auth?.searchParams.get('scope')).toContain('offline_access');
    expect(auth?.searchParams.get('scope')).not.toContain('ChannelMessage');
    // code exchange
    expect(graph.tokenCalls).toHaveLength(1);
    expect(graph.tokenCalls[0]?.get('grant_type')).toBe('authorization_code');
    expect(graph.tokenCalls[0]?.get('code')).toBe('the-code');
    expect(graph.tokenCalls[0]?.get('code_verifier')?.length).toBeGreaterThanOrEqual(43);
    // tokens live in the secret store only
    const stored = JSON.parse((await secrets.get(secretKey(SOURCE_ID, 'oauth'))) ?? '{}') as {
      accessToken?: string;
      refreshToken?: string;
    };
    expect(stored.accessToken).toBe('at-for-the-code');
    expect(stored.refreshToken).toBe('rt-1');
    expect((await adapter.authenticate()).status).toBe('authenticated');
  });

  it('requests ChannelMessage.Read.All when channelMessages is enabled', async () => {
    const { adapter } = await setup({
      seed: false,
      config: { resources: { channelMessages: true } },
    });
    const opened: URL[] = [];
    await adapter.login({ openBrowser: browser(opened, () => ({ code: 'c' })), timeoutMs: 5000 });
    expect(opened[0]?.searchParams.get('scope')).toContain('ChannelMessage.Read.All');
  });

  it('consent denied in the browser (AADSTS65001/access_denied) → auth_required with the admin message', async () => {
    const { adapter, secrets } = await setup({ seed: false });
    const res = await adapter.login({
      openBrowser: browser([], () => ({
        error: 'access_denied',
        error_description:
          'AADSTS65001: The user or administrator has not consented to use the application.',
      })),
      timeoutMs: 5000,
    });
    expect(res.status).toBe('auth_required');
    expect(res.message).toContain('管理者');
    expect(res.message).toContain('browser adapter');
    expect(await secrets.get(secretKey(SOURCE_ID, 'oauth'))).toBeUndefined();
    expect((await adapter.health()).state).toBe('auth_required');
  });

  it('admin approval required in the token response → auth_required', async () => {
    const graph = new FakeGraph();
    graph.tokenHandler = () =>
      json(
        { error: 'consent_required', error_description: 'AADSTS90094: Need admin approval' },
        400,
      );
    const { adapter } = await setup({ graph, seed: false });
    const res = await adapter.login({
      openBrowser: browser([], () => ({ code: 'x' })),
      timeoutMs: 5000,
    });
    expect(res.status).toBe('auth_required');
    expect(res.message).toContain('admin consent');
  });

  it('other failures are "failed" and never expose tokens', async () => {
    const graph = new FakeGraph();
    graph.tokenHandler = () =>
      json({ error: 'invalid_client', error_description: 'AADSTS70002: bad client' }, 401);
    const { adapter } = await setup({ graph, seed: false });
    const res = await adapter.login({
      openBrowser: browser([], () => ({ code: 'x' })),
      timeoutMs: 5000,
    });
    expect(res.status).toBe('failed');
  });

  it('login without a clientId fails with a configuration message', async () => {
    const { adapter } = await setup({ seed: false, config: { clientId: undefined } });
    const res = await adapter.login({ openBrowser: () => undefined });
    expect(res.status).toBe('failed');
    expect(res.message).toContain('clientId');
  });

  it('logout() forgets the stored tokens', async () => {
    const { adapter, secrets } = await setup();
    expect(await secrets.get(secretKey(SOURCE_ID, 'oauth'))).toBeDefined();
    await adapter.logout();
    expect(await secrets.get(secretKey(SOURCE_ID, 'oauth'))).toBeUndefined();
    expect((await adapter.authenticate()).status).toBe('auth_required');
  });
});
