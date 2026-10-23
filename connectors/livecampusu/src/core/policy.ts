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
 *   opening an unread notice marks it read) or the notice-detail-on-demand grant (issued only by
 *   LcuSession.openNoticeOnDemand(): the user explicitly asked to fetch these unread notices and
 *   accepted that LCU marks them read; never during a sync);
 * - grade screens unless grades were enabled in the config (opt-in).
 *
 * `readMark` stays denied with every grant. It only ever marks rows READ (observed 2026-10-02: a
 * POST with a read row checked leaves it read; there is no 未読にする button on the list or the
 * detail screen), so it cannot restore a notice to unread and has no use for this connector.
 *
 * One narrow exception to the `upload` rule: with the `notice-attachments` grant (issued by
 * LcuSession.loadNoticeAttachments() while the detail of a READ notice is open), exactly
 * `POST fileUpload/load/<id>` is allowed — the read-only file-list call the detail screen makes on
 * every view. And with the `notice-attachment-download` grant (issued by
 * LcuSession.downloadNoticeAttachment() while a notice detail is open, on the student's request for
 * that file), exactly `GET fileUpload/download/<prefix>/<temporaryId>/` — what the detail screen's
 * file link fetches. Uploads and deletes (fileUpload / fileUploadDb) stay denied.
 *
 * Assignments (課題・アンケート): with the `assignment-detail` grant (issued only by
 * LcuSession.openAssignmentDetail() while the assignment list is the current screen), exactly
 * `POST <assignment list>/rowselect` and then the plain `GET` of the detail screen (SC_14002B00_02)
 * or of the submission screen (SC_14002B00_03) the row redirects to — nothing after the screen id.
 * A row that still accepts submissions only shows its 本文 and 参考資料 on the submission screen;
 * the GET is what displaying it costs, and no script runs over plain HTTP. Every action on that
 * screen (submit, upload, the student's own file area) stays denied. The `assignment-attachments`
 * and `assignment-attachment-download` grants mirror the notice ones for the 参考資料 widget of the
 * assignment screen that is open.
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
const DEFAULT_GRADE_SCREENS = ['SC_10004B00_01', 'SC_10004B00_02', 'SC_15005B00_01'];
const GRADE_ACTIONS = /^(grede|grade)information$/i;

export type PolicyGrant =
  | 'notice-detail'
  | 'notice-detail-on-demand'
  | 'notice-attachments'
  | 'notice-attachment-download'
  | 'assignment-detail'
  | 'assignment-attachments'
  | 'assignment-attachment-download';

const NOTICE_DETAIL_GRANTS: ReadonlySet<PolicyGrant | undefined> = new Set([
  'notice-detail',
  'notice-detail-on-demand',
]);
const ATTACHMENT_LIST_GRANTS: ReadonlySet<PolicyGrant | undefined> = new Set([
  'notice-attachments',
  'assignment-attachments',
]);
const ATTACHMENT_DOWNLOAD_GRANTS: ReadonlySet<PolicyGrant | undefined> = new Set([
  'notice-attachment-download',
  'assignment-attachment-download',
]);
const DEFAULT_ASSIGNMENT_LIST_SCREEN = 'SC_14002B00_01';
const DEFAULT_ASSIGNMENT_READ_SCREENS = ['SC_14002B00_02', 'SC_14002B00_03'];

/** `fileUpload/load/<id>`: the only fileUpload* call ever made (notice-attachments grant). */
const ATTACHMENT_LIST_PATH = /^fileUpload\/load\/[A-Za-z0-9]{1,16}$/;
/** `fileUpload/download/<prefix>/<temporaryId>`: one attachment (notice-attachment-download grant). */
const ATTACHMENT_DOWNLOAD_PATH =
  /^fileUpload\/download\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,128}$/;

export interface PolicyContext {
  gradesEnabled: boolean;
  grant?: PolicyGrant | undefined;
  /** Deployment screen ids, added to the built-in sets (never removing anything). */
  extraDeniedScreens?: readonly string[];
  noticeListScreen?: string;
  noticeDetailScreen?: string;
  gradeScreens?: readonly string[];
  assignmentListScreen?: string;
  /** Screens an assignment row opens (detail, submission), shown with the assignment-detail grant. */
  assignmentReadScreens?: readonly string[];
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
  if (
    ATTACHMENT_LIST_GRANTS.has(ctx.grant) &&
    method.toUpperCase() === 'POST' &&
    ATTACHMENT_LIST_PATH.test(segments.join('/')) &&
    segments.join('/') === clean.replace(/^\/+/, '')
  )
    return;
  if (
    ATTACHMENT_DOWNLOAD_GRANTS.has(ctx.grant) &&
    method.toUpperCase() === 'GET' &&
    ATTACHMENT_DOWNLOAD_PATH.test(segments.join('/')) &&
    segments.join('/') === clean.replace(/^\/+|\/+$/g, '')
  )
    return;
  const extraScreens = new Set(ctx.extraDeniedScreens ?? []);
  const noticeDetailScreens = new Set([
    ...DEFAULT_NOTICE_DETAIL_SCREENS,
    ...(ctx.noticeDetailScreen ? [ctx.noticeDetailScreen] : []),
  ]);
  const gradeScreens = new Set([...DEFAULT_GRADE_SCREENS, ...(ctx.gradeScreens ?? [])]);
  const assignmentList = ctx.assignmentListScreen ?? DEFAULT_ASSIGNMENT_LIST_SCREEN;
  // Showing an assignment's screen: the bare GET the row transition redirects to, nothing more.
  const assignmentScreenRead =
    ctx.grant === 'assignment-detail' &&
    method.toUpperCase() === 'GET' &&
    segments.length === 1 &&
    [...DEFAULT_ASSIGNMENT_READ_SCREENS, ...(ctx.assignmentReadScreens ?? [])].includes(
      segments[0] as string,
    );

  for (const [i, seg] of segments.entries()) {
    const isScreen = /^SC_[A-Za-z0-9]{8}_\d{2}$/.test(seg);
    if (isScreen) {
      if (
        !assignmentScreenRead &&
        (DENIED_SCREEN_PATTERNS.some((re) => re.test(seg)) || extraScreens.has(seg))
      )
        deny(`screen ${seg} is a write/submission screen`);
      if (gradeScreens.has(seg) && !ctx.gradesEnabled)
        deny('grades are disabled (set `grades: true` in the source config to opt in)');
      if (noticeDetailScreens.has(seg)) {
        const action = segments[i + 1];
        // Leaving the detail screen ("back") is fine; showing it requires the grant.
        if (!(action && /^back$/i.test(action)) && !NOTICE_DETAIL_GRANTS.has(ctx.grant))
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
      const isAssignmentRow =
        screen === assignmentList &&
        i === 1 &&
        segments.length === 2 &&
        method.toUpperCase() === 'POST' &&
        ctx.grant === 'assignment-detail';
      if (isAssignmentRow) continue;
      if (!isNoticeList || !NOTICE_DETAIL_GRANTS.has(ctx.grant))
        deny(
          'row transitions are only allowed for read notices via openNoticeDetail() and assignments via openAssignmentDetail()',
        );
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
