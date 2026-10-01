import { type CanonicalEntityInput, stableId } from '@unicontext/canonical-model';
import type { PaceResponse, PaceSetResponse } from '@unicontext/daemon/api-types';
import { startDaemon, type RunningDaemon } from '@unicontext/daemon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DoctorCheck } from '../src/commands/doctor.js';
import { defaultDeps } from '../src/deps.js';
import {
  exec,
  json,
  OK_PROBES,
  removeDir,
  sharedDevRuntime,
  tempDir,
  type SharedRuntime,
} from './helpers.js';

const SLOT = '土 10:00-11:30';
const self = stableId('person', 'pace-self');
const retake = stableId('courseOffering', 'lcu', 'pace-retake');
const intensive = stableId('courseOffering', 'lcu', 'pace-intensive');

/** Registers two synthetic 時間割外 / 集中講義 courses of the dev seed's current term (2026 後期). */
function seed(shared: SharedRuntime): void {
  const entities = shared.runtime.uc.sync.stores.entities;
  const put = (e: CanonicalEntityInput): unknown => entities.upsert(e, { sourceId: 'lcu' });
  put({ id: self, kind: 'person', name: '本人', roles: ['student'], isSelf: true });
  const course = (id: string, title: string, scheduleType: string): void => {
    put({
      id,
      kind: 'courseOffering',
      title,
      courseCode: `PACE-${scheduleType}`,
      academicYear: 2026,
      term: '後期',
      instructorIds: [],
      instructorNames: [],
      schedule: [],
      scheduleType,
    } as CanonicalEntityInput);
    put({
      id: stableId('enrollment', id),
      kind: 'enrollment',
      personId: self as never,
      courseOfferingId: id as never,
      role: 'student',
      status: 'active',
    });
  };
  course(retake, '物理学（再履修）', 'unscheduled');
  course(intensive, '集中講義演習', 'intensive');
}

describe('pace set / list / clear (dev seed, in-process)', () => {
  let shared: SharedRuntime;
  beforeAll(async () => {
    shared = await sharedDevRuntime();
    seed(shared);
  }, 60_000);
  afterAll(async () => {
    await shared.dispose();
  });
  const dev = (...args: string[]) =>
    exec(['--dev', ...args], { ...shared.overrides, probes: OK_PROBES });

  it('needs at least one --slot (exit 2) and rejects unreadable slots (exit 1)', async () => {
    const none = await dev('pace', 'set', '物理学');
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('--slot');
    const bad = await dev('pace', 'set', '物理学', '--slot', 'いつか');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('自習時間「いつか」を読み取れません');
    const missing = await dev('pace', 'set', '存在しない科目名', '--slot', SLOT);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('見つかりません');
  });

  it('doctor warns about unscheduled courses without slots (exit code unchanged)', async () => {
    const r = await dev('--json', 'doctor');
    expect(r.code, r.stdout).toBe(0);
    const checks = json<DoctorCheck[]>(r).filter((c) => c.id.startsWith('pace:'));
    expect(checks.map((c) => c.status)).toEqual(['warn', 'warn']);
    const messages = checks.map((c) => c.message).sort();
    expect(messages).toEqual(
      [
        `時間割外の科目に自習時間が未設定: 物理学（再履修）（unicontext pace set PACE-unscheduled --slot "${SLOT}"）`,
        `時間割外の科目に自習時間が未設定: 集中講義演習（unicontext pace set PACE-intensive --slot "${SLOT}"）`,
      ].sort(),
    );
    const text = await dev('doctor');
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/^警告\s+自習時間\s+時間割外の科目に自習時間が未設定: 物理学/m);
  });

  it('set stores the slots (replacing the set) and shows them', async () => {
    const r = await dev('pace', 'set', '物理学', '--slot', SLOT, '--slot', '水2限');
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('自習時間を保存しました');
    expect(r.stdout).toContain('科目: 物理学（再履修）');
    expect(r.stdout).toContain(`自習時間: 水2限、${SLOT}`);

    const j = json<PaceSetResponse & { via: string }>(
      await dev(
        '--json',
        'pace',
        'set',
        'PACE-unscheduled',
        '--slot',
        '土曜　１０：００〜１１：３０',
      ),
    );
    expect(j.via).toBe('in-process');
    expect(j.course.id).toBe(retake);
    expect(j.slots.map((s) => s.text)).toEqual([SLOT]);
    expect(j.fact).toMatchObject({ predicate: 'pace_slots', origin: 'user' });
    expect(j.fact.value).toEqual({
      slots: [{ dayOfWeek: 6, startTime: '10:00', endTime: '11:30' }],
    });
  });

  it('list shows enrolled courses with type, slots and this week status', async () => {
    const r = await dev('pace', 'list');
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/物理学（再履修）\s+時間割外\s+土 10:00-11:30\s+未着手/);
    expect(r.stdout).toMatch(/集中講義演習\s+集中講義\s+-\s+-/);
    const body = json<PaceResponse>(await dev('--json', 'pace', 'list'));
    const row = body.courses.find((c) => c.course.id === retake);
    expect(row).toMatchObject({
      scheduleType: 'unscheduled',
      enrolled: true,
      behindWeeks: 0,
      thisWeek: { status: 'pending' },
    });
    expect(row?.slots.map((s) => s.text)).toEqual([SLOT]);
    // doctor stops warning about the course that now has slots
    const checks = json<DoctorCheck[]>(await dev('--json', 'doctor')).filter((c) =>
      c.id.startsWith('pace:'),
    );
    expect(checks.map((c) => c.id)).toEqual([`pace:${intensive}`]);
  });

  it('today prints 「ペース（遅れ）」 only when behind, in red from 2 weeks, right after 締切', async () => {
    const before = await dev('today');
    expect(before.stdout).not.toContain('ペース（遅れ）');

    // two weeks later nothing was done
    const clock = shared.runtime.uc.clock as unknown as { set(t: string): void };
    const now = shared.runtime.uc.clock.now();
    clock.set(new Date(now.getTime() + 7 * 86_400_000).toISOString());
    shared.runtime.uc.tasks.derive();
    const week1 = await dev('today');
    expect(week1.stdout).toContain('ペース（遅れ）');
    expect(week1.stdout).toContain('物理学（再履修） 先週分が未完了');

    clock.set(new Date(now.getTime() + 14 * 86_400_000).toISOString());
    shared.runtime.uc.tasks.derive();
    const week2 = await dev('today');
    expect(week2.stdout).toContain('物理学（再履修） 2週分遅れています');
    expect(week2.stdout).toContain(`自習時間: ${SLOT}`);
    const at = (s: string): number => week2.stdout.indexOf(s);
    expect(at('ペース（遅れ）')).toBeGreaterThan(at('締切（'));
    expect(at('ペース（遅れ）')).toBeLessThan(at('その他のタスク'));
    const j = json<{ pacing: { behindWeeks: number; message: string }[] }>(
      await dev('--json', 'today'),
    );
    expect(j.pacing).toMatchObject([
      { behindWeeks: 2, message: '物理学（再履修） 2週分遅れています' },
    ]);
    clock.set(now.toISOString());
  });

  it('clear stores an empty set', async () => {
    const r = await dev('pace', 'clear', '物理学');
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('自習時間を解除しました');
    const body = json<PaceResponse>(await dev('--json', 'pace', 'list'));
    expect(body.courses.find((c) => c.course.id === retake)?.slots).toEqual([]);
    expect(shared.runtime.uc.tasks.schedule.paceSlots([retake])).toEqual([]);
    const raw = json<PaceSetResponse>(await dev('--json', 'pace', 'clear', 'PACE-unscheduled'));
    expect(raw.fact.value).toEqual({ slots: [] });
  });

  it('confirm applies an AI proposal for pace_slots and shows the slots as text', async () => {
    const p = shared.runtime.proposals.create({
      kind: 'correct_fact',
      subject: retake,
      predicate: 'pace_slots',
      value: { slots: [{ dayOfWeek: 6, startTime: '10:00', endTime: '11:30' }] },
      createdBy: 'mcp:test',
      preview: '「物理学（再履修）」の自習時間を設定',
    });
    const r = await dev('confirm', p.id, '--yes');
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`新しい値: ${SLOT}`);
    expect(r.stdout).toContain('適用しました');
    expect(shared.runtime.uc.tasks.schedule.paceSlots([retake])).toHaveLength(1);
  });
});

