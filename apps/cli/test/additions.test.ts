import type { AdditionsResponse } from '@unicontext/daemon/api-types';
import { resolveCourse } from '@unicontext/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exec, json, sharedDevRuntime, type SharedRuntime } from './helpers.js';

/* `unicontext additions`: the owner reviews what AI clients added from chats and recordings. */

describe('additions', () => {
  let shared: SharedRuntime;
  let conflicting: string;
  let own: string;
  beforeAll(async () => {
    shared = await sharedDevRuntime();
    const uc = shared.runtime.uc;
    const db = resolveCourse(uc, 'データベースシステム論').ref.id;
    const chatgpt = { id: 'oauth-chatgpt', name: 'ChatGPT' };
    // The LMS says 課題1 is due 10/10 (after the day-2 change); the recording says 10/12.
    conflicting = (
      await uc.additions.addDeadline(chatgpt, {
        courseOfferingId: db,
        title: '課題1: ER図の作成',
        dueAt: '10月12日',
        kind: 'assignment',
        evidence: '課題1の締切は12日に延長します',
        recordingTimestamp: '00:12:34',
      })
    ).addition.id;
    own = (
      await uc.additions.addDeadline(chatgpt, {
        courseOfferingId: db,
        title: '課題3 SQL演習',
        dueAt: '2026-10-09T17:00:00+09:00',
        kind: 'assignment',
        evidence: '課題3は9日の17時までです',
        via: 'recording',
      })
    ).addition.id;
  }, 60_000);
  afterAll(async () => {
    await shared.dispose();
  });
  const dev = (args: string[]) => exec(['--dev', ...args], shared.overrides);

  it('lists unconfirmed additions with the conflict marked', async () => {
    const r = await dev(['additions']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('AIが追加した内容（チャットで登録・録音から）');
    expect(r.stdout).toContain('課題1: ER図の作成');
    expect(r.stdout).toContain('大学側と食い違い');
    expect(r.stdout).toContain('unicontext additions confirm');
    const body = json<AdditionsResponse>(await dev(['--json', 'additions']));
    expect(body.additions.map((a) => a.id).sort()).toEqual([conflicting, own].sort());
    expect(body.additions.every((a) => a.status === 'unconfirmed')).toBe(true);
  });

  it('shows 録音から on the deadlines of the day', async () => {
    const r = await dev(['deadlines']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('課題3 SQL演習');
    expect(r.stdout).toContain('録音から（未確認）');
    expect(r.stdout).toContain('課題3は9日の17時までです');
  });

  it('show prints the evidence and the source position', async () => {
    const r = await dev(['additions', 'show', conflicting]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('根拠: 「課題1の締切は12日に延長します」');
    expect(r.stdout).toContain('ChatGPT Record 00:12:34');
    expect(r.stdout).toContain('食い違い');
  });

  it('confirm needs --yes without a terminal, then stores the user fact', async () => {
    expect((await dev(['additions', 'confirm', conflicting])).code).not.toBe(0);
    const r = await dev(['additions', 'confirm', conflicting, '--yes']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('確認しました');
    const uc = shared.runtime.uc;
    expect(uc.additions.get(conflicting)?.status).toBe('confirmed');
    expect(uc.additions.get(conflicting)?.conflicts).toEqual([]);
  });

  it('reject removes it; unknown ids fail', async () => {
    const r = await dev(['additions', 'reject', own]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('却下しました');
    const all = json<AdditionsResponse>(await dev(['--json', 'additions', '--all']));
    expect(all.additions.find((a) => a.id === own)?.status).toBe('rejected');
    const deadlines = await dev(['deadlines']);
    expect(deadlines.stdout).not.toContain('課題3 SQL演習');
    expect((await dev(['additions', 'reject', 'addition:nope'])).code).toBe(1);
    expect((await dev(['additions', '--status', 'bogus'])).code).toBe(2);
  });
});
