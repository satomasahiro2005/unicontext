import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { externalIdFor, rootKeyFor } from '../src/index.js';
import { collect, createAdapter, makeTempDir, put, removeDir } from './helpers.js';

// Directories whose basename is in `locked` fail readdir with EACCES (portable stand-in for
// chmod 000, which does not work on Windows).
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
  it('keeps the files of a subdirectory that cannot be read instead of deleting them', async () => {
    await put(root, 'a.txt', 'one');
    await put(root, 'sub/b.txt', 'two');
    await put(root, 'sub2/c.txt', 'three');
    const adapter = createAdapter({ roots: [root] });
    expect((await collect(adapter, { mode: 'initial' })).items).toHaveLength(3);

    locked.add('sub');
    const res = await collect(adapter, { mode: 'incremental' });
    expect(res.deletions).toEqual([]);
    expect(res.warnings.join(' ')).toContain('Cannot read sub');

    // Once readable again, real deletions under it are still detected.
    locked.clear();
    await removeDir(path.join(root, 'sub'));
    const key = externalIdFor(rootKeyFor(path.resolve(root)), 'sub/b.txt');
    expect((await collect(adapter, { mode: 'incremental' })).deletions).toEqual([key]);
  });
});
