# shizuoka-vpn-files (`@unicontext/shizuoka-vpn-files`)

The 静岡大学 情報学部 SSL-VPN portal file share (lecture materials and related folders), read **only**
through the student's own signed-in browser session. The portal is an **Ivanti Connect Secure**
clientless web portal (`https://vpn.inf.shizuoka.ac.jp`, realm path `url_3`); there is no usable VPN
client (the student confirmed the Store Pulse app fails), so this is the only path. Research:
[docs/research/shizuoka-vpn-files.md](../research/shizuoka-vpn-files.md).

Metadata: `apiStability: unofficial`, `risk: unsupported`, `adapter: browser`, tested against the
`25.1.x` appliance (`testedVersion`), default authority `collaboration`, schedule `1d`. **Disabled by
default** in the profile.

## Why it is index-first (never live)

The portal's file-browser API is **flaky**: the same folder returns 114 entries once, then `403
ファイル参照エラー` for minutes, then an empty `200`, even in the official UI (research §3.4). The
session also caps at ~60 minutes. So UniContext keeps a **local index** of the tree and the AI always
browses/searches/lists from that index — it answers instantly and shows, per folder, when it was last
listed successfully. Only the background sync (low-frequency, incremental) and on-request downloads
ever touch the portal.

## What it reads

| Data | Where it comes from | Raw type |
| --- | --- | --- |
| Folders (the whole accessible tree, metadata-only) | `GET /api/v1/fb/list?…&dir=<path>` JSON, by same-origin `fetch` from the signed-in page. DFS with depth/entry caps. | `szvpn.folder` |
| Files (name, size, timestamp, full path) | The same listing; each file is a `document` (+ `material`) keyed by its full tree path. | `szvpn.file` |
| File text (opt-in / on download) | The file downloaded in the page via `/dana/fb/smb/wfd.cgi`, extracted with the local-files extractors, size-capped. | `szvpn.fileText` |

The crawl is **not** filtered by enrolled course. The whole readable tree is indexed so the AI can
browse and search any folder. `report` / `student` / `submit` return 403 for this student; they are
recorded once as `forbidden` roots and skipped, never deleted.

Course association is **best-effort and never a filter**: a folder named like `2024コンピュータ入門（教員）`
yields a *candidate* `courseOffering` (title + year + teacher) that the IdentityResolver proposes as an
**unconfirmed** link to the academic system's offering; the student confirms or overrides it. An
explicit `courseMap` in config can map a path to a known offering id (used directly) or title.
Unmapped folders stay fully visible.

## Safety rules (enforced in code)

- **No tokens or cookies leave the browser.** All reads run inside the signed-in page (`cookieUrls:
  []`); the HttpOnly `DSID` session cookie is never exported. UA and source IP match the student's
  own session automatically, which also avoids evicting it.
- **Read-only.** A route on the browser context aborts every non-GET to the portal except the Ivanti
  sign-in POSTs under `/dana-na/auth/` (so the human can log in). Uploads (`wu.cgi`), new folders
  (`wnf.cgi`), deletes and any xsauth/nonce-bearing write are blocked before they leave the browser
  (`routeDecision`, tested). The connector never sends xsauth/nonce.
- **A failed or empty listing is never a deletion.** `403 ファイル参照エラー` and empty `200` are
  treated as flaky/retryable; the last good listing is kept. A file is removed from the index only
  when its folder lists **successfully** without it. The connector never declares `complete`, so the
  sync engine can never delete unseen items either. A session lost before anything was listed
  fails the run with `auth_required` and changes nothing; one lost in the middle of a long walk
  keeps the pages already listed (and the cursor), deletes nothing, and the next run asks for a
  sign-in (or signs in again with the saved password, below). The sync engine saves the cursor only
  after the last page, so a later page never fails the sync: the session found gone between two
  pages, or a browser profile held by another UniContext process, ends the sync with the progress
  so far (a page that broke off in the middle is rolled back to where it started).
- **Polite & incremental.** One request at a time with a pause (≈3 s + jitter) and exponential
  backoff; `maxFoldersPerRun` (default 60) per page; the walk resumes from where it stopped via the
  cursor, re-lists stale folders, and re-seeds the whole tree every `rewalkAfterHours` (72 h). A root that
  has never been listed OK is retried as soon as its backoff allows (capped at 30 min), not after 72 h.
  A folder that failed (flaky 403 / empty) stays on the frontier for up to 3 failures instead of
  waiting a day for its parent to be listed again; a forbidden placeholder does not.
  Schedule is daily; keep it off known maintenance windows.
- **The whole tree inside one sign-in.** When UniContext knows when the current session was signed
  in (`signedInAt` in `portal-session.json`, written by `login` and by an automatic sign-in that
  actually submitted the form — not when it only found a session still live), one sync keeps going
  page after page until the tree is indexed,
  `walk.maxFoldersPerSession` (2000) folders, or `signedInAt + browser.sessionMaxMinutes −
  walk.sessionMarginMinutes` (60 − 5 = 55 min). At ≈3.75 s per folder that is ≈800 folders per
  sign-in. Without a known sign-in time it is one page per sync, as before.
- **Own browser profile.** Not shared with LiveCampusU/Teams (different host and session system).

## Enabling it and signing in

1. In `config.yaml`, list the source so the (profile-disabled) entry turns on:

   ```yaml
   sources:
     shizuoka-vpn-files: { enabled: true }
   ```

2. Sign in once (the human does the password/MFA; UniContext types credentials only when the student
   saved them for automatic sign-in, see below):

   ```
   unicontext login shizuoka-vpn-files
   ```

   A browser window opens on the realm's sign-in form (`/dana-na/auth/url_3/welcome.cgi`) and stays
   open until the portal itself confirms the session, or until the login timeout (10 min). The
   confirmation is asked on **any page of the portal host**, including a tab that stays on
   `/dana-na/auth/url_3/login.cgi` after sign-in (observed 2026-10-06): a same-origin GET of
   `/api/v1/enduser/landing-page` that answers 200 JSON (JSON content type, or a body that parses),
   not redirected to the sign-in area; when that answered 200 without a redirect but not with JSON,
   a second probe (`list-shares`, then the fb list of the first root) that answers JSON
   `files`/`shares`. A landing-page that bounced to `/dana-na/auth/welcome.cgi` (signed out) is one
   request and nothing more. The URL alone is never proof: signed out, `/dana/home/index.cgi`
   redirects via `/dana-na/auth/welcome.cgi` to `/`, a 404 page on the portal host.

   Polite while you type: no probe is sent from a page that shows a visible password or MFA field
   (the session cannot be live there, and a probe would follow the sign-in redirect in the middle of
   the flow), and a page is probed at most once every 5 s.

   While it waits, the terminal says what it is stuck on (every 15 s, tab paths without queries):

   ```
   サインイン後の確認待ち: /dana-na/auth/url_3/login.cgi（確認: landing-page 200→/dana-na/auth/welcome.cgi text/html · list-shares 404、ブロックした通信 1件）
   ```

   and, if the portal shows its "other user sessions in progress" notice (found by the field names
   `btnContinue` / `FormDataStr`; UniContext never presses it), `画面の「続行」を押してください`.
   Non-read requests the read-only route blocked are counted in that line. Everything the sign-in
   window went through is also written, without secrets, to `login-trace.jsonl` in the source's
   cache directory (rewritten per interactive sign-in, capped at 64 KB): one line per tab-path
   change (path without query, whether a password/MFA field or `btnContinue`/`FormDataStr` was on
   screen), per probe result (the same summary as above), and per blocked non-read request (method
   and path). That file is what UniContext reads next; the only thing you do is sign in once. Tabs
   restored from the last session are closed (one is kept) before the sign-in page opens.

   When it succeeds, the result is printed **before** the daemon is contacted, and the daemon's
   sync is started without waiting for it:

   ```
   shizuoka-vpn-files: 認証できました
     デーモンで同期を開始しました（ジョブ shizuoka-vpn-files-…）
   ```

   (`--json`: `{ sourceId, auth, syncJob }`.) The daemon is looked up for at most 10 s; if it is alive
   but does not answer, the login still exits 0 and says so. `--wait-sync` keeps the old behaviour:
   it waits for the sync (a progress line every 10 s, at most 10 min) and prints its result
   (`--json`: `sync` holds the report).

   After sign-in, background syncs reuse that session headlessly. `DSID` has no expiry, so Chrome
   would drop it when the window closes; the profile is launched with `--restore-last-session`,
   which keeps such cookies in the profile's own cookie store (nothing is exported), and closes with
   a single blank tab so the next launch does not re-request a portal page. When the session is
   gone (the portal ends it 60 min after sign-in), a sync signs in again with the saved password
   when the student stored one, else stops with `auth_required` — run `login`
   again.

How "signed in" is decided (`authenticate()`, never prompts): a browser profile on disk proves
nothing. UniContext records when a live portal session was last verified (`portal-session.json` in
the source's cache directory; a timestamp only) by a sign-in, or by a sync or download that got an answer
only a live session gives (a list that was OK, empty or forbidden, or bytes). A run that makes no request
leaves it alone; with a stale marker it asks the portal once. Never verified,
or longer ago than `browser.sessionMaxMinutes` (60) → `auth_required` without opening a browser;
verified in the last 2 minutes → signed in; otherwise a headless check against the portal decides.

One browser per profile: Chrome cannot open a profile twice. A headless run that finds the profile
held by another process (the daemon's sync, an open sign-in window) fails at once with "the browser
profile is in use" instead of a misleading "no browser could be launched"; `login` waits for it
(up to 5 min, saying so). The CLI hands `sync` to the running daemon, and waits up to 2 min for a
daemon that is alive but not answering yet (its start-up can take a minute on a large database)
instead of running the sync next to it.

Optional config (all under `sources.shizuoka-vpn-files`): `roots.disable` / `roots.include`,
`courseMap` (`[{ path, root?, course }]`), `prefetch` (path prefixes to pre-download small files),
`prefetchCurrentYear` (also the course folders of the current academic year, e.g.
`class/2026…/…`; needs `mirror.enabled`, and `mirror.maxFileMB` decides what is small),
`walk.*` (caps and intervals, incl. `maxFoldersPerSession`, `sessionMarginMinutes`), `files.*`
(download/extract limits), `mirror.*` (opt-in local copy), `browser.*` (`channel`,
`executablePath`, `loginTimeoutMs`, `bootTimeoutMs`, `sessionMaxMinutes`), `autoLogin.*`
(`enabled`, `minIntervalMinutes` 10, `maxConsecutiveFailures` 3, `submitTimeoutMs` 30 s).

## Session lifetime: what one sign-in buys

The portal ends every session **60 minutes after sign-in** (`DSmaxTimeout = 3600`, research §2.3),
however busy it is; it also ends idle sessions (`DSLastAccess`). Concretely, after one manual
sign-in:

| Within the 60 minutes | After them |
| --- | --- |
| The post-login sync walks the whole tree (above) and the opt-in mirror/prefetch pass downloads small files of linked / current-year folders | No portal request succeeds. Every sync logs `auth_required` (observed 2026-10-06 from 13:33 JST, 76 min after the 12:17 sign-in) |
| On-request downloads work | The **index stays**: browse / search / recent answer from it, with each folder's last listing time; files already downloaded or mirrored are served from disk |
| | A file that is not cached yet answers `authRequired: true` with "このファイルはまだ UniContext に保存されていない…サインインしてください" |

A keep-alive cannot help: it only defeats the idle timeout, never `DSmaxTimeout`. Ways to stay
signed in longer, best first:

1. **Automatic sign-in with the saved password** (implemented, opt-in, below). Each daily sync and
   each on-request download that finds the session gone signs in again by itself.
2. Ask the faculty's IT to raise the role's max session length or allow a persistent session
   (an Ivanti role setting; nothing UniContext can change).
3. A full VPN client + direct SMB would remove the portal entirely, but the student confirmed the
   Store Pulse/Ivanti app does not connect (research §4), and on campus the share is reachable
   without VPN only from the campus network.

## Automatic sign-in with the saved password (opt-in)

Decided by the student on 2026-10-06 ("セッションじゃなくてパスワードをセキュアに保存すれば同じこと"):
UniContext may keep the VPN user name and password in the **OS keychain** (Windows Credential
Manager, `SecretStore`) and sign in again by itself when the session is gone.

- **Turning it on**: `unicontext login shizuoka-vpn-files` asks once whether to save them (`y/N`;
  `--save-password` skips the question, `--no-save-password` never asks); the user name is typed
  visibly, the password without echo. Or `unicontext secrets set shizuoka-vpn-files username` /
  `… password`. `unicontext secrets list shizuoka-vpn-files` shows whether they are stored (never
  the values); `unicontext secrets delete shizuoka-vpn-files password` turns it off, as does
  `autoLogin.enabled: false`. Saving them again (`secrets set`, or deleting and re-entering them)
  clears any stop below. A successful manual sign-in clears only the stops a working account
  explains (an MFA page, the Continue page, an unknown form, failures before anything was sent),
  never one whose cause may be the saved password itself: a manual sign-in proves the account
  works, not that the saved password does.
- **Where it types**: only into `form[name="frmLogin"]`'s `username` and `password` fields on
  `https://<portal host>/dana-na/auth/url_3/welcome.cgi` (the realm's form, checked before typing),
  then presses that form's own submit button. The read-only route still blocks every non-GET
  except the sign-in POSTs under `/dana-na/auth/`. The session is then confirmed by the same
  portal check as a manual sign-in (`landing-page` JSON). A page that is not that form gets nothing
  typed (`form_not_found`). A session that is still live at the sign-in URL is confirmed without
  typing anything (`already_signed_in`); its real start is unknown, so it opens no new 55-minute
  walk window (one page per sync, as for any session UniContext did not sign in).
