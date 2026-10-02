# livecampusu (`@unicontext/livecampusu`)

Spec: §5, §6, §26 (product / deployment / auth separated), §27 (unofficial API), §35–§38, §50/§51
(read-only), §55, §60, §65, §72 (product version), §73 (schema drift).
Research: [shizuoka.md](../research/shizuoka.md) §1, §7.

## Purpose

First-class connector for **LiveCampusU / LCU-Web** (学務情報システム). It reads the student's own
timetable (rooms, periods), enrolled courses, notices (授業連絡・学内連絡 including 休講・補講・試験・
講義室変更), assignments / quizzes / questionnaires with submission state, the exam timetable, the
scheduler's holidays/events, deadline warnings, attendance counts and — only when enabled — grades.

How it works:

1. **Login in a browser** (`browser-sso` strategy, `@unicontext/adapter-browser`): a human signs in
   once (Shibboleth → Entra ID + MFA). The persistent browser profile keeps the IdP session; the LCU
   session cookie (`JSESSIONID`, path `/lcu-web`) is exported to the OS keychain (SecretStore),
   never to the database.
2. **Data over plain HTTP** (Node `fetch`, no browser): the connector replays LCU's form navigation
   (`POST <screen>/init` → 302 → `GET <screen>`) and the screen's JSON XHRs with that cookie.
3. JSON endpoints are used first; everything else is parsed from server-rendered HTML (cheerio).

Code layout: `src/core/` is product logic (no university ids/paths), `src/auth/` the strategies,
`src/profiles/shizuoka.ts` the 静岡大学 deployment profile.

## Setup

```yaml
# config.yaml
profile: shizuoka-university
sources:
  livecampusu:
    connector: livecampusu
    schedule: 15m # default
    # deployment: shizuoka      # default: products.livecampusu.deployment, else matched by profile id
    # grades: true              # opt-in (default false)
    # attendance: true
    # noticeDetails: true
    # maxNoticeDetailsPerRun: 300
    # academicYear: 2026        # default: current academic year (April start)
    # semesters: ['1', '2']     # default: all semesters of the deployment
    # minRequestIntervalMs: 1000
    # browser: { channel: msedge }   # or executablePath; default tries chrome, then msedge
```

Then log in once: `unicontext login livecampusu` (the host calls `adapter.login()`; a visible
Chrome/Edge window opens at the LCU top page, the connector presses the SSO button, the human
completes SSO + MFA, the Shibboleth attribute-release consent 「送信属性の選択」 is accepted
automatically with "remember"). `logout()` deletes the exported cookies and the browser profile
locally; it never calls LCU's logout.

University profile (`profiles/<id>/profile.yaml`) keys read from `products.livecampusu`:
`deployment`, `auth`, `allowLocalAccount`, and the per-key deployment overrides `baseUrl`,
`idpHosts`, `maintenanceWindow`, `idleTimeoutMinutes`, `screens`, `actions`, `endpoints`,
`contactTypes`, `semesters`. Period start/end times come from `academicCalendar.periods`
(period N = LCU pair index N, see below).

## Config keys

| Key                                                                                                                         | Default        | Meaning                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `deployment`                                                                                                                | profile        | Deployment profile key (`shizuoka`).                                                                                                       |
| `auth`                                                                                                                      | profile `auth` | `saml` / `entra` / `browser-sso` → browser SSO; `local` → local-account stub.                                                              |
| `allowLocalAccount`                                                                                                         | `false`        | Only with `auth: local`; still not implemented (see Auth).                                                                                 |
| `baseUrl`, `idpHosts`, `maintenanceWindow`, `idleTimeoutMinutes`                                                            | deployment     | Overrides.                                                                                                                                 |
| `academicYear`                                                                                                              | current        | Year for the assignment search and `getClassSubjectList`.                                                                                  |
| `semesters`                                                                                                                 | deployment     | Semester codes for timetable / exams / subject lists.                                                                                      |
| `grades`                                                                                                                    | `false`        | Read 成績 (`SC_15005B00_01` → `SC_10004B00_01`). Disabled ⇒ the HTTP layer refuses grade screens and previously synced grades are removed. |
| `attendance`                                                                                                                | `true`         | Read 出欠 counts (`SC_13002B00_01`).                                                                                                       |
| `noticeDetails`                                                                                                             | `true`         | Fetch body, sender, targets and attachment names of every READ notice (once, again when its row changes). Unread notices are never opened. |
| `maxNoticeDetailsPerRun`                                                                                                    | `300`          | Cap on detail transitions per run (newest first; covers the first backfill; progress is checkpointed after each notice).                   |
| `minRequestIntervalMs`                                                                                                      | `1000`         | Minimum gap between requests (on top of the source RateLimiter).                                                                           |
| `browser.channel` / `browser.executablePath` / `browser.profileDir` / `browser.loginTimeoutMs` / `browser.refreshTimeoutMs` | —              | Passed to adapter-browser. Profile dir defaults to `<cacheDir>/browser-profile`.                                                           |

