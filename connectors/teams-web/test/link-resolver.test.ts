import vm from 'node:vm';
import { createNormalizeContext, type LinkResolution } from '@unicontext/connector-sdk';
import { describe, expect, it } from 'vitest';
import {
  createTeamsWebNormalizer,
  isMicrosoftFileHost,
  LINK_GET_JSON,
  parseSharePointLink,
  shareIdOf,
} from '../src/index.js';
import { call } from '../src/page-scripts.js';
import { CLASS_GROUP, harness, NOW, SITE, toView } from './helpers.js';
import {
  classContext,
  driveItem,
  FakeLinkClient,
  ORIGIN,
  OTHER_DRIVE,
  payloadOf,
  PERSONAL,
  shareChildrenPath,
  shareItemPath,
} from './link-helpers.js';

const normalizeCtx = createNormalizeContext({
  sourceId: 'teams-web',
  sourceSystem: 'teams-web',
  sourceLabel: 'Teams',
  defaultAuthority: 'collaboration',
  timezone: 'Asia/Tokyo',
  now: NOW,
});

const SHARE = `${ORIGIN}/:b:/s/2026X_abc123/EabcDEF123?e=xyz`;
const FOLDER_SHARE = `${ORIGIN}/:f:/s/2026X_abc123/EfolderTOKEN?e=abc`;

function setup() {
  const client = new FakeLinkClient();
  const h = harness({ client });
  return { ...h, client };
}

function expectFile(r: LinkResolution) {
  if (r.status !== 'file') throw new Error(`expected a file, got ${JSON.stringify(r)}`);
  return r.file;
}

describe('parseSharePointLink', () => {
  it('classifies sharing links and finds the site to start on', () => {
    const cases: [string, string, string][] = [
      [`${ORIGIN}/:b:/s/2026X_abc123/EabcDEF?e=1`, 'sharing', `${ORIGIN}/sites/2026X_abc123`],
      [`${ORIGIN}/:f:/t/Lab/EabcDEF`, 'sharing', `${ORIGIN}/teams/Lab`],
      [
        'https://example-my.sharepoint.com/:w:/g/personal/teacher_example_ac_jp/IQAbc?e=2',
        'sharing',
        `${PERSONAL}`,
      ],
      [
        `${ORIGIN}/:x:/r/sites/2026X_abc123/Shared%20Documents/a.xlsx?d=w1&csf=1`,
        'sharing',
        `${ORIGIN}/sites/2026X_abc123`,
      ],
      [
        `${SITE}/Shared%20Documents/00_%E8%AC%9B%E7%BE%A9/week1.pdf`,
        'path',
        `${ORIGIN}/sites/2026X_abc123`,
      ],
    ];
    for (const [url, kind, start] of cases) {
      const p = parseSharePointLink(url);
      expect(p, url).toMatchObject({ ok: true, kind, startUrl: start });
    }
  });

  it('unwraps Teams file links, Office web links, library views and &amp;', () => {
    const inner = `${SITE}/Shared Documents/General/a.pdf`;
    const teams = `https://teams.microsoft.com/l/file/ABC?tenantId=t&fileType=pdf&objectUrl=${encodeURIComponent(inner)}&baseUrl=x`;
    expect(parseSharePointLink(teams)).toMatchObject({ ok: true, kind: 'path' });
    expect(
      parseSharePointLink(
        `${SITE}/_layouts/15/Doc.aspx?sourcedoc=%7BC8EF138A-4978-4DEA-8684-FE2859E1D092%7D&amp;file=a.xlsx`,
      ),
    ).toMatchObject({
      ok: true,
      kind: 'document',
      sourcedoc: 'c8ef138a-4978-4dea-8684-fe2859e1d092',
      sitePath: '/sites/2026X_abc123',
    });
    expect(
      parseSharePointLink(
        `${SITE}/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2F2026X_abc123%2FShared%20Documents%2F00&viewid=1`,
      ),
    ).toMatchObject({ ok: true, kind: 'path', url: `${SITE}/Shared%20Documents/00` });
    expect(parseSharePointLink(`${SITE}/Shared%20Documents/Forms/AllItems.aspx`)).toMatchObject({
      ok: true,
      url: `${SITE}/Shared%20Documents`,
    });
    expect(parseSharePointLink(`<${SHARE}>」`)).toMatchObject({ ok: true, url: SHARE });
  });

  it('refuses what it cannot open, with a reason', () => {
    for (const url of [
      'https://1drv.ms/b/s!abc',
      'https://onedrive.live.com/redir?resid=1',
      'https://example.com/a.pdf',
      `${SITE}/SitePages/Home.aspx`,
      'https://teams.microsoft.com/l/channel/19%3Aabc/General?groupId=g',
      'not a url',
      `${SITE}/_layouts/15/Doc.aspx?file=a.xlsx`,
    ]) {
      const p = parseSharePointLink(url);
      expect(p.ok, url).toBe(false);
      if (!p.ok) expect(p.reason.length).toBeGreaterThan(5);
    }
    expect(isMicrosoftFileHost('https://1drv.ms/b/s!abc')).toBe(true);
    expect(isMicrosoftFileHost(SHARE)).toBe(true);
    expect(isMicrosoftFileHost('https://example.com/a.pdf')).toBe(false);
  });

  it('encodes sharing ids as documented (u! + unpadded base64url)', () => {
    expect(
      shareIdOf('https://onedrive.live.com/redir?resid=1231244193912!12&authKey=1201919!12921!1'),
    ).toBe(
      'u!aHR0cHM6Ly9vbmVkcml2ZS5saXZlLmNvbS9yZWRpcj9yZXNpZD0xMjMxMjQ0MTkzOTEyITEyJmF1dGhLZXk9MTIwMTkxOSExMjkyMSEx',
    );
  });
});

