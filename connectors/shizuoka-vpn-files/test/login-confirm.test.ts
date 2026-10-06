import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { FakeBrowserDriver, type FakePage, type PageLike } from '@unicontext/adapter-browser';
import { instantiateConnector } from '@unicontext/connector-sdk';
import type { SecretStore, UniversityProfile } from '@unicontext/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createShizuokaVpnFilesConnector,
  installReadOnlyRoute,
  probePortalSession,
  type SessionCheck,
  ShizuokaVpnFilesAdapter,
} from '../src/index.js';
import { call, SESSION_CHECK } from '../src/page-scripts.js';
import { DEPLOYMENT } from './helpers.js';

const O = 'https://vpn.inf.shizuoka.ac.jp';
const LOGIN_CGI = `${O}/dana-na/auth/url_3/login.cgi`;
const LANDING = '/api/v1/enduser/landing-page';

const noSecrets: SecretStore = {
  backend: 'memory',
  get: () => Promise.resolve(undefined),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve(false),
};

const JSON_OK: SessionCheck = { live: true, status: 200, ctype: 'application/json', redirected: false, finalPath: LANDING };
const BOUNCED: SessionCheck = {
  live: false,
  status: 200,
  ctype: 'text/html',
  redirected: true,
  finalPath: '/dana-na/auth/welcome.cgi',
};
const HTML_200: SessionCheck = { live: false, status: 200, ctype: 'text/html', redirected: false, finalPath: LANDING };

/** The probed URL of an in-page check expression. */
function probedUrl(expression: string): string {
  const m = /\)\((\{.*\})\)$/s.exec(expression);
  return (JSON.parse(m?.[1] ?? '{}') as { url?: string }).url ?? '';
}

describe('sign-in confirmation from the portal host, whatever the path', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup(answer: (url: string) => SessionCheck | undefined, screens: FakeBrowserDriver['screens'] = {}) {
    const cacheDir = mkdtempSync(join(tmpdir(), 'uc-vpn-lc-'));
    dirs.push(cacheDir);
    const probes: string[] = [];
    const pagesProbed: string[] = [];
    const driver = new FakeBrowserDriver({
      screens: {
        [`${O}/`]: { title: 'Ivanti Connect Secure', html: '<h1>404</h1>' },
        [`${O}/dana-na/auth/url_3/welcome.cgi`]: {
          title: 'Ivanti Connect Secure',
          html: '<form><input type="password"></form>',
          selectors: ['input[type="password"]:visible'],
        },
        [LOGIN_CGI]: { title: 'Ivanti Connect Secure', html: '' },
        ...screens,
      },
      redirects: {
        [`${O}/dana/home/index.cgi`]: `${O}/dana-na/auth/welcome.cgi`,
        [`${O}/dana-na/auth/welcome.cgi`]: `${O}/`,
      },
      evaluate: (page: FakePage, expression: string) => {
        const url = probedUrl(expression);
        probes.push(url);
        pagesProbed.push(page.url());
        return answer(url);
      },
    });
    const profile = {
      products: { 'shizuoka-vpn-files': { deployment: 'shizuoka' } },
      academicCalendar: { timezone: 'Asia/Tokyo' },
    } as unknown as UniversityProfile;
    const { adapter } = instantiateConnector(
      createShizuokaVpnFilesConnector({ driver, notifyIntervalMs: 100 }),
      {
        sourceId: 'shizuoka-vpn-files',
        config: { browser: { loginTimeoutMs: 15_000, bootTimeoutMs: 5_000 } },
        secrets: noSecrets,
        profile,
        cacheDir,
      },
    );
    return { adapter: adapter as ShizuokaVpnFilesAdapter, driver, probes, pagesProbed };
  }

  it('a tab that stays on login.cgi is confirmed by the landing-page JSON', async () => {
    let signedIn = false;
    const { adapter, driver, pagesProbed } = setup((url) => (url === LANDING && signedIn ? JSON_OK : BOUNCED));
    let settled = false;
    const login = adapter.login().finally(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);
    // The student signs in; the portal sends the tab to login.cgi and it stays there.
    signedIn = true;
    driver.activePage?.navigate(LOGIN_CGI);
    const r = await login;
    expect(r.status).toBe('authenticated');
    expect(pagesProbed.at(-1)).toBe(LOGIN_CGI); // confirmed while the tab was still on login.cgi
  }, 15_000);

  it('landing-page bouncing to welcome.cgi stays pending and says where the tab is', async () => {
    let signedIn = false;
    const { adapter, driver } = setup((url) => (url === LANDING && signedIn ? JSON_OK : BOUNCED));
    const said: string[] = [];
    let settled = false;
    const login = adapter.login({ notify: (m) => said.push(m) }).finally(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 150));
    driver.activePage?.navigate(LOGIN_CGI);
    await new Promise((r) => setTimeout(r, 2_500));
    expect(settled).toBe(false);
    const line = said.find((m) => m.includes('サインイン後の確認待ち'));
    expect(line, said.join('\n')).toBeDefined();
    expect(line).toContain('/dana-na/auth/url_3/login.cgi');
    expect(line).toContain('/dana-na/auth/welcome.cgi'); // what the check saw
    expect(line).not.toContain('?');
    signedIn = true;
    expect((await login).status).toBe('authenticated');
  }, 15_000);

  it('asks for the 続行 press when the sign-in notice is shown (never presses it)', async () => {
    const { adapter, driver } = setup(() => BOUNCED, {
      [LOGIN_CGI]: {
        title: 'Ivanti Connect Secure',
        html: '',
        selectors: ['input[name="btnContinue"]', 'input[name="FormDataStr"]'],
      },
    });
    const said: string[] = [];
    const login = adapter.login({ notify: (m) => said.push(m), timeoutMs: 2_500 });
    await new Promise((r) => setTimeout(r, 150));
    driver.activePage?.navigate(LOGIN_CGI);
    const r = await login;
    expect(r.status).toBe('failed'); // timed out: nobody pressed anything
    expect(said).toContain('画面の「続行」を押してください');
    expect(driver.clicked).toEqual([]);
  }, 15_000);

  it('does not claim a session when landing-page and the lists all fail', async () => {
    const { adapter } = setup(() => HTML_200);
    const r = await adapter.login({ timeoutMs: 1_500 });
    expect(r.status).toBe('failed');
  }, 15_000);
});

