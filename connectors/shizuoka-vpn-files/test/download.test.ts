import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileDownloadRequest } from '@unicontext/connector-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FilePayload, StreamFileResult } from '../src/index.js';
import { FakeVpnClient, harness } from './helpers.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'uc-vpn-dl-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const payload = (over: Partial<FilePayload> = {}): FilePayload => ({
  root: 'fs-share',
  parent: 'class/2026年度データ処理演習',
  path: 'class/2026年度データ処理演習/week01.pdf',
  name: 'week01.pdf',
  label: 'FS share / class / 2026年度データ処理演習 / week01.pdf',
  sizeBytes: 11,
  resourceId: 'resource_x',
  bookmark: 'FS share',
  dir: 'class/2026年度データ処理演習',
  version: 'v1|11',
  listedAt: '2026-10-05T01:00:00.000Z',
  course: null,
  prefetch: false,
  ...over,
});

const req = (targetPath: string, over: Partial<FilePayload> = {}): FileDownloadRequest => {
  const p = payload(over);
  return { externalId: `fs-share:${p.path}`, payload: p, targetPath, maxBytes: 200 * 1024 * 1024, extract: true };
};

describe('shizuoka-vpn-files downloads', () => {
  it('streams a file to disk and extracts its text', async () => {
    const client = new FakeVpnClient();
    client.files['class/2026年度データ処理演習\u0000week01.pdf'] = new TextEncoder().encode('hello world');
    const h = harness({
      client,
      extract: (data) => Promise.resolve({ text: new TextDecoder().decode(data) }),
    });
    const target = join(dir, 'week01.pdf');
    const out = await h.adapter.downloadFiles([req(target)]);
    expect(out.results[0]?.status).toBe('downloaded');
    expect(readFileSync(target, 'utf8')).toBe('hello world');
    const text = out.items.find((i) => i.sourceType === 'szvpn.fileText');
    expect((text?.payload as { text: string }).text).toBe('hello world');
  });

  it('refuses a file larger than maxBytes', async () => {
    const client = new FakeVpnClient();
    const h = harness({ client });
    const out = await h.adapter.downloadFiles([
      { ...req(join(dir, 'big.pdf'), { sizeBytes: 999 }), maxBytes: 10 },
    ]);
    expect(out.results[0]?.status).toBe('tooLarge');
  });

  it('reports notFound and never writes a partial file', async () => {
    const h = harness();
    const out = await h.adapter.downloadFiles([req(join(dir, 'missing.pdf'))]);
    expect(out.results[0]?.status).toBe('notFound');
  });

  it('retries a transient download failure with backoff', async () => {
    class FlakyClient extends FakeVpnClient {
      fails = 1;
      override streamFile(
        r: { dir: string; name: string; maxBytes: number },
        onChunk: (chunk: Uint8Array) => Promise<void>,
      ): Promise<StreamFileResult> {
        if (this.fails > 0) {
          this.fails--;
          return Promise.resolve({ ok: false, reason: 'failed', status: 500 });
        }
        return super.streamFile(r, onChunk);
      }
    }
    const client = new FlakyClient();
    client.files['class/2026年度データ処理演習\u0000week01.pdf'] = new TextEncoder().encode('ok');
    const h = harness({ client, config: { files: { maxRetries: 2 } } });
    const out = await h.adapter.downloadFiles([req(join(dir, 'retry.pdf'), { course: null })]);
    expect(out.results[0]?.status).toBe('downloaded');
  });
});
