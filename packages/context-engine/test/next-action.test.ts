import { ManualClock } from '@unicontext/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  attentionRequired,
  briefing,
  classifyWork,
  DEFAULT_EFFORT_MINUTES,
  freeMinutes,
  studentState,
  type UniContext,
} from '../src/index.js';
import { circuit, createNextActionScenario, NOW } from './next-action-scenario.js';

let uc: UniContext;
let clock: ManualClock;

beforeEach(async () => {
  ({ uc, clock } = await createNextActionScenario());
});

afterEach(async () => {
  await uc.close();
});

describe('nextActions', () => {
  it('puts the unsubmitted Ed lesson due tomorrow 17:00 first, with a startable step', () => {
    const r = uc.context.nextActions();
    expect(r.top?.title).toBe('Lesson 3: SQL演習');
    expect(r.top?.kind).toBe('assignment');
    expect(r.top?.what).toBe('Lesson 3: SQL演習: 課題を開いて問題を確認する（10分）');
    expect(r.top?.why).toContain('締切まで31時間');
    expect(r.top?.why).toContain('未提出');
    expect(r.top?.dueText).toBe('10/6 17:00');
    expect(r.top?.course?.title).toBe('データベース');
    expect(r.top?.link).toEqual({
      url: 'https://edstem.org/au/courses/1/lessons/lesson3',
      label: 'EdStem',
    });
    expect(r.top?.effort).toMatchObject({ stepMinutes: 10, totalMinutes: 60, basis: 'default' });
    expect(r.top?.citations.length).toBeGreaterThan(0);
    expect(r.line).toBe(`今やること: ${r.top?.what}（${r.top?.why}）`);
    expect(r.urgent).toBe(true);
    expect(r.coverage.trusted).toBe(true);
  });

  it('ranks the unknown-due report as possibly urgent, then tomorrow’s class prep, then the far report', () => {
    const r = uc.context.nextActions({ count: 5 });
    const ids = r.next.map((a) => a.kind);
    expect(ids.slice(0, 3)).toEqual(['check_deadline', 'prep', 'assignment']);
    const [unknown, prep, far] = r.next;
    expect(unknown?.what).toBe('小レポート2: EdStemの課題ページで締切と内容を確認する（5分）');
    // Unknown, so estimated early from 小レポート1 (due 10/7 23:59, given in the 10/2 class).
    expect(unknown?.dueText).toBe('締切不明（推定10/7 23:59）');
    expect(unknown?.dueAt).toBeUndefined();
    expect(unknown?.why).toContain('締切不明・推定10/7 23:59（あと2日）');
    expect(unknown?.reasons).toEqual(expect.arrayContaining(['unknown_due', 'estimated_due']));
    expect(unknown?.estimatedDue).toMatchObject({
      label: '推定',
      method: 'series',
      confidence: 'medium',
      at: '2026-10-07T14:59:00.000Z',
      latest: '2026-10-14T14:59:00.000Z',
      checkWhere: 'EdStemの課題ページ',
    });
    expect(unknown?.estimatedDue?.basis).toContain('小レポート1');
    expect(prep?.what).toBe('明日のネットワーク: 資料「第2回スライド」を開いて目を通す（15分）');
    expect(prep?.why).toBe('明日10:20の授業の準備');
    expect(prep?.link?.url).toBe('https://edstem.org/au/courses/2/resources/2');
    expect(far?.title).toBe('実験レポート: 回路設計');
    expect(far?.workLabel).toBe('実験レポート');
    expect(far?.what).toBe('実験レポート: 回路設計: 実験データとテンプレートを開く（10分）');
    expect(far?.effort.totalMinutes).toBe(360);
    expect(far?.steps).toHaveLength(5);
    expect(far?.freeHoursBeforeDue).toBeGreaterThan(100);
  });

  it('leaves out submitted work and courses the student dropped', () => {
    const r = uc.context.nextActions({ count: 10 });
    const titles = [r.top, ...r.next].map((a) => a?.title);
    expect(titles).not.toContain('小レポート1');
    expect(titles).not.toContain('古い課題');
    expect(r.dueSoon.map((d) => d.title)).toEqual(['Lesson 3: SQL演習', '小レポート2']);
    // The unknown one is there by its estimate, marked as such.
    expect(r.dueSoon[0]?.estimated).toBeUndefined();
    expect(r.dueSoon[1]).toMatchObject({ dueText: '推定10/7 23:59', unsubmitted: true });
    expect(r.dueSoon[1]?.estimated?.label).toBe('推定');
  });

  it('is deterministic and embedded compactly in today / week', () => {
    const a = uc.context.nextActions();
    const b = uc.context.nextActions();
    expect(b).toEqual(a);
    const today = uc.context.today();
    expect(today.next?.top?.id).toBe(a.top?.id);
    expect(today.next?.then).toHaveLength(3);
    expect(today.next?.urgent).toBe(true);
    expect(uc.context.week().next?.line).toBe(a.line);
  });

  it('says to check EdStem first when its login expired (deadlines cannot be trusted)', () => {
    uc.sync.stores.health.set('edstem', {
      state: 'auth_required',
      checkedAt: NOW,
      lastSuccessAt: '2026-10-01T00:00:00.000Z',
    });
    const r = uc.context.nextActions();
    expect(r.top?.kind).toBe('coverage');
    expect(r.top?.what).toBe('EdStemの課題一覧を開いて、締切が漏れていないか確認する（5分）');
    expect(r.top?.link?.url).toBe('https://edstem.org');
    expect(r.coverage.trusted).toBe(false);
    expect(r.next[0]?.title).toBe('Lesson 3: SQL演習');
  });

  it('says to go to class shortly before it starts', () => {
    clock.set('2026-10-05T05:05:00.000Z'); // 14:05, データベース 4限 at 14:25
    const r = uc.context.nextActions();
    expect(r.top?.kind).toBe('attend');
    expect(r.top?.what).toBe('4限 データベースに出る（14:25〜・データベース教室）');
    expect(r.top?.why).toBe('あと20分で始まる');
  });

  it('accepts effort overrides per kind and restricts to one course', () => {
    const r = uc.context.nextActions({
      courseOfferingId: circuit,
      effortMinutes: { lab_report: 600 },
    });
    expect(r.top?.title).toBe('実験レポート: 回路設計');
    expect(r.top?.effort).toMatchObject({ totalMinutes: 600, basis: 'override' });
    expect(r.next).toEqual([]);
  });

  it('treats an overdue assignment as possibly still accepted', () => {
    clock.set('2026-10-06T10:00:00.000Z'); // the lesson closed 2 hours ago
    const r = uc.context.nextActions({ count: 5 });
    const late = [r.top, ...r.next].find((a) => a?.title === 'Lesson 3: SQL演習');
    expect(late?.kind).toBe('check_late');
    expect(late?.what).toBe(
      'Lesson 3: SQL演習: 課題ページを開いて、遅れて提出できるか確認する（5分）',
    );
    expect(late?.why).toContain('期限切れ（2時間前）');
  });
});

