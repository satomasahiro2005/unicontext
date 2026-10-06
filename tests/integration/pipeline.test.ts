import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stableId } from '@unicontext/canonical-model';
import { ManualClock } from '@unicontext/core';
import {
  applySeedDay2,
  createFakeConnector,
  createShizuokaSeed,
  type FakeSourceAdapter,
  SEED_DAY1_SYNC_AT,
  SEED_DAY2_SYNC_AT,
} from '@unicontext/connector-sdk';
import { createUniContext, getView, type UniContext } from '@unicontext/context-engine';
import {
  backupDatabase,
  exportJsonl,
  importJsonl,
  openDatabase,
  purgeSource,
} from '@unicontext/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * Whole pipeline on the synthetic Shizuoka-like seed:
 * fake connectors → raw → normalize → facts → identity → conflicts → tasks → today context.
 */
let uc: UniContext;
let clock: ManualClock;
const adapters: Record<string, FakeSourceAdapter> = {};
const lcuDb = stableId('courseOffering', 'lcu', 'J2401-2026-2');
const teamsDb = stableId('courseOffering', 'teams', 'team-db');
const recordDb = stableId('courseOffering', 'record', 'rec-db');
const changeLog: string[] = [];
let tmp: string;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'uc-int-'));
  clock = new ManualClock(SEED_DAY1_SYNC_AT);
  uc = createUniContext({ dataDir: path.join(tmp, 'data'), profile: 'shizuoka-university', clock });
  for (const s of createShizuokaSeed()) {
    const fake = createFakeConnector(s.options);
    adapters[s.sourceId] = fake.adapter;
    uc.sync.register({
      sourceId: s.sourceId,
      adapter: fake.adapter,
      normalizer: fake.normalizer,
      metadata: fake.metadata,
    });
  }
  uc.bus.on('change', (e) => {
    changeLog.push(e.summary ?? e.type);
  });
  for (const s of uc.sync.sources()) expect((await uc.sync.sync(s.sourceId)).ok).toBe(true);

  applySeedDay2(adapters);
  clock.set(SEED_DAY2_SYNC_AT);
  for (const s of uc.sync.sources()) expect((await uc.sync.sync(s.sourceId)).ok).toBe(true);
  clock.set('2026-10-01T00:30:00.000Z'); // 09:30 JST
});