describe('second probe: the share list when landing-page is HTML', () => {
  const page = (answer: (url: string) => SessionCheck) =>
    ({
      url: () => LOGIN_CGI,
      evaluate: (expression: string) => Promise.resolve(answer(probedUrl(expression))),
    }) as unknown as PageLike;

  it('landing-page text/html 200 is not live, but a JSON share list is', async () => {
    const probe = await probePortalSession(
      page((url) =>
        url === LANDING
          ? HTML_200
          : url === DEPLOYMENT.listSharesPath
            ? { live: true, status: 200, ctype: 'application/json' }
            : { live: false },
      ),
      DEPLOYMENT,
    );
    expect(probe.live).toBe(true);
    expect(probe.via).toBe('list-shares');
    expect(probe.checks.map((c) => c.probe)).toEqual(['landing-page', 'list-shares']);
  });

  it('the fb list of the root is the last resort; a failing portal is not live', async () => {
    const viaList = await probePortalSession(
      page((url) => (url.startsWith(`${DEPLOYMENT.listPath}?`) ? { live: true, status: 200 } : { live: false })),
      DEPLOYMENT,
    );
    expect(viaList.via).toBe('list');
    expect((await probePortalSession(page(() => ({ live: false, status: 404 })), DEPLOYMENT)).live).toBe(
      false,
    );
  });

  it('another host is never asked (a federated IdP page)', async () => {
    let asked = 0;
    const idp = {
      url: () => 'https://idp.shizuoka.ac.jp/idp/profile/SAML2/Redirect/SSO',
      evaluate: () => {
        asked++;
        return Promise.resolve({ live: true });
      },
    } as unknown as PageLike;
    expect((await probePortalSession(idp, DEPLOYMENT)).live).toBe(false);
    expect(asked).toBe(0);
  });
});