- **When it stops** (and reports `auth_required` with what it saw, e.g. `自動サインインできませんでした:
  二段階認証（ワンタイムコードなど）を求められました / … mfa @ /dana-na/auth/url_3/…`):
  - once the form has been submitted, **anything but a confirmed sign-in stops for good**: a wrong
    user name or password (`p=failed`, or the form again after submit), a lock-out (`p=…lock…`), an
    MFA / one-time-code / secondary-password page, a CAPTCHA, Ivanti's "other user sessions in
    progress" page, no recognisable answer within `submitTimeoutMs` (`timeout`: it may be a
    refusal page the connector does not know), or a browser error after the submit button was
    pressed (`submit_error`);
  - wrong password, lock-out, CAPTCHA, `timeout` and `submit_error` are lifted **only** by saving
    the credentials again (`unicontext secrets set shizuoka-vpn-files password`); the others also
    by a manual sign-in. So a saved password that stopped working is submitted at most once;
  - the "other user sessions in progress" page (`btnContinue` / `FormDataStr`) is **never
    pressed** — Continue can end another session, which may be the student's own browser session,
    and UniContext cannot tell whose it is;
  - a page that is not the realm's form: nothing typed, stops (`form_not_found`).
  Only failures before anything was submitted (the page did not load, the browser failed while
  filling) are soft: retried at most once per `minIntervalMinutes` (10), stopping after
  `maxConsecutiveFailures` (3) in a row. A browser profile held by another UniContext process does
  not count as an attempt (nothing was typed).