afterAll(async () => {
  await uc.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('integration: seed → today context', () => {
  it('resolved identities across sources (§14)', () => {
    expect(uc.identity.expand(teamsDb)).toContain(lcuDb);
    expect(uc.identity.canonical(teamsDb)).toBe(lcuDb);
    expect(uc.identity.expand(stableId('courseOffering', 'lms', 'm-101'))).toContain(lcuDb);
    // "DBSys" alone is too thin: suggested, waiting for the user (§14 user confirmation)
    expect(uc.identity.expand(recordDb)).toEqual([recordDb]);
    expect(
      uc.identity
        .listLinks({ status: 'suggested' })
        .some((l) => l.leftId === recordDb || l.rightId === recordDb),
    ).toBe(true);
  });

  it('builds today with classes, room conflict, deadlines, changes and citations (§17)', () => {
    const today = uc.context.today();
    expect(today.date).toBe('2026-10-01');
    expect(today.classes.map((c) => [c.period, c.course.title])).toEqual([
      [1, '線形代数学II'],
      [2, 'データベースシステム論'],
      [4, 'プログラミング演習'],
    ]);
    const db = today.classes[1];
    expect(db?.room.status).toBe('conflict');
    expect(db?.room.candidates.map((c) => [c.value, c.source]).sort()).toEqual([
      ['情報学部2号館11教室', 'Microsoft Teams'],
      ['情報学部2号館21教室', '学務情報システム'],
      ['情報学部2号館21教室', '学務情報システム'],
    ]);
    expect(db?.summary).toContain('情報が食い違っています');
    expect(today.classes[0]?.room).toMatchObject({ status: 'resolved', value: '共通教育A棟301' });
    expect(today.classes[0]?.summary).toMatch(
      /教室: 共通教育A棟301（根拠: 学務情報システム 9\/30 09:00取得）/,
    );

    expect(today.conflicts).toHaveLength(1);
    expect(today.conflicts[0]).toMatchObject({
      subject: lcuDb,
      predicate: 'room',
      subjectLabel: 'データベースシステム論',
    });

    const titles = today.deadlines.map((d) => d.title);
    expect(titles).toContain('課題1: ER図の作成');
    expect(titles).toContain('課題2: 正規化演習');
    expect(titles).not.toContain('第2回 演習課題'); // submitted per the submission system
    expect(today.deadlines.find((d) => d.title === '課題1: ER図の作成')?.dueAt).toBe(
      '2026-10-10T23:59:00+09:00',
    );
    const extracted = today.deadlines.filter((d) => d.kind === 'extracted');
    expect(extracted.map((d) => d.evidence)).toEqual(
      expect.arrayContaining([
        '第2回の復習課題は次回までに提出してください。',
        '後期の履修登録内容の確認は10月6日17時までに学務情報システムで行ってください。',
      ]),
    );
    expect(extracted.find((d) => d.evidence?.includes('次回まで'))?.dueAt).toBe(
      '2026-10-01T01:20:00.000Z',
    );

    const changes = today.changes.map((c) => c.summary);
    expect(changes).toContain('課題「課題1: ER図の作成」の締切: 10/8 23:59 → 10/10 23:59');
    expect(changes).toContain('ファイル「Lecture 3.pdf」が追加されました');
    expect(changes.some((c) => c.includes('教室') || c.includes('room'))).toBe(true);

    expect(today.importantAnnouncements.map((a) => a.title)).toEqual(
      expect.arrayContaining(['本日の教室変更', '後期履修登録の確認期間について']),
    );
    const prep = today.preparation.find((p) => p.course.id === lcuDb);
    expect(prep?.materials.map((m) => m.title)).toContain('Lecture 3.pdf');
    expect(prep?.dueBeforeClass.map((d) => d.kind)).toContain('extracted');

    // every item can be traced back to a source (§49)
    for (const item of [
      ...today.classes,
      ...today.deadlines,
      ...today.changes,
      ...today.importantAnnouncements,
      ...today.conflicts,
    ]) {
      expect(item.citations.length, JSON.stringify(item).slice(0, 120)).toBeGreaterThan(0);
      for (const c of item.citations) expect(c.retrievedAt).toMatch(/^\d{4}-/);
    }
    expect(changeLog.some((s) => s.includes('締切'))).toBe(true);
  });

  it('serves every built-in view (§18)', () => {
    for (const name of [
      'today',
      'tomorrow',
      'week',
      'deadline',
      'changes',
      'class-preparation',
      'class-review',
      'exam-preparation',
      'admin',
    ] as const) {
      expect(getView(uc.context, name, {}).view).toBe(name);
    }
    const course = getView(uc.context, 'course', { courseOfferingId: teamsDb });
    expect(course.course.id).toBe(lcuDb);
    expect(course.instructors).toEqual(expect.arrayContaining(['山田 太郎']));
    // The Teams post moves today's class only (a room fact dated to 10/1): the course keeps its room.
    expect(course.room).toMatchObject({ status: 'resolved', value: '情報学部2号館21教室' });
    expect(course.conflicts).toHaveLength(1);
    expect(uc.context.tomorrow().classes.map((c) => c.course.title)).toEqual(['情報ネットワーク']);
    expect(uc.context.admin().sources.find((s) => s.sourceId === 'lcu')).toMatchObject({
      state: 'healthy',
      detectedVersion: 'seed-1',
      versionKnown: true,
    });
  });

  it('aggregates a lecture after the user confirms the transcript mapping (§21, §14)', () => {
    const link = uc.identity
      .listLinks({ status: 'suggested' })
      .find((l) => l.leftId === recordDb || l.rightId === recordDb);
    expect(link).toBeDefined();
    uc.identity.confirm(link?.leftId ?? '', link?.rightId ?? '');
    const review = uc.context.classReview({ courseOfferingId: lcuDb, date: '2026-09-24' });
    const lecture = review.lecture;
    expect(lecture?.session?.sessionId).toBe(stableId('classSession', 'lcu', 'db-0924'));
    expect(lecture?.slides.map((s) => s.title)).toEqual(['Lecture 2.pdf']);
    const seg = lecture?.transcript.find((s) => s.timestamp === '00:42:18');
    expect(seg?.text).toContain('中間試験');
    expect(seg?.citations[0]?.location?.timestamp).toBe('00:42:18');
    expect(lecture?.questions).toEqual([]);
    const exam = uc.context.examPreparation({ courseOfferingId: lcuDb });
    expect(exam.exams[0]).toMatchObject({
      title: '試験準備: データベースシステム論 中間試験',
      scope: '第1回〜第6回（ER図・正規化）',
    });
    expect(exam.transcriptMentions.map((m) => m.timestamp)).toContain('00:42:18');
  });

  it('finds 「正規化」 through search with citations (§15)', async () => {
    const res = await uc.search.search('正規化');
    expect(res.hits.map((h) => h.kind)).toEqual(
      expect.arrayContaining(['lectureSegment', 'documentChunk']),
    );
    expect(res.hits.every((h) => h.citations.length > 0)).toBe(true);
    const due = await uc.search.search('明日締切');
    expect(due.query.route).toBe('structured');
  });

  it('resolves the conflict when the user corrects it (§74)', async () => {
    uc.resolver.correct({
      subject: lcuDb,
      predicate: 'room',
      value: '情報学部2号館11教室',
      note: '教室の掲示で確認',
    });
    await uc.runPipeline();
    const today = uc.context.today();
    expect(today.conflicts).toHaveLength(0);
    expect(today.classes[1]?.room).toMatchObject({
      status: 'resolved',
      value: '情報学部2号館11教室',
      origin: 'user',
    });
  });

  it('exports/imports JSONL, backs up and purges by source (§62, §63, §68)', async () => {
    const lines = [...exportJsonl(uc.db)];
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      type: 'header',
      format: 'unicontext-jsonl',
    });
    const copy = openDatabase();
    const report = importJsonl(copy, lines, { strict: true });
    expect(report.errors).toEqual([]);
    expect(report.imported.entity).toBeGreaterThan(20);
    expect(copy.sqlite.prepare('SELECT COUNT(*) AS n FROM facts').get()).toEqual(
      uc.db.sqlite.prepare('SELECT COUNT(*) AS n FROM facts').get(),
    );
    copy.close();

    const backup = await backupDatabase(uc.db, path.join(tmp, 'backups'), { now: clock.now() });
    const restored = openDatabase({ path: backup.databaseFile });
    expect(
      (restored.sqlite.prepare('SELECT COUNT(*) AS n FROM course_offerings').get() as { n: number })
        .n,
    ).toBeGreaterThan(0);
    restored.close();

    const purge = purgeSource(uc.db, 'record');
    expect(purge.rawItems).toBe(2);
    expect(purge.entities).toBeGreaterThan(0);
    expect(
      uc.db.sqlite
        .prepare("SELECT COUNT(*) AS n FROM source_references WHERE source_id = 'record'")
        .get(),
    ).toEqual({ n: 0 });
    uc.identity.invalidate();
    expect(
      (await uc.search.search('第3正規形まで')).hits.filter((h) => h.kind === 'lectureSegment'),
    ).toHaveLength(0);
  });
});
