import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  type BrowserContextLike,
  type BrowserCookie,
  type BrowserDriver,
  BrowserProfileInUseError,
  COOKIE_SECRET_NAME,
  isProfileInUse,
  playwrightDriver,
} from '@unicontext/adapter-browser';
import { secretKey } from '@unicontext/core';
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError, UsageError } from '../errors.js';
import { action, type Harness } from '../harness.js';
import { type RemoteTarget, runOverSsh } from '../remote-host.js';
import { discoverDaemon, startSync } from './login.js';
import { credentialAdapter, persistentStore, secretsOfSource } from './secrets.js';

/**
 * `unicontext login` on a PC that drives a remote UniContext (UNICONTEXT_REMOTE): the browser
 * opens here, and afterwards what the sign-in changed is handed to the remote over ssh — the
 * source's secrets that changed, and the cookies of every browser profile it wrote to (a sign-in
 * may go through another source's profile, as Teams does through LiveCampusU's). Cookies travel
 * as values because Chrome encrypts its cookie store per machine. The remote (`import-login`)
 * puts them in its own profiles and secret store, which is what a sign-in there would have left,
 * and starts a sync.
 */

export interface LoginHandoff {
  version: 1;
  sourceId: string;
  /** Secrets of the source that the sign-in changed: name → value. */
  secrets: Record<string, string>;
  /** Browser profiles the sign-in wrote to, relative to the cache dir: their cookies. */
  profiles: Record<string, BrowserCookie[]>;
}

export interface LoginSnapshot {
  at: number;
  secrets: Record<string, string | undefined>;
}

type CookieContext = BrowserContextLike & {
  addCookies(cookies: BrowserCookie[]): Promise<void>;
  clearCookies(): Promise<void>;
};

/** Profile directories live at `<cache>/<name>/browser-profile`. */
const PROFILE_DIR = /^[A-Za-z0-9._-]+\/browser-profile$/;
const SECRET_NAME = /^[A-Za-z0-9._-]+$/;
/** Session restore is what keeps cookies without an expiry (an SSL-VPN's DSID) across restarts. */
const LAUNCH = { headless: true, args: ['--restore-last-session'] };
const PROFILE_WAIT_MS = 5 * 60_000;

async function secretNames(ctx: CliContext, sourceId: string): Promise<string[]> {
  const names = new Set([COOKIE_SECRET_NAME, 'oauth']);
  for (const s of await secretsOfSource(ctx, sourceId)) names.add(s.secret);
  return [...names];
}

export async function loginSnapshot(ctx: CliContext, sourceId: string): Promise<LoginSnapshot> {
  const store = await ctx.secrets();
  const secrets: Record<string, string | undefined> = {};
  for (const name of await secretNames(ctx, sourceId))
    secrets[name] = await store.get(secretKey(sourceId, name));
  return { at: ctx.deps.now().getTime(), secrets };
}

/** `<name>/browser-profile` directories whose cookie store was written since `since`. */
export function touchedProfiles(cacheDir: string, since: number): string[] {
  if (!existsSync(cacheDir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(cacheDir)) {
    const dir = path.join(cacheDir, name, 'browser-profile');
    const stores = ['Default/Network/Cookies', 'Default/Cookies'].map((f) => path.join(dir, f));
    if (stores.some((f) => existsSync(f) && statSync(f).mtimeMs >= since - 2_000))
      out.push(`${name}/browser-profile`);
  }
  return out;
}

async function closeTidy(ctx: BrowserContextLike): Promise<void> {
  // With session restore on, the next launch reopens these tabs: leave one blank one.
  try {
    const pages = ctx.pages().filter((p) => !p.isClosed());
    for (const extra of pages.slice(1)) await extra.close?.();
    const first = pages[0];
    if (first && first.url() !== 'about:blank')
      await first.goto('about:blank', { waitUntil: 'commit', timeout: 5_000 });
  } catch {
    // closing matters more than the tabs
  }
  await ctx.close();
}

export async function buildHandoff(
  ctx: CliContext,
  sourceId: string,
  before: LoginSnapshot,
  driver: BrowserDriver = ctx.deps.browserDriver ?? playwrightDriver(),
): Promise<LoginHandoff> {
  const after = await loginSnapshot(ctx, sourceId);
  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(after.secrets))
    if (value !== undefined && value !== before.secrets[name]) secrets[name] = value;
  const profiles: Record<string, BrowserCookie[]> = {};
  const cache = ctx.paths().cache;
  for (const rel of touchedProfiles(cache, before.at)) {
    const browser = await driver.launchPersistentContext(path.join(cache, rel), LAUNCH);
    try {
      profiles[rel] = await browser.cookies();
    } finally {
      await closeTidy(browser);
    }
  }
  return { version: 1, sourceId, secrets, profiles };
}

