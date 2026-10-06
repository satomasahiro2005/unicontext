import { type CanonicalEntityInput, stableId } from '@unicontext/canonical-model';
import { EntityStore } from '@unicontext/database';
import type {
  AssignmentsResponse,
  ChangesContext,
  ConflictsResponse,
  CoursesResponse,
  DeadlineContext,
  SearchResponse,
  SourcesResponse,
  TodayContext,
  TomorrowContext,
  WeekContext,
} from '@unicontext/daemon/api-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClassItem } from '@unicontext/context-engine';
import { classStateText } from '../src/format/views.js';
import { exec, json, sharedDevRuntime, type SharedRuntime } from './helpers.js';

let shared: SharedRuntime;

beforeAll(async () => {
  shared = await sharedDevRuntime();
}, 60_000);

afterAll(async () => {
  await shared.dispose();
});

const dev = (...args: string[]) => exec(['--dev', ...args], shared.overrides);

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[/;

describe('today / tomorrow / week (dev seed, 2026-10-01 09:30 JST)', () => {
  it('shows the 2nd period class and the room conflict explicitly', async () => {
    const r = await dev('today');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('今日（10月1日(木)）');
    expect(r.stdout).toContain('2限');
    expect(r.stdout).toContain('データベースシステム論');
    // the conflict is shown with every candidate and its source, not silently resolved
    expect(r.stdout).toContain('競合');
    expect(r.stdout).toContain('情報学部2号館21教室');
    expect(r.stdout).toContain('情報学部2号館11教室');
    expect(r.stdout).toContain('学務情報システム');
    expect(r.stdout).toContain('Microsoft Teams');
    expect(r.stdout).toContain('取得');
    expect(r.stdout).toMatch(/unicontext correct conflict:/);
    expect(r.stderr).toBe('');
  });

  it('every table section names its source (citation label)', async () => {
    const r = await dev('today');
    const sections = ['授業', '昨日からの変更', '締切', '大学からのお知らせ'];
    for (const title of sections) expect(r.stdout).toContain(title);
    const lines = r.stdout
      .split('\n')
      .filter((l) => /^\s{2}\S/.test(l) && /\d限|あと\d|^\s+10\/1/.test(l));
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) expect(line, line).toMatch(/取得/);
  });

  it('--json is the raw context bundle', async () => {
    const r = await dev('--json', 'today');
    const b = json<TodayContext>(r);
    expect(b.view).toBe('today');
    expect(b.date).toBe('2026-10-01');
    expect(b.classes).toHaveLength(3);
    const db = b.classes.find((c) => c.period === 2);
    expect(db?.room.status).toBe('conflict');
    expect(db?.room.candidates.map((c) => c.value)).toEqual(
      expect.arrayContaining(['情報学部2号館21教室', '情報学部2号館11教室']),
    );
    expect(b.conflicts).toHaveLength(1);
    expect(r.stdout.endsWith('\n')).toBe(true);
  });

  it('tomorrow shows the next day timetable', async () => {
    const r = await dev('tomorrow');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('明日（10月2日(金)）');
    expect(r.stdout).toContain('情報ネットワーク');
    expect(r.stdout).toContain('3限');
    expect(json<TomorrowContext>(await dev('--json', 'tomorrow')).view).toBe('tomorrow');
  });

  it('week lists the seven days of the week', async () => {
    const r = await dev('week');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('今週（9月28日(月)〜10月4日(日)）');
    expect(r.stdout).toContain('10月2日(金)');
    const b = json<WeekContext>(await dev('--json', 'week'));
    expect(b.days).toHaveLength(7);
  });
});

