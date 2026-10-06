import { ManualClock } from '@unicontext/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AttentionContext,
  attentionRequired,
  deadlineStage,
  NOTIFY_STAGES,
  type UniContext,
} from '../src/index.js';
import { createNextActionScenario, db as dbCourse } from './next-action-scenario.js';

/*
 * Re-notification by stage: a deadline is told again when its stage advances (24h → 6h → final →
 * overdue), never twice at the same stage, and what is held back is listed in `pending`.
 * The deadline in these scenarios is 23:59 JST, unsubmitted.
 */

let uc: UniContext;
let clock: ManualClock;
const HOUR = 3_600_000;

beforeEach(async () => {
  ({ uc, clock } = await createNextActionScenario());
});
afterEach(async () => {
  await uc.close();
});

/** 10/6 23:59 JST: a report the student was told about in a chat (an assignment, unsubmitted). */
async function addReport(): Promise<void> {
  await uc.additions.addDeadline(
    { id: 'local:test', name: 'test' },
    {
      courseOfferingId: dbCourse,
      title: 'ER図レポート',
      dueAt: '2026-10-06T23:59+09:00',
      kind: 'assignment',
      evidence: 'ER図のレポートは10/6の23:59まで',
    },
  );
}

const about = (r: AttentionContext, text: string) => ({
  fresh: r.items.filter((i) => i.line.includes(text)),
  pending: r.pending.filter((i) => i.line.includes(text)),
});

describe('deadlineStage', () => {
  const due = Date.parse('2026-10-06T14:59:00Z');
  it('goes 24h → 6h → final → overdue, with the next boundary', () => {
    expect(deadlineStage(due, due - 23 * HOUR)).toEqual({ stage: '24h', nextAt: due - 6 * HOUR });
    expect(deadlineStage(due, due - 6 * HOUR)).toEqual({ stage: '6h', nextAt: due - 2 * HOUR });
    expect(deadlineStage(due, due - 2.5 * HOUR)).toEqual({ stage: '6h', nextAt: due - 2 * HOUR });
    expect(deadlineStage(due, due - 2 * HOUR)).toEqual({ stage: 'final', nextAt: due });
    expect(deadlineStage(due, due - 60_000)).toEqual({ stage: 'final', nextAt: due });
    expect(deadlineStage(due, due)).toEqual({ stage: 'overdue', nextAt: undefined });
    expect(NOTIFY_STAGES).toEqual(['24h', '6h', '1h', 'final', 'overdue']);
  });

  it('a 23:59 deadline is final from 21:59, covering the 23時台 and everything after 22:00', () => {
    // 22:05 JST on the deadline day.
    expect(deadlineStage(due, Date.parse('2026-10-06T13:05:00Z')).stage).toBe('final');
    // 21:30 JST is still the 6-hour stage.
    expect(deadlineStage(due, Date.parse('2026-10-06T12:30:00Z')).stage).toBe('6h');
  });
});

