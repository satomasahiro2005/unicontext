import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AssignmentPayload,
  assertRequestAllowed,
  createLiveCampusUNormalizer,
  LiveCampusUAdapter,
  metadata,
  RAW_TYPES,
} from '../src/index.js';
import {
  assignmentReferenceLoadPath,
  parseAssignmentDetail,
} from '../src/core/parsers/assignments.js';
import {
  FakeLcuServer,
  FakeStrategy,
  fixture,
  newClock,
  TEST_DEPLOYMENT,
  testContext,
} from './helpers.js';

/*
 * An assignment's own screen: the 本文 and the 参考資料 list are read by the sync (a closed row opens
 * the detail screen, an accepting one the submission screen, of which only the plain GET is made);
 * the 参考資料 bytes come on the student's request through the widget's file link.
 */

const ACCEPTING = '2045';
const CLOSED = '95133';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(config: Record<string, unknown> = {}) {
  const clock = newClock();
  const server = new FakeLcuServer({ clock });
  const adapter = new LiveCampusUAdapter(testContext(clock, server.fetch, config), {
    strategy: new FakeStrategy(server),
  });
  return { clock, server, adapter };
}

function payloadOf(
  items: { sourceType: string; externalId: string; payload: unknown }[],
  seq: string,
) {
  return items.find((i) => i.sourceType === RAW_TYPES.assignment && i.externalId === seq)
    ?.payload as AssignmentPayload | undefined;
}