describe('courses / assignments / deadlines', () => {
  it('courses mirrors GET /api/v1/courses', async () => {
    const body = json<CoursesResponse>(await dev('--json', 'courses'));
    const db = body.courses.find((c) => c.title === 'データベースシステム論');
    expect(db?.courseCode).toBe('J2401');
    expect(db?.openConflicts).toBe(1);
    // The Teams post moved only 10/1's class (a dated room fact): the course's room stays.
    expect(db?.room).toMatchObject({ status: 'resolved', value: '情報学部2号館21教室' });
    expect(db?.linkedIds.length).toBeGreaterThan(1);
    const human = await dev('courses');
    expect(human.stdout).toContain('線形代数学II');
    expect(human.stdout).not.toContain('競合: 情報学部2号館21教室 / 情報学部2号館11教室');
    expect(human.stdout).toContain('courseOffering:');
  });

  it('assignments are open ones by default and --all adds finished tasks', async () => {
    const open = json<AssignmentsResponse>(await dev('--json', 'assignments'));
    expect(open.assignments.length).toBeGreaterThan(0);
    expect(
      open.assignments.every((a) => ['pending', 'in_progress', 'unknown'].includes(a.status)),
    ).toBe(true);
    expect(open.assignments.map((a) => a.title).join('\n')).toContain('課題1');
    const all = json<AssignmentsResponse>(await dev('--json', 'assignments', '--all'));
    expect(all.assignments.length).toBeGreaterThanOrEqual(open.assignments.length);
    const human = await dev('assignments');
    expect(human.stdout).toContain('課題2: 正規化演習');
    expect(human.stdout).toContain('LMS');
  });

  it('--course accepts a title, a code or an id', async () => {
    const byTitle = json<AssignmentsResponse>(
      await dev('--json', 'assignments', '--course', 'データベース'),
    );
    expect(byTitle.assignments.length).toBeGreaterThan(0);
    for (const a of byTitle.assignments) expect(a.course?.title).toBe('データベースシステム論');
    const byCode = json<AssignmentsResponse>(
      await dev('--json', 'assignments', '--course', 'J2401'),
    );
    expect(byCode.assignments.length).toBe(byTitle.assignments.length);
    const id = byTitle.assignments[0]?.course?.id ?? '';
    const byId = json<AssignmentsResponse>(await dev('--json', 'assignments', '--course', id));
    expect(byId.assignments.length).toBe(byTitle.assignments.length);
    const missing = await dev('assignments', '--course', '存在しない科目名XYZ');
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('見つかりません');
  });

  it('deadlines supports --days and --course', async () => {
    const wide = json<DeadlineContext>(await dev('--json', 'deadlines', '--days', '30'));
    const narrow = json<DeadlineContext>(await dev('--json', 'deadlines', '--days', '3'));
    expect(wide.upcoming.length).toBeGreaterThan(narrow.upcoming.length);
    expect(wide.upcoming.map((d) => d.title).join('\n')).toContain('課題1: ER図の作成');
    const human = await dev('deadlines', '--days', '30');
    expect(human.stdout).toContain('これからの締切');
    expect(human.stdout).toContain('10/10 23:59');
    const course = json<DeadlineContext>(await dev('--json', 'deadlines', '--course', 'J2401'));
    for (const d of course.upcoming) expect(d.course?.title).toBe('データベースシステム論');
  });
});

