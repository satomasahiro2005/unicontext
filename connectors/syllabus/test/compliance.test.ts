import type { RawItem } from '@unicontext/connector-sdk';
import { testConnectorCompliance } from '@unicontext/connector-sdk/testing';
import {
  CancellationsAdapter,
  CancellationsConfigSchema,
  cancellationsMetadata,
  createCancellationNormalizer,
  createSyllabusNormalizer,
  metadata,
  SyllabusAdapter,
  SyllabusConfigSchema,
} from '../src/index.js';
import { BASE, fixture, makeContext, shizuokaProfile } from './helpers.js';
import { createLcuServer } from './lcu-server.js';

testConnectorCompliance('syllabus (lcu-public)', {
  createAdapter: () =>
    new SyllabusAdapter(
      makeContext(
        SyllabusConfigSchema.parse({
          baseUrl: BASE,
          screens: { syllabusSearch: 'SC_06001B00_21', syllabusDetail: 'SC_06001B00_22' },
          targets: [{ year: 2026, subjectCode: '77403030' }],
        }),
        createLcuServer().fetch,
      ),
    ),
  metadata,
  normalizer: createSyllabusNormalizer(),
  profile: shizuokaProfile(),
  sourceId: 'syllabus',
});

const cancellationFetch = () => () =>
  Promise.resolve(
    new Response(fixture('lcu-kyuko-SC_90002szu_01.html'), {
      status: 200,
      headers: { 'content-type': 'text/html;charset=UTF-8' },
    }),
  );

/** A row of the user's own course: exercises the classSession + courseOffering branch. */
const matchedFixture: RawItem = {
  sourceType: 'lcu.publicCancellation',
  externalId: '外国史概論|人文専門１A|2026-10-02|3・4',
  payload: {
    title: '外国史概論 (人文専門１A)',
    courseTitle: '外国史概論',
    className: '人文専門１A',
    dateText: '10/02',
    date: '2026-10-02',
    period: '3・4',
    periodIndex: 2,
    instructors: ['教員 花子'],
    matched: { title: '外国史概論' },
    url: `${BASE}SC_90002szu_01`,
  },
  sourceUpdatedAt: '2026-10-01T02:29:00.000Z',
};

testConnectorCompliance('lcu-public-cancellations', {
  createAdapter: () =>
    new CancellationsAdapter(
      makeContext(
        CancellationsConfigSchema.parse({
          baseUrl: BASE,
          screens: { publicCancellations: 'SC_90002szu_01' },
          courses: [{ title: '外国史概論' }],
        }),
        cancellationFetch(),
      ),
    ),
  metadata: cancellationsMetadata,
  normalizer: createCancellationNormalizer(),
  rawFixtures: [matchedFixture],
  profile: shizuokaProfile(),
  sourceId: 'cancellations',
});
