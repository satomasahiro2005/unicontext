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
    # maxNoticeDetailsPerRun: 20
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
| `noticeDetails`                                                                                                             | `true`         | Fetch bodies of READ notices whose row changed.                                                                                            |
| `maxNoticeDetailsPerRun`                                                                                                    | `20`           | Cap on detail transitions per run (newest first).                                                                                          |
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
  unless `grades: true`. Violations throw `PolicyViolationError`.
- **Unread notices are never opened** (opening marks them read). `openNoticeDetail(proof)` needs a
  proof built from the current list page; the session re-parses that page itself and refuses rows
  shown as `tr.is-unread`, unknown rows, stale list versions, or calls made while not on the list.

## Sync flow

1. `GET <landing>` (`SC_01002B00_00`): fresh tokens + version fingerprint.
2. JSON: `importantNotice`, `submissionInformation?mode=web`, `warningNoticeInformation`.
3. スケジュール (`SC_18001B00_01`, inline FullCalendar `events: [...]` parsed without eval) →
   時間割 (`timeTable`, then `change` per semester) → 試験時間割 (`testTimeTable`, `change` per
   semester; 「対象の科目はありません」 → none).
4. 課題・アンケートリスト (`init` + `search` for the year, all rows incl. hidden `submissionSeq`) and
   `getClassSubjectList` per semester (JSON POST).
5. 出欠 (`SC_13002B00_01`).
6. 連絡一覧 (`SC_17001B00_01`, all rows incl. hidden columns and read state). Details
   (`rowSelect` → `SC_17001B00_02` → `back`) only for READ rows whose row hash changed since the
   detail was last fetched (incremental), newest first, capped per run. Bodies are carried forward
   in `cursor.extra.notices` (and in memory), so unchanged notices keep their body without a request.
7. 成績 (only with `grades: true`).

A step that fails (non-auth) becomes a `SyncResult.warnings` entry and its types are not marked
complete, so nothing is deleted by mistake. Steps whose listing is complete set
`complete.sourceTypes` (vanished rows ⇒ deleted). The calendar is only the current week, so
`lcu.calendarEvent` is never "complete". The whole run is one page (a few dozen requests).

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

| Raw type (externalId)                             | Source                                                                       | Canonical                                                                                                                                                                                                                                                                                         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lcu.course` (`<year>-<subjectCode>-<classCode>`) | timetable cells + `getClassSubjectList`                                      | `course` (8-digit `courseCode`), `courseOffering` (year, term 前期/後期, teachers, `schedule[]` {dayOfWeek 月=1…日=0, period, start/end from profile, room}, `room`, `extra` {classCode, className, numbering, credits, campus}), `enrollment` (self), `person` self (`name: 本人`, no real name) | room → authoritative `room` fact                                                                                                                                                                                                                                                                                                                                                                                     |
| `lcu.notice` (`n-<hash(date,type,title)>`)        | `importantNotice` JSON merged with the list row (+ detail body when fetched) | `announcement` (category = type title, importance high for importanceCategory 1 / 休講・試験・教室変更, scope course/university, `courseOfferingId` from the hidden subject code or by title)                                                                                                     | U01 休講 → `classSession` `cancelled`; U02 補講 → `makeup`; U03 試験 → `exam` (targetDate, time from title if any); U04 講義室変更 → `classSession` `changed` + room (origin `extracted`) and a `room` fact on the offering {origin `extracted`, confidence 0.8, validFrom/validUntil = that day, evidence = title}. Period only when the subject text gives one period on that weekday. U23–U28 stay announcements. |
| `lcu.assignment` (`submissionSeq`)                | assignment list                                                              | `assignment` (availableFrom/dueAt from 「提出期間」, submissionType), `submission` (未提出 → `not_submitted`, 提出済 → `submitted`)                                                                                                                                                               | ref authority `submission-system` (LCU is the submission system for its own assignments)                                                                                                                                                                                                                                                                                                                             |
| `lcu.submissionInfo`                              | `submissionInformation?mode=web`                                             | none (raw + drift only)                                                                                                                                                                                                                                                                           | shape unobserved; the assignment list is the full listing                                                                                                                                                                                                                                                                                                                                                            |
| `lcu.warningNotice` (`warningNoticeId`)           | `warningNoticeInformation` (opaque `warningNoticeRequestPath` dropped)       | `calendarEvent` per date (category 期限, all-day), `announcement` 「<name>: M月D日まで（状態）」 (high)                                                                                                                                                                                           | year inferred from the fetch date                                                                                                                                                                                                                                                                                                                                                                                    |
| `lcu.calendarEvent`                               | scheduler `events`                                                           | `calendarEvent` (category = `listType`: Holiday / teachingevent)                                                                                                                                                                                                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `lcu.exam`                                        | 試験時間割                                                                   | `exam` (`final`, date + period times or explicit time, room)                                                                                                                                                                                                                                      | column layout unobserved (heuristic)                                                                                                                                                                                                                                                                                                                                                                                 |
| `lcu.attendance`                                  | 出欠                                                                         | fact `attendance` = {attended, absent, late, earlyLeave, excused, invalid, published} on the offering, authoritative                                                                                                                                                                              |                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `lcu.grade` (opt-in)                              | 成績情報                                                                     | `grade` (score, letter, gradePoint, finalizedAt)                                                                                                                                                                                                                                                  | header 学籍番号/氏名 never parsed                                                                                                                                                                                                                                                                                                                                                                                    |

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
- Unread notices have no body (title, type and dates only) until the user reads them in LCU.
- Course matching for notices without a hidden subject code, assignments, exams and attendance is
  by title (+ class name) within the year's offerings; ambiguous titles stay unlinked.
- Timetable `room` is LCU's text as-is (e.g. 共通講義棟３１, full-width digits).
- A full refresh after a process restart re-fetches notice details (capped per run) because the
  cursor is only passed in incremental mode.
- Calendar events are the current week only.
