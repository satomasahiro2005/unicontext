import { defineMetadata } from '@unicontext/connector-sdk';
import { RAW_TYPES } from './schemas.js';

export const PRODUCT = 'shizuoka-vpn-files';
/** Ivanti Connect Secure appliance generation the connector was written against (research 2026-10-05). */
export const TESTED_VERSION = '25.1.x';

/**
 * Unofficial and unsupported (§27, §55): it reads the Ivanti Connect Secure clientless portal's
 * file-browser JSON (`/api/v1/fb/list`) and SMB download CGI (`/dana/fb/smb/wfd.cgi`) through the
 * student's own signed-in browser session. Read-only: every non-GET to the portal is blocked, and
 * the list endpoint is flaky (research §3.4), so a failed or empty listing is never a deletion.
 */
export const metadata = defineMetadata({
  name: '@unicontext/shizuoka-vpn-files',
  product: PRODUCT,
  version: '1.0.0',
  license: 'MIT',
  description:
    '静岡大学 情報学部の SSL-VPN ポータル（Ivanti Connect Secure）の Windows ファイル共有（講義資料など）を、本人のログイン済みセッションで読み取り専用に索引・ダウンロードする。 / The Faculty of Informatics SSL-VPN portal Windows file share (lecture materials), indexed and downloaded read-only through the student’s own session.',
  capabilities: ['materials'],
  adapter: 'browser',
  apiStability: 'unofficial',
  risk: 'unsupported',
  testedVersion: TESTED_VERSION,
  defaultAuthority: 'collaboration',
  sourceLabel: 'VPNファイル共有',
  // The listing is flaky and the session caps at 60 min; walk rarely and off-hours.
  defaultSchedule: '1d',
  rawTypes: [...RAW_TYPES],
});
