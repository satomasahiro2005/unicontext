import { defineMetadata } from '@unicontext/connector-sdk';
import { ALL_RAW_TYPES } from './core/schemas.js';
import { TESTED_FINGERPRINT } from './core/version.js';

export const PRODUCT = 'livecampusu';

/** §55 + §27: unofficial, unsupported; tested against the 静岡大学 deployment (2026-10-01). */
export const metadata = defineMetadata({
  name: '@unicontext/livecampusu',
  product: PRODUCT,
  version: '1.0.0',
  license: 'MIT',
  description:
    'LiveCampusU / LCU-Web (学務情報システム): timetable, rooms, notices (休講・補講・試験・教室変更), assignments, exams, calendar, attendance, optional grades. Browser SSO login, plain-HTTP read-only replay.',
  capabilities: [
    'courses',
    'enrollments',
    'timetable',
    'rooms',
    'announcements',
    'assignments',
    'submissions',
    'exams',
    'calendar',
    'grades',
  ],
  adapter: 'native',
  apiStability: 'unofficial',
  risk: 'unsupported',
  testedVersion: TESTED_FINGERPRINT,
  defaultAuthority: 'academic-system',
  sourceLabel: '学務情報システム',
  defaultSchedule: '15m',
  rawTypes: ALL_RAW_TYPES,
});
