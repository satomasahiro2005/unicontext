import type { SyncRunReport } from '@unicontext/daemon/api-types';
import type { DaemonClient } from '@unicontext/daemon/lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncViaDaemon } from '../src/commands/sync.js';
import { describeError } from '../src/errors.js';
import { exec, json, sharedDevRuntime, type SharedRuntime } from './helpers.js';

// Synthetic attempts (no real grades).
const ATTEMPTS = [
  {
    key: 'a1',
    code: '90000001',
    title: 'サンプル入門',
    year: 2024,
    term: '前期',
    ev: '不可',
    outcome: 'failed',
  },
  {
    key: 'a2',
    code: '90000001',
    title: 'サンプル入門',
    year: 2025,
    term: '前期',
    ev: '不可',
    outcome: 'failed',
  },
  {
    key: 'a3',
    code: '90000002',
    title: 'サンプル演習',
    year: 2025,
    term: '後期',
    ev: '優',
    outcome: 'passed',
  },
  {
    key: 'a4',
    code: '90000003',
    title: 'サンプル統計',
    year: 2026,
    term: '前期',
    ev: '再試',
    outcome: 'not_graded',
  },
  {
    key: 'a5',
    code: '90000004',
    title: 'サンプル特論',
    year: 2026,
    term: '前期',
    ev: '評価保留中',
    outcome: 'unknown',
  },
];

describe('unicontext grades', () => {
  let shared: SharedRuntime;
  beforeAll(async () => {
    shared = await sharedDevRuntime();
    const store = shared.runtime.uc.sync.stores.entities;
    for (const a of ATTEMPTS)
      store.upsert(
        {
          id: `grade:test-${a.key}` as never,
          kind: 'grade',
          letter: a.ev,
          extra: {
            subjectCode: a.code,
            subjectName: a.title,
            credits: 2,
            evaluation: a.ev,
            outcome: a.outcome,
            academicYear: a.year,
            term: a.term,
          },
        },
        { sourceId: 'lcu', at: '2026-10-01T00:00:00.000Z' },
      );
  }, 60_000);
  afterAll(async () => {
    await shared.dispose();
  });
  const dev = (...args: string[]) => exec(['--dev', ...args], shared.overrides);

  it('prints every attempt grouped by year and term with the verbatim evaluation', async () => {
    const r = await dev('grades');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('2024年度 前期');
    expect(r.stdout).toContain('2026年度 前期');
    expect(r.stdout).toContain('評価保留中');
    expect(r.stdout).toContain('不明');
    expect(r.stdout).toContain('1/2回目');
    expect(r.stdout).toContain('再試待ち');
    expect(r.stdout).toMatch(/まだ修得していない不合格科目（1件）/);
    expect(r.stdout).toMatch(/区分を判定できない評価: 評価保留中/);
  });

  it('filters with --failed, --status and --year; --json gives the report', async () => {
    const failed = json<{ attempts: { evaluation: string }[] }>(
      await dev('--json', 'grades', '--failed'),
    );
    expect(failed.attempts.map((a) => a.evaluation)).toEqual(['不可', '不可']);
    const status = json<{ attempts: { outcome: string }[] }>(
      await dev('--json', 'grades', '--status', 'not_graded,評価保留中'),
    );
    expect(status.attempts.map((a) => a.outcome).sort()).toEqual(['not_graded', 'unknown']);
    const year = json<{ attempts: unknown[]; totals: { attempts: number } }>(
      await dev('--json', 'grades', '--year', '2025'),
    );
    expect(year.attempts).toHaveLength(2);
    expect(year.totals.attempts).toBe(2);
  });
});

describe('sync through the daemon', () => {
  const report = { sourceId: 'lcu', ok: true } as SyncRunReport;

  it('starts a background job and polls it until it finishes', async () => {
    const calls: string[] = [];
    let polls = 0;
    const client = {
      post: (path: string) => {
        calls.push(`POST ${path}`);
        return Promise.resolve({ job: { id: 'j1', sourceId: 'lcu', state: 'running' } });
      },
      get: (path: string) => {
        calls.push(`GET ${path}`);
        polls++;
        return Promise.resolve({
          job:
            polls < 3
              ? { id: 'j1', sourceId: 'lcu', state: 'running' }
              : { id: 'j1', sourceId: 'lcu', state: 'done', report },
        });
      },
    } as unknown as DaemonClient;
    const got = await syncViaDaemon(client, 'lcu', { sleep: () => Promise.resolve() });
    expect(got).toBe(report);
    expect(calls[0]).toBe('POST /api/v1/sources/lcu/sync?wait=0');
    expect(calls.filter((c) => c === 'GET /api/v1/sync-jobs/j1')).toHaveLength(3);
  });

  it('accepts a daemon that answers with the report directly, and surfaces job errors', async () => {
    const direct = {
      post: () => Promise.resolve({ report }),
    } as unknown as DaemonClient;
    expect(await syncViaDaemon(direct, 'lcu')).toBe(report);
    const failing = {
      post: () =>
        Promise.resolve({ job: { id: 'j2', sourceId: 'lcu', state: 'failed', error: 'boom' } }),
    } as unknown as DaemonClient;
    await expect(syncViaDaemon(failing, 'lcu')).rejects.toThrow('boom');
  });

  it('a request timeout is not reported as "cannot connect"', () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    expect(describeError(timeout).message).toBe('デーモンが時間内に応答しませんでした');
    const refused = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    expect(describeError(refused).message).toBe('デーモンに接続できません');
  });
});