describe('stated deadline, 23:59 JST and unsubmitted', () => {
  it('emits each stage change exactly once and never repeats a stage', async () => {
    await addReport();
    const seenStages: string[] = [];
    const at = async (jst: string, iso: string) => {
      clock.set(iso);
      const r = attentionRequired(uc, 'watcher');
      const mine = about(r, 'ER図レポート');
      for (const i of mine.fresh) seenStages.push(`${jst} ${String(i.notifyStage)}`);
      return { r, ...mine };
    };

    // 10/6 00:30 JST: 23.5 hours left.
    const a = await at('00:30', '2026-10-05T15:30:00Z');
    expect(a.fresh).toHaveLength(1);
    expect(a.fresh[0]).toMatchObject({
      kind: 'deadline',
      notifyStage: '24h',
      severity: 'warning',
      nextEscalationAt: '2026-10-06T08:59:00.000Z', // 6 h before
    });
    expect(a.fresh[0]?.key).toMatch(/:24h$/);
    // Local 0:00-7:59 and not within 3 hours: kept until 08:00 (the client decides).
    expect(a.fresh[0]?.quietUntil).toBe('2026-10-05T23:00:00.000Z');

    // The same stage an hour later is held back and listed with when it comes back.
    const a2 = await at('01:30', '2026-10-05T16:30:00Z');
    expect(a2.fresh).toHaveLength(0);
    expect(a2.pending).toHaveLength(1);
    expect(a2.pending[0]).toMatchObject({
      notifyStage: '24h',
      severity: 'warning',
      nextEscalationAt: '2026-10-06T08:59:00.000Z',
    });
    expect(a2.r.alreadyTold).toBeGreaterThanOrEqual(1);

    // 18:00 JST: 5.98 hours left, the 6h stage, critical.
    const b = await at('18:00', '2026-10-06T09:00:00Z');
    expect(b.fresh).toHaveLength(1);
    expect(b.fresh[0]).toMatchObject({
      notifyStage: '6h',
      severity: 'critical',
      nextEscalationAt: '2026-10-06T12:59:00.000Z', // final starts 2 h before
    });
    expect(b.fresh[0]?.quietUntil).toBeUndefined();

    // 21:00 JST: still 6h.
    expect((await at('21:00', '2026-10-06T12:00:00Z')).fresh).toHaveLength(0);

    // 22:05 JST: the final stage.
    const c = await at('22:05', '2026-10-06T13:05:00Z');
    expect(c.fresh).toHaveLength(1);
    expect(c.fresh[0]).toMatchObject({
      notifyStage: 'final',
      severity: 'critical',
      nextEscalationAt: '2026-10-06T14:59:00.000Z',
    });
    expect(c.fresh[0]?.line).toContain('【締切直前】');

    // 23:00 JST: final again (the 1h boundary is inside it): not repeated twice.
    const d = await at('23:00', '2026-10-06T14:00:00Z');
    expect(d.fresh).toHaveLength(0);
    expect(d.pending[0]).toMatchObject({
      notifyStage: 'final',
      nextEscalationAt: '2026-10-06T14:59:00.000Z',
    });

    // 10/7 00:10 JST: overdue, still unsubmitted, late work not ruled out.
    const e = await at('00:10', '2026-10-06T15:10:00Z');
    expect(e.fresh).toHaveLength(1);
    expect(e.fresh[0]).toMatchObject({
      notifyStage: 'overdue',
      severity: 'critical',
      nextEscalationAt: undefined,
    });
    expect(e.fresh[0]?.line).toContain('【締切超過】');
    expect(e.fresh[0]?.recommendedAction).toContain('遅れて提出できるか確認');
    // Eleven minutes after the deadline: within 3 hours, so no quiet period.
    expect(e.fresh[0]?.quietUntil).toBeUndefined();
    expect((await at('00:40', '2026-10-06T15:40:00Z')).fresh).toHaveLength(0);

    expect(seenStages).toEqual(['00:30 24h', '18:00 6h', '22:05 final', '00:10 overdue']);
  });

  it('keeps the same item across stages (attentionId) and counts a client apart from another', async () => {
    await addReport();
    clock.set('2026-10-05T15:30:00Z');
    const first = about(attentionRequired(uc, 'watcher'), 'ER図レポート').fresh[0];
    clock.set('2026-10-06T09:00:00Z');
    const second = about(attentionRequired(uc, 'watcher'), 'ER図レポート').fresh[0];
    expect(second?.attentionId).toBe(first?.attentionId);
    expect(second?.key).not.toBe(first?.key);
    expect(second?.firstSeenAt).toBe('2026-10-05T15:30:00.000Z');
    expect(second?.lastChangedAt).toBe('2026-10-06T09:00:00.000Z');
    // Another client has not been told the 24h stage: it gets the current one only.
    const other = about(attentionRequired(uc, 'other-client'), 'ER図レポート');
    expect(other.fresh.map((i) => i.notifyStage)).toEqual(['6h']);
  });

  it('a dry run records nothing: the stage comes back next time', async () => {
    await addReport();
    clock.set('2026-10-06T09:00:00Z');
    expect(about(attentionRequired(uc, 'w', { dryRun: true }), 'ER図レポート').fresh).toHaveLength(
      1,
    );
    expect(about(attentionRequired(uc, 'w'), 'ER図レポート').fresh).toHaveLength(1);
    expect(about(attentionRequired(uc, 'w'), 'ER図レポート').fresh).toHaveLength(0);
  });

  it('does not flag overdue work once the student has said it is done', async () => {
    await addReport();
    const task = uc.tasks.list().find((t) => t.title.includes('ER図レポート'));
    clock.set('2026-10-06T15:10:00Z');
    expect(about(attentionRequired(uc, 'a', { dryRun: true }), 'ER図レポート').fresh).toHaveLength(
      1,
    );
    await uc.additions.recordTaskProgress(
      { id: 'local:test', name: 'test' },
      { task: task?.id ?? '', status: 'completed', statement: 'ER図レポートは終わった' },
    );
    expect(about(attentionRequired(uc, 'b', { dryRun: true }), 'ER図レポート').fresh).toHaveLength(
      0,
    );
  });

  it('stops flagging overdue work a week after the deadline (the next actions still list it)', async () => {
    await addReport();
    clock.set('2026-10-13T00:00:00Z'); // 10/13 09:00 JST, six days past
    expect(about(attentionRequired(uc, 'a', { dryRun: true }), 'ER図レポート').fresh).toHaveLength(
      1,
    );
    clock.set('2026-10-14T00:00:00Z'); // 10/14 09:00 JST, a week and a day past
    expect(about(attentionRequired(uc, 'b', { dryRun: true }), 'ER図レポート').fresh).toHaveLength(
      0,
    );
  });
});

