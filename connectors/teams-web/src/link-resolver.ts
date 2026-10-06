import type {
  LinkContext,
  LinkFile,
  LinkResolution,
  LinkSubfolder,
  RawItem,
} from '@unicontext/connector-sdk';
import { AuthRequiredError, errorMessage, type Logger, RateLimitedError } from '@unicontext/core';
import type { WithClient } from './adapter.js';
import type { JsonGetResult, TeamsWebClient } from './client.js';
import { teamName } from './normalizer.js';
import { folderNameOf, scrubSecrets } from './parse.js';
import { DriveItemPayloadSchema, TeamPayloadSchema } from './schemas.js';

/*
 * SharePoint / OneDrive for Business links (from an email, a post, a message) opened on the
 * student's request through the teams-web browser session — the same signed-in Microsoft session
 * that downloads class files. Read-only: only same-origin GETs of documented endpoints run inside a
 * page of the link's SharePoint host (`/_api/v2.0/shares/{id}/driveItem`, its children, the site's
 * default drive id and, for an Office web link, `GetFileById`); nothing is posted, no permission is
 * requested or changed. For a sharing link the account cannot open directly, the request is
 * repeated once with `Prefer: redeemSharingLinkIfNecessary` — the API's form of what the browser
 * does when the student clicks the link (SharePoint may record the use, as it does for a click).
 *
 * A file becomes a raw item: `teamsweb.driveItem` (the sync's own id) when it lives in a known
 * team's library, else `teamsweb.linkItem` (same payload shape; a team site's other library keeps
 * the team, so a class team's file still belongs to the course). Download and text extraction then
 * go through the ordinary on-demand download by the document id.
 */

export const LINK_ITEM_TYPE = 'teamsweb.linkItem';

/** Children listed per page / pages followed for a folder link. */
export const LINK_FOLDER_PAGE = 200;
export const LINK_FOLDER_MAX_PAGES = 3;

export type ParsedLink =
  | {
      ok: true;
      /** The link to resolve (Teams wrapper removed, `&amp;` decoded). */
      url: string;
      origin: string;
      /** Page the browser session starts on (the site, else the host root). */
      startUrl: string;
      /** `/sites/x`, `/teams/x`, `/personal/x` or '' (root site / unknown). */
      sitePath: string;
      kind: 'sharing' | 'path' | 'document';
      /** Office web link (`Doc.aspx?sourcedoc={guid}`): the file's unique id. */
      sourcedoc?: string;
    }
  | { ok: false; reason: string };

const SHAREPOINT_HOST = /^[a-z0-9][a-z0-9-]*\.sharepoint\.com$/i;
const TEAMS_HOST = /^(teams\.microsoft\.com|teams\.cloud\.microsoft|teams\.live\.com)$/i;
const CONSUMER_ONEDRIVE = /(^|\.)(onedrive\.live\.com|1drv\.ms|onedrive\.com)$/i;
const GUID = /\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?/i;

/** Is this host one the resolver answers for (with a result or a specific reason)? */
export function isMicrosoftFileHost(url: string): boolean {
  try {
    const h = new URL(cleanLink(url)).hostname;
    return SHAREPOINT_HOST.test(h) || TEAMS_HOST.test(h) || CONSUMER_ONEDRIVE.test(h);
  } catch {
    return false;
  }
}

function cleanLink(input: string): string {
  return input
    .trim()
    .replace(/^</, '')
    .replace(/&amp;/gi, '&')
    .replace(/[\s>」』】。、]+$/u, '');
}

function sitePathOf(pathname: string): string {
  const m = /^\/(sites|teams|personal)\/([^/]+)/i.exec(pathname);
  return m ? `/${m[1]!.toLowerCase()}/${m[2]}` : '';
}

