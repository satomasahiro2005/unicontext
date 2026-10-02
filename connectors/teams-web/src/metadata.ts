import { defineMetadata } from '@unicontext/connector-sdk';
import { RAW_TYPES } from './schemas.js';

export const PRODUCT = 'teams-web';
/** Teams web client generation the connector was tested against (2026-10-02). */
export const TESTED_VERSION = 'v2';

/**
 * Unofficial and unsupported (§27, §55): it observes the official Teams web client (its own cache
 * and the responses it receives) and reads SharePoint's documented drive API from the team site.
 */
export const metadata = defineMetadata({
  name: '@unicontext/teams-web',
  product: PRODUCT,
  version: '1.0.0',
  license: 'MIT',
  description:
    'Microsoft Teams through the official web client in the UniContext browser profile: class teams, channel posts and replies, Assignments (課題) and the teams’ SharePoint files. Read-only.',
  capabilities: ['courses', 'announcements', 'messages', 'materials', 'assignments', 'submissions'],
  adapter: 'browser',
  apiStability: 'unofficial',
  risk: 'unsupported',
  testedVersion: TESTED_VERSION,
  defaultAuthority: 'collaboration',
  sourceLabel: 'Teams',
  defaultSchedule: '30m',
  rawTypes: [...RAW_TYPES],
});
