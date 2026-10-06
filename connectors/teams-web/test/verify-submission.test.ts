import { describe, expect, it } from 'vitest';
import { harness } from './helpers.js';

/*
 * verify_submission on a Teams assignment: right after the student turns it in, the Assignments
 * app lists the student's work again and only that assignment comes back. No channel is read, no
 * library listed, no assignment opened, nothing downloaded; a default sync never downloads a file
 * body either (text extraction and the mirror are off unless the student turns them on).
 */

const WORKING = 'aaaaaaaa-0000-4000-8000-000000000003';

type Work = { id: string; submissions?: { status?: string; submittedDateTime?: string }[] };

describe('teams-web: on-request submission state (verify_submission)', () => {
  it('a default sync lists files but never downloads one', async () => {
    const h = harness();
    const result = await h.adapter.sync({ mode: 'initial' });
    expect(result.items.some((i) => i.sourceType === 'teamsweb.driveItem')).toBe(true);
    expect(h.client.downloads).toEqual([]);
    expect(h.client.streamRequests).toEqual([]);
  });

  it('re-reads only the requested assignment from the Assignments app', async () => {
    const h = harness();
    await h.adapter.sync({ mode: 'initial' });
    const opened = h.client.opened.length;
    const deltas = h.client.deltaCalls.length;
    // the student turns it in on Teams
    const work = h.client.work as Work[];
    const item = work.find((w) => w.id === WORKING);
    if (!item?.submissions?.[0]) throw new Error('fixture changed');
    item.submissions[0].status = 'submitted';
    item.submissions[0].submittedDateTime = '2026-10-02T02:59:00Z';

    const out = await h.adapter.fetchDetails([
      { externalId: WORKING, sourceType: 'teamsweb.assignment' },
    ]);
    expect(out.results).toEqual([{ externalId: WORKING, status: 'fetched' }]);
    expect(out.items.map((i) => `${i.sourceType}:${i.externalId}`)).toEqual([
      `teamsweb.assignment:${WORKING}`,
    ]);
    expect((out.items[0]?.payload as Work).submissions?.[0]).toMatchObject({
      status: 'submitted',
      submittedDateTime: '2026-10-02T02:59:00Z',
    });
    // nothing but the Assignments list: no channel, no library, no download
    expect(h.client.opened.length).toBe(opened);
    expect(h.client.deltaCalls.length).toBe(deltas);
    expect(h.client.downloads).toEqual([]);
  });

  it('says when an assignment is not listed, and refuses other item types', async () => {
    const h = harness();
    const out = await h.adapter.fetchDetails([
      { externalId: 'gone', sourceType: 'teamsweb.assignment' },
      { externalId: 'x', sourceType: 'teamsweb.driveItem' },
    ]);
    expect(out.results).toEqual([
      { externalId: 'x', status: 'failed', error: 'no on-request read for teamsweb.driveItem' },
      { externalId: 'gone', status: 'notFound' },
    ]);
    h.client.workComplete = false;
    const partial = await h.adapter.fetchDetails([{ externalId: 'gone' }]);
    expect(partial.results[0]).toMatchObject({ status: 'failed' });
  });
});