- **Fail closed**: the attempt history is `auto-login.json`, written atomically (temp file +
  rename). When it cannot be read (anything but "no file yet": a lock from a scanner or sync
  client, a half-written or corrupt file) or the attempt cannot be recorded before the browser
  opens, no attempt is made (`auth_required`, saying so). A stop that could not be saved after the
  attempt still holds in that process.
- **Never written anywhere else**: not config, the database, raw payloads, logs, `login-trace.jsonl`,
  `portal-session.json` or `auto-login.json` (that file holds timestamps, the last outcome name and
  a path without query only), and not in error messages (of a browser error only the first line
  is kept — Playwright's call log repeats `fill("<value>")` — and it is scrubbed of both values,
  the longest first, so a password that contains the user name is not half-replaced). Tested with the fake portal (`test/auto-login.test.ts`).
- **Risks the student accepted**: the password sits in Windows Credential Manager, readable by any
  program running as the same Windows user; automated sign-in to the portal is not something the
  university documents as allowed (the connector stays read-only); a portal change (MFA added, a
  new form) stops it rather than working around it.

## Exploring from the AI (local index, read-only)

MCP tools (local and the remote read-only surface):

- `browse_vpn_files { root?, path?, limit?, offset? }` — a folder's subfolders (each with its last
  successful listing time and status) and files. No `root` → the share roots.
