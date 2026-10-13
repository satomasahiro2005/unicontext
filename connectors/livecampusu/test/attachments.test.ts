import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLiveCampusUNormalizer, LiveCampusUAdapter, metadata } from '../src/index.js';
import { FakeLcuServer, FakeStrategy, newClock, TEST_DEPLOYMENT, testContext } from './helpers.js';

/*
 * Notice attachments are documents of their own; the bytes come on the student's request through
 * the detail screen's file link (never during a sync).
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('LiveCampusU notice attachments', () => {
  it('are listed as documents and downloaded on request through the file link', async () => {
    const { createUniContext, downloadCourseFiles } =
      await import('../../../packages/context-engine/src/index.js');
    const clock = newClock();
    const server = new FakeLcuServer({ clock });
    const adapter = new LiveCampusUAdapter(testContext(clock, server.fetch, {}), {
      strategy: new FakeStrategy(server),
    });
    const uc = createUniContext({ clock });
    const filesDir = mkdtempSync(path.join(tmpdir(), 'uc-lcu-files-'));
    dirs.push(filesDir);
    try {
      uc.sync.register({
        sourceId: 'livecampusu',
        adapter,
        normalizer: createLiveCampusUNormalizer({ deployment: TEST_DEPLOYMENT }),
        metadata,
      });
      expect((await uc.sync.sync('livecampusu')).ok).toBe(true);
      // The sync lists the file but never fetches it.
      expect(server.paths().some((p) => p.startsWith('GET fileUpload/download'))).toBe(false);
      const docs = uc.sync.stores.entities.list('document').filter((d) => d.title === '資料.pdf');
      expect(docs.length).toBeGreaterThan(0);
      expect(uc.sync.stores.entities.list('document').some((d) => d.title === '削除済み.txt')).toBe(
        false,
      );

      const doc = docs[0]!;
      const report = await downloadCourseFiles(uc, [doc.id], { filesDir, extract: false });
      expect(report.results[0]).toMatchObject({ id: doc.id, status: 'downloaded' });
      expect(readFileSync(report.results[0]!.path!, 'utf8')).toBe('bytes of 資料.pdf');
      const fetched = server.paths().filter((p) => p.startsWith('GET fileUpload/download'));
      expect(fetched).toHaveLength(1);
      expect(fetched[0]).toMatch(/^GET fileUpload\/download\/fi02\/TMP0\/\?X-CSRF-TOKEN=/);
      // Nothing that writes: no readMark, todo, upload or delete.
      expect(
        server
          .paths()
          .some((p) => /readMark|todo|fileUpload\/(?!download\/|load\/)|fileUploadDb/i.test(p)),
      ).toBe(false);

      // Cached afterwards: no second request.
      const again = await downloadCourseFiles(uc, [doc.id], { filesDir, extract: false });
      expect(again.results[0]?.status).toBe('cached');
      expect(server.paths().filter((p) => p.startsWith('GET fileUpload/download'))).toHaveLength(1);
    } finally {
      await uc.close();
    }
  });
});
