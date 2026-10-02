import { describe, expect, it } from 'vitest';
import { formatDateTimeYear } from '../src/lib/dates.js';
import { submissionStatusLabel, submissionStatusTone } from '../src/lib/labels.js';
import { groupByChannel, groupByFolder } from '../src/lib/text.js';

describe('submission status labels', () => {
  it('uses Japanese labels and lets unknown values pass through', () => {
    const statuses = ['not_submitted', 'submitted', 'late', 'graded', 'returned'];
    expect(statuses.map(submissionStatusLabel)).toEqual([
      '未提出',
      '提出済み',
      '遅れて提出',
      '採点済み',
      '返却済み',
    ]);
    expect(submissionStatusLabel('weird')).toBe('weird');
    expect(submissionStatusTone('returned')).toBe('ok');
    expect(submissionStatusTone('late')).toBe('warn');
    expect(submissionStatusTone('not_submitted')).toBe('info');
  });
});

describe('formatDateTimeYear', () => {
  it('always shows the year, with the time for instants', () => {
    expect(formatDateTimeYear('2026-10-10T14:59:00.000Z', 'Asia/Tokyo')).toBe('2026/10/10 23:59');
    expect(formatDateTimeYear('2027-01-05', 'Asia/Tokyo')).toBe('2027/1/5');
    expect(formatDateTimeYear(undefined)).toBe('');
    expect(formatDateTimeYear('not a date')).toBe('');
  });
});

describe('Teams grouping helpers', () => {
  it('groups files by folder in first-seen order', () => {
    const groups = groupByFolder([
      { folder: '', n: 1 },
      { folder: 'a', n: 2 },
      { folder: 'a', n: 3 },
      { folder: 'b', n: 4 },
    ]);
    expect(groups.map((g) => [g.folder, g.items.map((i) => i.n)])).toEqual([
      ['', [1]],
      ['a', [2, 3]],
      ['b', [4]],
    ]);
  });

  it('groups posts by channel and puts posts without one last', () => {
    const groups = groupByChannel([
      { channel: undefined, n: 1 },
      { channel: '一般', n: 2 },
      { channel: '課題', n: 3 },
      { channel: '一般', n: 4 },
    ]);
    expect(groups.map((g) => [g.channel, g.items.map((i) => i.n)])).toEqual([
      ['一般', [2, 4]],
      ['課題', [3]],
      [undefined, [1]],
    ]);
  });
});
