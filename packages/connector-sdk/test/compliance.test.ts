import { loadProfile } from '@unicontext/core';
import { createFakeConnector } from '../src/index.js';
import { testConnectorCompliance } from '../src/testing.js';

// The fake connector must pass the same contract suite every real connector runs (§66).
const make = () =>
  createFakeConnector({
    product: 'fake-lms',
    authority: 'lms',
    pageSize: 2,
    dataset: {
      courses: [
        {
          id: 'c1',
          code: 'DB101',
          title: 'データベースシステム論',
          schedule: [{ day: 4, period: 2, room: '21教室' }],
        },
      ],
      sessions: [{ id: 's1', courseId: 'c1', date: '2026-10-01', period: 2, room: '21教室' }],
      assignments: [
        {
          id: 'a1',
          courseId: 'c1',
          title: '課題1',
          due: '2026-10-08T23:59:00+09:00',
          updatedAt: '2026-09-30T00:00:00Z',
        },
      ],
      announcements: [
        {
          id: 'n1',
          courseId: 'c1',
          title: '教室変更',
          body: '本日は11教室です',
          roomChange: { room: '11教室', date: '2026-10-01' },
        },
      ],
      transcripts: [
        {
          id: 't1',
          courseId: 'c1',
          date: '2026-10-01',
          segments: [{ start: '00:42:18', text: '正規化の話' }],
        },
      ],
    },
  });

const fake = make();
testConnectorCompliance('fake-lms', {
  createAdapter: () => make().adapter,
  metadata: fake.metadata,
  normalizer: fake.normalizer,
  profile: loadProfile('shizuoka-university'),
});
