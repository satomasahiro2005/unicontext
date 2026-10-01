import { type CourseOffering, stableId } from '@unicontext/canonical-model';
import { ManualClock } from '@unicontext/core';
import { EntityStore, openDatabase } from '@unicontext/database';
import { describe, expect, it } from 'vitest';
import {
  extractYear,
  IdentityResolver,
  normalizeCourseTitle,
  normalizeTerm,
  personNamesMatch,
  scoreOfferingMatch,
  titleSimilarity,
  toCandidate,
} from '../src/index.js';

describe('title normalization (§14)', () => {
  it('maps the spec example to one key', () => {
    expect(normalizeCourseTitle('データベースシステム論')).toBe('dbsys');
    expect(normalizeCourseTitle('2026 DB Systems')).toBe('dbsys');
    expect(normalizeCourseTitle('DBSys')).toBe('dbsys');
    expect(normalizeCourseTitle('【2026後期】データベースシステム論（木2）')).toBe('dbsys');
    expect(normalizeCourseTitle('ＤＢ　Ｓｙｓｔｅｍｓ')).toBe('dbsys');
  });

  it('handles full/half width and year/term markers', () => {
    expect(normalizeCourseTitle('ﾌﾟﾛｸﾞﾗﾐﾝｸﾞ演習Ⅰ')).toBe(
      normalizeCourseTitle('プログラミング演習I'),
    );
    expect(normalizeCourseTitle('2026年度 前期 情報ネットワーク')).toBe('infonet');
    expect(extractYear('2026 DB Systems')).toBe(2026);
    expect(normalizeTerm('後期')).toBe(normalizeTerm('Fall'));
  });

  it('scores similarity', () => {
    expect(titleSimilarity('データベースシステム論', '2026 DB Systems')).toBe(1);
    expect(titleSimilarity('線形代数学I', '線形代数学II')).toBeGreaterThan(0.6);
    expect(titleSimilarity('データベースシステム論', '線形代数学')).toBeLessThan(0.2);
  });

  it('matches teacher names with honorifics and surname-only forms', () => {
    expect(personNamesMatch('山田 太郎 先生', '山田太郎')).toBe(true);
    expect(personNamesMatch('山田', '山田太郎教授')).toBe(true);
    expect(personNamesMatch('山田太郎', '佐藤花子')).toBe(false);
  });
});

const offering = (id: string, o: Partial<CourseOffering>): CourseOffering => ({
  id: id as CourseOffering['id'],
  kind: 'courseOffering',
  title: 'x',
  instructorIds: [],
  instructorNames: [],
  schedule: [],
  ...o,
});

describe('offering matcher', () => {
  const lcu = offering('courseOffering:lcu', {
    title: 'データベースシステム論',
    courseCode: 'J1234',
    academicYear: 2026,
    term: '後期',
    instructorNames: ['山田 太郎'],
    schedule: [{ dayOfWeek: 4, period: 2 }],
  });
  it('auto-links on title + teacher + year', () => {
    const teams = offering('courseOffering:teams', {
      title: '2026 DB Systems',
      instructorNames: ['山田太郎'],
    });
    expect(scoreOfferingMatch(toCandidate(lcu), toCandidate(teams)).decision).toBe('link');
  });
  it('only suggests when evidence is thin (needs user confirmation)', () => {
    const ed = offering('courseOffering:ed', { title: 'DBSys' });
    expect(scoreOfferingMatch(toCandidate(lcu), toCandidate(ed)).decision).toBe('suggest');
  });
  it('vetoes different years (Course vs CourseOffering, §8)', () => {
    const old = offering('courseOffering:old', {
      title: 'データベースシステム論',
      courseCode: 'J1234',
      academicYear: 2025,
    });
    expect(scoreOfferingMatch(toCandidate(lcu), toCandidate(old))).toMatchObject({
      decision: 'none',
      veto: expect.stringContaining('year'),
    });
  });
  it('links on course code even with different titles', () => {
    const syl = offering('courseOffering:syl', {
      title: 'Database Systems (Syllabus)',
      courseCode: 'j-1234',
      academicYear: 2026,
    });
    expect(scoreOfferingMatch(toCandidate(lcu), toCandidate(syl)).decision).toBe('link');
  });
});

describe('IdentityResolver', () => {
  it('persists links, expands groups and respects user decisions', () => {
    const db = openDatabase();
    const clock = new ManualClock();
    const entities = new EntityStore(db, { clock });
    const lcuId = stableId('courseOffering', 'lcu', '1');
    const teamsId = stableId('courseOffering', 'teams', '1');
    const edId = stableId('courseOffering', 'edstem', '1');
    const otherId = stableId('courseOffering', 'teams', '2');
    entities.upsert(
      offering(lcuId, {
        title: 'データベースシステム論',
        academicYear: 2026,
        term: '後期',
        instructorNames: ['山田太郎'],
      }),
      { sourceId: 'lcu', at: '2026-09-01T00:00:00Z' },
    );
    entities.upsert(
      offering(teamsId, { title: '2026 DB Systems', instructorNames: ['山田 太郎'] }),
      { sourceId: 'teams', at: '2026-09-02T00:00:00Z' },
    );
    entities.upsert(offering(edId, { title: 'DBSys' }), {
      sourceId: 'edstem',
      at: '2026-09-03T00:00:00Z',
    });
    entities.upsert(offering(otherId, { title: '2026 線形代数学', instructorNames: ['佐藤'] }), {
      sourceId: 'teams',
      at: '2026-09-02T00:00:00Z',
    });

    const r = new IdentityResolver(db, { clock });
    const report = r.resolveCourseOfferings();
    expect(report.linked).toHaveLength(1);
    expect(report.suggested.length).toBeGreaterThanOrEqual(1);
    expect(r.expand(teamsId)).toEqual([lcuId, teamsId]);
    expect(r.canonical(teamsId)).toBe(lcuId);
    expect(r.expand(edId)).toEqual([edId]);
    expect(r.expand(otherId)).toEqual([otherId]);

    r.confirm(lcuId, edId);
    expect(r.expand(edId)).toEqual([lcuId, teamsId, edId]);

    r.reject(lcuId, teamsId);
    r.resolveCourseOfferings();
    expect(r.getLink(lcuId, teamsId)?.status).toBe('rejected');
    // still connected through EdStem? teams-ed was only suggested, so teams is now alone
    expect(r.expand(teamsId)).toEqual([teamsId]);
    // a fresh resolver reads the same persisted state
    expect(new IdentityResolver(db).expand(edId)).toEqual([lcuId, edId]);
    db.close();
  });
});