describe('effort model', () => {
  it('classifies by title and kind with simple defaults', () => {
    const t = (title: string, taskKind = 'assignment') =>
      classifyWork({ title, taskKind: taskKind as 'assignment' });
    expect(t('第3回 小テスト')).toBe('quiz');
    expect(t('小レポート1')).toBe('short_report');
    expect(t('期末レポート')).toBe('report');
    expect(t('実験レポート 第2回')).toBe('lab_report');
    expect(t('演習問題3')).toBe('exercise');
    expect(t('試験準備: 期末試験', 'exam_preparation')).toBe('exam_study');
    expect(DEFAULT_EFFORT_MINUTES).toMatchObject({
      quiz: 20,
      short_report: 60,
      report: 180,
      lab_report: 360,
      exam_study: 480,
    });
  });

  it('counts free awake time outside classes', () => {
    const from = new Date('2026-10-05T00:30:00.000Z'); // Mon 09:30
    const to = new Date('2026-10-06T08:00:00.000Z'); // Tue 17:00
    expect(freeMinutes(from, to, [], 'Asia/Tokyo')).toBe(14.5 * 60 + 9 * 60);
    const busy = [
      { start: Date.parse('2026-10-05T05:25:00Z'), end: Date.parse('2026-10-05T06:55:00Z') },
    ];
    expect(freeMinutes(from, to, busy, 'Asia/Tokyo')).toBe(14.5 * 60 + 9 * 60 - 90);
  });
});

