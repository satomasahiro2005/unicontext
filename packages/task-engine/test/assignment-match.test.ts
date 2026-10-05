import { describe, expect, it } from 'vitest';
import { itemKeys, matchAssignment, notesAsDetails } from '../src/assignment-match.js';

const ED = {
  id: 'assignment:ed-1',
  title: '当日課題 (小レポート1)',
  dueAt: '2026-10-06T08:00:00.000Z',
  appearedAt: ['2026-10-01T03:00:00.000Z'],
};
const LECTURE = '2026-10-01T03:00:00.000Z';

describe('itemKeys', () => {
  it('reads numbered items across spellings', () => {
    expect(itemKeys('当日課題 (小レポート1)')).toEqual([{ family: 'report', n: 1 }]);
    expect(itemKeys('レポート1：レンタル店のER図を作成する')).toEqual([{ family: 'report', n: 1 }]);
    expect(itemKeys('Report 1')).toEqual([{ family: 'report', n: 1 }]);
    expect(itemKeys('課題３')).toEqual([{ family: 'assignment', n: 3 }]);
    expect(itemKeys('ER図を作る')).toEqual([]);
  });
});

describe('matchAssignment', () => {
  it('links レポート1 told after the 10/1 class to Ed’s 当日課題 (小レポート1)', () => {
    const m = matchAssignment(
      { title: 'レポート1：レンタル店のER図を作成する', referenceAt: LECTURE },
      [ED],
    );
    expect(m).toMatchObject({ assignmentId: 'assignment:ed-1', level: 'linked' });
    expect(m?.score).toBeGreaterThanOrEqual(0.8);
  });

  it('never matches another number', () => {
    expect(matchAssignment({ title: 'レポート2', referenceAt: LECTURE }, [ED])).toBeUndefined();
    expect(matchAssignment({ title: '小レポート10', referenceAt: LECTURE }, [ED])).toBeUndefined();
  });

  it('does not link an item that closed long before the lecture (last year’s)', () => {
    const old = { ...ED, id: 'assignment:old', dueAt: '2025-10-07T08:00:00.000Z', appearedAt: [] };
    expect(matchAssignment({ title: 'レポート1', referenceAt: LECTURE }, [old])).toBeUndefined();
  });

  it('is only a candidate on a weak title, and when two items are equally good', () => {
    expect(matchAssignment({ title: 'ER図のレポート', referenceAt: LECTURE }, [ED])).toMatchObject({
      level: 'candidate',
    });
    const twin = { ...ED, id: 'assignment:ed-2', title: 'レポート1（再提出）' };
    expect(matchAssignment({ title: 'レポート1', referenceAt: LECTURE }, [ED, twin])).toMatchObject(
      {
        level: 'candidate',
      },
    );
  });

  it('uses the description: shared content words count', () => {
    const described = { ...ED, title: '第1回課題', description: 'レンタル店のER図を作成し提出' };
    const m = matchAssignment(
      { title: 'レンタル店のER図', texts: ['レンタル店の業務'], referenceAt: LECTURE },
      [described],
    );
    expect(m).toMatchObject({ level: 'candidate' });
    expect(m?.reasons.join()).toContain('レンタル');
  });
});

describe('notesAsDetails', () => {
  it('drops sentences that only say the deadline is unknown', () => {
    expect(notesAsDetails('ER図を作成する。提出期限は現時点で未確認。')).toBe('ER図を作成する。');
    expect(notesAsDetails('締切は不明')).toBeUndefined();
  });
});
