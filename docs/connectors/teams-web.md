# teams-web (`@unicontext/teams-web`)

Microsoft Teams through the **official Teams web client** (`https://teams.cloud.microsoft/`) in the
UniContext browser profile. It exists because the shizuoka.ac.jp tenant blocks user consent for
self-registered apps, so Graph with our own app ([microsoft365](microsoft365.md)) cannot be used.
Research and the spike behind it: [docs/research/teams-web.md](../research/teams-web.md) (§10).

Metadata: `apiStability: unofficial`, `risk: unsupported`, `adapter: browser`, tested against the
v2 client (`testedVersion: v2`), default authority `collaboration`, schedule `30m`.

## What it reads

| Data                          | Where it comes from                                                                                                                                                          | Raw type                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Teams and channels            | The client's own cache (`conversation-manager` IndexedDB, read-only transaction) after it booted. The client fetches the full team list only on its first boot, then deltas. | `teamsweb.team`           |
| Channel posts and replies     | Each channel is opened through its documented deep link (`/l/channel/…`, in-app navigation); the client loads (and caches) its posts; the cached reply chains are read.      | `teamsweb.replychain`     |
| Assignments (課題) + my state | The responses `/api/v1.0/edu/me/work` the Assignments app inside Teams receives when its three tabs are shown (今後の予定 / 期限を経過 / 完了), all pages.                   | `teamsweb.assignment`     |
| Assignments bot cards         | Fallback only: cards in channels whose assignment the service did not list (dropped once it lists the student's work completely).                                            | `teamsweb.assignmentCard` |
| Files                         | SharePoint drive delta (`/_api/v2.0/drive/root/delta`) by same-origin `fetch` from a page on the team's SharePoint site, with the page's own session.                        | `teamsweb.driveItem`      |
| File text (opt-in)            | PDF/DOCX/PPTX downloaded inside the page (`/_api/v2.0/drive/items/{id}/content`), extracted with the local-files extractors, size-capped.                                    | `teamsweb.fileText`       |
| File downloads / mirror       | Same endpoint (classic `GetFileById(…)/$value` as fallback), streamed from the page to a local file on request or for the opt-in mirror; text as above.                      | `teamsweb.fileText`       |

## Safety rules (enforced in code)

- **No tokens or cookies leave the browser.** The connector never reads cookies, `localStorage`
  auth entries or tokens, exports nothing to the keychain (`cookieUrls: []`), and never calls a
  Teams service itself. Teams/Assignments data is only what the official client received or
  cached; SharePoint calls run inside the page.
- **Read-only.** A route on the browser context aborts every non-GET request to Microsoft service
  hosts except a short allow-list of read POSTs (token exchange, profile lookups, batched reads).
  That blocks marking channels read (`PUT …/properties?name=consumptionhorizon` was observed and
  blocked), presence, posting, reactions, joining, app installs, turning in and telemetry
  (`routeDecision`, tested). The connector only navigates and scrolls; it never clicks compose,
  reply, react, join or turn in.
- **No pre-authenticated URLs are stored.** `@content.downloadUrl` and any `tempauth`/`token`/`sig`
  parameters are removed from every payload, also inside JSON strings and HTML (`scrubSecrets`).
- **Polite.** One browser context, one channel at a time, a pause after each (2.5 s + jitter),
  at most `maxChannelsPerRun` (12) changed channels plus `revisitPerRun` (2) unchanged ones per
  run. Service workers are blocked so the client's own requests are visible to the page.
- **No visible windows during sync.** Syncs run headless. When Microsoft asks for a sign-in, the
  run ends with `auth_required`; sign in with `unicontext login teams-web` (or `livecampusu`,
  whose profile is shared).

## Downloads and the mirror

Files are downloaded only when asked (`unicontext files download`, `POST /api/v1/files/download`,
the ダウンロード button in a course's file list, MCP `download_course_file`) or by the opt-in mirror.

- **How**: a headless session of the shared browser profile starts on the team's SharePoint site
  (no Teams boot; a site that does not open in time is retried once), the page GETs the file from the same origin with its own session, and Node pulls
  the response body in 1 MB chunks (`DOWNLOAD_OPEN` / `DOWNLOAD_READ`) straight into
  `<target>.part`, renamed when complete. Neither process holds the whole file; no cookie, token or
  pre-authenticated URL leaves the page or is stored. GET only: nothing at SharePoint changes (no
  check-out, no sharing change, no view marks beyond SharePoint's own access log).
- **Serialized and paced**: the browser profile's queue runs downloads after (never during) a
  sync of any source sharing the profile; files are fetched one at a time with
  `files.downloadDelayMs` (1.5 s + jitter) in between; a 429/503 stops the batch.
- **Size**: `files.maxDownloadMB` (200) for on-demand downloads, `mirror.maxFileMB` for the mirror.
  A larger file is refused from its listed size without contacting SharePoint.
- **Text**: after the browser is closed, PDF/DOCX/PPTX/TXT/MD up to `files.maxExtractBytes` (50 MB)
  are extracted with the local-files extractors and stored as `teamsweb.fileText`, which becomes
  document chunks of the file's Document (course = the team's offering), so search finds them.
  A delta deletion of the file also deletes its text.
- **Where**: on-demand copies in `<data dir>/files/teams-web/cache/<hash>/<name>` (indexed in
  `cache.json`, oldest evicted beyond 2 GB); a file already on disk in its current version (cache or
  mirror) is not downloaded again.

### Mirror (`sources.teams-web.mirror`, off by default)

```yaml
sources:
  teams-web:
    mirror:
      enabled: true
      root: ~/University/Teams # default
      courses: linked # linked (default): class teams linked to an academic-system course; all: every class team
      maxFileMB: 200
      maxFilesPerPass: 40 # the rest follow after the next syncs
      trashRetentionDays: 30
```

Layout: `<root>/<course or team>/<channel folder>/<path>` — the course title of the linked
academic-system offering (the team name for unlinked class teams with `courses: all`), then the
library path (its first folder is the channel's folder). After every successful teams-web sync the
daemon runs a pass in the background (`unicontext files mirror` runs one by hand): files that are new
or changed in the synced listing (the delta) are downloaded, newest first; a changed file's previous
copy and files that disappeared (deleted, or their course is no longer mirrored) move to
`<root>/.trash/<date>/…`, emptied after `trashRetentionDays`; moved or renamed files are moved
locally. The index (`<data dir>/files/teams-web/mirror.json`) remembers versions (SharePoint
`cTag`), so unchanged files are never fetched again. Only class teams are mirrored.

## Incremental sync and state

`cursor.extra` (sync_state) holds per channel the client's last-activity time when it was read,
per team the SharePoint delta link, the assignment ids the service listed, the instructor hints
and the text-extraction queue. A run reads changed channels first (newest activity first) and
continues with the rest on later runs; unchanged channels are revisited slowly for edits and
deletions. The file listing runs from the delta link; a full listing (which also removes files
that disappeared) runs at night (`files.fullListingHours`, default 02–06) at most once a day, when
the link expires (410) and on full syncs. Content seen for the first time but old (a channel read
for the first time, the first Assignments read, a newly joined team's library) is marked
`backfill`, so it is stored without being reported as a change.

## Mapping

| Teams                                      | Canonical                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Class team (`spaceType: class`)            | `courseOffering`: title without the year and a bracketed section (`2026-計算理論(A組)` → `計算理論`), `academicYear` from the name (else creation date), teacher = team creator |
| Other teams                                | no course; their channels and posts are kept                                                                                                                                    |
| Channel                                    | `thread` (`platform: teams`, deep link)                                                                                                                                         |
| Root post by an instructor in a class team | `announcement` (authority `instructor-announcement`, importance by core rules, urgent → critical) + room-change hint fact                                                       |
| Other posts, all replies                   | `message` (`extra`: channel, subject, importance, mentions, `mentionsMe`, attachments, reply flag)                                                                              |
| Assignment (`me/work`)                     | `assignment` (due date with year, points, class) + `submission` mirrored from Teams (authority `submission-system`, never set by UniContext)                                    |
| Bot card                                   | `assignment` stub (`origin: extracted`, due date inferred from 「期限 M月D日」)                                                                                                 |
| SharePoint file                            | `document` + `material` (folder, channel, modified by/at, webUrl without temporary tokens)                                                                                      |

Instructors are the team creator and the authors of the class's assignments (the client does not
expose other members' roles). Class teams join the academic system's offerings through the identity
resolver (same normalized title and year, teacher when known); unclear matches wait for
confirmation (`unicontext confirm --list`, the Web UI's 紐付けの確認).

## Config (`sources.teams-web`)

| Key                                               | Default                                                         |
| ------------------------------------------------- | --------------------------------------------------------------- |
| `maxChannelsPerRun` / `revisitPerRun`             | 12 / 2                                                          |
| `channelDelayMs`, `settleMs`, `scrollPages`       | 2500, 4000, 2                                                   |
| `assignments`, `includeNonClassTeams`             | true, true                                                      |
| `files.enabled`, `files.extractText`              | true, false                                                     |
| `files.maxExtractBytes`, `files.maxExtractPerRun` | 50 MB, 10                                                       |
| `files.extractExtensions`                         | pdf, docx, pptx, txt, md                                        |
| `files.maxDownloadMB`, `files.downloadDelayMs`    | 200, 1500                                                       |
| `mirror.*`                                        | see [the mirror](#mirror-sourcesteams-webmirror-off-by-default) |
| `browser.shareProfileWith` / `browser.profileDir` | profile `browserProfile` (livecampusu)                          |

## Limits

- Internal client shapes (IndexedDB stores, the Assignments service) change with client builds;
  zod schemas report drift, and an empty team list is treated as an error, not as deletions.
- Assignment instructions are not in the list responses; opening an assignment would record a
  view for the teacher, so the connector does not open them (`description` stays empty unless the
  service sends it).
- Only posts the client loads after opening a channel and two scroll pages are read per visit;
  older history arrives on later visits as the client caches more.
- Chats are not read.
