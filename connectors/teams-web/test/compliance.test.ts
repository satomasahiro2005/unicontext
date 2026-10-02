import { testConnectorCompliance } from '@unicontext/connector-sdk/testing';
import { createTeamsWebNormalizer, metadata } from '../src/index.js';
import { harness } from './helpers.js';

testConnectorCompliance('teams-web', {
  metadata,
  sourceId: 'teams-web',
  createAdapter: () => harness().adapter,
  normalizer: createTeamsWebNormalizer(),
});