## Auth

| Strategy        | Selected by                              | Behaviour                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser-sso`   | `saml`, `entra`, `browser-sso` (default) | `authenticate()` = stored cookies present (or one headless refresh if a profile exists); `login()` = visible browser; on session loss the HTTP layer calls `refresh()` once (headless, never prompts); failure ⇒ `AuthRequiredError` ⇒ health `auth_required`. Rotated cookies are written back to the SecretStore.                                         |
| `local-account` | `local`                                  | **Stub.** LCU still has a hidden local login form; posting it would bypass the university SSO/MFA, so it is not implemented. Reports `failed` ("disabled") unless `auth: local` and `allowLocalAccount: true`; then `failed` ("not implemented"), `login()` throws. It documents the extension point for institutions that officially issue local accounts. |

## HTTP layer (read-only by construction)

- **One request in flight** per session: every operation (including its redirects) runs in a
  promise-chain queue. LCU treats parallel use as "multiple tabs" and kills the session.
- Every fetch goes through the source `RateLimiter` (`createHttpClient`) plus `minRequestIntervalMs`.
- `redirect: 'manual'`; PRG 302s are followed by hand, Set-Cookie applied on each hop,
  `;jsessionid=` rewriting stripped (and adopted as a cookie if missing). Off-site redirects (IdP)
  mean the session is gone.
- `_csrf` and `_TRANSACTION_TOKEN` are taken from the **latest** HTML response and sent with the next
  form POST. JSON POSTs send `X-CSRF-TOKEN` and `_csrf` in the body
  (`Content-Type: application/json;charset=utf-8`).
- Session loss = login screen (`SC_01001B00_01` form / SSO button), error screen (`<title>error`,
  「処理を続行することができませんでした」), CSRF failure, 401/403, IdP redirect, or the 60-minute idle
  timeout (tracked with the clock, checked before the next request). One re-auth per run; the
  interrupted step restarts from its menu entry; a second loss ⇒ `AuthRequiredError`.
- **Hard-coded denylist** (`src/core/policy.ts`, not configurable; profile screen ids only add to
  it), checked before any fetch and on every redirect hop: `toDoIcon`, `readMark`, `addTodo`,
  `scheduleAdd`, any action ending in `report`, anything with `submit` / `upload`, registration-like
  verbs (`regist…`, `entry`, `apply`, `save`, `update`, `delete`, `send`, `confirm`, …), `lcuLogout` /
  `beforeLogoutProcess` / any `logout` (logout is local only), `webLogin`, `changeLocale`,
  `importantNoticeLink`, `submissionInformationLink`; screens 課題提出 `SC_14002B00_03`, 履修登録
  `SC_07002B00_*`, 予約 `SC_18001B00_04`; all row transitions (`rowSelect` / `rowselect` /
  `linkselect`) and the notice detail screen except through `openNoticeDetail()`; grade screens
  unless `grades: true`. Violations throw `PolicyViolationError`. The one exception to the `upload`
  rule: `POST fileUpload/load/<id>` (the detail screen's read-only file-list call) with the
  `notice-attachments` grant, which only `loadNoticeAttachments()` issues while a READ notice's
  detail is open; downloads, uploads and deletes stay denied.
- **Unread notices are never opened.** Opening a detail marks the notice read in LCU (observed
  2026-10-02 over plain HTTP: the row left the unread set), and LCU has **no way back to unread**:
  the list's only read action is 「既読にする」 (`SC_17001B00_01/readMark`, posts the checked
  `checkArray` row indexes of `TableForm`); posting it for a read row leaves it read, and neither
  the list nor the detail screen has a 未読にする button. So `readMark` stays denied with every
  grant (it could only ever make things worse), and bodies of unread notices are fetched after the
  student reads them in LCU. `openNoticeDetail(proof)` needs a proof built from the current list
  page; the session re-parses that page itself and refuses unread rows, unknown rows, stale list
  versions, or calls made while not on the list.
- **Read state** comes from the list's inline 「検索結果一覧の未読行のスタイル適用」 script, not from
  `tr.is-unread` (which every row carries): unread rows get `$("[_index='N']").css("font-weight",
"bold")`. This set equals the rows the 「未読のみ」 search returns (checked 2026-10-02, 167 = 167).
  A page without the script, or a row the script does not mention, counts as unread (fail-safe).

## Sync flow

1. `GET <landing>` (`SC_01002B00_00`): fresh tokens + version fingerprint.
2. JSON: `importantNotice`, `submissionInformation?mode=web`, `warningNoticeInformation`.
3. スケジュール (`SC_18001B00_01`, inline FullCalendar `events: [...]` parsed without eval) →
   時間割 (`timeTable`, then `change` per semester) → 試験時間割 (`testTimeTable`, `change` per
   semester; 「対象の科目はありません」 → none). The 時間割 page has three sections: the weekly grid
   (一般・抽選講義), **時間割外講義** (`#lecture2`) and **集中講義** (`#lecture3`), both lists of
   `li.stady-lecture-list-item` with the same `displayPopup(semester, kind 2|3, …, year, subject,
class)` arguments; off-grid courses become offerings with `scheduleType` `unscheduled` /
   `intensive` and no weekly slot. Every page shows the semester it lists (`a.is-active` 前期/後期);
   when it is not the requested one (a `change` that did not apply) that semester's rows are
   skipped with a warning and courses/exams are not marked complete, so 前期 rows can never be
   filed under 後期. Without `change` the screen opens on the current semester.
