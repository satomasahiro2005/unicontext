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
  it('auto-links a title-only source (course folder) with the exact title in the same year', () => {
    const folder = offering('courseOffering:folder', {
      title: 'データベースシステム論',
      academicYear: 2026,
    });
    expect(scoreOfferingMatch(toCandidate(lcu), toCandidate(folder)).decision).toBe('link');
    const noYear = offering('courseOffering:folder2', { title: 'データベースシステム論' });
    expect(scoreOfferingMatch(toCandidate(lcu), toCandidate(noYear)).decision).toBe('suggest');
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

  it('does not merge two same-titled sections through one title-only folder', () => {
    const db = openDatabase();
    const entities = new EntityStore(db);
    const secA = stableId('courseOffering', 'syllabus', 'A');
    const secB = stableId('courseOffering', 'syllabus', 'B');
    const folder = stableId('courseOffering', 'files', 'eng');
    const section = (instructor: string, code: string) => ({
      title: '英語I',
      academicYear: 2026,
      courseCode: code,
      instructorNames: [instructor],
    });
    entities.upsert(offering(secA, section('山田太郎', 'E101')), { sourceId: 'syllabus' });
    entities.upsert(offering(secB, section('佐藤花子', 'E102')), { sourceId: 'syllabus' });
    entities.upsert(offering(folder, { title: '英語I', academicYear: 2026 }), {
      sourceId: 'files',
    });
    const r = new IdentityResolver(db);
    const report = r.resolveCourseOfferings();
    expect(report.linked).toHaveLength(0);
    expect(r.expand(secA)).toEqual([secA]);
    expect(r.expand(secB)).toEqual([secB]);
    expect(r.getLink(folder, secA)?.status).toBe('suggested');
    expect(r.getLink(folder, secB)?.status).toBe('suggested');

    // with only one candidate the exact title still auto-links
    const db2 = openDatabase();
    const e2 = new EntityStore(db2);
    e2.upsert(offering(secA, section('山田太郎', 'E101')), { sourceId: 'syllabus' });
    e2.upsert(offering(folder, { title: '英語I', academicYear: 2026 }), { sourceId: 'files' });
    const r2 = new IdentityResolver(db2);
    r2.resolveCourseOfferings();
    expect(r2.getLink(folder, secA)?.status).toBe('auto');
    db.close();
    db2.close();
  });
});

