import { describe, expect, it } from 'vitest';
import {
  classifyGradeLabel,
  GRADE_OUTCOME_LABELS,
  GRADE_OUTCOMES,
  isEarnedOutcome,
  isGradeOutcome,
  isReexamLabel,
} from '../src/index.js';

describe('grade outcomes', () => {
  it('classifies the labels of Japanese grading systems', () => {
    const cases: [string | undefined, string][] = [
      ['秀', 'passed'],
      ['優', 'passed'],
      ['良', 'passed'],
      ['可', 'passed'],
      ['合', 'passed'],
      ['合格', 'passed'],
      ['Ａ', 'passed'], // full-width letters are normalized
      ['不可', 'failed'],
      ['否', 'failed'],
      ['不合格', 'failed'],
      ['F', 'failed'],
      ['認定', 'transferred'],
      ['単位認定', 'transferred'],
      ['履修中', 'in_progress'],
      ['未評価', 'not_graded'],
      ['評価なし', 'not_graded'],
      ['保留', 'not_graded'],
      ['再試', 'not_graded'],
      ['放棄', 'withdrawn'],
      ['欠席', 'withdrawn'],
      ['取消', 'withdrawn'],
      [' 秀 ', 'passed'],
      ['', 'in_progress'],
      [undefined, 'in_progress'],
    ];
    for (const [label, outcome] of cases)
      expect([label, classifyGradeLabel(label)]).toEqual([label, outcome]);
  });

  it('never guesses: unknown labels stay unknown', () => {
    for (const label of ['D', 'X', '評価保留中', '秀?', 'P*'])
      expect(classifyGradeLabel(label)).toBe('unknown');
    expect(classifyGradeLabel('', { emptyAs: 'unknown' })).toBe('unknown');
  });

  it('only passed and transferred are earned; labels exist for every outcome', () => {
    expect(GRADE_OUTCOMES.filter(isEarnedOutcome)).toEqual(['passed', 'transferred']);
    for (const o of GRADE_OUTCOMES) expect(GRADE_OUTCOME_LABELS[o]).toBeTruthy();
    expect(isGradeOutcome('failed')).toBe(true);
    expect(isGradeOutcome('pass')).toBe(false);
    expect(isReexamLabel('再試')).toBe(true);
    expect(isReexamLabel('不可')).toBe(false);
  });
});
