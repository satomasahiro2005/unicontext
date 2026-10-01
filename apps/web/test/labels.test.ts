import { describe, expect, it } from 'vitest';
import {
  changeTypeLabel,
  countUnhealthy,
  entityKindLabel,
  fieldLabel,
  GRADE_OUTCOME_ORDER,
  gradeOutcomeLabel,
  gradeOutcomeTone,
  healthLabel,
  healthSeverity,
  healthTone,
  isUnhealthy,
  needsLoginCommand,
  notificationKindLabel,
  originLabel,
  scheduleTypeLabel,
  taskStatusLabel,
} from '../src/lib/labels.js';

describe('connector health labels', () => {
  it('maps every health state to a Japanese label and a tone', () => {
    const states = ['healthy', 'degraded', 'auth_required', 'rate_limited', 'offline', 'failed'];
    const labels = states.map(healthLabel);
    expect(new Set(labels).size).toBe(states.length);
    expect(healthLabel('healthy')).toBe('正常');
    expect(healthLabel('auth_required')).toBe('要ログイン');
    expect(healthTone('healthy')).toBe('ok');
    expect(healthTone('degraded')).toBe('warn');
    expect(healthTone('failed')).toBe('bad');
  });

  it('falls back to the raw value for unknown states', () => {
    expect(healthLabel('mystery')).toBe('mystery');
    expect(healthTone('mystery')).toBe('muted');
  });

  it('flags only states that need attention', () => {
    expect(isUnhealthy('healthy')).toBe(false);
    expect(isUnhealthy('unknown')).toBe(false);
    expect(isUnhealthy('rate_limited')).toBe(true);
    expect(isUnhealthy('failed')).toBe(true);
    expect(
      countUnhealthy([{ state: 'healthy' }, { state: 'offline' }, { state: 'degraded' }]),
    ).toBe(2);
  });

  it('shows the login command for auth_required and failed only', () => {
    expect(needsLoginCommand('auth_required')).toBe(true);
    expect(needsLoginCommand('failed')).toBe(true);
    expect(needsLoginCommand('degraded')).toBe(false);
    expect(needsLoginCommand('healthy')).toBe(false);
  });

  it('orders failures above warnings', () => {
    expect(healthSeverity('failed')).toBeGreaterThan(healthSeverity('degraded'));
    expect(healthSeverity('healthy')).toBe(0);
  });
});

describe('other labels', () => {
  it('labels entity kinds, change types, fields, origins and task statuses', () => {
    expect(entityKindLabel('assignment')).toBe('課題');
    expect(entityKindLabel('changeEvent')).toBe('変更');
    expect(changeTypeLabel('created')).toBe('追加');
    expect(changeTypeLabel('conflict_detected')).toBe('競合を検出');
    expect(fieldLabel('dueAt')).toBe('締切');
    expect(fieldLabel('someNewField')).toBe('someNewField');
    expect(originLabel('extracted')).toBe('抽出');
    expect(taskStatusLabel('pending')).toBe('未提出');
    expect(notificationKindLabel('room_change')).toBe('教室変更');
    expect(notificationKindLabel('pace_behind')).toBe('ペースの遅れ');
    expect(notificationKindLabel('future_kind')).toBe('future_kind');
    expect(scheduleTypeLabel('unscheduled')).toBe('時間割外');
    expect(scheduleTypeLabel('intensive')).toBe('集中講義');
    expect(scheduleTypeLabel('regular')).toBe('時間割');
  });
});

describe('grade outcome labels', () => {
  it('labels and colours every outcome, falling back to the raw value', () => {
    expect(GRADE_OUTCOME_ORDER).toEqual([
      'passed',
      'failed',
      'in_progress',
      'not_graded',
      'withdrawn',
      'transferred',
      'unknown',
    ]);
    expect(GRADE_OUTCOME_ORDER.map(gradeOutcomeLabel)).toEqual([
      '合格',
      '不合格',
      '履修中',
      '未評価',
      '放棄・取消',
      '認定',
      '不明',
    ]);
    expect(gradeOutcomeTone('passed')).toBe('ok');
    expect(gradeOutcomeTone('transferred')).toBe('ok');
    expect(gradeOutcomeTone('failed')).toBe('bad');
    expect(gradeOutcomeTone('in_progress')).toBe('info');
    expect(gradeOutcomeTone('unknown')).toBe('warn');
    expect(gradeOutcomeLabel('something')).toBe('something');
  });
});
