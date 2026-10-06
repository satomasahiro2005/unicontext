import { describe, expect, it } from 'vitest';
import {
  buildCapabilityCoverage,
  buildDeadlineCoverage,
  type CoverageSourceInput,
} from '../src/index.js';

const now = new Date('2026-10-05T03:00:00Z');
const HOUR = 60 * 60 * 1000;
const src = (o: Partial<CoverageSourceInput> & { sourceId: string }): CoverageSourceInput => ({
  label: o.sourceId,
  capabilities: ['assignments'],
  authority: 'lms',
  referenceOnly: false,
  state: 'healthy',
  lastSuccessAt: new Date(now.getTime() - HOUR).toISOString(),
  staleAfterMs: 6 * HOUR,
  ...o,
});
const build = (
  sources: CoverageSourceInput[],
  extra: Partial<Parameters<typeof buildDeadlineCoverage>[0]> = {},
) =>
  buildDeadlineCoverage({
    now,
    sources,
    courses: [],
    undated: [],
    courseScoped: false,
    formatTime: (iso) => iso.slice(5, 16),
    ...extra,
  });

describe('deadline coverage', () => {
  it('is complete only when every deadline source is healthy and fresh', () => {
    const lcu = src({
      sourceId: 'livecampusu',
      label: '学務情報システム',
      authority: 'academic-system',
      capabilities: ['courses', 'assignments', 'exams', 'announcements'],
    });
    const syllabus = src({
      sourceId: 'syllabus',
      capabilities: ['courses', 'timetable'],
      authority: 'syllabus',
      referenceOnly: true,
    });
    const ok = build([lcu, syllabus]);
    expect(ok.complete).toBe(true);
    expect(ok.gaps).toEqual([]);
    // the catalog does not feed deadlines
    expect(ok.sources.map((s) => s.sourceId)).toEqual(['livecampusu']);
    expect(ok.sources[0]?.covers).toEqual(['課題', '試験', 'お知らせ（文中の締切）']);
    expect(ok.note).toContain('締切が無いことを意味しません');
  });

  it('reports unhealthy, stale, never-synced and unloaded sources as gaps', () => {
    const c = build([
      src({ sourceId: 'edstem', label: 'Ed Discussion', state: 'auth_required' }),
      src({
        sourceId: 'teams-web',
        label: 'Teams',
        lastSuccessAt: new Date(now.getTime() - 30 * HOUR).toISOString(),
      }),
      src({ sourceId: 'canvas', lastSuccessAt: undefined, state: undefined }),
      src({ sourceId: 'broken', capabilities: undefined, state: 'failed' }),
      // a disabled source left in the raw store (not loaded, no failure) is not a deadline source
      src({ sourceId: 'old', capabilities: undefined, state: undefined }),
    ]);
    expect(c.complete).toBe(false);
    expect(c.sources.map((s) => [s.sourceId, s.health])).toEqual([
      ['edstem', 'auth_required'],
      ['teams-web', 'stale'],
      ['canvas', 'never_synced'],
      ['broken', 'failing'],
    ]);
    const ed = c.gaps.find((g) => g.kind === 'source_unhealthy' && g.sourceId === 'edstem');
    expect(ed?.detail).toContain('Ed Discussionを直接確認');
    expect(c.note).toContain('「締切はない」「余裕がある」とは言わないでください');
  });

  it('names courses that live where deadlines are not synced, and undated assignments', () => {
    const c = build(
      [
        src({
          sourceId: 'livecampusu',
          authority: 'academic-system',
          capabilities: ['assignments', 'announcements'],
        }),
        src({
          sourceId: 'microsoft365',
          label: 'Microsoft 365',
          authority: 'collaboration',
          capabilities: ['courses', 'announcements', 'messages', 'calendar'],
        }),
        src({ sourceId: 'local-files', authority: 'local-file', capabilities: ['materials'] }),
      ],
      {
        courses: [
          {
            id: 'courseOffering:db',
            title: 'データベースシステム論',
            sourceIds: ['livecampusu', 'microsoft365', 'local-files'],
          },
        ],
        undated: [
          {
            course: { id: 'courseOffering:db', title: 'データベースシステム論' },
            title: '課題 (小レポート2)',
            url: 'https://edstem.org/au/courses/1/lessons/2',
          },
        ],
        courseScoped: true,
      },
    );
    expect(c.complete).toBe(false);
    expect(c.gaps.map((g) => g.kind)).toEqual(['deadlines_not_synced', 'unknown_due']);
    expect(c.gaps[0]).toMatchObject({
      sourceId: 'microsoft365',
      course: { title: 'データベースシステム論' },
    });
    expect(c.gaps[1]).toMatchObject({
      items: [{ title: '課題 (小レポート2)', url: 'https://edstem.org/au/courses/1/lessons/2' }],
    });
    expect(c.gaps[1]?.detail).toContain('すぐ締切が来る可能性');
    // course scope: only the course's own sources
    expect(c.sources.map((s) => s.sourceId)).toEqual(['livecampusu', 'microsoft365']);
  });
});

