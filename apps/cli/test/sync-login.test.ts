import type { FakeSourceAdapter } from '@unicontext/connector-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  exec,
  json,
  removeDir,
  sharedDevRuntime,
  tempDir,
  writeConfig,
  type SharedRuntime,
} from './helpers.js';

interface SyncJson {
  via: string;
  reports: {
    sourceId: string;
    ok: boolean;
    mode: string;
    health: string;
    error?: string;
    raw: { inserted: number };
  }[];
  skipped: { sourceId: string; reason: string }[];
}

describe('sync in-process (no daemon)', () => {
  let shared: SharedRuntime;
  beforeAll(async () => {
    shared = await sharedDevRuntime();
  }, 60_000);
  afterAll(async () => {
    await shared.dispose();
  });
  const dev = (...args: string[]) => exec(['--dev', ...args], shared.overrides);

  it('syncs every enabled source sequentially and prints a per-source report', async () => {
    const r = await dev('sync');
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('デーモンが起動していないため、この場で同期しました');
    for (const id of ['lcu', 'lms', 'record', 'teams']) expect(r.stdout).toContain(id);
    expect(r.stdout).toContain('差分');
    expect(r.stdout).toContain('正常');
    const header =
      r.stdout.split('\n').find((l) => l.includes('ソース') && l.includes('モード')) ?? '';
    for (const col of ['追加', '更新', '削除', '状態', 'エラー']) expect(header).toContain(col);
  });

  it('--json lists the SyncRunReports', async () => {
    const r = await dev('--json', 'sync');
    const body = json<SyncJson>(r);
    expect(body.via).toBe('in-process');
    expect(body.reports).toHaveLength(4);
    expect(body.reports.every((x) => x.ok)).toBe(true);
    expect(body.skipped).toEqual([]);
  });

  it('syncs one source by id and rejects an unknown id', async () => {
    const one = json<SyncJson>(await dev('--json', 'sync', 'lms'));
    expect(one.reports.map((x) => x.sourceId)).toEqual(['lms']);
    const bad = await dev('sync', 'ghost');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/^エラー: 設定に問題があります/);
    expect(bad.stderr).toContain('ghost');
  });

  it('a failing source gives exit code 1 and the login hint for auth_required', async () => {
    const adapter = shared.runtime.uc.sync.getSource('lcu').adapter as FakeSourceAdapter;
    adapter.authenticated = false;
    try {
      const r = await dev('sync', 'lcu');
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('要ログイン');
      expect(r.stderr).toContain('unicontext login lcu');
      // the other sources are unaffected
      const all = json<SyncJson>(await dev('--json', 'sync'));
      expect(all.reports.find((x) => x.sourceId === 'lcu')?.ok).toBe(false);
      expect(all.reports.filter((x) => x.ok)).toHaveLength(3);
    } finally {
      adapter.authenticated = true;
    }
  });
});

describe('login', () => {
  let shared: SharedRuntime;
  beforeAll(async () => {
    shared = await sharedDevRuntime();
  }, 60_000);
  afterAll(async () => {
    await shared.dispose();
  });
  const dev = (...args: string[]) => exec(['--dev', ...args], shared.overrides);

  it('prints the AuthResult of the source', async () => {
    const r = await dev('login', 'lcu');
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('lcu: 認証できました');
    expect(r.stdout).toContain('アカウント: student@example.ac.jp');
    // --dev keeps secrets in memory only; the user is told
    expect(r.stderr).toContain('ログイン情報はこのコマンドの終了とともに失われます');
    const body = json<{ sourceId: string; auth: { status: string; account: string } }>(
      await dev('--json', 'login', 'lcu'),
    );
    expect(body.auth).toMatchObject({ status: 'authenticated', account: 'student@example.ac.jp' });
  });

  it('fails with exit code 1 and a hint when the source still needs a login', async () => {
    const adapter = shared.runtime.uc.sync.getSource('teams').adapter as FakeSourceAdapter;
    adapter.authenticated = false;
    try {
      const r = await dev('login', 'teams');
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('ログインが必要です');
      expect(r.stdout).toContain('login required');
      expect(r.stderr).toContain('unicontext login teams');
    } finally {
      adapter.authenticated = true;
    }
  });

  it('explains unknown, disabled and unloadable sources', async () => {
    const dir = tempDir();
    try {
      writeConfig(
        dir,
        [
          'sources:',
          '  ghost:',
          '    connector: "@unicontext/definitely-not-installed"',
          '  parked:',
          '    enabled: false',
          '    connector: "@unicontext/definitely-not-installed"',
          '',
        ].join('\n'),
      );
      const base = ['--data-dir', dir];
      const unknown = await exec([...base, 'login', 'nothing']);
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain('ソース「nothing」は登録されていません');
      expect(unknown.stderr).toContain('config.yaml');

      const disabled = await exec([...base, 'login', 'parked']);
      expect(disabled.code).toBe(1);
      expect(disabled.stderr).toContain('無効になっています');

      const missing = await exec([...base, 'login', 'ghost']);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain('コネクタを読み込めません');
      expect(missing.stderr).toContain('@unicontext/definitely-not-installed');
      expect(missing.stderr).toContain('unicontext doctor');

      // sync: skipped sources are reported, an explicit id gives the load error
      const all = await exec([...base, 'sync']);
      expect(all.code).toBe(0);
      expect(all.stdout).toContain('同期できるソースがありません');
      expect(all.stderr).toContain('ソース「ghost」はスキップしました');
      const one = await exec([...base, 'sync', 'ghost']);
      expect(one.code).toBe(1);
      expect(one.stderr).toContain('definitely-not-installed');

      const sources = json<{
        sources: { sourceId: string; state: string; loadError?: string; enabled: boolean }[];
      }>(await exec([...base, '--json', 'sources']));
      expect(sources.sources.find((s) => s.sourceId === 'ghost')).toMatchObject({
        state: 'failed',
      });
      expect(sources.sources.find((s) => s.sourceId === 'parked')?.enabled).toBe(false);
    } finally {
      removeDir(dir);
    }
  });
});
