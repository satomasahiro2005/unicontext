import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthResult, RawItem, RawItemView } from '@unicontext/connector-sdk';
import { type Clock, RateLimitedError, silentLogger } from '@unicontext/core';
import {
  type ChannelTarget,
  type ClientConversations,
  type DriveDeltaResult,
  type ReplyChainRow,
  type StreamFileRequest,
  type StreamFileResult,
  TeamsWebAdapter,
  type TeamsWebClient,
  type TeamsWebConfig,
  TeamsWebConfigSchema,
} from '../src/index.js';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

export function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

export const CLASS_GROUP = '3f6b2c1e-8a47-4d2b-9c5e-1a2b3c4d5e6f';
export const LAB_GROUP = '6c6c6c6c-1111-4222-8333-444444444444';
export const TEAM_ID = '19:a1b2c3d4e5f60718293a4b5c6d7e8f90@thread.tacv2';
export const CH_MATERIALS = '19:0f1e2d3c4b5a69788796a5b4c3d2e1f0@thread.tacv2';
export const CH_QUESTIONS = '19:5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a@thread.tacv2';
export const LAB_TEAM_ID = '19:b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0@thread.tacv2';
export const TEACHER_MRI = '8:orgid:9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
export const SELF_MRI = '8:orgid:1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
export const CARD_ASSIGNMENT = '7e8f9a0b-1c2d-4e3f-9a4b-5c6d7e8f9a0b';
export const SITE = 'https://example.sharepoint.com/sites/2026X_abc123';
export const NOW = new Date('2026-10-02T03:00:00Z');

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

/** Scripted Teams web client: the fixtures plus counters of what the adapter asked for. */
export class FakeTeamsClient implements TeamsWebClient {
  conv: ClientConversations = fixture<ClientConversations>('client-conversations.json');
  chains: Record<string, ReplyChainRow[]> = fixture('client-replychains.json') as unknown as Record<
    string,
    ReplyChainRow[]
  >;
  work: Record<string, unknown>[] = fixture<{ value: Record<string, unknown>[] }>(
    'edu-me-work.json',
  ).value;
  workComplete = true;
  delta = fixture<{ full: Record<string, unknown>; incremental: Record<string, unknown> }>(
    'sharepoint-delta.json',
  );
  files: Record<string, Uint8Array> = {};
  opened: string[] = [];
  deltaCalls: { siteUrl: string; deltaLink: string | undefined }[] = [];
  downloads: string[] = [];
  failOpen: Error | undefined;
  expiredLink = false;

  open(): Promise<{ version: string }> {
    if (this.failOpen) return Promise.reject(this.failOpen);
    return Promise.resolve({ version: 'v2' });
  }

  conversations(): Promise<ClientConversations> {
    return Promise.resolve(JSON.parse(JSON.stringify(this.conv)) as ClientConversations);
  }

  openChannel(target: ChannelTarget): Promise<{ fetched: boolean }> {
    this.opened.push(target.channelId);
    return Promise.resolve({ fetched: true });
  }

  replyChains(conversationId: string): Promise<ReplyChainRow[]> {
    return Promise.resolve(
      JSON.parse(JSON.stringify(this.chains[conversationId] ?? [])) as ReplyChainRow[],
    );
  }

  assignments(): Promise<{ items: Record<string, unknown>[]; complete: boolean }> {
    return Promise.resolve({
      items: JSON.parse(JSON.stringify(this.work)) as Record<string, unknown>[],
      complete: this.workComplete,
    });
  }

  driveDelta(siteUrl: string, deltaLink: string | undefined): Promise<DriveDeltaResult> {
    this.deltaCalls.push({ siteUrl, deltaLink });
    if (siteUrl !== SITE)
      return Promise.resolve({ items: [], deltaLink: `${siteUrl}/delta?token=x` });
    if (deltaLink && this.expiredLink) {
      this.expiredLink = false;
      return Promise.resolve({ items: [], deltaLink: undefined, resync: true });
    }
    const page = deltaLink ? this.delta.incremental : this.delta.full;
    return Promise.resolve({
      items: JSON.parse(JSON.stringify(page.value)) as Record<string, unknown>[],
      deltaLink: page['@odata.deltaLink'] as string,
    });
  }

  /** Status answered for an item (default: 200 with `files[itemId]`, 404 when absent). */
  fileStatus: Record<string, number> = {};
  /** Chunk size of the fake stream (several chunks per file in tests). */
  chunkSize = 4;
  streamRequests: StreamFileRequest[] = [];

  async streamFile(
    request: StreamFileRequest,
    onChunk: (chunk: Uint8Array) => Promise<void>,
  ): Promise<StreamFileResult> {
    this.downloads.push(request.itemId);
    this.streamRequests.push(request);
    const status = this.fileStatus[request.itemId];
    if (status === 429) throw new RateLimitedError('throttled', { retryAfterMs: 1000 });
    const data = this.files[request.itemId];
    if (status !== undefined && status !== 200)
      return { ok: false, reason: status === 404 ? 'notFound' : 'failed', status };
    if (!data) return { ok: false, reason: 'notFound', status: 404 };
    if (data.byteLength > request.maxBytes) return { ok: false, reason: 'tooLarge' };
    for (let i = 0; i < data.byteLength; i += this.chunkSize)
      await onChunk(data.subarray(i, i + this.chunkSize));
    return { ok: true, bytes: data.byteLength, contentType: 'application/octet-stream' };
  }
}

export interface Harness {
  adapter: TeamsWebAdapter;
  client: FakeTeamsClient;
  clock: ReturnType<typeof testClock>;
  config: TeamsWebConfig;
  /** Browser sessions opened (the start URL each asked for). */
  sessions: (string | undefined)[];
}

export function harness(
  options: {
    config?: Record<string, unknown>;
    client?: FakeTeamsClient;
    auth?: AuthResult;
    profileExists?: boolean;
    extract?: (
      data: Uint8Array,
      ext: string,
    ) => Promise<{ text: string; pages?: { page: number; text: string }[] }>;
  } = {},
): Harness {
  const client = options.client ?? new FakeTeamsClient();
  const clock = testClock();
  const config = TeamsWebConfigSchema.parse({ channelDelayMs: 10, ...(options.config ?? {}) });
  const sessions: (string | undefined)[] = [];
  const adapter = new TeamsWebAdapter({
    sourceId: 'teams-web',
    config,
    clock,
    logger: silentLogger,
    timezone: 'Asia/Tokyo',
    profileExists: () => options.profileExists ?? true,
    withClient: async (fn, o) => {
      sessions.push(o?.url);
      return options.auth ? { auth: options.auth } : { result: await fn(client) };
    },
    random: () => 0,
    ...(options.extract ? { extract: options.extract } : {}),
  });
  return { adapter, client, clock, config, sessions };
}

export function toView(item: RawItem, sourceId = 'teams-web'): RawItemView {
  return {
    id: `raw:${item.sourceType}:${item.externalId}`,
    sourceId,
    sourceType: item.sourceType,
    externalId: item.externalId,
    payload: JSON.parse(JSON.stringify(item.payload)) as unknown,
    fetchedAt: NOW.toISOString(),
    sourceUpdatedAt: item.sourceUpdatedAt,
    contentHash: 'h',
  };
}
