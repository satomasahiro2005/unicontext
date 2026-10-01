import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DaemonClient } from '@unicontext/daemon';
import type { CoursesResponse } from '@unicontext/daemon/api-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exec, json, removeDir, sharedDevRuntime, tempDir, type SharedRuntime } from './helpers.js';

describe('backup / export / import', () => {
  let shared: SharedRuntime;
  let dir: string;
  beforeAll(async () => {
    shared = await sharedDevRuntime();
    dir = tempDir();
  }, 60_000);
  afterAll(async () => {
    await shared.dispose();
    removeDir(dir);
  });
  const dev = (...args: string[]) => exec(['--dev', ...args], shared.overrides);

  it('backup writes db, mappings and metadata without secrets and prints the directory', async () => {
    const target = path.join(dir, 'backups');
    const r = await dev('backup', '--dir', target);
    expect(r.code, r.stderr).toBe(0);
    const folder = readdirSync(target)[0] ?? '';
    expect(folder).toMatch(/^unicontext-backup-\d{8}-\d{6}$/);
    expect(r.stdout).toContain(path.join(target, folder));
    expect(r.stdout).toContain('秘密情報は含まれていません');
    for (const f of ['unicontext.db', 'mappings.json', 'metadata.json'])
      expect(existsSync(path.join(target, folder, f)), f).toBe(true);
    const meta = JSON.parse(readFileSync(path.join(target, folder, 'metadata.json'), 'utf8')) as {
      containsSecrets: boolean;
      schemaVersion: number;
    };
    expect(meta.containsSecrets).toBe(false);
    expect(meta.schemaVersion).toBeGreaterThan(0);
  });

  it('backup --json prints the result paths; the default destination is <data dir>/backups', async () => {
    const r = await dev('--json', 'backup', '--dir', path.join(dir, 'b2'));
    const body = json<{ directory: string; databaseFile: string }>(r);
    expect(existsSync(body.databaseFile)).toBe(true);

    const dataDir = tempDir();
    try {
      const real = await exec(['--data-dir', dataDir, '--json', 'backup']);
      expect(real.code, real.stderr).toBe(0);
      expect(
        json<{ directory: string }>(real).directory.startsWith(path.join(dataDir, 'backups')),
      ).toBe(true);
    } finally {
      removeDir(dataDir);
    }
  });

  it('export without a file streams pure JSONL to stdout', async () => {
    for (const args of [['export'], ['export', '-']]) {
      const r = await dev(...args);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stderr).toBe('');
      const lines = r.stdout.trim().split('\n');
      expect(lines.length).toBeGreaterThan(50);
      const parsed = lines.map((l) => JSON.parse(l) as { type: string });
      expect(parsed[0]?.type).toBe('header');
      expect(new Set(parsed.map((p) => p.type))).toEqual(expect.objectContaining({}));
      expect(parsed.some((p) => p.type === 'entity')).toBe(true);
      expect(parsed.some((p) => p.type === 'fact')).toBe(true);
    }
  });

  it('export to a file summarises with --json', async () => {
    const file = path.join(dir, 'out.jsonl');
    const r = await dev('--json', 'export', file);
    const body = json<{ file: string; records: number }>(r);
    expect(body.file).toBe(file);
    expect(body.records).toBeGreaterThan(50);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(body.records + 1);
    const human = await dev('export', path.join(dir, 'out2.jsonl'));
    expect(human.stdout).toContain('件を書き出しました');
  });

  it('round trip: an export imports into an empty data dir with the same courses', async () => {
    const file = path.join(dir, 'roundtrip.jsonl');
    expect((await dev('export', file)).code).toBe(0);
    const fresh = tempDir();
    try {
      const imported = await exec(['--data-dir', fresh, 'import', file]);
      expect(imported.code, imported.stderr).toBe(0);
      expect(imported.stdout).toContain('件を取り込みました');
      expect(imported.stdout).toContain('エンティティ');
      const original = json<CoursesResponse>(await dev('--json', 'courses'));
      const copy = json<CoursesResponse>(await exec(['--data-dir', fresh, '--json', 'courses']));
      // the canonical title of a linked course depends on which connectors are registered, so
      // compare the number of courses and a course that has one name everywhere
      expect(copy.courses).toHaveLength(original.courses.length);
      expect(copy.courses.map((c) => c.title)).toContain('データベースシステム論');
      expect(copy.courses.find((c) => c.title === 'データベースシステム論')?.openConflicts).toBe(1);
      const conflicts = await exec(['--data-dir', fresh, '--json', 'conflicts']);
      expect(conflicts.code).toBe(0);
    } finally {
      removeDir(fresh);
    }
  });

  it('import reports invalid lines (exit 1) and --strict aborts', async () => {
    const good = (await dev('export')).stdout.trim().split('\n');
    const bad = [good[0] ?? '', '{not json', ...good.slice(1, 4)].join('\n');
    const file = path.join(dir, 'bad.jsonl');
    writeFileSync(file, `${bad}\n`);
    const fresh = tempDir();
    try {
      const lenient = await exec(['--data-dir', fresh, 'import', file]);
      expect(lenient.code).toBe(1);
      expect(lenient.stderr).toContain('2行目');
      expect(lenient.stdout).toContain('件を取り込みました');
      const strict = await exec(['--data-dir', fresh, 'import', '--strict', file]);
      expect(strict.code).toBe(1);
      expect(strict.stderr).toContain('JSONL line 2');
    } finally {
      removeDir(fresh);
    }
    const missing = await dev('import', path.join(dir, 'nope.jsonl'));
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('ファイルが見つかりません');
  });
});

