import { describe, expect, it } from 'vitest';
import { buildDeadlineCoverage, type CoverageSourceInput } from '../src/index.js';

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
