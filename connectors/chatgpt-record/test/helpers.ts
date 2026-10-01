import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  instantiateConnector,
  type RawItem,
  type SourceAdapter,
  type SyncInput,
  type SyncResult,
} from '@unicontext/connector-sdk';
import type { Clock, SecretStore } from '@unicontext/core';
import connector, { ChatGptRecordAdapter, type ChatGptRecordAdapterOptions } from '../src/index.js';

export const memorySecrets: SecretStore = {
  backend: 'memory',
  get: () => Promise.resolve(undefined),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve(false),
};

export const makeTempDir = (prefix = 'uc-record-'): Promise<string> =>
  mkdtemp(path.join(tmpdir(), prefix));

export const removeDir = (dir: string): Promise<void> => rm(dir, { recursive: true, force: true });

export async function put(root: string, rel: string, data: string | Uint8Array): Promise<string> {
  const abs = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, data);
  return abs;
}

export async function setMtime(abs: string, seconds: number): Promise<void> {
  const t = new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + seconds * 1000);
  await utimes(abs, t, t);
}

export function createAdapter(
  config: Record<string, unknown>,
  init: { cacheDir?: string; clock?: Clock } = {},
  options: ChatGptRecordAdapterOptions = {},
): ChatGptRecordAdapter {
  const inst = instantiateConnector(connector, {
    sourceId: 'record',
    config,
    secrets: memorySecrets,
    ...(init.cacheDir ? { cacheDir: init.cacheDir } : {}),
    ...(init.clock ? { clock: init.clock } : {}),
  });
  if (Object.keys(options).length > 0) return new ChatGptRecordAdapter(inst.context, options);
  return inst.adapter as ChatGptRecordAdapter;
}

export async function collect(
  adapter: SourceAdapter,
  input: SyncInput,
): Promise<{ pages: SyncResult[]; items: RawItem[]; deletions: string[]; warnings: string[] }> {
  const pages: SyncResult[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 100; i++) {
    const res = await adapter.sync({ ...input, ...(pageToken ? { pageToken } : {}) });
    pages.push(res);
    if (!res.hasMore) break;
    pageToken = res.nextPageToken;
  }
  return {
    pages,
    items: pages.flatMap((p) => p.items),
    deletions: pages.flatMap((p) => (p.deletions ?? []).map((d) => d.externalId)),
    warnings: pages.flatMap((p) => p.warnings ?? []),
  };
}

// ------------------------------------------------------------------------ fixtures

export const TXT_LECTURE = `授業: データベースシステム論
タイトル: 第3回 正規化
[00:00:05] 先生: 今日は正規化について説明します。
[00:00:30] レポートは10月15日23時59分までに提出してください。
[00:01:10] Speaker 1: 質問です。
第3正規形とは何ですか。
`;

export const VTT_LECTURE = `WEBVTT
Kind: captions
Language: ja

NOTE this is a comment

1
00:00:01.000 --> 00:00:04.000
<v 先生>今日はレポートについて話します。</v>

2
00:00:04.500 --> 00:00:07.000
<v 先生>レポートは10月15日</v>

3
00:00:07.000 --> 00:00:10.000
<v 先生>23時59分までに提出してください。</v>

4
01:02:03.250 --> 01:02:05.000
<v 学生><i>ありがとうございます</i></v>
`;

export const SRT_LECTURE = `1
00:00:01,000 --> 00:00:04,000
今日はER図について説明します。

2
00:00:05,500 --> 00:00:09,000
- 来週の金曜日までに
- 課題を出してください。
`;

export const WHISPER_JSON = JSON.stringify({
  text: '全文',
  language: 'ja',
  segments: [
    { id: 0, start: 0, end: 4.5, text: ' 今日は始めます。' },
    { id: 1, start: 4.5, end: 9.25, text: ' レポートは10月15日23時59分までです。' },
  ],
});

export const lectureTree = async (root: string): Promise<void> => {
  await put(root, 'データベースシステム論/2026-10-01 10-40.vtt', VTT_LECTURE);
  await put(root, '2026前期/線形代数/20261002_0900.txt', TXT_LECTURE.replace(/^授業:.*\n/, ''));
  await put(root, 'whisper/2026-10-03.json', WHISPER_JSON);
  await put(root, 'readme.pdf', '%PDF');
  await put(root, '.hidden/x.txt', '[00:00:01] x');
};
