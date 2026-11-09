import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exec, json, removeDir, tempDir, writeConfig } from './helpers.js';

describe('share', () => {
  let dir: string;
  let base: string[];
  beforeAll(() => {
    dir = tempDir();
    base = [
      '--data-dir',
      dir,
      '--config',
      writeConfig(
        dir,
        'sources: {}\nremote:\n  enabled: true\n  publicUrl: https://uc.example.test\n',
      ),
    ];
  });
  afterAll(() => removeDir(dir));

  it('adds someone with chosen categories, changes them and issues codes', async () => {
    const add = await exec([...base, '--json', 'share', 'add', '母', '--allow', 'family,grades']);
    expect(add.code, add.stderr).toBe(0);
    const added = json<{ id: string; allow: string[]; connector: string; code: string }>(add);
    expect(added.allow).toEqual(['schedule', 'courses', 'deadlines', 'submissions', 'grades']);
    expect(added.connector).toBe('https://uc.example.test');
    expect(added.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const deny = await exec([...base, 'share', 'deny', '母', 'grades', 'submissions']);
    expect(deny.stdout).toContain('母: 時間割（授業・教室・休講）・履修科目・シラバス・締切・試験');
    const allow = await exec([...base, 'share', 'allow', '母', 'attendance']);
    expect(allow.stdout).toContain('出席');

    const list = json<{ name: string; allow: string[] }[]>(
      await exec([...base, '--json', 'share', 'list']),
    );
    expect(list).toEqual([
      expect.objectContaining({
        name: '母',
        allow: ['schedule', 'courses', 'deadlines', 'attendance'],
      }),
    ]);
    expect(JSON.stringify(list)).not.toContain(added.code);

    const code = json<{ code: string }>(await exec([...base, '--json', 'guest', 'code', '母']));
    expect(code.code).not.toBe(added.code);

    const bad = await exec([...base, 'share', 'allow', '母', 'everything']);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('「everything」は範囲の名前ではありません');

    const revoke = await exec([...base, 'share', 'revoke', '母']);
    expect(revoke.code).toBe(0);
    expect(json<unknown[]>(await exec([...base, '--json', 'share', 'list']))).toEqual([]);
  });
});
