import { type CourseOffering, stableId } from '@unicontext/canonical-model';
import { describe, expect, it } from 'vitest';
import { resolveCourse } from '../src/courses.js';
import { createSeeded } from './seeded.js';

const offering = (source: string, key: string, o: Partial<CourseOffering>): CourseOffering => ({
  id: stableId('courseOffering', source, key),
  kind: 'courseOffering',
  title: 'x',
  instructorIds: [],
  instructorNames: [],
  schedule: [],
  ...o,
});

describe('resolveCourse by title', () => {
  it('prefers the course the student takes over a same-titled past or catalog offering', async () => {
    const { uc } = await createSeeded();
    const entities = uc.sync.stores.entities;
    const mine = resolveCourse(uc, 'データベースシステム論').ref;
    const me = stableId('person', 'lcu', 'me');
    entities.upsert({ id: me, kind: 'person', name: '本人', isSelf: true } as never, {
      sourceId: 'lcu',
    });
    entities.upsert(
      {
        id: stableId('enrollment', 'lcu', 'db'),
        kind: 'enrollment',
        personId: me,
        courseOfferingId: mine.id,
        role: 'student',
        status: 'active',
      } as never,
      { sourceId: 'lcu' },
    );
    expect(uc.context.enrollmentOf(mine.id).enrolled).toBe(true);
    // last year's Ed course of the same name stays a separate offering
    entities.upsert(
      offering('edstem', '28169', {
        title: 'データベースシステム論',
        courseCode: 'db2025',
        academicYear: 2025,
      }),
      { sourceId: 'edstem' },
    );
    expect(resolveCourse(uc, 'データベースシステム論').ref.id).toBe(mine.id);

    // two offerings nobody is enrolled in stay ambiguous
    for (const key of ['a', 'b'])
      entities.upsert(offering('edstem', key, { title: '量子情報特論', academicYear: 2026 }), {
        sourceId: 'edstem',
      });
    expect(() => resolveCourse(uc, '量子情報特論')).toThrow(/ambiguous/);
    await uc.close();
  });
});