describe('discussion platform courses (EdStem) against the academic system', () => {
  // A Shizuoka student's real case: Ed course "データベースシステム論" (code db2026, session
  // "Semester 2" → 後期 through the profile) and the LCU / syllabus offering with code 77403030.
  const lcu = offering('courseOffering:lcu', {
    title: 'データベースシステム論',
    courseCode: '77403030',
    academicYear: 2026,
    term: '後期',
    instructorNames: ['山本 泰生'],
    schedule: [{ dayOfWeek: 4, period: 2 }],
  });
  const ed = (o: Partial<CourseOffering> = {}): CourseOffering =>
    offering('courseOffering:ed', {
      title: 'データベースシステム論',
      courseCode: 'db2026',
      academicYear: 2026,
      term: '後期',
      ...o,
    });

  it('links an exact title in the same year and term although the codes differ', () => {
    const m = scoreOfferingMatch(
      toCandidate(lcu, 'livecampusu', 'registrar'),
      toCandidate(ed(), 'edstem', 'platform'),
    );
    expect(m.decision).toBe('link');
    expect(m.evidence.join(' ')).toContain('course codes from different systems');
    // two registrar codes that differ still count against a match
    expect(scoreOfferingMatch(toCandidate(lcu), toCandidate(ed())).decision).toBe('none');
  });

  it('treats Ed session labels as terms and placeholders as unknown', () => {
    expect(normalizeTerm('Semester 2')).toBe('second');
    expect(normalizeTerm('S1')).toBe('first');
    const cand = (term: string) => toCandidate(ed({ term }), 'edstem', 'platform');
    const academic = toCandidate(lcu, 'livecampusu', 'registrar');
    expect(scoreOfferingMatch(academic, cand('Semester 2')).decision).toBe('link');
    expect(scoreOfferingMatch(academic, cand('Semester 1')).veto).toMatch(/term differs/);
    // "X" (a placeholder session) neither vetoes nor counts
    expect(scoreOfferingMatch(academic, cand('X')).decision).toBe('link');
    // another academic year is another offering (§8)
    const past = toCandidate(ed({ academicYear: 2025, term: undefined }), 'edstem', 'platform');
    expect(scoreOfferingMatch(academic, past).veto).toMatch(/year differs/);
  });

  it('auto-links the Ed course into the LCU + syllabus group and keeps last year apart', () => {
    const db = openDatabase();
    const entities = new EntityStore(db);
    const lcuId = stableId('courseOffering', 'livecampusu', '1');
    const sylId = stableId('courseOffering', 'syllabus', '1');
    const edNow = stableId('courseOffering', 'edstem', '41566');
    const edPast = stableId('courseOffering', 'edstem', '28169');
    entities.upsert({ ...lcu, id: lcuId }, { sourceId: 'livecampusu', at: '2026-04-01T00:00:00Z' });
    entities.upsert({ ...lcu, id: sylId }, { sourceId: 'syllabus', at: '2026-04-02T00:00:00Z' });
    entities.upsert(ed({ id: edNow }), { sourceId: 'edstem' });
    entities.upsert(ed({ id: edPast, courseCode: 'db2025', academicYear: 2025, term: undefined }), {
      sourceId: 'edstem',
    });
    const r = new IdentityResolver(db, {
      sourcePriority: (s) => (s === 'livecampusu' ? 0 : 1),
      codeScheme: (s) => (s === 'edstem' ? 'platform' : 'registrar'),
    });
    r.resolveCourseOfferings();
    expect(r.getLink(lcuId, edNow)?.status).toBe('auto');
    expect(r.getLink(sylId, edNow)?.status).toBe('auto');
    expect(r.expand(edNow)).toEqual([lcuId, sylId, edNow]);
    expect(r.expand(edPast)).toEqual([edPast]);
    expect(r.listLinks({ entityId: edPast })).toEqual([]);

    // without knowing that Ed codes are platform labels, nothing links (the pre-fix behaviour)
    const db2 = openDatabase();
    const e2 = new EntityStore(db2);
    e2.upsert({ ...lcu, id: lcuId }, { sourceId: 'livecampusu' });
    e2.upsert(ed({ id: edNow }), { sourceId: 'edstem' });
    const r2 = new IdentityResolver(db2);
    r2.resolveCourseOfferings();
    expect(r2.getLink(lcuId, edNow)).toBeUndefined();
    db.close();
    db2.close();
  });

  it('with several same-titled offerings links only to the one the student takes', () => {
    const db = openDatabase();
    const entities = new EntityStore(db);
    const secA = stableId('courseOffering', 'syllabus', 'A');
    const secB = stableId('courseOffering', 'syllabus', 'B');
    const edId = stableId('courseOffering', 'edstem', '1');
    const section = (code: string, teacher: string) => ({
      title: '英語I',
      academicYear: 2026,
      term: '後期',
      courseCode: code,
      instructorNames: [teacher],
    });
    entities.upsert(offering(secA, section('E101', '山田太郎')), { sourceId: 'syllabus' });
    entities.upsert(offering(secB, section('E102', '佐藤花子')), { sourceId: 'syllabus' });
    entities.upsert(
      offering(edId, { title: '英語I', courseCode: 'eng', academicYear: 2026, term: '後期' }),
      { sourceId: 'edstem' },
    );
    const codeScheme = (s: string | undefined) => (s === 'edstem' ? 'platform' : 'registrar');
    const r = new IdentityResolver(db, { codeScheme });
    r.resolveCourseOfferings();
    // not enrolled in either: both are only suggestions for `unicontext confirm`
    expect(r.getLink(edId, secA)?.status).toBe('suggested');
    expect(r.getLink(edId, secB)?.status).toBe('suggested');

    const me = stableId('person', 'livecampusu', 'me');
    entities.upsert({ id: me, kind: 'person', name: '本人', isSelf: true } as never, {
      sourceId: 'livecampusu',
    });
    entities.upsert(
      {
        id: stableId('enrollment', 'livecampusu', 'B'),
        kind: 'enrollment',
        personId: me,
        courseOfferingId: secB,
        role: 'student',
        status: 'active',
      } as never,
      { sourceId: 'livecampusu' },
    );
    new IdentityResolver(db, { codeScheme }).resolveCourseOfferings();
    const r3 = new IdentityResolver(db, { codeScheme });
    expect(r3.getLink(edId, secB)?.status).toBe('auto');
    expect(r3.getLink(edId, secB)?.evidence.join(' ')).toContain('enrolled');
    expect(r3.getLink(edId, secA)?.status).toBe('suggested');
    expect(r3.expand(secA)).toEqual([secA]);
    db.close();
  });
});
