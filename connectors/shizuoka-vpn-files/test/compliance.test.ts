import { testConnectorCompliance } from '@unicontext/connector-sdk/testing';
import { createShizuokaVpnFilesNormalizer, metadata } from '../src/index.js';
import { harness } from './helpers.js';

testConnectorCompliance('shizuoka-vpn-files', {
  metadata,
  sourceId: 'shizuoka-vpn-files',
  createAdapter: () => harness().adapter,
  normalizer: createShizuokaVpnFilesNormalizer(),
});