describe('changes / search / conflicts / sources / status', () => {
  it('changes shows what changed, including the deadline move', async () => {
    const r = await dev('changes', '--since', '1d');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('以降の変更');
    expect(r.stdout).toContain('課題1');
    expect(r.stdout).toContain('10/8 23:59');
    expect(r.stdout).toContain('10/10 23:59');
    const body = json<ChangesContext>(await dev('--json', 'changes', '--since', 'yesterday'));
    expect(body.changes.length).toBeGreaterThan(0);
    const iso = json<ChangesContext>(
      await dev('--json', 'changes', '--since', '2026-10-01T00:00:00+09:00'),
    );
    expect(iso.since).toBe('2026-09-30T15:00:00.000Z');
    const recent = json<ChangesContext>(await dev('--json', 'changes', '--since', '30m'));
    expect(recent.changes.length).toBeLessThan(body.changes.length);
  });

  it('search returns cited hits and honours --limit and --course', async () => {
    const r = await dev('search', '正規化');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('「正規化」の検索結果');
    expect(r.stdout).toContain('Lecture 3.pdf');
    expect(r.stdout).toMatch(/LMS.*取得/);
    const body = json<SearchResponse>(await dev('--json', 'search', '正規化'));
    expect(body.hits.length).toBeGreaterThan(1);
    for (const h of body.hits) expect(h.citations.length).toBeGreaterThan(0);
    const limited = json<SearchResponse>(await dev('--json', 'search', '正規化', '--limit', '1'));
    expect(limited.hits).toHaveLength(1);
    const scoped = json<SearchResponse>(
      await dev('--json', 'search', '正規化', '--course', 'データベースシステム論'),
    );
    expect(scoped.hits.length).toBeGreaterThan(0);
    const none = await dev('search', 'zzzzqqqq存在しない語');
    expect(none.code).toBe(0);
    expect(none.stdout).toContain('見つかりませんでした');
  });

  it('conflicts prints every candidate with its source and how to resolve it', async () => {
    const r = await dev('conflicts');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('競合（1件）');
    expect(r.stdout).toContain('データベースシステム論の教室');
    expect(r.stdout).toContain('- 情報学部2号館21教室  学務情報システム');
    expect(r.stdout).toContain('- 情報学部2号館11教室  Microsoft Teams');
    expect(r.stdout).toContain('[extracted / instructor-announcement]');
    const body = json<ConflictsResponse>(await dev('--json', 'conflicts'));
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0]?.predicate).toBe('room');
    expect(body.conflicts[0]?.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it('sources shows health per source', async () => {
    const body = json<SourcesResponse>(await dev('--json', 'sources'));
    expect(body.sources.map((s) => s.sourceId).sort()).toEqual(['lcu', 'lms', 'record', 'teams']);
    const human = await dev('sources');
    expect(human.stdout).toContain('学務情報システム');
    expect(human.stdout).toContain('正常');
    expect(human.stdout).toContain('seed-1');
  });

  it('status summarises daemon, sources and what awaits confirmation', async () => {
    const r = await dev('status');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('デーモン: 停止中');
    expect(r.stdout).toContain('競合: 1件');
    expect(r.stdout).toContain('AIの提案: 0件、紐付けの候補: 3件');
    const s = json<{
      daemon: { running: boolean };
      openConflicts: number;
      suggestedLinks: number;
      sources: unknown[];
    }>(await dev('--json', 'status'));
    expect(s.daemon.running).toBe(false);
    expect(s.openConflicts).toBe(1);
    expect(s.suggestedLinks).toBe(3);
    expect(s.sources).toHaveLength(4);
  });
});

describe('output hygiene', () => {
  it('uses no ANSI colours without a TTY and no emoji anywhere', async () => {
    for (const cmd of [
      'today',
      'week',
      'courses',
      'assignments',
      'conflicts',
      'sources',
      'status',
    ]) {
      const r = await dev(cmd);
      expect(r.stdout, cmd).not.toMatch(ANSI);
      expect(r.stdout, cmd).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it('uses colours on a TTY, but not with NO_COLOR', async () => {
    const tty = await exec(['--dev', 'conflicts'], { ...shared.overrides, isTTY: true });
    expect(tty.stdout).toMatch(ANSI);
    const noColor = await exec(['--dev', 'conflicts'], {
      ...shared.overrides,
      isTTY: true,
      env: { NO_COLOR: '1' },
    });
    expect(noColor.stdout).not.toMatch(ANSI);
    const jsonTty = await exec(['--dev', '--json', 'conflicts'], {
      ...shared.overrides,
      isTTY: true,
    });
    expect(jsonTty.stdout).not.toMatch(ANSI);
  });

  it('strips terminal escapes from source text', async () => {
    const entities = shared.runtime.uc.sync.stores.entities;
    const evil = entities.list('announcement')[0];
    expect(evil).toBeDefined();
    if (!evil) return;
    entities.upsert({ ...evil, title: '重要\u001b[2J\u001b]0;pwned\u0007なお知らせ' });
    const r = await dev('today');
    expect(r.stdout).not.toContain('\u001b[2J');
    expect(r.stdout).not.toContain('\u0007');
  });
});

describe('unfinished work of terms that have ended (synthetic Teams assignments)', () => {
  let past: SharedRuntime;
  const old = stableId('courseOffering', 'teams-web', 'team-2024');
  const team2026 = stableId('courseOffering', 'teams-web', 'team-2026');

  beforeAll(async () => {
    past = await sharedDevRuntime();
    const { uc } = past.runtime;
    const store = new EntityStore(uc.db, { clock: uc.clock });
    const put = (input: CanonicalEntityInput): void => {
      store.upsert(input, { sourceId: 'teams-web' });
    };
    put({
      id: old,
      kind: 'courseOffering',
      title: '過去のチーム',
      academicYear: 2024,
      instructorIds: [],
      instructorNames: [],
      schedule: [],
    } as CanonicalEntityInput);
    put({
      id: team2026,
      kind: 'courseOffering',
      title: '今年のチーム',
      academicYear: 2026,
      term: '後期',
      instructorIds: [],
      instructorNames: [],
      schedule: [],
    } as CanonicalEntityInput);
    for (const [key, course, dueAt] of [
      ['古い課題', old, '2025-01-10T14:59:00Z'],
      ['今期の期限切れ課題', team2026, '2026-10-01T00:00:00Z'],
    ] as const)
      put({
        id: stableId('assignment', 'teams-web', key),
        kind: 'assignment',
        title: key,
        courseOfferingId: course,
        dueAt,
      } as CanonicalEntityInput);
    uc.tasks.derive();
  }, 60_000);

  afterAll(async () => {
    await past.dispose();
  });

  const run = (...args: string[]) => exec(['--dev', ...args], past.overrides);

  it('tasks and assignments leave them out by default and keep current-term overdue ones', async () => {
    for (const command of ['tasks', 'assignments']) {
      const open = json<AssignmentsResponse>(await run('--json', command));
      const titles = open.assignments.map((a) => a.title);
      expect(titles).not.toContain('古い課題');
      expect(titles).toContain('今期の期限切れ課題');
      expect(open.assignments.find((a) => a.title === '今期の期限切れ課題')?.overdue).toBe(true);
    }
    const deadlines = json<DeadlineContext>(await run('--json', 'deadlines'));
    expect(deadlines.overdue.map((d) => d.title)).toEqual(['今期の期限切れ課題']);
  });

  it('--include-past lists them as 終了した学期', async () => {
    const all = json<AssignmentsResponse>(await run('--json', 'tasks', '--include-past'));
    const old = all.assignments.find((a) => a.title === '古い課題');
    expect(old).toMatchObject({ status: 'expired_past_term', overdue: false });
    const human = await run('tasks', '--include-past');
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('古い課題');
    expect(human.stdout).toContain('終了した学期');
  });
});

describe('class state column', () => {
  const item = (status: 'attending' | 'not_attending' | 'unknown', cancelled = false) =>
    ({
      cancelled,
      status: { status: 'resolved', value: cancelled ? 'cancelled' : 'scheduled', candidates: [] },
      effectiveSchedule: { status, reason: 'グループ次第', citations: [] },
    }) as unknown as ClassItem;

  it('shows the effective status, not 通常, when the meeting is not plainly the student’s', () => {
    expect(classStateText(item('attending'))).toBe('通常');
    expect(classStateText(item('unknown'))).toBe('未確定');
    expect(classStateText(item('not_attending'))).toBe('出席なし');
    expect(classStateText(item('unknown', true))).toBe('休講');
  });
});