describe('SESSION_CHECK (the script that runs in the portal page)', () => {
  interface Stub {
    status: number;
    ctype?: string;
    body?: string;
    redirected?: boolean;
    url?: string;
  }
  async function run(stub: Stub, arg: { url: string; anyKey?: string[] } = { url: LANDING }): Promise<SessionCheck> {
    const response = {
      status: stub.status,
      ok: stub.status >= 200 && stub.status < 300,
      redirected: stub.redirected ?? false,
      url: stub.url ?? `${O}${arg.url}`,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? (stub.ctype ?? '') : null) },
      text: () => Promise.resolve(stub.body ?? ''),
      body: { cancel: () => Promise.resolve() },
    };
    const ctx = {
      URL,
      location: { origin: O, href: `${O}/dana-na/auth/url_3/login.cgi` },
      fetch: () => Promise.resolve(response),
    };
    return (await runInNewContext(call(SESSION_CHECK, arg), ctx)) as SessionCheck;
  }

  it('live: 200 JSON', async () => {
    expect(await run({ status: 200, ctype: 'application/json', body: '{"a":1}' })).toMatchObject({
      live: true,
      status: 200,
      redirected: false,
      finalPath: LANDING,
    });
  });

  it('live: 200 labelled text/html whose body parses as JSON', async () => {
    expect((await run({ status: 200, ctype: 'text/html', body: '{"a":1}' })).live).toBe(true);
  });

  it('not live: an HTML page, a redirect to the sign-in area or the root, a 404', async () => {
    expect((await run({ status: 200, ctype: 'text/html', body: '<html></html>' })).live).toBe(false);
    const bounced = await run({
      status: 200,
      ctype: 'text/html',
      redirected: true,
      url: `${O}/dana-na/auth/welcome.cgi`,
      body: '{}',
    });
    expect(bounced).toMatchObject({ live: false, redirected: true, finalPath: '/dana-na/auth/welcome.cgi' });
    expect((await run({ status: 200, redirected: true, url: `${O}/`, body: '{}' })).live).toBe(false);
    expect((await run({ status: 404, ctype: 'application/json', body: '{}' })).live).toBe(false);
  });

  it('with anyKey the body must carry a files/shares array', async () => {
    const arg = { url: DEPLOYMENT.listSharesPath, anyKey: ['shares', 'files'] };
    expect((await run({ status: 200, ctype: 'application/json', body: '{"shares":[]}' }, arg)).live).toBe(true);
    expect((await run({ status: 200, ctype: 'application/json', body: '{"error":"x"}' }, arg)).live).toBe(false);
  });
});

describe('the read-only route reports what it blocked', () => {
  function fakeContext() {
    let handler: ((route: unknown) => Promise<unknown>) | undefined;
    return {
      route: (_pattern: string, h: (route: unknown) => Promise<unknown>) => {
        handler = h;
        return Promise.resolve();
      },
      fire: (method: string, url: string) => {
        const log: string[] = [];
        const route = {
          request: () => ({ method: () => method, url: () => url }),
          continue: () => {
            log.push('continue');
            return Promise.resolve();
          },
          abort: () => {
            log.push('abort');
            return Promise.resolve();
          },
        };
        return handler?.(route).then(() => log);
      },
    };
  }

  it('logs method and path (no query) at info during an interactive sign-in and counts it', async () => {
    const lines: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
    const mk = (level: string) => (msg: string, fields?: Record<string, unknown>) =>
      void lines.push({ level, msg, ...(fields ? { fields } : {}) });
    const logger = { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error'), child: () => logger };
    const blocked: string[] = [];
    let interactive = true;
    const ctx = fakeContext();
    await installReadOnlyRoute(ctx, O, logger, {
      interactive: () => interactive,
      onBlocked: (m, p) => void blocked.push(`${m} ${p}`),
    });
    expect(await ctx.fire('POST', `${O}/dana/fb/smb/wu.cgi?xsauth=SECRET`)).toEqual(['abort']);
    expect(await ctx.fire('POST', `${O}/dana-na/auth/url_3/login.cgi`)).toEqual(['continue']);
    expect(await ctx.fire('GET', `${O}/dana/home/index.cgi`)).toEqual(['continue']);
    expect(blocked).toEqual(['POST /dana/fb/smb/wu.cgi']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', fields: { method: 'POST', path: '/dana/fb/smb/wu.cgi' } });
    expect(JSON.stringify(lines)).not.toContain('SECRET');
    interactive = false;
    await ctx.fire('POST', `${O}/dana/fb/smb/wnf.cgi`);
    expect(lines.at(-1)?.level).toBe('debug');
  });
});
