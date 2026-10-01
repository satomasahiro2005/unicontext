import type { PortalDeployment } from './types.js';

/**
 * Shizuoka University 学生教務ポータル (docs/research/shizuoka.md §4): WordPress 5.2 with the REST
 * API enabled. Faculty pages carry the timetable / exam / calendar PDFs; which faculty page to
 * watch depends on the user, so pages are listed as examples, not applied automatically.
 */
export const shizuokaPortal: PortalDeployment = {
  id: 'shizuoka',
  baseUrl: 'https://wwp.shizuoka.ac.jp/acad-affairs-portal/',
  label: '学生教務ポータル',
  exampleWatchPages: ['https://wwp.shizuoka.ac.jp/acad-affairs-portal/student_e/inf'],
};
