import type { UniContext } from '@unicontext/context-engine';
import type { ManualClock } from '@unicontext/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNextActionScenario } from '../../context-engine/test/next-action-scenario.js';
import { type Notification, NotificationService } from '../src/index.js';

let uc: UniContext;
let clock: ManualClock;

beforeEach(async () => {
  const s = await createNextActionScenario();
  // The scenario is built from the context-engine sources; this package type-checks against dist.
  uc = s.uc as unknown as UniContext;
  clock = s.clock;
});

afterEach(async () => {
  await uc.close();
});

function memorySink(): { id: string; sent: Notification[]; send(n: Notification): void } {
  const sent: Notification[] = [];
  return { id: 'memory', sent, send: (n) => void sent.push(n) };
}

describe('next-action notifications', () => {
  it('sends the morning digest once and escalates the unsubmitted lesson by window', async () => {
    const sink = memorySink();
    const svc = new NotificationService({
      uc,
      sinks: [sink],
      morningDigestAt: '08:00',
      escalationLeadTimes: ['72h', '24h', '6h'],
    });
    const first = await svc.checkDeadlines();
    expect(first.map((n) => n.kind).sort()).toEqual(['deadline_escalation', 'next_action_digest']);
    const digest = first.find((n) => n.kind === 'next_action_digest');
    expect(digest?.title).toBe('今日やること（10月5日(月)）');
    expect(digest?.body).toContain(
      'まずこれ: Lesson 3: SQL演習: 課題を開いて問題を確認する（10分）',
    );
    expect(digest?.body).toContain('72時間以内: Lesson 3: SQL演習（10/6 17:00・未提出）');
    expect(digest?.priority).toBe('high');
    const esc = first.find((n) => n.kind === 'deadline_escalation');
    expect(esc?.priority).toBe('normal');
    expect(esc?.body).toContain('まずこれ: Lesson 3: SQL演習: 課題を開いて問題を確認する（10分）');

    expect(await svc.checkDeadlines()).toEqual([]);

    clock.set('2026-10-05T10:00:00.000Z'); // 19:00, 22 hours left
    const second = await svc.checkDeadlines();
    expect(second.map((n) => [n.kind, n.priority])).toEqual([['deadline_escalation', 'high']]);
    expect(second[0]?.title).toBe('未提出・締切まであと約22時間: Lesson 3: SQL演習');

    clock.set('2026-10-06T03:30:00.000Z'); // 12:30, 4.5 hours left
    const third = await svc.checkDeadlines();
    expect(third.map((n) => [n.kind, n.priority])).toEqual([['deadline_escalation', 'critical']]);
    expect(sink.sent).toHaveLength(4);
  });

  it('builds the digest object without sending it', () => {
    const svc = new NotificationService({ uc, sinks: [] });
    const d = svc.morningDigest();
    expect(d.kind).toBe('next_action_digest');
    expect(d.dedupeKey).toBe('next_action_digest:2026-10-05');
    expect(d.body.length).toBeLessThanOrEqual(301);
    expect(svc.list()).toEqual([]);
  });

  it('stays off unless configured', async () => {
    const svc = new NotificationService({ uc, sinks: [] });
    const out = await svc.checkDeadlines();
    expect(
      out.filter((n) => n.kind === 'next_action_digest' || n.kind === 'deadline_escalation'),
    ).toEqual([]);
  });
});