describe('resolveLink (teams-web session)', () => {
  it('a synced file of a class team: the stored item, nothing new', async () => {
    const { adapter, client, sessions } = setup();
    client.answer = (url) =>
      url.startsWith(shareItemPath(SHARE))
        ? { status: 200, body: driveItem('01FILEWEEK1', 'week1.pdf', { path: '/00_講義資料' }) }
        : { status: 404 };
    const f = expectFile(await adapter.resolveLink(SHARE, classContext()));
    expect(f).toEqual({
      sourceType: 'teamsweb.driveItem',
      externalId: `${CLASS_GROUP}/01FILEWEEK1`,
      name: 'week1.pdf',
    });
    expect(sessions).toEqual([`${ORIGIN}/sites/2026X_abc123`]);
    expect(client.requests.every((r) => !r.redeem)).toBe(true);
  });

  it('a new file in the team library becomes a driveItem with the sync’s id and channel', async () => {
    const { adapter, client } = setup();
    client.answer = (url) =>
      url.startsWith(shareItemPath(SHARE))
        ? { status: 200, body: driveItem('01NEWFILE', 'week3.pdf', { path: '/00_講義資料' }) }
        : { status: 404 };
    const f = expectFile(await adapter.resolveLink(SHARE, classContext()));
    expect(f.sourceType).toBe('teamsweb.driveItem');
    expect(f.externalId).toBe(`${CLASS_GROUP}/01NEWFILE`);
    const p = payloadOf(f.raw);
    expect(p).toMatchObject({
      teamGroupId: CLASS_GROUP,
      spaceType: 'class',
      siteUrl: SITE,
      channelName: '講義資料',
    });
    // No pre-authenticated URL is kept.
    expect(JSON.stringify(f.raw)).not.toMatch(/tempauth|downloadUrl/i);
  });

  it('another library of a class team keeps the team (course) but is a link item', async () => {
    const { adapter, client } = setup();
    client.answer = (url) =>
      url.startsWith(shareItemPath(SHARE))
        ? { status: 200, body: driveItem('01DOCLIB', 'slido.pdf', { driveId: OTHER_DRIVE }) }
        : { status: 404 };
    const f = expectFile(await adapter.resolveLink(SHARE, classContext()));
    expect(f.sourceType).toBe('teamsweb.linkItem');
    expect(f.externalId).toBe(`${CLASS_GROUP}/01DOCLIB`);
    expect(payloadOf(f.raw)).toMatchObject({ teamGroupId: CLASS_GROUP, spaceType: 'class' });
    // The normalizer puts it in the class team's course.
    const out = await createTeamsWebNormalizer().normalize(toView(f.raw!), normalizeCtx);
    const doc = out.entities.find((e) => e.entity.kind === 'document')?.entity as
      { courseOfferingId?: string; title: string } | undefined;
    expect(doc?.title).toBe('slido.pdf');
    expect(doc?.courseOfferingId).toBeTruthy();
  });

  it('asks for the default library once when no file of the team is synced yet', async () => {
    const { adapter, client } = setup();
    const ctx = classContext();
    ctx.items = ctx.items.filter((i) => i.sourceType === 'teamsweb.team');
    client.answer = (url) => {
      if (url.startsWith(shareItemPath(SHARE)))
        return { status: 200, body: driveItem('01NEWFILE', 'a.pdf') };
      if (url === '/sites/2026X_abc123/_api/v2.0/drive?$select=id')
        return { status: 200, body: { id: 'b!SYNTHETIC' } };
      return { status: 404 };
    };
    const f = expectFile(await adapter.resolveLink(SHARE, ctx));
    expect(f.sourceType).toBe('teamsweb.driveItem');
    expect(client.requests.map((r) => r.url)).toContain(
      '/sites/2026X_abc123/_api/v2.0/drive?$select=id',
    );
  });

  it('a personal OneDrive link: redeemed only when the plain request is refused', async () => {
    const { adapter, client, sessions } = setup();
    const link = `https://example-my.sharepoint.com/:b:/g/personal/teacher_example_ac_jp/IQabc?e=1`;
    client.answer = (url, redeem) =>
      url.startsWith(shareItemPath(link))
        ? redeem
          ? { status: 200, body: driveItem('01PERS', '配布.pdf', { siteUrl: PERSONAL }) }
          : { status: 403, body: { error: { code: 'accessDenied' } } }
        : { status: 404 };
    const f = expectFile(await adapter.resolveLink(link, classContext()));
    expect(f.sourceType).toBe('teamsweb.linkItem');
    expect(f.externalId).toBe(
      'site:example-my.sharepoint.com/personal/teacher_example_ac_jp/01PERS',
    );
    expect(payloadOf(f.raw)).toMatchObject({
      teamName: 'OneDrive (teacher_example_ac_jp)',
      siteUrl: PERSONAL,
    });
    expect(payloadOf(f.raw).spaceType).toBeUndefined();
    expect(client.requests.map((r) => r.redeem)).toEqual([false, true]);
    expect(sessions).toEqual([PERSONAL]);
  });

  it('a path link is never redeemed; its 403 is a clear "forbidden"', async () => {
    const { adapter, client } = setup();
    client.answer = () => ({ status: 403, body: { error: { code: 'accessDenied' } } });
    const r = await adapter.resolveLink(`${SITE}/Shared%20Documents/secret.pdf`, classContext());
    expect(r.status).toBe('forbidden');
    expect(client.requests.every((x) => !x.redeem)).toBe(true);
  });

  it('maps not found, sign-in and throttling to statuses', async () => {
    const { adapter, client } = setup();
    client.answer = () => ({ status: 404, body: { error: { code: 'itemNotFound' } } });
    expect(await adapter.resolveLink(SHARE, classContext())).toMatchObject({
      status: 'notFound',
    });
    client.answer = () => ({ status: 401 });
    expect(await adapter.resolveLink(SHARE, classContext())).toMatchObject({
      status: 'authRequired',
    });
    client.answer = () => ({ status: 429, retryAfter: '5' });
    expect(await adapter.resolveLink(SHARE, classContext())).toMatchObject({
      status: 'throttled',
    });
    expect(await adapter.resolveLink('https://1drv.ms/b/s!x', classContext())).toMatchObject({
      status: 'unsupported',
    });
    const signedOut = harness({
      client: new FakeLinkClient(),
      auth: { status: 'auth_required', message: 'sign in' },
    });
    expect(await signedOut.adapter.resolveLink(SHARE, classContext())).toMatchObject({
      status: 'authRequired',
    });
  });

  it('an Office web link falls back to GetFileById and the file’s path', async () => {
    const { adapter, client } = setup();
    const link = `${SITE}/_layouts/15/Doc.aspx?sourcedoc=%7BC8EF138A-4978-4DEA-8684-FE2859E1D092%7D&file=a.xlsx&action=default`;
    const target = `${SITE}/Shared%20Documents/General/a.xlsx`;
    client.answer = (url) => {
      if (url.startsWith(shareItemPath(link))) return { status: 404 };
      if (url.startsWith("/sites/2026X_abc123/_api/web/GetFileById('c8ef138a-"))
        return {
          status: 200,
          body: { ServerRelativeUrl: '/sites/2026X_abc123/Shared Documents/General/a.xlsx' },
        };
      if (url.startsWith(shareItemPath(target)))
        return { status: 200, body: driveItem('01XLSX', 'a.xlsx', { path: '/General' }) };
      return { status: 404 };
    };
    const f = expectFile(await adapter.resolveLink(link, classContext()));
    expect(f).toMatchObject({ name: 'a.xlsx', externalId: `${CLASS_GROUP}/01XLSX` });
    expect(payloadOf(f.raw).channelName).toBe('一般');
  });

  it('a folder: files with ids, subfolders with links, paged and capped', async () => {
    const { adapter, client, clock } = setup();
    const page = (n: number, next: boolean) => ({
      status: 200,
      body: {
        value: [
          driveItem(`01F${n}`, `file${n}.pdf`, { path: '/各種資料', driveId: OTHER_DRIVE }),
          { ...driveItem(`01D${n}`, `sub${n}`, { folder: 2 }), webUrl: `${SITE}/sub${n}` },
        ],
        ...(next
          ? {
              '@odata.nextLink': `${SITE}/_api/v2.0/drives('x')/items('y')/children?$skiptoken=${n}`,
            }
          : {}),
      },
    });
    client.answer = (url) => {
      if (url.startsWith(shareItemPath(FOLDER_SHARE)))
        return {
          status: 200,
          body: driveItem('01FOLDER', '各種資料', { folder: 9, driveId: OTHER_DRIVE }),
        };
      if (url.startsWith(shareChildrenPath(FOLDER_SHARE))) return page(1, true);
      const m = /skiptoken=(\d+)/.exec(url);
      if (m) return page(Number(m[1]) + 1, true);
      return { status: 404 };
    };
    const r = await adapter.resolveLink(FOLDER_SHARE, classContext());
    if (r.status !== 'folder') throw new Error(JSON.stringify(r));
    expect(r.folder).toMatchObject({ name: '各種資料', childCount: 9 });
    expect(r.files.map((f) => f.name)).toEqual(['file1.pdf', 'file2.pdf', 'file3.pdf']);
    expect(r.files.every((f) => f.sourceType === 'teamsweb.linkItem')).toBe(true);
    expect(r.folders.map((f) => [f.name, f.url, f.childCount])).toEqual([
      ['sub1', `${SITE}/sub1`, 2],
      ['sub2', `${SITE}/sub2`, 2],
      ['sub3', `${SITE}/sub3`, 2],
    ]);
    expect(r.truncated).toBe(true);
    // Paced: a pause before every page.
    expect(clock.slept.filter((ms) => ms >= 500).length).toBeGreaterThanOrEqual(3);
  });

  it('a notebook or list is neither file nor folder', async () => {
    const { adapter, client } = setup();
    client.answer = () => ({
      status: 200,
      body: { ...driveItem('01NB', 'Notebook', {}), file: undefined, package: { type: 'oneNote' } },
    });
    expect(await adapter.resolveLink(SHARE, classContext())).toMatchObject({
      status: 'unsupported',
    });
  });
});

