import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collect, createAdapter, makeTempDir, put, removeDir, TXT_LECTURE } from './helpers.js';

const locked = new Set<string>();
vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...orig,
    readdir: ((p: Parameters<typeof orig.readdir>[0], ...rest: unknown[]) => {
      if (locked.has(path.basename(String(p))))
        return Promise.reject(
          Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
        );
      return (orig.readdir as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof orig.readdir,
  };
});

let root: string;
beforeEach(async () => {
  root = await makeTempDir();
  locked.clear();
});
afterEach(async () => {
  locked.clear();
  await removeDir(root);
});

describe('unreadable directories', () => {
  it('keeps transcripts under a directory that cannot be read', async () => {
    await put(root, 'DB/lecture1.txt', TXT_LECTURE);
    await put(root, 'OS/lecture2.txt', TXT_LECTURE.replace('データベース', 'オペレーティング'));
    const adapter = createAdapter({ watchDir: root });
    expect((await collect(adapter, { mode: 'initial' })).items.length).toBeGreaterThanOrEqual(2);
    locked.add('DB');
    const res = await collect(adapter, { mode: 'incremental' });
    expect(res.deletions).toEqual([]);
    expect(res.warnings.join(' ')).toContain('Cannot read DB');
  });
});