describe('capability coverage', () => {
  const fmt = (iso: string): string => iso.slice(5, 16);
  const teams = src({
    sourceId: 'teams-web',
    label: 'Teams',
    authority: 'collaboration',
    capabilities: ['courses', 'announcements', 'messages', 'materials', 'assignments'],
    lastSuccessAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
    intervalMs: 30 * 60_000,
  });
  const localFiles = src({
    sourceId: 'local-files',
    label: 'ローカルファイル',
    authority: 'local-file',
    capabilities: ['files', 'materials'],
  });
  const lcu = src({
    sourceId: 'livecampusu',
    label: '学務情報システム',
    authority: 'academic-system',
    capabilities: [
      'courses',
      'enrollments',
      'timetable',
      'assignments',
      'exams',
      'announcements',
      'grades',
      'calendar',
    ],
  });
  const input = (sourceIds: string[], courseScoped = true) => ({
    now,
    sources: [teams, localFiles, lcu],
    courses: [{ id: 'courseOffering:db', title: 'データベースシステム論', sourceIds }],
    courseScoped,
    formatTime: fmt,
  });

  it('lists the sources that read materials, with age and freshness', () => {
    const c = buildCapabilityCoverage(
      'materials',
      input(['teams-web', 'local-files', 'livecampusu']),
    );
    expect(c.capability).toBe('materials');
    expect(c.complete).toBe(true);
    expect(c.gaps).toEqual([]);
    expect(c.sources.map((s) => s.sourceId)).toEqual(['teams-web', 'local-files']);
    expect(c.sources[0]).toMatchObject({
      health: 'ok',
      ageMinutes: 30,
      intervalMinutes: 30,
      freshness: 'fresh', // 30 min against the 24 h budget of materials
      covers: ['資料'],
    });
    expect(c.sources[0]?.lastSuccessAt).toBeDefined();
  });

  it('a course without a materials source has a gap', () => {
    const c = buildCapabilityCoverage('materials', input(['livecampusu']));
    expect(c.complete).toBe(false);
    expect(c.sources).toEqual([]);
    expect(c.gaps).toEqual([
      expect.objectContaining({
        kind: 'no_source',
        capability: 'materials',
        course: { id: 'courseOffering:db', title: 'データベースシステム論' },
      }),
    ]);
    expect(c.gaps[0]?.detail).toContain('資料を取得できる情報源がありません');
  });

  it('reports an unhealthy source as a gap, and age is freshness (not completeness)', () => {
    const down = buildCapabilityCoverage('assignments', {
      ...input(['teams-web', 'livecampusu']),
      sources: [{ ...teams, state: 'auth_required' }, lcu],
    });
    expect(down.complete).toBe(false);
    expect(down.gaps).toMatchObject([
      { kind: 'source_unhealthy', sourceId: 'teams-web', health: 'auth_required' },
    ]);
    const old = buildCapabilityCoverage('assignments', {
      ...input(['livecampusu']),
      sources: [
        {
          ...lcu,
          lastSuccessAt: new Date(now.getTime() - 200 * 60_000).toISOString(),
          intervalMs: 15 * 60_000,
        },
      ],
    });
    // healthy (200 min < 6 h) but over twice the 90-minute budget: stale freshness, still complete
    expect(old.sources[0]).toMatchObject({ health: 'ok', freshness: 'stale', ageMinutes: 200 });
    expect(old.complete).toBe(true);
  });

  it('calendar and attendance belong to the student, not to a course', () => {
    const c = buildCapabilityCoverage('calendar', input(['teams-web']));
    expect(c.sources.map((s) => s.sourceId)).toEqual(['livecampusu']);
    const a = buildCapabilityCoverage('attendance', input(['teams-web']));
    expect(a.sources.map((s) => s.sourceId)).toEqual(['livecampusu']); // read by the academic system
    const g = buildCapabilityCoverage('grades', input(['teams-web']));
    expect(g.complete).toBe(false); // grades are per course: this course has no grades source
  });

  it('keeps the deadline coverage and adds age to its sources', () => {
    const d = build([lcu]);
    expect(d.sources[0]).toMatchObject({ sourceId: 'livecampusu', health: 'ok', ageMinutes: 60 });
    expect(d.sources[0]?.freshness).toBe('fresh');
  });
});
