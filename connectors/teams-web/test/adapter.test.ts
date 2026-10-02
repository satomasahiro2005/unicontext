import type { SyncResult } from '@unicontext/connector-sdk';
import { AuthRequiredError } from '@unicontext/core';
import { describe, expect, it } from 'vitest';
import {
  buildTeams,
  emptyState,
  planChannels,
  resolveProfileDir,
  TeamsWebConfigSchema,
} from '../src/index.js';
import {
  CARD_ASSIGNMENT,
  CH_MATERIALS,
  CH_QUESTIONS,
  CLASS_GROUP,
  FakeTeamsClient,
  harness,
  LAB_TEAM_ID,
  SITE,
  TEAM_ID,
} from './helpers.js';

const types = (r: SyncResult) =>
  r.items.reduce<Record<string, number>>((acc, i) => {
    acc[i.sourceType] = (acc[i.sourceType] ?? 0) + 1;
    return acc;
  }, {});

describe('teams-web adapter', () => {
  it('reads teams, channels, posts, assignments and files in one polite run', async () => {
    const { adapter, client, clock } = harness();
    const r = await adapter.sync({ mode: 'initial' });
    expect(types(r)).toEqual({
      'teamsweb.assignment': 3,
      'teamsweb.replychain': 5,
      'teamsweb.driveItem': 3,
      'teamsweb.team': 2,
    });
    // one channel at a time, every channel of both teams (General + 2 live channels + lab General)
    expect(client.opened).toEqual([CH_MATERIALS, TEAM_ID, CH_QUESTIONS, LAB_TEAM_ID]);
    // paused after each channel
    expect(clock.slept.filter((ms) => ms === 10)).toHaveLength(4);
    expect(r.productVersion).toEqual({ product: 'teams-web', version: 'v2' });
    expect(r.complete?.sourceTypes.sort()).toEqual([
      'teamsweb.assignment',
      'teamsweb.driveItem',
      'teamsweb.team',
    ]);
    expect(adapter.lastRunCounts).toMatchObject({
      teams: 2,
      channels: 4,
      channelsRead: 4,
      assignments: 3,
      files: 3,
    });
    // nothing that could authenticate a request is stored
    expect(JSON.stringify(r.items)).not.toMatch(/tempauth|downloadUrl|skypetoken/i);
    const state = r.cursor?.extra as { drives: Record<string, string> };
    expect(state.drives[CLASS_GROUP]).toContain('SYNTHETIC-DELTA-1');
    expect(JSON.parse(JSON.stringify(r.cursor))).toEqual(r.cursor);
  });

  it('skips unchanged channels, reads changed ones and continues with the delta link', async () => {
    const { adapter, client } = harness({ config: { revisitPerRun: 0 } });
    const first = await adapter.sync({ mode: 'initial' });
    client.opened = [];
    // a new post in 質問
    const q = client.conv.topics.find((t) => t.id === CH_QUESTIONS);
    if (q) q.lastMessageTimeUtc = 1799999999999;
    const second = await adapter.sync({
      mode: 'incremental',
      ...(first.cursor ? { cursor: first.cursor } : {}),
    });
    expect(client.opened).toEqual([CH_QUESTIONS]);
    expect(client.deltaCalls.at(-2)?.deltaLink).toContain('SYNTHETIC-DELTA-1');
    // the deleted file is reported, the new one stored
    expect(second.deletions).toEqual([
      { sourceType: 'teamsweb.driveItem', externalId: `${CLASS_GROUP}/01FILEROOT` },
      // its text, if any was extracted (sync, on-demand download or mirror), goes with it
      { sourceType: 'teamsweb.fileText', externalId: `${CLASS_GROUP}/01FILEROOT` },
    ]);
    expect(
      second.items.filter((i) => i.sourceType === 'teamsweb.driveItem').map((i) => i.externalId),
    ).toEqual([`${CLASS_GROUP}/01FILEWEEK2`]);
    // an incremental listing never completes the file type (that would delete unlisted files)
    expect(second.complete?.sourceTypes).not.toContain('teamsweb.driveItem');
  });

  it('caps channels per run and resumes with the rest next time', async () => {
    const { adapter, client } = harness({ config: { maxChannelsPerRun: 2, revisitPerRun: 0 } });
    const first = await adapter.sync({ mode: 'initial' });
    expect(client.opened).toEqual([CH_MATERIALS, TEAM_ID]);
    client.opened = [];
    await adapter.sync({ mode: 'incremental', ...(first.cursor ? { cursor: first.cursor } : {}) });
    expect(client.opened).toEqual([CH_QUESTIONS, LAB_TEAM_ID]);
  });

  it('revisits a few unchanged channels, least recently read first', () => {
    const teams = buildTeams(new FakeTeamsClient().conv);
    const state = emptyState();
    for (const t of teams)
      for (const c of t.channels)
        state.channels[c.id] = {
          last: c.last,
          visitedAt: c.id === CH_QUESTIONS ? '2026-01-01' : '2026-10-01',
        };
    const plan = planChannels(teams, state, { maxChannelsPerRun: 5, revisitPerRun: 1 });
    expect(plan.map((p) => [p.channel.id, p.reason])).toEqual([[CH_QUESTIONS, 'revisit']]);
  });

  it("keeps an Assignments card only while the service has not listed the student's work completely", async () => {
    const { adapter, client } = harness();
    client.workComplete = false;
    client.work = client.work.filter((w) => w.id !== CARD_ASSIGNMENT);
    const first = await adapter.sync({ mode: 'initial' });
    expect(
      first.items
        .filter((i) => i.sourceType === 'teamsweb.assignmentCard')
        .map((i) => i.externalId),
    ).toEqual([CARD_ASSIGNMENT]);
    // the service now answers completely: the card goes
    client.workComplete = true;
    const t = client.conv.spaces.find((s) => s.id === TEAM_ID);
    if (t) t.lastMessageTimeUtc = 1799999999999;
    const second = await adapter.sync({
      mode: 'incremental',
      ...(first.cursor ? { cursor: first.cursor } : {}),
    });
    expect(second.items.some((i) => i.sourceType === 'teamsweb.assignmentCard')).toBe(false);
    expect(second.deletions).toContainEqual({
      sourceType: 'teamsweb.assignmentCard',
      externalId: CARD_ASSIGNMENT,
    });
  });

  it('marks old content seen for the first time as backfill (not news)', async () => {
    const { adapter, client, clock } = harness({
      config: { maxChannelsPerRun: 1, revisitPerRun: 0 },
    });
    const first = await adapter.sync({ mode: 'initial' });
    clock.set(new Date('2026-10-12T00:00:00Z'));
    // the very first Assignments read is a backfill
    expect(
      first.items.filter((i) => i.sourceType === 'teamsweb.assignment').every((i) => i.backfill),
    ).toBe(true);
    const second = await adapter.sync({
      mode: 'incremental',
      ...(first.cursor ? { cursor: first.cursor } : {}),
    });
    // General is read for the first time now; its posts are months old
    expect(client.opened.at(-1)).toBe(TEAM_ID);
    const chains = second.items.filter((i) => i.sourceType === 'teamsweb.replychain');
    expect(chains.length).toBeGreaterThan(0);
    expect(chains.every((i) => i.backfill)).toBe(true);
    expect(
      second.items.filter((i) => i.sourceType === 'teamsweb.assignment').some((i) => i.backfill),
    ).toBe(false);
  });

  it('lists every file again when the delta link expired', async () => {
    const { adapter, client } = harness();
    const first = await adapter.sync({ mode: 'initial' });
    client.expiredLink = true;
    const second = await adapter.sync({
      mode: 'incremental',
      ...(first.cursor ? { cursor: first.cursor } : {}),
    });
    const siteCalls = client.deltaCalls.filter((c) => c.siteUrl === SITE).slice(-2);
    expect(siteCalls.map((c) => c.deltaLink === undefined)).toEqual([false, true]);
    expect(second.items.filter((i) => i.sourceType === 'teamsweb.driveItem')).toHaveLength(3);
  });

  it('extracts text only when enabled, size-capped and once per file version', async () => {
    const extracted: string[] = [];
    const { adapter, client } = harness({
      config: { files: { extractText: true, maxExtractBytes: 100_000 } },
      extract: (data, ext) => {
        extracted.push(ext);
        return Promise.resolve({ text: new TextDecoder().decode(data) });
      },
    });
    client.files['01FILESLIDES'] = new TextEncoder().encode('第1回 ERモデル');
    client.files['01FILEROOT'] = new TextEncoder().encode('シラバス本文');
    const first = await adapter.sync({ mode: 'initial' });
    // week1.pdf (123 456 bytes) is over the cap
    expect(client.downloads.sort()).toEqual(['01FILEROOT', '01FILESLIDES']);
    expect(extracted.sort()).toEqual(['docx', 'pptx']);
    expect(
      first.items
        .filter((i) => i.sourceType === 'teamsweb.fileText')
        .map((i) => i.externalId)
        .sort(),
    ).toEqual([`${CLASS_GROUP}/01FILEROOT`, `${CLASS_GROUP}/01FILESLIDES`]);
    client.downloads = [];
    await adapter.sync({ mode: 'full', ...(first.cursor ? { cursor: first.cursor } : {}) });
    expect(client.downloads).toEqual([]);
  });

  it('does not download anything when text extraction is off (default)', async () => {
    const { adapter, client } = harness();
    await adapter.sync({ mode: 'initial' });
    expect(client.downloads).toEqual([]);
  });

  it('reports a needed sign-in as auth_required and never treats an empty client as "no teams"', async () => {
    const auth = harness({ auth: { status: 'auth_required', message: 'sign in' } });
    await expect(auth.adapter.sync({ mode: 'initial' })).rejects.toBeInstanceOf(AuthRequiredError);
    expect((await auth.adapter.health()).state).toBe('auth_required');

    const failing = harness();
    failing.client.failOpen = new AuthRequiredError('Microsoft sign-in required');
    await expect(failing.adapter.sync({ mode: 'initial' })).rejects.toBeInstanceOf(
      AuthRequiredError,
    );

    const empty = harness();
    empty.client.conv.spaces = [];
    await expect(empty.adapter.sync({ mode: 'initial' })).rejects.toThrow(/no teams/);

    expect((await harness({ profileExists: false }).adapter.authenticate()).status).toBe(
      'auth_required',
    );
    expect((await harness().adapter.authenticate()).status).toBe('authenticated');
  });

  it('does not delete teams when the list suddenly shrinks', async () => {
    const { adapter, client } = harness();
    client.conv.spaces.push(
      ...[1, 2, 3].map((n) => ({
        id: `19:${String(n).repeat(32)}@thread.tacv2`,
        threadProperties: {
          groupId: `00000000-0000-4000-8000-00000000000${n}`,
          spaceThreadTopic: `T${n}`,
          spaceType: 'edu',
          topics: '[]',
        },
      })),
    );
    const first = await adapter.sync({ mode: 'initial' });
    client.conv.spaces = client.conv.spaces.slice(0, 1);
    const second = await adapter.sync({
      mode: 'incremental',
      ...(first.cursor ? { cursor: first.cursor } : {}),
    });
    expect(second.complete?.sourceTypes ?? []).not.toContain('teamsweb.team');
    expect(second.warnings?.join(' ')).toMatch(/shrank/);
  });

  it('uses the shared browser profile of another source by default', () => {
    const cfg = TeamsWebConfigSchema.parse({});
    expect(resolveProfileDir('teams-web', cfg, '/data/cache/teams-web').replace(/\\/g, '/')).toBe(
      '/data/cache/livecampusu/browser-profile',
    );
    expect(
      resolveProfileDir('teams-web', cfg, '/data/cache/teams-web', 'other').replace(/\\/g, '/'),
    ).toBe('/data/cache/other/browser-profile');
    expect(
      resolveProfileDir(
        'teams-web',
        TeamsWebConfigSchema.parse({ browser: { profileDir: '/p' } }),
        '/x',
      ),
    ).toBe('/p');
  });
});
