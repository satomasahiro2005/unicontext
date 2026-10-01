import { PolicyViolationError } from '@unicontext/core';

/**
 * Hard-coded request policy of the LiveCampusU HTTP layer (§27, §50, §51). It is product logic and
 * deliberately NOT configurable: neither the deployment profile nor the source config can relax
 * it (profile screen ids are only ever ADDED to the deny sets). Every request — including each hop
 * of a redirect chain — is checked before any fetch happens.
 *
 * Denied:
 * - state-changing actions: ToDo/read marks (`toDoIcon`, `readMark`, `addTodo`), schedule writes
 *   (`scheduleAdd`), file export (`…report`), submissions/uploads (`…submit…`, `upload`),
 *   registration/application verbs, logout (`lcuLogout`, `beforeLogoutProcess` — logging out
 *   would end the user's browser session; local logout only forgets cookies), locale switching,
 *   the hidden local login (`webLogin`), and `importantNoticeLink` / `submissionInformationLink`
 *   (they open items without a read-state proof);
 * - whole screens: 課題提出 (SC_14002B00_03), 履修登録 (SC_07002B00_*), 予約申込 (SC_18001B00_04);
 * - row transitions (`rowSelect` / `rowselect` / `linkselect`) and the notice detail screen,
 *   unless the caller holds the notice-detail grant (issued only for rows the list shows as READ —
 *   opening an unread notice marks it read);
 * - grade screens unless grades were enabled in the config (opt-in).
 */

/** Action segments (case-insensitive, full segment) that are never requested. */
const DENIED_ACTION_PATTERNS: readonly RegExp[] = [
  /todo/i,
  /^readmark$/i,
  /^scheduleadd$/i,
  /report$/i,
  /submit/i,
  /upload/i,
  /logout/i,
  /^changelocale$/i,
  /^weblogin$/i,
  /^importantnoticelink$/i,
  /^submissioninformationlink$/i,
  /^(regist|register|entry|apply|save|update|delete|remove|send|cancel|confirm|complete|decide|commit)/i,
];

/** Screen ids that are never requested (product screen ids of LiveCampusU). */
const DENIED_SCREEN_PATTERNS: readonly RegExp[] = [
  /^SC_14002B00_03$/, // 課題・アンケート提出
  /^SC_07002B00_\d{2}$/, // 履修登録
  /^SC_18001B00_04$/, // 予約申込
];

const ROW_TRANSITION = /^(rowselect|linkselect)$/i;
const DEFAULT_NOTICE_DETAIL_SCREENS = ['SC_17001B00_02'];
const DEFAULT_GRADE_SCREENS = ['SC_10004B00_01', 'SC_15005B00_01'];
const GRADE_ACTIONS = /^(grede|grade)information$/i;

export type PolicyGrant = 'notice-detail';

export interface PolicyContext {
  gradesEnabled: boolean;
  grant?: PolicyGrant | undefined;
  /** Deployment screen ids, added to the built-in sets (never removing anything). */
  extraDeniedScreens?: readonly string[];
  noticeListScreen?: string;
  noticeDetailScreen?: string;
  gradeScreens?: readonly string[];
}

/**
 * Throws PolicyViolationError when the request is not allowed. `path` is relative to the LCU base
 * URL (query string allowed; `;jsessionid=` is ignored).
 */
export function assertRequestAllowed(method: string, path: string, ctx: PolicyContext): void {
  const clean = path.replace(/;jsessionid=[^/?#]*/gi, '').replace(/[?#].*$/, '');
  // Normalize the way a servlet container does before matching: path parameters (`;x=y`) are
  // dropped from every segment, and an encoded separator (%2F, %5C) is treated as a separator,
  // so `SC_14002B00_03;x/init` or `SC_14002B00_03%2Finit` cannot slip past the screen rules.
  const segments = clean
    .split('/')
    .flatMap((raw) => safeDecode(raw.replace(/;.*$/, '')).split(/[/\\]/))
    .map((seg) => seg.replace(/;.*$/, ''))
    .filter(Boolean);
  const deny = (why: string): never => {
    throw new PolicyViolationError(
      `LiveCampusU request blocked by the read-only policy: ${method.toUpperCase()} ${clean} (${why})`,
      { details: { method: method.toUpperCase(), path: clean } },
    );
  };
  if (segments.some((s) => s === '..' || s === '.')) deny('path traversal');
  const extraScreens = new Set(ctx.extraDeniedScreens ?? []);
  const noticeDetailScreens = new Set([
    ...DEFAULT_NOTICE_DETAIL_SCREENS,
    ...(ctx.noticeDetailScreen ? [ctx.noticeDetailScreen] : []),
  ]);
  const gradeScreens = new Set([...DEFAULT_GRADE_SCREENS, ...(ctx.gradeScreens ?? [])]);

  for (const [i, seg] of segments.entries()) {
    const isScreen = /^SC_[A-Za-z0-9]{8}_\d{2}$/.test(seg);
    if (isScreen) {
      if (DENIED_SCREEN_PATTERNS.some((re) => re.test(seg)) || extraScreens.has(seg))
        deny(`screen ${seg} is a write/submission screen`);
      if (gradeScreens.has(seg) && !ctx.gradesEnabled)
        deny('grades are disabled (set `grades: true` in the source config to opt in)');
      if (noticeDetailScreens.has(seg)) {
        const action = segments[i + 1];
        // Leaving the detail screen ("back") is fine; showing it requires the grant.
        if (!(action && /^back$/i.test(action)) && ctx.grant !== 'notice-detail')
          deny('notice details may only be opened through the read-state-checked transition');
      }
      continue;
    }
    if (i === 0 && segments.length === 1 && /\.(js|css|png|svg|gif|jpe?g|woff2?)$/i.test(seg))
      continue;
    if (DENIED_ACTION_PATTERNS.some((re) => re.test(seg))) deny(`action "${seg}" changes state`);
    if (GRADE_ACTIONS.test(seg) && !ctx.gradesEnabled)
      deny('grades are disabled (set `grades: true` in the source config to opt in)');
    if (ROW_TRANSITION.test(seg)) {
      const screen = segments[i - 1];
      const isNoticeList =
        screen !== undefined &&
        (screen === (ctx.noticeListScreen ?? 'SC_17001B00_01') || screen === 'SC_17001B00_01');
      if (!isNoticeList || ctx.grant !== 'notice-detail')
        deny('row transitions are only allowed for read notices via openNoticeDetail()');
    }
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