describe('student state, attention and briefing', () => {
  it('returns one compact snapshot with the suggestion', () => {
    const s = studentState(uc);
    expect(JSON.stringify(s).length).toBeLessThan(30_000);
    expect(s.today.classes.map((c) => c.course)).toEqual(['データベース']);
    expect(s.tomorrow.classes.map((c) => c.course)).toEqual(['ネットワーク']);
    expect(s.nextClass?.course).toBe('データベース');
    // The unknown due date sorts by its estimate (10/7), not last.
    expect(s.assignments.map((a) => a.title)).toEqual([
      'Lesson 3: SQL演習',
      '小レポート2',
      '実験レポート: 回路設計',
    ]);
    expect(s.assignments[1]).toMatchObject({
      dueAt: undefined,
      dueText: '締切不明（推定10/7 23:59）',
      estimatedDue: { label: '推定', at: '2026-10-07T14:59:00.000Z' },
    });
    expect(s.assignments[0]).toMatchObject({ submission: 'not_submitted', effortMinutes: 60 });
    expect(s.suggestion.top?.title).toBe('Lesson 3: SQL演習');
  });

  it('tells each client once, again only when the severity rises', () => {
    clock.set('2026-10-05T10:00:00.000Z'); // 19:00, the lesson is due in 22 hours
    const first = attentionRequired(uc, 'chatgpt-a');
    expect(first.nothingImportant).toBe(false);
    expect(first.items.map((i) => [i.kind, i.severity])).toEqual([['deadline', 'warning']]);
    expect(first.text).toBe(
      '【締切】データベース「Lesson 3: SQL演習」が未提出です。締切10/6 17:00（あと22時間）',
    );
    expect(first.text.length).toBeLessThanOrEqual(300);

    clock.set('2026-10-05T11:00:00.000Z');
    const second = attentionRequired(uc, 'chatgpt-a');
    expect(second.nothingImportant).toBe(true);
    expect(second.text).toBe('');
    expect(second.alreadyTold).toBe(1);
    // Another client has not been told yet.
    expect(attentionRequired(uc, 'claude-b').nothingImportant).toBe(false);

    clock.set('2026-10-06T03:00:00.000Z'); // 12:00, 5 hours left
    const third = attentionRequired(uc, 'chatgpt-a');
    expect(third.items.map((i) => [i.kind, i.severity])).toEqual([['deadline', 'critical']]);
    expect(third.text).toContain('【締切間近】');
  });

  it('gives every item a stable id, when it was first seen and changed, and what comes next', () => {
    clock.set('2026-10-05T10:00:00.000Z'); // the lesson is due in 22 hours
    const [first] = attentionRequired(uc, 'chatgpt-a').items;
    expect(first?.attentionId).toMatch(/^attention:[0-9a-f]{24}$/);
    expect(first?.firstSeenAt).toBe('2026-10-05T10:00:00.000Z');
    expect(first?.lastChangedAt).toBe('2026-10-05T10:00:00.000Z');
    // Becomes critical 6 hours before the deadline (10/6 17:00 JST).
    expect(first?.nextEscalationAt).toBe('2026-10-06T02:00:00.000Z');
    expect(first?.recommendedAction).toBe(
      '「Lesson 3: SQL演習」をEdStemで提出する（締切10/6 17:00）',
    );
    expect(first?.sourceHealth.map((h) => h.sourceId)).toContain('edstem');

    clock.set('2026-10-06T03:00:00.000Z'); // 5 hours left: critical
    const [later] = attentionRequired(uc, 'chatgpt-a').items;
    expect(later?.attentionId).toBe(first?.attentionId);
    expect(later?.firstSeenAt).toBe('2026-10-05T10:00:00.000Z');
    expect(later?.lastChangedAt).toBe('2026-10-06T03:00:00.000Z');
    // The final stage starts two hours before the deadline (10/6 17:00 JST).
    expect(later?.nextEscalationAt).toBe('2026-10-06T06:00:00.000Z');
    // Another client sees the same id.
    const [other] = attentionRequired(uc, 'claude-b', { dryRun: true }).items;
    expect(other?.attentionId).toBe(first?.attentionId);
  });

  it('warns about a class starting within the hour, with its room', () => {
    clock.set('2026-10-06T00:50:00.000Z'); // Tue 09:50, ネットワーク 2限 10:20
    const r = attentionRequired(uc, 'watcher', { dryRun: true });
    const cls = r.items.find((i) => i.kind === 'class_soon');
    expect(cls?.line).toBe('【もうすぐ授業】10:20から2限 ネットワーク（ネットワーク教室）');
    expect(r.recorded).toBe(false);
    expect(attentionRequired(uc, 'watcher').items.some((i) => i.kind === 'class_soon')).toBe(true);
  });

  it('writes a morning briefing that is never empty on a class day', () => {
    const b = briefing(uc, 'chatgpt-a');
    expect(b.kind).toBe('morning');
    expect(b.nothingImportant).toBe(false);
    expect(b.text).toContain('今日の授業: 4限 データベース（データベース教室）');
    expect(b.text).toContain('まずこれ: Lesson 3: SQL演習: 課題を開いて問題を確認する（10分）');
    expect(b.text).toContain('72時間以内の未提出: Lesson 3: SQL演習（10/6 17:00）');
    expect(b.text.length).toBeLessThanOrEqual(300);
  });
});