describe('LINK_GET_JSON (in the page)', () => {
  function page(response: { status: number; body: unknown; headers?: Record<string, string> }) {
    const requests: { url: string; method: string; headers: Record<string, string> }[] = [];
    const ctx = vm.createContext({
      location: { origin: ORIGIN },
      URL,
      fetch: (url: string, init: { method: string; headers: Record<string, string> }) => {
        requests.push({ url, method: init.method, headers: init.headers });
        return Promise.resolve(
          new Response(JSON.stringify(response.body), {
            status: response.status,
            headers: response.headers ?? {},
          }),
        );
      },
      Object,
      Array,
    });
    return {
      requests,
      run: (arg: unknown) => vm.runInContext(call(LINK_GET_JSON, arg), ctx) as Promise<unknown>,
    };
  }

  it('GETs same-origin JSON, drops download URLs, sends the redeem header only when asked', async () => {
    const p = page({
      status: 200,
      body: {
        id: '1',
        '@content.downloadUrl': 'https://x/download.aspx?tempauth=SECRET',
        '@content.downloadUrlNoAuth': 'https://x/download.aspx',
        nested: [{ '@content.downloadUrl': 'y', name: 'n' }],
      },
    });
    const r = (await p.run({ url: '/_api/v2.0/shares/u!x/driveItem', redeem: false })) as {
      status: number;
      body: unknown;
    };
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toMatch(/downloadUrl|tempauth/i);
    expect(r.body).toEqual({ id: '1', nested: [{ name: 'n' }] });
    expect(p.requests[0]).toMatchObject({
      method: 'GET',
      url: `${ORIGIN}/_api/v2.0/shares/u!x/driveItem`,
    });
    expect(p.requests[0]!.headers.prefer).toBeUndefined();
    await p.run({ url: '/_api/v2.0/shares/u!x/driveItem', redeem: true });
    expect(p.requests[1]!.headers.prefer).toBe('redeemSharingLinkIfNecessary');
  });

  it('refuses another origin', async () => {
    const p = page({ status: 200, body: {} });
    expect(await p.run({ url: 'https://evil.example.com/x', redeem: false })).toMatchObject({
      status: 0,
      error: 'cross-origin',
    });
    expect(p.requests).toEqual([]);
  });
});