- `search_vpn_files { query, year?, course?, root? }` — name/path substring across the whole index.
- `list_recent_vpn_files { since?, root? }` — recently added/updated files, newest first.

While nothing has been indexed yet, every one of the three (browse with or without `root`, search,
recent) carries `index: { empty: true, sources: [{ source, health, … }], note }`, so an empty list
is never read as "the file does not exist" or "the share is empty".
- `download_course_file { file }` — download one file's bytes/text on request (pass a `document:…`
  id from the tools above). Downloaded files are cached locally, so later reads never touch the
  portal; retries use backoff.

All four are on the remote surface (`https://uc.nemut.ai`, read-only and write grants alike;
`apps/mcp/test/remote-surface.test.ts`). ChatGPT caches a connector's tool list: its last
`tools/list` was on 2026-10-05 12:15 JST, an hour before these tools existed, so it needs
**Settings → Connectors → UniContext → Refresh** (or reconnecting) and a new chat to see them.

Context-engine functions behind them: `browseVpnFiles`, `searchVpnFiles`, `recentVpnFiles`
(`@unicontext/context-engine`).

## Limits / unverified

- The exact `wfd.cgi` download parameters were not captured live (research §3.2); the Ivanti-standard
  shape is used and is only ever a GET. If a real session shows a different shape, adjust
  `buildDownloadUrl`.
- `report` / `student` / `submit` 403s cannot be told apart from transient 403s; they are recorded as
  `forbidden` and retried conservatively.
- Timestamps are the appliance's local (JST) strings; the version key is `timestamp + size` (SMB has
  no cTag), which is tz-independent.