/** Sends the handoff to the remote's `import-login`; its output goes straight to this terminal. */
export function sendHandoff(target: RemoteTarget, handoff: LoginHandoff, json: boolean) {
  return runOverSsh(target, [...(json ? ['--json'] : []), 'import-login'], {
    tty: false,
    stdin: JSON.stringify(handoff),
  });
}

function parseHandoff(text: string): LoginHandoff {
  let data: Partial<LoginHandoff>;
  try {
    data = JSON.parse(text) as Partial<LoginHandoff>;
  } catch {
    throw new UsageError('標準入力がログインの引き渡しデータ（JSON）ではありません');
  }
  if (data.version !== 1 || typeof data.sourceId !== 'string' || !data.secrets || !data.profiles)
    throw new UsageError('ログインの引き渡しデータの形式が違います');
  for (const name of Object.keys(data.secrets))
    if (!SECRET_NAME.test(name)) throw new UsageError(`秘密情報の名前が不正です: ${name}`);
  for (const rel of Object.keys(data.profiles))
    if (!PROFILE_DIR.test(rel)) throw new UsageError(`プロファイルの場所が不正です: ${rel}`);
  return data as LoginHandoff;
}

async function readStdin(): Promise<string> {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk as string;
  return text;
}

/** Replaces a profile's cookies, waiting while the daemon's sync has the profile open. */
async function seedProfile(
  ctx: CliContext,
  driver: BrowserDriver,
  dir: string,
  cookies: BrowserCookie[],
): Promise<number> {
  const until = ctx.deps.now().getTime() + PROFILE_WAIT_MS;
  let said = false;
  for (;;) {
    if (!isProfileInUse(dir)) {
      try {
        const browser = (await driver.launchPersistentContext(dir, LAUNCH)) as CookieContext;
        let added = 0;
        try {
          await browser.clearCookies();
          for (const c of cookies) {
            try {
              await browser.addCookies([c]);
              added++;
            } catch {
              // a cookie this browser will not take (e.g. a partitioned one) is skipped
            }
          }
        } finally {
          await closeTidy(browser);
        }
        return added;
      } catch (e) {
        if (!(e instanceof BrowserProfileInUseError)) throw e;
      }
    }
    if (ctx.deps.now().getTime() > until)
      throw new CliError(`ブラウザのプロファイルが使用中のままです: ${dir}`, 1);
    if (!said && !ctx.json) ctx.err('同期が終わるのを待っています…');
    said = true;
    await ctx.deps.sleep(2_000);
  }
}

export function registerImportLogin(program: Command, h: Harness): void {
  program
    .command('import-login', { hidden: true })
    .description('別のPCでのログインを受け取る（標準入力） / Receive a sign-in made on another PC')
    .action(
      action(h, async (ctx) => {
        if (ctx.dev) throw new UsageError('--devでは受け取れません');
        const handoff = parseHandoff(await (ctx.deps.readStdin ?? readStdin)());
        const { sourceId } = handoff;
        const driver = ctx.deps.browserDriver ?? playwrightDriver();
        const seeded: Record<string, number> = {};
        for (const [rel, cookies] of Object.entries(handoff.profiles))
          seeded[rel] = await seedProfile(ctx, driver, path.join(ctx.paths().cache, rel), cookies);
        const names = Object.keys(handoff.secrets);
        if (names.length > 0) {
          const store = await persistentStore(ctx);
          for (const name of names)
            await store.set(secretKey(sourceId, name), handoff.secrets[name] ?? '');
          const login = (await secretsOfSource(ctx, sourceId)).filter((s) => s.via === 'login');
          if (login.some((s) => names.includes(s.secret)))
            await (await credentialAdapter(ctx, sourceId))?.credentialsChanged();
        }
        const { daemon } = await discoverDaemon(ctx);
        let job: string | undefined;
        let syncError: string | undefined;
        if (daemon) {
          try {
            job = (await startSync(daemon, sourceId)).job?.id;
          } catch (e) {
            syncError = e instanceof Error ? e.message : String(e);
          }
        }
        if (ctx.json) {
          ctx.printJson({ sourceId, profiles: seeded, secrets: names, syncJob: job, syncError });
          return 0;
        }
        const where = Object.entries(seeded).map(([rel, n]) => `${rel.split('/')[0]}（${n}件）`);
        ctx.out(
          ctx.style.green(
            `${sourceId}: ログインを受け取りました${where.length > 0 ? `（cookie: ${where.join('、')}）` : ''}`,
          ),
        );
        if (names.length > 0) ctx.out(`  秘密情報: ${names.join(', ')}`);
        if (job) ctx.out(`  同期を開始しました（ジョブ ${ctx.text(job)}）`);
        if (syncError) ctx.err(`警告: 同期を始められませんでした: ${ctx.text(syncError)}`);
        return 0;
      }),
    );
}