describe('unknown deadlines: early estimates (推定)', () => {
  it('ranks an item by its estimate: an estimate a few hours away comes first', () => {
    clock.set('2026-10-07T12:00:00.000Z'); // Wed 21:00, 小レポート2 estimated 10/7 23:59
    const r = uc.context.nextActions();
    expect(r.top?.kind).toBe('check_deadline');
    expect(r.top?.title).toBe('小レポート2');
    expect(r.top?.why).toContain('締切不明・推定10/7 23:59（あと2時間）');
    expect(r.urgent).toBe(true);
  });

  it('alerts on the estimate with 推定 wording and escalates like a deadline', () => {
    clock.set('2026-10-07T01:00:00.000Z'); // Wed 10:00, 14 hours before the estimate
    const first = attentionRequired(uc, 'watcher').items.filter((i) =>
      i.key.startsWith('deadline-estimate:'),
    );
    expect(first.map((i) => i.severity)).toEqual(['warning']);
    expect(first[0]?.line).toBe(
      '【締切不明・推定】情報倫理「小レポート2」は締切が分かりません。推定10/7 23:59（あと14時間・これまでの例から）。EdStemの課題ページで確認',
    );
    expect(first[0]?.recommendedAction).toContain('推定10/7 23:59');
    expect(first[0]?.nextEscalationAt).toBe('2026-10-07T08:59:00.000Z');

    clock.set('2026-10-07T10:00:00.000Z'); // 19:00, 5 hours before
    const second = attentionRequired(uc, 'watcher').items.filter((i) =>
      i.key.startsWith('deadline-estimate:'),
    );
    expect(second.map((i) => i.severity)).toEqual(['critical']);
    expect(second[0]?.line).toContain('【締切不明・推定間近】');
  });

  it('lists estimates apart from stated deadlines, in deadlines, coverage and tasks', () => {
    const d = uc.context.deadline();
    expect(d.upcoming.map((x) => x.title)).not.toContain('小レポート2');
    expect(d.estimated.map((x) => x.title)).toEqual(['小レポート2']);
    expect(d.estimated[0]?.summary).toMatch(
      /^【推定】情報倫理: 小レポート2 締切不明・推定 10\/7 23:59〜10\/14 23:59（/,
    );
    expect(d.estimated[0]?.hoursLeft).toBeCloseTo(62.5, 1);
    const gap = uc.context.deadlineCoverage().gaps.find((g) => g.kind === 'unknown_due');
    expect(gap?.kind === 'unknown_due' && gap.items[0]?.estimatedDue?.at).toBe(
      '2026-10-07T14:59:00.000Z',
    );
    expect(gap?.detail).toContain('最も早い推定は10/7 23:59');
    expect(gap?.detail).toContain('推定は確定した締切ではありません');
    const task = uc.context.today().tasks.find((t) => t.title === '小レポート2');
    expect(task?.dueAt).toBeUndefined();
    expect(task?.estimatedDue?.label).toBe('推定');
  });

  it('puts estimates due within 72 hours in the briefing, marked 推定', () => {
    const b = briefing(uc, 'chatgpt-a', { dryRun: true });
    expect(b.text).toContain('締切不明（早めの推定）: 小レポート2（推定10/7 23:59）');
    expect(b.text.length).toBeLessThanOrEqual(300);
  });
});
