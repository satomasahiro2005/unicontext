import { stableId } from '@unicontext/canonical-model';
import { createFakeConnector } from '@unicontext/connector-sdk';
import { createUniContext } from '@unicontext/context-engine';
import { ManualClock } from '@unicontext/core';
import { describe, expect, it } from 'vitest';
import { NotificationService } from '../src/index.js';

/*
 * Deadlines an AI client added from a lecture recording (unconfirmed, origin extracted) get
 * deadline-approaching notifications like any other — but only for courses the student takes.
 */

describe('deadline_approaching for recorded deadlines', () => {
  it('notifies for an enrolled course, marks it 録音から, and skips courses not taken', async () => {
    const clock = new ManualClock('2026-11-10T00:00:00.000Z');
    const uc = createUniContext({ profile: 'shizuoka-university', clock });
    const lcu = createFakeConnector({
      product: 'livecampusu',
      sourceLabel: '学務情報システム',
      authority: 'academic-system',
      capabilities: ['courses', 'enrollments', 'timetable'],
      dataset: {
        courses: [
          {
            id: 'C-MON',
            title: 'ソフトウェア工学',
            year: 2026,
            term: '後期',
            enrolled: true,
            schedule: [{ day: 1, period: 2 }],
          },
          {
            id: 'C-OTHER',
            title: '他学部の講義',
            year: 2026,
            term: '後期',
            schedule: [{ day: 2, period: 3 }],
          },
        ],
      },
    });
    uc.sync.register({
      sourceId: 'livecampusu',
      adapter: lcu.adapter,
      normalizer: lcu.normalizer,
      metadata: lcu.metadata,
    });
    expect((await uc.sync.sync('livecampusu')).ok).toBe(true);
    clock.set('2026-11-16T03:00:00.000Z');
    const chatgpt = { id: 'oauth-chatgpt', name: 'ChatGPT' };
    const base = {
      dueAt: '2026-11-17T09:00:00+09:00',
      kind: 'assignment' as const,
      evidence: '明日の朝9時までに出してください',
      recordingTimestamp: '01:02:03',
    };
    await uc.additions.addDeadline(chatgpt, {
      ...base,
      courseOfferingId: stableId('courseOffering', 'livecampusu', 'C-MON'),
      title: '課題3 クラス図',
    });
    await uc.additions.addDeadline(chatgpt, {
      ...base,
      courseOfferingId: stableId('courseOffering', 'livecampusu', 'C-OTHER'),
      title: '他学部の課題',
    });

    clock.set('2026-11-16T12:00:00.000Z'); // 21:00 JST, 12 hours before
    const svc = new NotificationService({ uc, sinks: [] });
    const sent = (await svc.checkDeadlines()).filter((n) => n.kind === 'deadline_approaching');
    expect(sent.map((n) => n.title)).toEqual([expect.stringContaining('課題3 クラス図')]);
    expect(sent[0]?.body).toContain('録音から・未確認');
    expect(sent[0]?.citations[0]?.label).toContain('ChatGPT Record 01:02:03');
    await uc.close();
  });
});
