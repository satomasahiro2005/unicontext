import type { RawItem } from '@unicontext/connector-sdk';
import { testConnectorCompliance } from '@unicontext/connector-sdk/testing';
import {
  createPortalNormalizer,
  metadata,
  WordpressConfigSchema,
  WordpressPortalAdapter,
  type WpPdfPayload,
} from '../src/index.js';
import { BASE, buildPdf, makeContext, samplePosts } from './helpers.js';
import { createWpServer, post } from './wp-server.js';

const PDF = `${BASE}wp-content/uploads/2026/03/aaa.pdf`;
const FACULTY = `${BASE}student_e/inf`;

const pdfFixture: RawItem = {
  sourceType: 'wp.pdf',
  externalId: PDF,
  payload: {
    url: PDF,
    title: 'R8時間割 前期',
    foundOn: FACULTY,
    size: 10,
    sha256: 'b'.repeat(64),
    pages: [{ page: 1, text: '月 1・2限 データベース' }],
  } satisfies WpPdfPayload,
};

testConnectorCompliance('wordpress-portal', {
  createAdapter: () => {
    const srv = createWpServer({
      posts: [
        ...samplePosts(),
        post(10, '2026-06-01T00:00:00', {
          content: { rendered: `<p><a href="${PDF}">R8時間割 前期</a></p>` },
        }),
      ],
      categories: [{ id: 1, name: '全学向け情報' }],
      pdfs: { [PDF]: buildPdf(['Timetable']) },
    });
    return new WordpressPortalAdapter(
      makeContext(WordpressConfigSchema.parse({ baseUrl: BASE, perPage: 2 }), srv.fetch),
    );
  },
  metadata,
  normalizer: createPortalNormalizer(),
  rawFixtures: [pdfFixture],
  sourceId: 'portal',
});
