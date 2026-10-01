import { stableId } from '@unicontext/canonical-model';
import { ManualClock, NotFoundError, ValidationError } from '@unicontext/core';
import { createFakeConnector } from '@unicontext/connector-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTEXT_VIEWS,
  ContextViewParams,
  createUniContext,
  getView,
  isContextViewName,
  type UniContext,
} from '../src/index.js';

let uc: UniContext;
const clock = new ManualClock('2026-10-01T00:00:00Z');

beforeEach(async () => {
  uc = createUniContext({ profile: 'shizuoka-university', clock });
  const fake = createFakeConnector({
    product: 'lcu',
    sourceLabel: '学務情報システム',
    authority: 'academic-system',
    dataset: {
      courses: [
        {
          id: 'c1',
          title: 'データベースシステム論',
          year: 2026,
          schedule: [{ day: 4, period: 2, room: '21教室' }],
        },
      ],
      sessions: [
        { id: 's1', courseId: 'c1', date: '2026-10-01', period: 2, room: '21教室' },
        {
          id: 's2',
          courseId: 'c1',
          date: '2026-10-01',
          period: 5,
          room: '21教室',
          status: 'cancelled',
        },
      ],
    },
  });
  uc.sync.register({
    sourceId: 'lcu',
    adapter: fake.adapter,
    normalizer: fake.normalizer,
    metadata: fake.metadata,
  });
  await uc.sync.sync('lcu');
});
afterEach(async () => uc.close());

describe('context views', () => {
  it('lists the ten built-in views with params', () => {
    expect(CONTEXT_VIEWS.map((v) => v.name)).toEqual([
      'today',
      'tomorrow',
      'week',
      'course',
      'deadline',
      'changes',
      'class-preparation',
      'class-review',
      'exam-preparation',
      'admin',
    ]);
    expect(Object.keys(ContextViewParams)).toHaveLength(10);
    expect(isContextViewName('today')).toBe(true);
    expect(isContextViewName('grades')).toBe(false);
  });

  it('validates parameters and reports missing courses', () => {
    expect(() => getView(uc.context, 'course', {})).toThrow(ValidationError);
    expect(() => getView(uc.context, 'today', { extra: 1 })).toThrow(ValidationError);
    expect(() => uc.context.course('courseOffering:missing')).toThrow(NotFoundError);
  });

  it('marks cancelled classes and does not prepare for them', () => {
    const today = uc.context.today();
    expect(today.classes.map((c) => [c.period, c.cancelled])).toEqual([
      [2, false],
      [5, true],
    ]);
    expect(today.classes[1]?.summary).toContain('休講');
    expect(today.preparation).toHaveLength(1);
    expect(today.classes[0]?.room).toMatchObject({
      status: 'resolved',
      value: '21教室',
      origin: 'authoritative',
    });
    expect(today.classes[0]?.citations[0]?.label).toBe('学務情報システム 10/1 09:00取得');
  });

  it('prepares the next class and returns empty bundles gracefully', () => {
    const prep = uc.context.classPreparation({
      courseOfferingId: stableId('courseOffering', 'lcu', 'c1'),
    });
    expect(prep.session?.period).toBe(2);
    expect(prep.previousLecture).toBeUndefined();
    expect(uc.context.lecture({ lectureId: 'lecture:none' })).toBeUndefined();
    expect(uc.context.examPreparation().exams).toEqual([]);
    expect(uc.context.deadline()).toMatchObject({ overdue: [], upcoming: [] });
  });
});