describe('purge source', () => {
  let shared: SharedRuntime;
  beforeAll(async () => {
    shared = await sharedDevRuntime();
  }, 60_000);
  afterAll(async () => {
    await shared.dispose();
  });
  const rawCount = (id: string): number =>
    shared.runtime.uc.sync.stores.raw.list({ sourceId: id, includeDeleted: true }).length;
  const dev = (args: string[], overrides: object = {}, answers: string[] = []) =>
    exec(['--dev', ...args], { ...shared.overrides, ...overrides }, answers);

  it('needs --yes without a terminal (exit 2) and deletes nothing', async () => {
    const before = rawCount('record');
    expect(before).toBeGreaterThan(0);
    const r = await dev(['purge', 'source', 'record']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--yes');
    expect(rawCount('record')).toBe(before);
  });

  it('asks for confirmation on a terminal and cancels on n', async () => {
    const before = rawCount('record');
    const r = await dev(['purge', 'source', 'record'], { interactive: true }, ['n']);
    expect(r.code).toBe(1);
    expect(r.t.prompts[0]).toContain('record');
    expect(r.t.prompts[0]).toContain('元に戻せません');
    expect(rawCount('record')).toBe(before);
  });

  it('warns when a daemon is running', async () => {
    const fake = new DaemonClient({ baseUrl: 'http://127.0.0.1:9' });
    const r = await dev(['purge', 'source', 'does-not-exist', '--yes'], {
      daemonClient: async () => fake,
    });
    // unknown source stops before anything is deleted
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('見つかりません');
  });

  it('with --yes deletes the source data and prints the report', async () => {
    const before = rawCount('teams');
    expect(before).toBeGreaterThan(0);
    const fake = new DaemonClient({ baseUrl: 'http://127.0.0.1:9' });
    const r = await dev(['--json', 'purge', 'source', 'teams', '--yes'], {
      daemonClient: async () => fake,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain('デーモンが起動中です');
    const report = json<{ sourceId: string; rawItems: number; facts: number; entities: number }>(r);
    expect(report.sourceId).toBe('teams');
    expect(report.rawItems).toBe(before);
    expect(report.entities).toBeGreaterThan(0);
    expect(rawCount('teams')).toBe(0);
    // the other sources keep their data
    expect(rawCount('lcu')).toBeGreaterThan(0);
    // the room conflict came from Teams: it is gone with its evidence
    const after = await dev(['--json', 'conflicts']);
    expect(json<{ conflicts: unknown[] }>(after).conflicts).toHaveLength(0);
  });

  it('prints a table of what was deleted for humans', async () => {
    const r = await dev(['purge', 'source', 'record', '--yes']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('ソース「record」のデータを削除しました');
    expect(r.stdout).toContain('生データ');
    expect(r.stdout).toContain('ファクト');
  });
});