describe('estimated deadline (推定) follows the same stages', () => {
  it('24h, 6h, final, overdue with the 推定 wording, each once', async () => {
    const stages: string[] = [];
    const at = (iso: string) => {
      clock.set(iso);
      const r = attentionRequired(uc, 'watcher');
      const mine = about(r, '小レポート2');
      for (const i of mine.fresh) stages.push(String(i.notifyStage));
      return mine;
    };
    // The estimate is 10/7 23:59 JST (see next-action.test.ts).
    const a = at('2026-10-06T15:30:00Z'); // 10/7 00:30 JST
    expect(a.fresh[0]).toMatchObject({ severity: 'warning', notifyStage: '24h' });
    expect(a.fresh[0]?.line).toContain('【締切不明・推定】');
    expect(a.fresh[0]?.key).toMatch(/^deadline-estimate:.*:24h$/);
    expect(at('2026-10-06T16:30:00Z').fresh).toHaveLength(0);
    const b = at('2026-10-07T09:00:00Z'); // 18:00
    expect(b.fresh[0]).toMatchObject({ severity: 'critical', notifyStage: '6h' });
    expect(b.fresh[0]?.line).toContain('【締切不明・推定間近】');
    const c = at('2026-10-07T13:05:00Z'); // 22:05
    expect(c.fresh[0]).toMatchObject({ severity: 'critical', notifyStage: 'final' });
    expect(c.fresh[0]?.line).toContain('【締切不明・推定直前】');
    const d = at('2026-10-07T14:00:00Z'); // 23:00
    expect(d.fresh).toHaveLength(0);
    expect(d.pending[0]).toMatchObject({ notifyStage: 'final' });
    const e = at('2026-10-07T15:10:00Z'); // 10/8 00:10
    expect(e.fresh[0]).toMatchObject({ severity: 'critical', notifyStage: 'overdue' });
    expect(e.fresh[0]?.line).toContain('推定を過ぎた可能性');
    expect(at('2026-10-07T16:10:00Z').fresh).toHaveLength(0);
    expect(stages).toEqual(['24h', '6h', 'final', 'overdue']);
  });
});

describe('pending', () => {
  it('lists what is held back, capped, and keeps alreadyTold as a count', async () => {
    clock.set('2026-10-05T10:00:00Z');
    const first = attentionRequired(uc, 'p');
    expect(first.pending).toEqual([]);
    clock.set('2026-10-05T11:00:00Z');
    const second = attentionRequired(uc, 'p');
    expect(second.nothingImportant).toBe(true);
    expect(second.alreadyTold).toBe(second.pending.length);
    expect(second.pending.length).toBeGreaterThan(0);
    expect(second.pending.length).toBeLessThanOrEqual(20);
    expect(second.pending[0]).toMatchObject({
      attentionId: expect.stringMatching(/^attention:/),
      severity: 'warning',
      notifyStage: '24h',
    });
  });
});
