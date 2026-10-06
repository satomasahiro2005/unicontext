import { describe, expect, it } from 'vitest';
import { type AssignmentPayload, LiveCampusUAdapter, RAW_TYPES } from '../src/index.js';
import { FakeLcuServer, FakeStrategy, newClock, testContext } from './helpers.js';

/*
 * verify_submission on a LiveCampusU assignment: right after the student hands it in, the
 * 課題・アンケートリスト is read again for that one assignment (提出済 / 未提出). Never the 課題提出
 * screen, never a row transition, never a download; a sync stays metadata-only for files.
 */

const SEQ = '95133';

function setup() {
  const clock = newClock();
  const server = new FakeLcuServer({ clock });
  const adapter = new LiveCampusUAdapter(testContext(clock, server.fetch), {
    strategy: new FakeStrategy(server),
  });
  return { server, adapter };
}

/** Requests that would read or move a file body, or open an assignment / the submission screen. */
const FILE_OR_SUBMISSION = /SC_14002B00_0[23]|download|fileUploadDb|fileUpload\/(?!load\/)|submit/i;
/** On request: also no row transition at all (no notice, no assignment detail). */
const FORBIDDEN = new RegExp(`${FILE_OR_SUBMISSION.source}|rowselect|linkselect`, 'i');

describe('LiveCampusU: on-request submission state (verify_submission)', () => {
  it('re-reads one assignment row after the student submits, from the list screen only', async () => {
    const { server, adapter } = setup();
    const synced = await adapter.sync({ mode: 'initial' });
    // the sync reads lists and metadata only: no file body, no submission screen
    expect(server.paths().filter((p) => FILE_OR_SUBMISSION.test(p))).toEqual([]);
    const stored = synced.items.find(
      (i) => i.sourceType === RAW_TYPES.assignment && i.externalId === SEQ,
    );
    expect((stored?.payload as AssignmentPayload).submittalStatus).toBe('未提出');

    server.submittedSeqs.add(SEQ); // the student hands it in on LiveCampusU
    const before = server.log.length;
    const out = await adapter.fetchDetails([
      { externalId: SEQ, sourceType: RAW_TYPES.assignment, previousPayload: stored?.payload },
    ]);
    expect(out.results).toEqual([{ externalId: SEQ, status: 'fetched' }]);
    expect(out.items).toHaveLength(1);
    const p = out.items[0]?.payload as AssignmentPayload;
    expect(p).toMatchObject({
      submissionSeq: SEQ,
      submittalStatus: '提出済',
      // the course context the sync resolved is kept
      context: (stored?.payload as AssignmentPayload).context,
    });
    const asked = server.paths().slice(before);
    expect(asked.some((x) => /SC_14002B00_01/.test(x))).toBe(true);
    expect(asked.filter((x) => FORBIDDEN.test(x))).toEqual([]);
    // only the assignment list (plus the landing page the session starts from)
    expect(asked.filter((x) => /SC_\w+/.test(x) && !/SC_14002B00_01|SC_01002B00/.test(x))).toEqual(
      [],
    );
  });

  it('reports rows the list no longer shows and refuses other item types', async () => {
    const { adapter } = setup();
    const out = await adapter.fetchDetails([
      { externalId: '1', sourceType: RAW_TYPES.assignment },
      { externalId: 'n1', sourceType: RAW_TYPES.notice },
    ]);
    expect(out.results).toEqual([
      { externalId: 'n1', status: 'failed', error: `no on-request read for ${RAW_TYPES.notice}` },
      { externalId: '1', status: 'notFound' },
    ]);
    expect(out.items).toEqual([]);
  });
});
