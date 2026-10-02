import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exec, json, sharedDevRuntime, type SharedRuntime } from './helpers.js';

/* `unicontext announcements open|read` on the dev seed (its fake connector cannot open notices). */

describe('announcements', () => {
  let shared: SharedRuntime;
  let id: string;
  beforeAll(async () => {
    shared = await sharedDevRuntime();
    id = shared.runtime.uc.context.listAnnouncements()[0]?.id ?? '';
  }, 60_000);
  afterAll(async () => {
    await shared.dispose();
  });
  const dev = (args: string[], answers: string[] = []) =>
    exec(['--dev', ...args], shared.overrides, answers);

  it('open needs ids or --unread-all, and --yes without a terminal', async () => {
    expect((await dev(['announcements', 'open'])).code).toBe(2);
    expect((await dev(['announcements', 'open', id, '--unread-all'])).code).toBe(2);
    const noYes = await dev(['announcements', 'open', id]);
    expect(noYes.code).toBe(2);
    expect(noYes.stderr).toContain('--yes');
  });

  it('open reports sources that cannot open notices on request', async () => {
    const r = await dev(['--json', 'announcements', 'open', id, '--yes']);
    expect(r.code, r.stderr).toBe(0);
    expect(json<{ results: { status: string }[] }>(r).results[0]?.status).toBe('unsupported');
  });

  it('--unread-all with nothing unopened says so', async () => {
    const r = await dev(['announcements', 'open', '--unread-all', '--yes']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('未読のお知らせはありません');
  });

  it('read / read --unread change only UniContext’s flag', async () => {
    const r = await dev(['announcements', 'read', id, '--unread']);
    expect(r.code, r.stderr).toBe(0);
    expect(shared.runtime.uc.context.getAnnouncement(id)?.unread).toBe(true);
    expect((await dev(['announcements', 'read', id])).code).toBe(0);
    expect(shared.runtime.uc.context.getAnnouncement(id)?.unread).toBe(false);
  });
});