/** Classify a SharePoint / OneDrive for Business link; a clear reason when it is not one. */
export function parseSharePointLink(input: string): ParsedLink {
  let u: URL;
  try {
    u = new URL(cleanLink(input));
  } catch {
    return { ok: false, reason: 'URLとして読めません / not a URL' };
  }
  if (TEAMS_HOST.test(u.hostname)) {
    // A Teams file link carries the SharePoint URL in `objectUrl`.
    const inner = u.searchParams.get('objectUrl');
    if (!/^\/l\/file\//i.test(u.pathname) || !inner)
      return {
        ok: false,
        reason:
          'Teamsのファイル以外へのリンクです（チャネルや会議は開けません） / a Teams link that is not a file',
      };
    return parseSharePointLink(inner);
  }
  if (CONSUMER_ONEDRIVE.test(u.hostname))
    return {
      ok: false,
      reason:
        '個人用MicrosoftアカウントのOneDriveのリンクです。大学のアカウントでは開けません / a personal (consumer) OneDrive link; the university session cannot open it',
    };
  if (!SHAREPOINT_HOST.test(u.hostname))
    return {
      ok: false,
      reason: 'SharePoint / OneDriveのリンクではありません / not a SharePoint or OneDrive link',
    };
  if (u.protocol === 'http:') u.protocol = 'https:';
  if (u.protocol !== 'https:')
    return { ok: false, reason: 'httpsのリンクではありません / not https' };
  const origin = u.origin;
  const path = decodeSafe(u.pathname);

  // Sharing links: /:b:/s/<site>/<token>, /:f:/t/<team>/…, /:w:/g/personal/<user>/…, /:x:/r/sites/…
  const share = /^\/:([a-z0-9]+):\/([a-z])\/(.+)$/i.exec(u.pathname);
  if (share) {
    const scope = share[2]!.toLowerCase();
    const rest = share[3]!;
    const first = rest.split('/')[0];
    const sitePath =
      scope === 's'
        ? `/sites/${first}`
        : scope === 't'
          ? `/teams/${first}`
          : sitePathOf(`/${rest}`);
    return {
      ok: true,
      url: u.toString(),
      origin,
      startUrl: origin + (sitePath || '/'),
      sitePath,
      kind: 'sharing',
    };
  }
  const sitePath = sitePathOf(u.pathname);
  const startUrl = origin + (sitePath || '/');
  // Office web / library views: Doc.aspx?sourcedoc={guid}, AllItems.aspx?id=/sites/…/folder
  if (/\/_layouts\/15\/(doc|doc2|xlviewer|wopiframe2?)\.aspx$/i.test(path)) {
    const guid = GUID.exec(u.searchParams.get('sourcedoc') ?? '')?.[1];
    if (!guid)
      return {
        ok: false,
        reason: 'Officeのリンクにファイルのidがありません / Office link without a file id',
      };
    return {
      ok: true,
      url: u.toString(),
      origin,
      startUrl,
      sitePath,
      kind: 'document',
      sourcedoc: guid.toLowerCase(),
    };
  }
  // A library view (…/Shared Documents/Forms/AllItems.aspx): the library itself.
  const view = /^(.*)\/Forms\/[^/]+\.aspx$/i.exec(u.pathname);
  if (view && !u.searchParams.get('id')) {
    const target = new URL(origin);
    target.pathname = view[1]!;
    return { ok: true, url: target.toString(), origin, startUrl, sitePath, kind: 'path' };
  }
  const idParam = u.searchParams.get('id');
  if (idParam?.startsWith('/') && /\.aspx$/i.test(path)) {
    const target = new URL(origin);
    target.pathname = idParam;
    return {
      ok: true,
      url: target.toString(),
      origin,
      startUrl: origin + (sitePathOf(idParam) || sitePath || '/'),
      sitePath: sitePathOf(idParam) || sitePath,
      kind: 'path',
    };
  }
  if (/\.aspx$/i.test(path) || path === '/' || path === '')
    return {
      ok: false,
      reason:
        'ファイルやフォルダーではなくSharePointのページへのリンクです / a link to a SharePoint page, not a file or folder',
    };
  return { ok: true, url: u.toString(), origin, startUrl, sitePath, kind: 'path' };
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The sharing id of a URL for `/shares/{id}` (`u!` + unpadded base64url). */
export function shareIdOf(url: string): string {
  return `u!${Buffer.from(url, 'utf8').toString('base64url')}`;
}

// ---------------------------------------------------------------------------------------------
// What is already known: team sites, their default libraries, synced files

export interface KnownTeam {
  groupId: string;
  name: string;
  spaceType: string | undefined;
  tenantId: string | undefined;
  siteUrl: string;
  /** Channel folder name → channel name. */
  folders: Map<string, string>;
  /** Default document library ids seen on synced files. */
  driveIds: Set<string>;
  /** The default library id was asked for during this resolution. */
  driveChecked?: boolean;
}

export interface KnownSites {
  teams: KnownTeam[];
  /** External ids of stored `teamsweb.driveItem`s. */
  driveItems: Set<string>;
}

const siteKey = (url: string): string => decodeSafe(url).replace(/\/+$/, '').toLowerCase();

export function knownSites(context: LinkContext): KnownSites {
  const teams = new Map<string, KnownTeam>();
  const driveIds = new Map<string, Set<string>>();
  const driveItems = new Set<string>();
  for (const it of context.items) {
    if (it.sourceType === 'teamsweb.team') {
      const r = TeamPayloadSchema.safeParse(it.payload);
      if (!r.success) continue;
      const tp = r.data.threadProperties;
      if (!tp.sharepointSiteUrl) continue;
      const folders = new Map<string, string>();
      for (const c of r.data.channels)
        folders.set(folderNameOf(c.channelDocsFolderRelativeUrl) ?? c.name, c.name);
      teams.set(tp.groupId, {
        groupId: tp.groupId,
        name: teamName(r.data),
        spaceType: tp.spaceType ?? undefined,
        tenantId: tp.tenantid ?? undefined,
        siteUrl: tp.sharepointSiteUrl.replace(/\/+$/, ''),
        folders,
        driveIds: new Set(),
      });
    } else if (it.sourceType === 'teamsweb.driveItem') {
      driveItems.add(it.externalId);
      const r = DriveItemPayloadSchema.safeParse(it.payload);
      const driveId = r.success ? r.data.item.parentReference?.driveId : undefined;
      if (!r.success || !driveId) continue;
      const set = driveIds.get(r.data.teamGroupId) ?? new Set<string>();
      set.add(driveId);
      driveIds.set(r.data.teamGroupId, set);
    }
  }
  for (const [groupId, ids] of driveIds) {
    const t = teams.get(groupId);
    if (t) for (const id of ids) t.driveIds.add(id);
  }
  return { teams: [...teams.values()], driveItems };
}

// ---------------------------------------------------------------------------------------------
// Page script and resolution

/**
 * Same-origin GET of a JSON resource inside the SharePoint page (the page's own session). Download
 * URLs (`@content.downloadUrl`, pre-authenticated) are dropped before anything returns to Node.
 */
export const LINK_GET_JSON = `async (arg) => {
  const u = new URL(arg.url, location.origin);
  if (u.origin !== location.origin) return { status: 0, error: 'cross-origin' };
  const headers = { accept: 'application/json' };
  if (arg.redeem) headers.prefer = 'redeemSharingLinkIfNecessary';
  const res = await fetch(u.toString(), { method: 'GET', headers, credentials: 'same-origin' });
  const retryAfter = res.headers.get('retry-after');
  let body;
  try { body = await res.json(); } catch (e) { body = undefined; }
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) if (!/downloadurl|fixiturl/i.test(k)) o[k] = strip(x);
      return o;
    }
    return v;
  };
  return { status: res.status, retryAfter, body: strip(body) };
}`;

const ITEM_FIELDS =
  'id,name,eTag,cTag,size,webUrl,createdDateTime,lastModifiedDateTime,createdBy,lastModifiedBy,parentReference,file,folder,root';

type Json = Record<string, unknown>;

interface Ctx {
  client: TeamsWebClient & Required<Pick<TeamsWebClient, 'getJson'>>;
  parsed: Extract<ParsedLink, { ok: true }>;
  known: KnownSites;
  pause: (ms: number) => Promise<void>;
  /** The redeem header was needed to open the link (children are listed the same way). */
  redeem: boolean;
}

async function get(ctx: Ctx, path: string, redeem = ctx.redeem): Promise<JsonGetResult> {
  const r = await ctx.client.getJson(ctx.parsed.startUrl, path, { redeemSharingLink: redeem });
  if (r.status === 401) throw new AuthRequiredError('SharePoint answered 401');
  if (r.status === 429 || r.status === 503) {
    const sec = Number(r.retryAfter ?? '60');
    throw new RateLimitedError('SharePoint is throttling', {
      retryAfterMs: (Number.isFinite(sec) ? sec : 60) * 1000,
    });
  }
  return r;
}

const ok = (r: JsonGetResult): r is JsonGetResult & { body: Json } =>
  r.status >= 200 && r.status < 300 && !!r.body && typeof r.body === 'object';

function failure(r: JsonGetResult): LinkResolution {
  const code = String(((r.body as Json | undefined)?.error as Json | undefined)?.code ?? '');
  if (r.status === 403)
    return {
      status: 'forbidden',
      reason:
        'このアカウントには開く権限がありません（共有の範囲外か、リンクが無効です） / the student’s account has no access to this item (or the sharing link was revoked)',
    };
  if (r.status === 404 || r.status === 400)
    return {
      status: 'notFound',
      reason: `リンク先が見つかりません（削除・移動されたか、リンクが壊れています） / the item or sharing link was not found${code ? ` (${code})` : ''}`,
    };
  return { status: 'failed', reason: `SharePoint answered ${r.status}${code ? ` (${code})` : ''}` };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function siteUrlOf(item: Json, fallback: string): string {
  const ids = (item.sharepointIds ?? (item.parentReference as Json | undefined)?.sharepointIds) as
    Json | undefined;
  const fromIds = str(ids?.siteUrl);
  if (fromIds) return fromIds.replace(/\/+$/, '');
  const context = str(item['@odata.context']);
  const i = context?.indexOf('/_api/') ?? -1;
  if (context && i > 0) return context.slice(0, i);
  return fallback.replace(/\/+$/, '');
}

/** The fields the normalizer and downloads use (no download URLs, no sharing data). */
function trimItem(item: Json): Json {
  const keep = ITEM_FIELDS.split(',');
  const out: Json = {};
  for (const k of keep) if (item[k] !== undefined && item[k] !== null) out[k] = item[k];
  const parent = item.parentReference as Json | undefined;
  if (parent) {
    const p: Json = {};
    for (const k of ['driveType', 'driveId', 'id', 'name', 'path', 'siteId'])
      if (parent[k] !== undefined && parent[k] !== null) p[k] = parent[k];
    out.parentReference = p;
  }
  return scrubSecrets(out);
}

function containerName(siteUrl: string): string {
  try {
    const p = decodeSafe(new URL(siteUrl).pathname).replace(/\/+$/, '');
    const m = /^\/(sites|teams|personal)\/([^/]+)/i.exec(p);
    if (m?.[1]?.toLowerCase() === 'personal') return `OneDrive (${m[2]})`;
    if (m) return `SharePoint ${m[2]}`;
    return `SharePoint ${new URL(siteUrl).hostname}`;
  } catch {
    return 'SharePoint';
  }
}

async function defaultDriveId(ctx: Ctx, team: KnownTeam): Promise<string | undefined> {
  if (team.driveIds.size > 0 || team.driveChecked) return undefined;
  team.driveChecked = true;
  const path = `${new URL(team.siteUrl).pathname.replace(/\/+$/, '')}/_api/v2.0/drive?$select=id`;
  const r = await get(ctx, path, false);
  const id = ok(r) ? str(r.body.id) : undefined;
  if (id) team.driveIds.add(id);
  return id;
}

async function toLinkFile(ctx: Ctx, raw: Json, siteUrl: string): Promise<LinkFile | undefined> {
  const item = trimItem(raw);
  const id = str(item.id);
  const name = str(item.name);
  if (!id || !name || !item.file) return undefined;
  const team = ctx.known.teams.find((t) => siteKey(t.siteUrl) === siteKey(siteUrl));
  const driveId = str((item.parentReference as Json | undefined)?.driveId);
  if (team) await defaultDriveId(ctx, team);
  const inTeamLibrary = !!team && !!driveId && team.driveIds.has(driveId);
  const groupId = team?.groupId ?? `site:${siteKey(siteUrl).replace(/^https:\/\//, '')}`;
  const externalId = `${groupId}/${id}`;
  if (inTeamLibrary && ctx.known.driveItems.has(externalId))
    return { sourceType: 'teamsweb.driveItem', externalId, name };
  const top = decodeSafe(
    (str((item.parentReference as Json | undefined)?.path)?.split('root:')[1] ?? '')
      .replace(/^\/+/, '')
      .split('/')[0] ?? '',
  );
  const channelName = team && top ? team.folders.get(top) : undefined;
  const sourceType = inTeamLibrary ? 'teamsweb.driveItem' : LINK_ITEM_TYPE;
  const rawItem: RawItem = {
    sourceType,
    externalId,
    payload: {
      teamGroupId: groupId,
      teamName: team?.name ?? containerName(siteUrl),
      ...(team?.spaceType ? { spaceType: team.spaceType } : {}),
      ...(team?.tenantId ? { tenantId: team.tenantId } : {}),
      siteUrl: team?.siteUrl ?? siteUrl,
      ...(channelName ? { channelName } : {}),
      item,
    },
    ...(str(item.lastModifiedDateTime) ? { sourceUpdatedAt: str(item.lastModifiedDateTime) } : {}),
  };
  return { sourceType, externalId, raw: rawItem, name };
}

async function resolveItem(ctx: Ctx): Promise<JsonGetResult> {
  const { parsed } = ctx;
  const select = `?$select=${ITEM_FIELDS},sharepointIds`;
  const byShare = (url: string, redeem = ctx.redeem) =>
    get(ctx, `/_api/v2.0/shares/${shareIdOf(url)}/driveItem${select}`, redeem);
  let r = await byShare(parsed.url);
  if (r.status === 403 && parsed.kind === 'sharing') {
    ctx.redeem = true;
    r = await byShare(parsed.url, true);
  }
  if (!ok(r) && parsed.kind === 'path' && new URL(parsed.url).search) {
    const u = new URL(parsed.url);
    r = await byShare(`${u.origin}${u.pathname}`);
  }
  if (!ok(r) && parsed.kind === 'document' && parsed.sourcedoc) {
    const f = await get(
      ctx,
      `${parsed.sitePath}/_api/web/GetFileById('${parsed.sourcedoc}')?$select=ServerRelativeUrl`,
    );
    const rel = ok(f) ? str(f.body.ServerRelativeUrl) : undefined;
    if (rel) {
      const target = new URL(parsed.origin);
      target.pathname = rel;
      r = await byShare(target.toString());
    } else if (!ok(f)) r = f;
  }
  return r;
}

async function resolveWithClient(ctx: Ctx): Promise<LinkResolution> {
  const r = await resolveItem(ctx);
  if (!ok(r)) return failure(r);
  const item = r.body;
  const siteUrl = siteUrlOf(item, ctx.parsed.startUrl);
  if (item.file) {
    const file = await toLinkFile(ctx, item, siteUrl);
    return file
      ? { status: 'file', file }
      : { status: 'failed', reason: 'SharePointの応答にファイル名かidがありません' };
  }
  if (!item.folder && !item.root)
    return {
      status: 'unsupported',
      reason:
        'ファイルでもフォルダーでもない項目です（ノートブック・リストなど） / neither a file nor a folder (a notebook, list, …)',
    };
  const files: LinkFile[] = [];
  const folders: LinkSubfolder[] = [];
  let next: string | undefined =
    `/_api/v2.0/shares/${shareIdOf(ctx.parsed.url)}/driveItem/children?$top=${LINK_FOLDER_PAGE}&$select=${ITEM_FIELDS}`;
  let pages = 0;
  while (next && pages < LINK_FOLDER_MAX_PAGES) {
    await ctx.pause(500);
    const page = await get(ctx, next);
    if (!ok(page)) {
      if (pages === 0) return failure(page);
      break;
    }
    pages++;
    const value = Array.isArray(page.body.value) ? (page.body.value as Json[]) : [];
    for (const child of value) {
      if (child.folder) {
        const name = str(child.name);
        if (!name) continue;
        const childCount = (child.folder as Json).childCount;
        folders.push({
          name,
          ...(str(child.webUrl) ? { url: str(child.webUrl) } : {}),
          ...(typeof childCount === 'number' ? { childCount } : {}),
          ...(str(child.lastModifiedDateTime)
            ? { modifiedAt: str(child.lastModifiedDateTime) }
            : {}),
        });
      } else if (child.file) {
        const f = await toLinkFile(ctx, child, siteUrl);
        if (f) files.push(f);
      }
    }
    next = str(page.body['@odata.nextLink']);
  }
  const childCount = (item.folder as Json | undefined)?.childCount;
  const parentPath = str((item.parentReference as Json | undefined)?.path)?.split('root:')[1];
  return {
    status: 'folder',
    folder: {
      name: str(item.name) ?? '',
      ...(str(item.webUrl) ? { url: str(item.webUrl) } : {}),
      ...(parentPath !== undefined
        ? { path: `${decodeSafe(parentPath).replace(/\/+$/, '')}/${str(item.name) ?? ''}` }
        : {}),
      ...(typeof childCount === 'number' ? { childCount } : {}),
    },
    files,
    folders,
    truncated: next !== undefined,
  };
}

export interface ResolveLinkDeps {
  withClient: WithClient;
  pause: (ms: number) => Promise<void>;
  logger: Logger;
}

const AUTH_REASON =
  'Microsoftのサインインが必要です。「unicontext login teams-web」でサインインしてください / Microsoft sign-in required (`unicontext login teams-web`)';

/** Open a SharePoint / OneDrive link with the teams-web session; never throws for the link. */
export async function resolveSharePointLink(
  url: string,
  context: LinkContext,
  deps: ResolveLinkDeps,
): Promise<LinkResolution> {
  const parsed = parseSharePointLink(url);
  if (!parsed.ok) return { status: 'unsupported', reason: parsed.reason };
  const known = knownSites(context);
  let started = false;
  const session = () =>
    deps.withClient(
      async (client) => {
        started = true;
        if (typeof client.getJson !== 'function')
          return { status: 'failed', reason: 'this client cannot open links' } as LinkResolution;
        return resolveWithClient({
          client: client as Ctx['client'],
          parsed,
          known,
          pause: deps.pause,
          redeem: false,
        });
      },
      { url: parsed.startUrl },
    );
  try {
    let out;
    try {
      out = await session();
    } catch (e) {
      // A cold site sometimes stalls in its sign-in redirects: try the session once more.
      if (started || e instanceof AuthRequiredError || !/timeout/i.test(errorMessage(e))) throw e;
      deps.logger.info('teams-web: SharePoint did not open in time, retrying once');
      await deps.pause(3000);
      out = await session();
    }
    if ('auth' in out) return { status: 'authRequired', reason: AUTH_REASON };
    return out.result;
  } catch (e) {
    if (e instanceof AuthRequiredError) return { status: 'authRequired', reason: AUTH_REASON };
    if (e instanceof RateLimitedError)
      return {
        status: 'throttled',
        reason: 'SharePointが混み合っています。少し待ってからもう一度 / SharePoint is throttling',
      };
    return { status: 'failed', reason: errorMessage(e) };
  }
}
