import { testConnectorCompliance } from '@unicontext/connector-sdk/testing';
import { createLiveCampusUNormalizer, LiveCampusUAdapter, metadata } from '../src/index.js';
import {
  FakeLcuServer,
  FakeStrategy,
  newClock,
  TEST_DEPLOYMENT,
  TEST_PROFILE,
  testContext,
} from './helpers.js';

testConnectorCompliance('livecampusu', {
  createAdapter: () => {
    const clock = newClock();
    const server = new FakeLcuServer({ clock, readRows: [46] });
    return new LiveCampusUAdapter(testContext(clock, server.fetch), {
      strategy: new FakeStrategy(server),
    });
  },
  metadata,
  normalizer: createLiveCampusUNormalizer({ deployment: TEST_DEPLOYMENT }),
  profile: TEST_PROFILE,
  sourceId: 'livecampusu',
  rawFixtures: [
    {
      sourceType: 'lcu.grade',
      externalId: 'g-fixture',
      payload: {
        subjectCode: '77401100',
        subjectName: '情報理論',
        score: 80,
        mark: 'B',
        context: {},
        source: { screen: 'SC_10004B00_01', selector: 'tr[subjectCode=77401100]' },
      },
    },
    {
      sourceType: 'lcu.submissionInfo',
      externalId: '99999',
      payload: {
        item: { submissionSeq: 99999, title: '未提出の課題', submittalEndDate: '2026/10/10 23:55' },
        extracted: { submissionSeq: '99999', title: '未提出の課題', deadline: '2026/10/10 23:55' },
        source: {
          screen: 'SC_01002B00_01',
          selector: 'submissionInformation[submissionSeq=99999]',
        },
      },
    },
  ],
});