4. 課題・アンケートリスト (`init` + `search` for the year, all rows incl. hidden `submissionSeq`) and
   `getClassSubjectList` per semester (JSON POST).
5. 出欠 (`SC_13002B00_01`): the screen opens on the current semester only, so with
   `actions.attendanceSearch` + `forms.attendanceSearch` (Shizuoka: `SC_13002B00_01/search` with
   `subjectInfomationSearch.startYear/startSemester/classSubject`) each configured semester is
   searched. Rows are matched to offerings by the hidden `classSubjectCode` column when present,
   else by title (preferring the searched semester).
6. 連絡一覧 (`SC_17001B00_01`, all rows incl. hidden columns and read state). Details
   (`rowSelect` → `SC_17001B00_02` → [`fileUpload/load/<id>` when the row shows the attachment
   clip] → `back`) only for READ rows whose detail is missing or whose row hash changed
   (incremental), newest first, capped per run, strictly serial at `minRequestIntervalMs` (1 s).
   The detail gives 内容 (rich text → plain text with paragraph breaks, links kept), 連絡種別,
   講義名 (targets), 重要度, 連絡日時, 連絡元 (sender); the file-list JSON gives attachment names and
   sizes (`temporaryFileList[].physicalFileName/fileSize`; session-bound ids and download paths are
   not kept). Bodies are carried forward in `cursor.extra.notices` and checkpointed to
   `<cacheDir>/notice-details.json` after every notice, so a backfill that is cut off resumes where
   it stopped. Every notice gets `bodyStatus`: `fetched`, `notOpened` (unread in LCU) or `pending`
   (read, over this run's budget).
7. 成績 (only with `grades: true`): 成績ダッシュボード → 成績情報 (`SC_10004B00_01`), switched to the
   「履修中含む」 tab (`changeSeisekiKind`, `seisekiKind=1`) so registered courses without a grade are
   listed too, then 「単位修得情報照会」 (`SC_10004B00_01/forward` → `SC_10004B00_02`, requirement
   status). The grade list holds every attempt of every year on one page (failed ones and re-exams
   included); there is no year selector. If the tab switch does not apply, the default 修得成績 tab
   is used and a warning is reported.

A step that fails (non-auth) becomes a `SyncResult.warnings` entry and its types are not marked
complete, so nothing is deleted by mistake. Steps whose listing is complete set
`complete.sourceTypes` (vanished rows ⇒ deleted). The calendar literal is not guaranteed to be
complete (at Shizuoka it held the 祝日 of 2025–2027 and a few 行事), so `lcu.calendarEvent` is never
"complete". 祝日 (`listType: Holiday`) stop generated weekly classes (see ARCHITECTURE §3.10
`ClassSchedule`). The whole run is one page (a few dozen requests).

**Nightly maintenance**: inside `maintenanceWindow` (profile timezone) `sync()` throws
`OfflineError` without any request and `health()` reports `offline`. The Shizuoka window
`01:00-06:00` is a conservative guess (the FAQ gives no time).

**Product version (§72)**: `lcu-web+jq<ver>+jqui<ver>+dt<ver>+dz<ver>+modaal<ver>` from the bundled
plugin folders on the landing page. When that fingerprint is new (or none is stored), `js/common.js`
is fetched once; a size/hash different from the deployment profile appends `+commonjs-<size>-<sha8>`.
Tested: `lcu-web+jq3.5.1+jqui1.12.1+dt1.10.20+dz5.7.0+modaal0.4.4` (`metadata.testedVersion`);
anything else ⇒ `SyncResult.productVersion` ⇒ the engine marks the source `degraded`.
`detectProductVersion()` returns the last detected value.

## Raw types → canonical

Product `livecampusu`, label 学務情報システム, default authority `academic-system`. Every entity
ref has `url` = base + screen id and `location.selector` = `<screen id> <selector>`.

| Raw type (externalId)                             | Source                                                                       | Canonical                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lcu.course` (`<year>-<subjectCode>-<classCode>`) | timetable cells + `getClassSubjectList`                                      | `course` (8-digit `courseCode`), `courseOffering` (year, term 前期/後期, teachers, `schedule[]` {dayOfWeek 月=1…日=0, period, start/end from profile, room}, `scheduleType` regular / unscheduled (時間割外講義) / intensive (集中講義), `room`, `extra` {classCode, className, numbering, credits, campus, retake (class name 再履修…)}), `enrollment` (self), `person` self (`name: 本人`, no real name)                                                                                                                                                                                                                                                                                                                                                                                                                            | room → authoritative `room` fact                                                                                                                                                                                                                                                                                                                                                                                     |
| `lcu.notice` (`n-<hash(date,type,title)>`)        | `importantNotice` JSON merged with the list row (+ detail body when fetched) | `announcement` (category = type title, importance by `classifyNoticeImportance` (LCU sends importanceCategory 1 for every notice, so it is ignored): high for 休講・補講・試験・教室変更, 催促, course-linked and personal procedures, low for campaigns (就活, メルマガ, 調査 …), else normal; with a body, a title-neutral notice whose text is marked 【重要】 or asks for a personal procedure becomes high; scope course/university, `courseOfferingId` from the hidden subject code or by title; `body` = 内容, `authorName` = 連絡元, `extra`: `read` (LCU's read state), `bodyStatus`, `attachments` [{name, size}], `links`, `courses`, `targetDate`; with a body the reference points at the detail's 内容 cell. The task engine's deadline extractor runs over title + body (origin `extracted`, evidence = the sentence)) | U01 休講 → `classSession` `cancelled`; U02 補講 → `makeup`; U03 試験 → `exam` (targetDate, time from title if any); U04 講義室変更 → `classSession` `changed` + room (origin `extracted`) and a `room` fact on the offering {origin `extracted`, confidence 0.8, validFrom/validUntil = that day, evidence = title}. Period only when the subject text gives one period on that weekday. U23–U28 stay announcements. |
| `lcu.assignment` (`submissionSeq`)                | assignment list                                                              | `assignment` (availableFrom/dueAt from 「提出期間」, submissionType), `submission` (未提出 → `not_submitted`, 提出済 → `submitted`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | ref authority `submission-system` (LCU is the submission system for its own assignments)                                                                                                                                                                                                                                                                                                                             |
| `lcu.submissionInfo`                              | `submissionInformation?mode=web`                                             | none (raw + drift only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | shape unobserved; the assignment list is the full listing                                                                                                                                                                                                                                                                                                                                                            |
| `lcu.warningNotice` (`warningNoticeId`)           | `warningNoticeInformation` (opaque `warningNoticeRequestPath` dropped)       | `calendarEvent` per date (category 期限, all-day), `announcement` 「<name>: M月D日まで（状態）」 (high)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | year inferred from the fetch date                                                                                                                                                                                                                                                                                                                                                                                    |
| `lcu.calendarEvent`                               | scheduler `events`                                                           | `calendarEvent` (category = `listType`: Holiday / teachingevent)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `lcu.exam`                                        | 試験時間割                                                                   | `exam` (`final`, date + period times or explicit time, room)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | column layout unobserved (heuristic)                                                                                                                                                                                                                                                                                                                                                                                 |
| `lcu.attendance`                                  | 出欠                                                                         | fact `attendance` = {attended, absent, late, earlyLeave, excused, invalid, published} on the offering, authoritative                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `lcu.grade` (opt-in)                              | 成績情報 (one item per attempt)                                              | `grade` (score, letter, gradePoint, finalizedAt; `extra.evaluation` = label verbatim, `extra.outcome`, academicYear, term, credits, 科目区分, 成績マーカー)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | header 学籍番号/氏名 never parsed                                                                                                                                                                                                                                                                                                                                                                                    |

Never stored: `userInformation` (not requested at all), student id/name, cookies, tokens,
`warningNoticeRequestPath`.

**Schema drift (§73)**: every payload is compared with its zod schema (`src/core/schemas.ts`); the
JSON endpoint shapes (`importantNotice`, `getClassSubjectList`, `warningNoticeInformation`,
`submissionInformation`) are mirrored field by field, so added / missing / retyped fields show up
as drift findings (missing/mismatched ⇒ `degraded`).

## Limits / known issues

- Unofficial; observed on the 静岡大学 deployment on 2026-10-01 only. Unverified: the exact field
  encoding of the assignment search form, the `rowIndex`-only `rowSelect` body, the exam timetable
  columns, the `submissionInformation` item shape, the maintenance window time.
- Unread notices have no body (title, type and dates only, `bodyStatus: notOpened`) until the user
  reads them in LCU: opening them would mark them read and LCU cannot set them back to unread.
- Course matching for notices without a hidden subject code, assignments, exams and attendance is
  by title (+ class name) within the year's offerings; ambiguous titles stay unlinked.
- Timetable `room` is LCU's text as-is (e.g. 共通講義棟３１, full-width digits).
- A full refresh does not re-fetch notice details: they are kept in memory and in the
  `notice-details.json` checkpoint (the cursor is only passed in incremental mode).
- Calendar events are the current week only.

## Grades: evaluation labels and outcomes

Every grade keeps the evaluation label exactly as LCU shows it (`extra.evaluation`: 秀, 優, 良, 可,
不可, 合, 否, 再試 …) and a normalized `extra.outcome` from `classifyGradeLabel`
(`@unicontext/canonical-model`): `passed`, `failed`, `in_progress`, `not_graded`, `withdrawn`,
`transferred` (認定) or `unknown`. Only `passed` and `transferred` count as earned credits; a label
outside the tables stays `unknown` and is never counted as passed or failed. 再試 (failed the regular
exam, re-exam pending) is `not_graded` with `pendingReexam: true`; an interim result (yellow
background, 「中間点」) is `in_progress`. A re-exam row (試験種別 ≠ 本試験) has its own entity id.

単位修得情報 is stored as one `lcu.creditRequirements` raw item and normalized into a
`credit_requirements` fact on the student (requirement tree: 必要単位, 修得見込単位, 充足状況, and the
courses of each requirement with 合格/不合格).

The grade report (`buildGradeReport` in `@unicontext/context-engine`) is shared by
`get_credit_summary` (local and remote MCP), `GET /api/v1/grades`, `unicontext grades` and the Web UI
授業 page.
