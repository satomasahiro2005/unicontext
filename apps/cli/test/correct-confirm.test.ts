import type { Conflict, Fact } from '@unicontext/canonical-model';
import type { ConflictsResponse, TodayContext } from '@unicontext/daemon/api-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exec, json, sharedDevRuntime, type SharedRuntime } from './helpers.js';

const ROOM_11 = '情報学部2号館11教室';

describe('correct', () => {
  let shared: SharedRuntime;
  beforeAll(async () => {
    shared = await sharedDevRuntime();
  }, 60_000);
  afterAll(async () => {
    await shared.dispose();
  });
  const dev = (args: string[], answers: string[] = []) =>
    exec(['--dev', ...args], shared.overrides, answers);

  async function conflictId(): Promise<string> {
    const body = json<ConflictsResponse>(await dev(['--json', 'conflicts']));
    const id = body.conflicts[0]?.id;
    if (!id) throw new Error('no open conflict in the seed');
    return id;
  }

  it('rejects wrong argument combinations with exit code 2', async () => {
    expect((await dev(['correct'])).code).toBe(2);
    expect((await dev(['correct', 'only-an-id'])).code).toBe(2);
    expect((await dev(['correct', '--subject', 'courseOffering:x'])).code).toBe(2);
    expect(
      (await dev(['correct', '--subject', 'courseOffering:x', '--predicate', 'room'])).code,
    ).toBe(2);
    const mixed = await dev(['correct', '--predicate', 'room', 'conflict:x', 'v']);
    expect(mixed.code).toBe(2);
    expect(mixed.stderr).toContain('--subject');
  });

  it('reports an unknown id as not found (exit 1)', async () => {
    const r = await dev(['correct', 'conflict:does-not-exist', ROOM_11]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('見つかりません');
    const subject = await dev([
      'correct',
      '--subject',
      'classSession:nope',
      '--predicate',
      'room',
      'x',
    ]);
    expect(subject.code).toBe(1);
  });

  it('stores a user fact for a conflict id and resolves the conflict (§74)', async () => {
    const id = await conflictId();
    const r = await dev(['correct', id, ROOM_11, '--note', '掲示で確認した']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('修正を保存しました');
    expect(r.stdout).toContain(ROOM_11);
    expect(r.stdout).toContain('由来: user');
    expect(r.stdout).toContain('掲示で確認した');
    expect(r.stdout).toContain('この値で解決しました');

    // the open conflict is gone and the class now shows the user's value
    const after = json<ConflictsResponse>(await dev(['--json', 'conflicts']));
    expect(after.conflicts).toHaveLength(0);
    const today = json<TodayContext>(await dev(['--json', 'today']));
    const db = today.classes.find((c) => c.period === 2);
    expect(db?.room.status).toBe('resolved');
    expect(db?.room.value).toBe(ROOM_11);
    expect(db?.room.origin).toBe('user');
  });

  it('--json prints the stored fact with origin user', async () => {
    const today = json<TodayContext>(await dev(['--json', 'today']));
    const course = today.classes.find((c) => c.period === 2)?.course.id;
    expect(course).toBeDefined();
    const r = await dev([
      '--json',
      'correct',
      '--subject',
      course ?? '',
      '--predicate',
      'room',
      '"情報学部2号館12教室"',
    ]);
    expect(r.code, r.stderr).toBe(0);
    const body = json<{ fact: Fact; conflict: Conflict | null; via: string }>(r);
    expect(body.fact.origin).toBe('user');
    expect(body.fact.value).toBe('情報学部2号館12教室');
    expect(body.fact.producer.type).toBe('user');
    expect(body.via).toBe('in-process');
  });

  it('parses JSON values and falls back to plain text', async () => {
    const today = json<TodayContext>(await dev(['--json', 'today']));
    const course = today.classes.find((c) => c.period === 2)?.course.id ?? '';
    const asNumber = json<{ fact: Fact }>(
      await dev(['--json', 'correct', '--subject', course, '--predicate', 'capacity', '120']),
    );
    expect(asNumber.fact.value).toBe(120);
    const asText = json<{ fact: Fact }>(
      await dev([
        '--json',
        'correct',
        '--subject',
        course,
        '--predicate',
        'note',
        'そのまま 文字列',
      ]),
    );
    expect(asText.fact.value).toBe('そのまま 文字列');
  });
});

describe('confirm', () => {
  let shared: SharedRuntime;
  beforeAll(async () => {
    shared = await sharedDevRuntime();
  }, 60_000);
  afterAll(async () => {
    await shared.dispose();
  });
  const dev = (args: string[], answers: string[] = [], interactive = false) =>
    exec(['--dev', ...args], { ...shared.overrides, interactive }, answers);

  function propose(value: string): string {
    const today = shared.runtime.uc.context.today();
    const db = today.classes.find((c) => c.period === 2);
    if (!db) throw new Error('seed class missing');
    return shared.runtime.proposals.create({
      kind: 'correct_fact',
      subject: db.course.id,
      predicate: 'room',
      value,
      createdBy: 'mcp:test',
      preview: `教室を${value}に修正する`,
      note: 'AIの提案',
    }).id;
  }

  it('--list shows pending proposals and suggested identity links', async () => {
    const id = propose(ROOM_11);
    const r = await dev(['confirm', '--list']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('AIの提案（1件）');
    expect(r.stdout).toContain(id);
    expect(r.stdout).toContain('紐付けの候補（3件）');
    expect(r.stdout).toContain('unicontext confirm link');
    const body = json<{ proposals: { id: string }[]; suggestedLinks: unknown[] }>(
      await dev(['--json', 'confirm', '--list']),
    );
    expect(body.proposals.map((p) => p.id)).toContain(id);
    expect(body.suggestedLinks).toHaveLength(3);
    await dev(['confirm', 'reject', id]);
  });

  it('refuses to apply without a terminal or --yes (exit 2) and changes nothing', async () => {
    const id = propose(ROOM_11);
    const r = await dev(['confirm', id]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--yes');
    expect(shared.runtime.proposals.get(id)?.status).toBe('pending');
    expect(r.t.prompts).toHaveLength(0);
    await dev(['confirm', 'reject', id]);
  });

  it('asks y/N after printing the preview and cancels on anything but y', async () => {
    const id = propose(ROOM_11);
    const no = await dev(['confirm', id], ['n'], true);
    expect(no.code).toBe(1);
    expect(no.stdout).toContain(`提案「${id}」`);
    expect(no.stdout).toContain('教室を');
    expect(no.stdout).toContain(ROOM_11);
    expect(no.t.prompts[0]).toContain('[y/N]');
    expect(shared.runtime.proposals.get(id)?.status).toBe('pending');

    const yes = await dev(['confirm', id], ['y'], true);
    expect(yes.code, yes.stderr).toBe(0);
    expect(yes.stdout).toContain('適用しました');
    expect(shared.runtime.proposals.get(id)?.status).toBe('confirmed');
    const body = json<ConflictsResponse>(await dev(['--json', 'conflicts']));
    expect(body.conflicts).toHaveLength(0);
    const today = shared.runtime.uc.context.today();
    expect(today.classes.find((c) => c.period === 2)?.room.value).toBe(ROOM_11);
  });

  it('--yes applies without asking, and a finished proposal cannot be applied twice', async () => {
    const id = propose('情報学部2号館13教室');
    const ok = await dev(['--json', 'confirm', id, '--yes']);
    expect(ok.code, ok.stderr).toBe(0);
    const body = json<{ proposal: { status: string }; fact: Fact }>(ok);
    expect(body.proposal.status).toBe('confirmed');
    expect(body.fact.origin).toBe('user');
    const again = await dev(['confirm', id, '--yes']);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('適用済み');
  });

  it('reports missing proposals and requires an id', async () => {
    const missing = await dev(['confirm', 'p_missing', '--yes']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('見つかりません');
    expect((await dev(['confirm'])).code).toBe(2);
  });

  it('reject marks a proposal rejected', async () => {
    const id = propose('情報学部2号館14教室');
    const r = await dev(['confirm', 'reject', id]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('却下しました');
    expect(shared.runtime.proposals.get(id)?.status).toBe('rejected');
  });

  it('link confirms a suggested identity link and unlink rejects one', async () => {
    const links = shared.runtime.uc.identity.listLinks({ status: 'suggested' });
    expect(links).toHaveLength(3);
    const [first, second] = links;
    if (!first || !second) throw new Error('expected suggested links');
    const linked = await dev(['--json', 'confirm', 'link', first.leftId, first.rightId]);
    expect(linked.code, linked.stderr).toBe(0);
    expect(json<{ link: { status: string; decidedBy: string } }>(linked).link).toMatchObject({
      status: 'confirmed',
      decidedBy: 'user',
    });
    const human = await dev(['confirm', 'unlink', second.leftId, second.rightId]);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain('別の科目として確定しました');
    expect(shared.runtime.uc.identity.listLinks({ status: 'suggested' })).toHaveLength(1);
    const unknown = await dev(['confirm', 'link', 'courseOffering:nope', first.rightId]);
    expect(unknown.code).toBe(1);
  });
});
