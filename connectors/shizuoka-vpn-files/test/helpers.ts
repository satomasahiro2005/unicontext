import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { AuthResult } from '@unicontext/connector-sdk';
import { type Clock, silentLogger } from '@unicontext/core';
import {
  ShizuokaVpnFilesAdapter,
  type ShizuokaVpnFilesConfig,
  ShizuokaVpnFilesConfigSchema,
  SHIZUOKA_VPN_DEPLOYMENT,
  type FbEntry,
  type ListResult,
  type SessionMarker,
  type StreamFileResult,
  type VpnDeployment,
  type VpnPortalClient,
  VpnDeploymentSchema,
  sizeToBytes,
  parseTimestamp,
} from '../src/index.js';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

export function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

export const NOW = new Date('2026-10-05T01:00:00Z');

export function testClock(now: Date = NOW): Clock & { slept: number[]; set(d: Date): void } {
  let current = now;
  const slept: number[] = [];
  return {
    slept,
    set(d: Date) {
      current = d;
    },
    now: () => current,
    setTimeout: () => 0 as never,
    clearTimeout: () => undefined,
    sleep: (ms: number) => {
      slept.push(ms);
      return Promise.resolve();
    },
  };
}

export const DEPLOYMENT: VpnDeployment = VpnDeploymentSchema.parse(SHIZUOKA_VPN_DEPLOYMENT);

interface TreeFixture {
  forbidden: string[];
  listings: Record<string, { name: string; isFile: string; size?: string; timestamp?: string }[]>;
}

type Scripted = Record<string, ListResult[]>;

/** Scripted portal client: listings from a fixture, plus per-dir status overrides for flaky tests. */
export class FakeVpnClient implements VpnPortalClient {
  listCalls: string[] = [];
  /** Set to give the client a session probe (the adapter asks it when a run made no request). */
  probeSession?: () => Promise<boolean>;
  downloadCalls: string[] = [];
  /** Bytes served for a file by its dir+name key "dir\u0000name". */
  files: Record<string, Uint8Array> = {};
  /** Overrides consumed in order per dir; falls back to the fixture when empty. */
  script: Scripted = {};

  constructor(readonly tree: TreeFixture = fixture<TreeFixture>('tree.synthetic.json')) {}

  private fromFixture(dir: string): ListResult {
    if (this.tree.forbidden.includes(dir))
      return { status: 'forbidden', httpStatus: 403, message: 'ファイル参照エラー' };
    const rows = this.tree.listings[dir];
    if (!rows) return { status: 'error', httpStatus: 404, message: 'no such dir' };
    const entries: FbEntry[] = rows.map((r) => ({
      name: r.name,
      isFile: /^y/i.test(r.isFile),
      sizeBytes: sizeToBytes(r.size),
      sizeText: r.size,
      modifiedAt: parseTimestamp(r.timestamp),
      modifiedText: r.timestamp,
    }));
    return entries.length > 0
      ? { status: 'ok', httpStatus: 200, entries }
      : { status: 'empty', httpStatus: 200 };
  }

  listDir(req: { dir: string }): Promise<ListResult> {
    this.listCalls.push(req.dir);
    const scripted = this.script[req.dir];
    if (scripted && scripted.length > 0) return Promise.resolve(scripted.shift()!);
    return Promise.resolve(this.fromFixture(req.dir));
  }

  streamFile(
    req: { dir: string; name: string; maxBytes: number },
    onChunk: (chunk: Uint8Array) => Promise<void>,
  ): Promise<StreamFileResult> {
    const key = `${req.dir}\u0000${req.name}`;
    this.downloadCalls.push(key);
    const data = this.files[key];
    if (!data) return Promise.resolve({ ok: false, reason: 'notFound', status: 404 });
    if (data.byteLength > req.maxBytes) return Promise.resolve({ ok: false, reason: 'tooLarge' });
    return onChunk(data).then(() => ({ ok: true as const, bytes: data.byteLength, contentType: 'application/octet-stream' }));
  }
}

export interface Harness {
  adapter: ShizuokaVpnFilesAdapter;
  client: FakeVpnClient;
  clock: ReturnType<typeof testClock>;
  config: ShizuokaVpnFilesConfig;
}

export function harness(
  overrides: {
    client?: FakeVpnClient;
    config?: Partial<unknown>;
    clock?: ReturnType<typeof testClock>;
    profileExists?: boolean;
    authFail?: boolean;
    sessionMarker?: SessionMarker;
    verifySession?: () => Promise<AuthResult>;
    profileInUse?: () => boolean;
    login?: () => Promise<AuthResult>;
    autoSignIn?: () => Promise<AuthResult | undefined>;
    resetAutoSignIn?: () => void;
    extract?: (data: Uint8Array, ext: string) => Promise<{ text: string; pages?: { page: number; text: string }[] }>;
  } = {},
): Harness {
  const client = overrides.client ?? new FakeVpnClient();
  const clock = overrides.clock ?? testClock();
  const base = { walk: { requestDelayMs: 0, retryBaseMs: 0, maxRetries: 1 }, files: { downloadDelayMs: 0, maxRetries: 1 } };
  const o = (overrides.config as { walk?: object; files?: object } | undefined) ?? {};
  const config = ShizuokaVpnFilesConfigSchema.parse({
    ...o,
    walk: { ...base.walk, ...(o.walk ?? {}) },
    files: { ...base.files, ...(o.files ?? {}) },
  });
  const adapter = new ShizuokaVpnFilesAdapter({
    sourceId: 'shizuoka-vpn-files',
    config,
    deployment: DEPLOYMENT,
    clock,
    logger: silentLogger,
    timezone: 'Asia/Tokyo',
    profileExists: () => overrides.profileExists !== false,
    ...(overrides.sessionMarker ? { sessionMarker: overrides.sessionMarker } : {}),
    ...(overrides.verifySession ? { verifySession: overrides.verifySession } : {}),
    ...(overrides.profileInUse ? { profileInUse: overrides.profileInUse } : {}),
    ...(overrides.login ? { login: overrides.login } : {}),
    ...(overrides.autoSignIn ? { autoSignIn: overrides.autoSignIn } : {}),
    ...(overrides.resetAutoSignIn ? { resetAutoSignIn: overrides.resetAutoSignIn } : {}),
    withClient: async (fn) => {
      if (overrides.authFail)
        return { auth: { status: 'auth_required', message: 'login' } as AuthResult };
      return { result: await fn(client) };
    },
    ...(overrides.extract ? { extract: overrides.extract } : {}),
    random: () => 0,
  });
  return { adapter, client, clock, config };
}
