import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createMcpConnector,
  MAPPINGS_DIR,
  McpConfigSchema,
  McpSourceAdapter,
} from '@unicontext/adapter-mcp';
import { downloadCourseFiles, fileTextExcerpt } from '@unicontext/context-engine';
import type { FetchLike, SecretStore } from '@unicontext/core';
import { createMappedNormalizer, loadMappingFile } from '@unicontext/mapping';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEdServer,
  inMemoryFactory,
} from '../../../packages/adapter-mcp/test/fixtures/servers.js';
import { CID_PDF_TEXT, makeCidPdf } from '../../../connectors/local-files/test/cid-pdf.js';
import { createTestServer, type TestServer } from './helpers.js';

/*
 * Ed attachments end to end: the Ed mapping (in-memory fake Ed server) registered in a dev
 * runtime, `download_course_file` on the lesson's PDF (a Japanese PDF with a CID font, the usual
 * PowerPoint output), and the text becoming searchable. The file host is a fake: every GET
 * returns the same PDF.
 */

const SRC = 'ed';
let s: TestServer;
let filesDir: string;
let documentId: string;
let requests = 0;

const secrets: SecretStore = {
  backend: 'memory',
  get: () => Promise.resolve(undefined),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve(false),
};

const pdf = makeCidPdf();
const fileFetch: FetchLike = () => {
  requests++;
  return Promise.resolve(
    new Response(new Uint8Array(pdf), { headers: { 'content-type': 'application/pdf' } }),
  );
};

beforeAll(async () => {
  s = await createTestServer();
  filesDir = mkdtempSync(path.join(tmpdir(), 'uc-ed-files-'));
  const spec = loadMappingFile(path.join(MAPPINGS_DIR, 'edstem-mcp.yaml'));
  s.runtime.uc.sync.register({
    sourceId: SRC,
    adapter: new McpSourceAdapter({
      sourceId: SRC,
      spec,
      config: McpConfigSchema.parse({ command: 'fake-mcp-server' }),
      secrets,
      transportFactory: inMemoryFactory(() => createEdServer()),
      runOptions: { fileFetch },
    }),
    normalizer: createMappedNormalizer(spec),
    metadata: createMcpConnector(spec).metadata,
  });
  const r = await s.runtime.uc.sync.sync(SRC);
  expect(r.ok, r.error).toBe(true);
  const doc = s.runtime.uc.sync.stores.entities
    .list('document', { sourceId: SRC })
    .find((d) => d.url === 'https://static.edusercontent.com/files/AAAA');
  expect(doc, 'the lesson PDF is a document').toBeDefined();
  documentId = doc!.id;
}, 60_000);

afterAll(async () => {
  await s.close();
  rmSync(filesDir, { recursive: true, force: true });
});

describe('Ed attachment text', () => {
  it('download_course_file extracts and indexes the text of the PDF', async () => {
    const report = await downloadCourseFiles(s.runtime.uc, [documentId], { filesDir });
    const r = report.results[0]!;
    expect(r.status).toBe('downloaded');
    expect(r.error).toBeUndefined();
    expect(r.text?.chunks).toBeGreaterThan(0);
    expect(r.text?.chars).toBe(CID_PDF_TEXT.length);
    const excerpt = fileTextExcerpt(s.runtime.uc, documentId, 10_000);
    expect(excerpt.chunks).toBeGreaterThan(0);
    expect(excerpt.text).toContain(CID_PDF_TEXT);
    expect(excerpt.text).toContain('[p.1]');
    // the text is cited like the lesson file it came from
    const stores = s.runtime.uc.sync.stores;
    const chunk = stores.entities.list('documentChunk', { where: { documentId } })[0]!;
    expect(stores.sourceRefs.forEntity(chunk.id)[0]?.sourceLabel).toBe('Ed Lessons');
  });

  it('a file already on disk is not fetched again', async () => {
    const before = requests;
    const report = await downloadCourseFiles(s.runtime.uc, [documentId], { filesDir });
    expect(report.results[0]).toMatchObject({ status: 'cached', text: { chunks: 1 } });
    expect(requests).toBe(before);
  });

  it('a file downloaded without text gets its text on the next request, without a new download', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'uc-ed-files2-'));
    try {
      const uc = s.runtime.uc;
      // forget the text of the first run: the chunks belong to the raw text item of the file
      await uc.sync.ingest(SRC, {
        items: [],
        deletions: [
          {
            sourceType: 'unicontext.fileText',
            externalId: 'https://static.edusercontent.com/files/AAAA',
          },
        ],
      });
      expect(fileTextExcerpt(uc, documentId, 100).chunks).toBe(0);
      const first = await downloadCourseFiles(uc, [documentId], { filesDir: dir, extract: false });
      expect(first.results[0]).toMatchObject({ status: 'downloaded', text: { chunks: 0 } });
      const before = requests;
      const second = await downloadCourseFiles(uc, [documentId], { filesDir: dir });
      expect(second.results[0]).toMatchObject({ status: 'cached' });
      expect(second.results[0]?.text?.chunks).toBeGreaterThan(0);
      expect(second.results[0]?.error).toBeUndefined();
      expect(requests).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
