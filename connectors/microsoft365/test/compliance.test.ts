import { testConnectorCompliance } from '@unicontext/connector-sdk/testing';
import type { RawItem } from '@unicontext/connector-sdk';
import { createMicrosoft365Normalizer, metadata } from '../src/index.js';
import { CH_DB_GENERAL, FakeGraph, fixtureValues, setup, SELF_ID, TEAM_DB } from './helpers.js';

// Raw fixtures run through the normalizer in addition to what the fixture-backed adapter returns.
const rawFixtures: RawItem[] = [
  ...(fixtureValues('channel-messages.json') as { id: string }[]).map((m) => ({
    sourceType: 'graph.channelMessage',
    externalId: `${TEAM_DB}/${CH_DB_GENERAL}/${m.id}`,
    payload: { ...m, _context: { teamId: TEAM_DB, channelId: CH_DB_GENERAL, selfUserId: SELF_ID } },
  })),
  ...(fixtureValues('channel-messages-incremental.json') as { id: string; '@removed'?: unknown }[])
    .filter((m) => !m['@removed'])
    .map((m) => ({
      sourceType: 'graph.channelMessage',
      externalId: `${TEAM_DB}/${CH_DB_GENERAL}/${m.id}`,
      payload: {
        ...m,
        _context: { teamId: TEAM_DB, channelId: CH_DB_GENERAL, selfUserId: SELF_ID },
      },
    })),
];

testConnectorCompliance('microsoft365', {
  metadata,
  sourceId: 'm365',
  rawFixtures,
  createAdapter: async () => {
    const { adapter } = await setup({
      graph: new FakeGraph(),
      config: { resources: { channelMessages: true } },
    });
    return adapter;
  },
  normalizer: createMicrosoft365Normalizer(),
});