describe('LiveCampusU assignment screens', () => {
  it('parses the 本文 and names only the 参考資料 widget (never the upload area)', () => {
    const html = fixture('lcu-kadai-screen.synthetic.html')
      .replaceAll('{{TITLE}}', '第03回課題')
      .replaceAll('{{STATUS}}', '受付中')
      .replaceAll('{{BODY}}', '第3回課題です．<br>こちらにZip形式で送信ください．')
      .replaceAll('{{PREFIX}}', 'reg02');
    expect(parseAssignmentDetail(html)).toEqual({
      title: '第03回課題',
      body: '第3回課題です．\nこちらにZip形式で送信ください．',
      links: [],
      statusText: '受付中',
      deadlineText: '2026年10月27日 12時45分',
      hasReferenceWidget: true,
    });
    expect(assignmentReferenceLoadPath(html)).toBe('fileUpload/load/reg02');
    const empty = html.replaceAll('第3回課題です．<br>こちらにZip形式で送信ください．', '');
    expect(parseAssignmentDetail(empty)?.body).toBe('');
  });

  it('a sync reads the 本文 and 参考資料 names; the submission screen is only shown', async () => {
    const { server, adapter } = setup();
    const result = await adapter.sync({ mode: 'initial' });
    const accepting = payloadOf(result.items, ACCEPTING);
    expect(accepting?.detail).toMatchObject({
      body: '第N回課題です。\nこちらにZip形式で送信ください。',
      references: [{ name: '第N回.pdf', size: 210262 }],
      screen: 'SC_14002B00_03',
    });
    // A closed row: the detail screen, read, with no 本文 (not the same as unread).
    const closed = payloadOf(result.items, CLOSED);
    expect(closed?.detail).toMatchObject({ body: '', references: [], screen: 'SC_14002B00_02' });
    const paths = server.paths();
    // The submission screen: its plain GET only; never the upload area, never a file body.
    expect(paths.filter((p) => /SC_14002B00_03/.test(p))).toEqual(
      paths.filter((p) => p === 'GET SC_14002B00_03'),
    );
    expect(paths.filter((p) => /newReg|download|fileUploadDb|SC_\w+\/\w*submit/i.test(p))).toEqual(
      [],
    );
    // The cache rides on the cursor: an unchanged closed row is not opened again.
    const opened = server.openedAssignmentRows.length;
    await adapter.sync({ mode: 'incremental', cursor: result.cursor });
    expect(server.openedAssignmentRows.length).toBe(opened);
  });

  it('respects assignmentDetails: false and maxAssignmentDetailsPerRun (accepting first)', async () => {
    const off = setup({ assignmentDetails: false });
    const r1 = await off.adapter.sync({ mode: 'initial' });
    expect(off.server.openedAssignmentRows).toEqual([]);
    expect(payloadOf(r1.items, ACCEPTING)?.detail).toBeUndefined();

    const one = setup({ maxAssignmentDetailsPerRun: 1 });
    const r2 = await one.adapter.sync({ mode: 'initial' });
    expect(one.server.openedAssignmentRows.map((r) => r.screen)).toEqual(['SC_14002B00_03']);
    expect(payloadOf(r2.items, ACCEPTING)?.detail).toBeDefined();
    expect(payloadOf(r2.items, CLOSED)?.detail).toBeUndefined();
  });

  it('becomes the assignment text, a searchable 本文 document and 参考資料 documents downloaded on request', async () => {
    const { createUniContext, downloadCourseFiles } =
      await import('../../../packages/context-engine/src/index.js');
    const clock = newClock();
    const server = new FakeLcuServer({ clock });
    const adapter = new LiveCampusUAdapter(testContext(clock, server.fetch, {}), {
      strategy: new FakeStrategy(server),
    });
    const uc = createUniContext({ clock });
    const filesDir = mkdtempSync(path.join(tmpdir(), 'uc-lcu-refs-'));
    dirs.push(filesDir);
    try {
      uc.sync.register({
        sourceId: 'livecampusu',
        adapter,
        normalizer: createLiveCampusUNormalizer({ deployment: TEST_DEPLOYMENT }),
        metadata,
      });
      expect((await uc.sync.sync('livecampusu')).ok).toBe(true);
      const entities = uc.sync.stores.entities;
      const accepting = entities
        .list('assignment')
        .find((a) => (a.extra as { submissionSeq?: string }).submissionSeq === ACCEPTING);
      expect(accepting?.description).toBe('第N回課題です。\nこちらにZip形式で送信ください。');
      expect(accepting?.extra).toMatchObject({
        contentStatus: 'fetched',
        references: [{ name: '第N回.pdf', size: 210262 }],
      });
      const closed = entities
        .list('assignment')
        .find((a) => (a.extra as { submissionSeq?: string }).submissionSeq === CLOSED);
      expect(closed?.description).toBeUndefined();
      expect(closed?.extra).toMatchObject({ contentStatus: 'empty' });

      const docs = entities.list('document');
      expect(docs.find((d) => d.title.endsWith('（課題の本文）'))?.text).toContain('Zip形式');
      const ref = docs.find((d) => d.title === '第N回.pdf');
      expect(ref).toBeDefined();
      // The sync never fetched the file.
      expect(server.paths().some((p) => p.startsWith('GET fileUpload/download'))).toBe(false);

      const report = await downloadCourseFiles(uc, [ref!.id], { filesDir, extract: false });
      expect(report.results[0]).toMatchObject({ id: ref!.id, status: 'downloaded' });
      expect(readFileSync(report.results[0]!.path!, 'utf8')).toBe('bytes of 第N回.pdf');
      const fetched = server.paths().filter((p) => p.startsWith('GET fileUpload/download'));
      expect(fetched).toHaveLength(1);
      expect(fetched[0]).toMatch(/^GET fileUpload\/download\/reg02\/TMP0\/\?X-CSRF-TOKEN=/);
      expect(server.paths().some((p) => /newReg|fileUploadDb/.test(p))).toBe(false);
    } finally {
      await uc.close();
    }
  });

  it('the policy shows an assignment screen only through the grant, and nothing on it', () => {
    const base = { gradesEnabled: false, extraDeniedScreens: ['SC_14002B00_03'] };
    const g = { ...base, grant: 'assignment-detail' as const };
    expect(() => assertRequestAllowed('POST', 'SC_14002B00_01/rowselect', base)).toThrow();
    expect(() => assertRequestAllowed('GET', 'SC_14002B00_03', base)).toThrow();
    expect(() => assertRequestAllowed('POST', 'SC_14002B00_01/rowselect', g)).not.toThrow();
    expect(() => assertRequestAllowed('GET', 'SC_14002B00_03', g)).not.toThrow();
    expect(() => assertRequestAllowed('GET', 'SC_14002B00_02', g)).not.toThrow();
    // Nothing after the screen id, no POST to it, and no other row transition with this grant.
    expect(() => assertRequestAllowed('POST', 'SC_14002B00_03', g)).toThrow();
    expect(() => assertRequestAllowed('GET', 'SC_14002B00_03/init', g)).toThrow();
    expect(() => assertRequestAllowed('POST', 'SC_14002B00_03/submit', g)).toThrow();
    expect(() => assertRequestAllowed('GET', 'SC_14002B00_03%2Fsubmit', g)).toThrow();
    expect(() => assertRequestAllowed('POST', 'SC_17001B00_01/rowSelect', g)).toThrow();
    // The 参考資料 widget's list and file link, with their own grants only.
    const list = { ...base, grant: 'assignment-attachments' as const };
    expect(() => assertRequestAllowed('POST', 'fileUpload/load/reg02', list)).not.toThrow();
    expect(() => assertRequestAllowed('POST', 'fileUpload/load/reg02', base)).toThrow();
    expect(() => assertRequestAllowed('POST', 'fileUploadDb/delete/reg02', list)).toThrow();
    const dl = { ...base, grant: 'assignment-attachment-download' as const };
    expect(() => assertRequestAllowed('GET', 'fileUpload/download/reg02/TMP0/', dl)).not.toThrow();
    expect(() => assertRequestAllowed('POST', 'fileUpload/download/reg02/TMP0/', dl)).toThrow();
  });
});