describe('describeFile / downloads of link items', () => {
  it('describes a link item (never a class-library file for the mirror) and downloads it', async () => {
    const { adapter, client } = setup();
    client.answer = () => ({
      status: 200,
      body: driveItem('01DOCLIB', 'slido.pdf', { driveId: OTHER_DRIVE }),
    });
    const f = expectFile(await adapter.resolveLink(SHARE, classContext()));
    const info = adapter.describeFile({
      sourceType: f.sourceType,
      externalId: f.externalId,
      payload: f.raw!.payload,
    });
    expect(info).toMatchObject({ name: 'slido.pdf', isClass: false, containerId: CLASS_GROUP });
    expect(adapter.fileSourceTypes).toContain('teamsweb.linkItem');
    client.files['01DOCLIB'] = new TextEncoder().encode('slido');
    const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'uc-link-'));
    try {
      const target = join(dir, 'slido.pdf');
      const out = await adapter.downloadFiles([
        {
          externalId: f.externalId,
          payload: f.raw!.payload,
          targetPath: target,
          maxBytes: 1e6,
          extract: false,
        },
      ]);
      expect(out.results[0]?.status).toBe('downloaded');
      expect(readFileSync(target, 'utf8')).toBe('slido');
      expect(client.streamRequests.at(-1)).toMatchObject({
        siteUrl: SITE,
        itemId: '01DOCLIB',
        uniqueId: '0c44dbaf-25cb-42ee-a697-ce197b2c257f',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