describe('pace through a running daemon', () => {
  let dir: string;
  let daemon: RunningDaemon;
  const real = { daemonClient: defaultDeps().daemonClient, probes: OK_PROBES };
  const base = (): string[] => ['--data-dir', dir];

  beforeAll(async () => {
    dir = tempDir('unicontext-cli-pace-');
    daemon = await startDaemon({
      dev: true,
      dataDir: dir,
      port: 0,
      noKeychain: true,
      handleSignals: false,
      noScheduler: true,
      noNotifications: true,
      logSink: () => undefined,
    });
    const rt = daemon.runtime;
    const entities = rt.uc.sync.stores.entities;
    entities.upsert(
      {
        id: retake,
        kind: 'courseOffering',
        title: '物理学（再履修）',
        academicYear: 2026,
        term: '後期',
        instructorIds: [],
        instructorNames: [],
        schedule: [],
        scheduleType: 'unscheduled',
      } as CanonicalEntityInput,
      { sourceId: 'lcu' },
    );
  }, 60_000);

  afterAll(async () => {
    await daemon.stop();
    removeDir(dir);
  });

  it('set / list / clear go through PUT, GET and DELETE with the write token', async () => {
    const set = json<PaceSetResponse & { via: string }>(
      await exec([...base(), '--json', 'pace', 'set', '物理学', '--slot', SLOT], real),
    );
    expect(set.via).toBe('daemon');
    expect(set.slots.map((s) => s.text)).toEqual([SLOT]);
    expect(daemon.runtime.uc.tasks.schedule.paceSlots([retake])).toHaveLength(1);

    const list = json<PaceResponse>(await exec([...base(), '--json', 'pace', 'list'], real));
    expect(list.courses.find((c) => c.course.id === retake)?.slots).toHaveLength(1);

    const cleared = json<PaceSetResponse & { via: string }>(
      await exec([...base(), '--json', 'pace', 'clear', '物理学'], real),
    );
    expect(cleared.via).toBe('daemon');
    expect(daemon.runtime.uc.tasks.schedule.paceSlots([retake])).toEqual([]);

    const bad = await exec([...base(), 'pace', 'set', '物理学', '--slot', 'いつか'], real);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('読み取れません');
  });
});
