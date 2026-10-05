# EdStem (Ed Discussion) via a community MCP server

Read-only Ed Discussion data (courses, announcements, threads, answers, comments) through
[adapter-mcp](adapter-mcp.md) and the shipped mapping `edstem-mcp`
(`packages/adapter-mcp/mappings/edstem-mcp.yaml`). Ed has no official MCP server; UniContext runs a
community one as a child process and only calls its read tools.

Stability: `experimental` (the server, its tool names and Ed's unofficial-but-public API are not
ours). Profile role: `discussion` (product `edstem`, `enabled: false` in the Shizuoka profile until
you list `edstem` in config.yaml).

## Server choice (2026-10-05)

| Server                                                          | Language   | License           | Notes                                                                                                                                                                                             |
| --------------------------------------------------------------- | ---------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[bunizao/edstem-cli](https://github.com/bunizao/edstem-cli)** | TypeScript | MIT               | **Chosen.** v0.7.2, maintained (releases, CHANGELOG, vitest suite), local stdio `edstem-mcp` binary, read tools annotated `readOnlyHint`, posting tools disabled unless `EDSTEM_ALLOW_POSTING=1`. |
| rob-9/edstem-mcp                                                | TypeScript | none (no LICENSE) | 22 tools, `ED_API_TOKEN` / `ED_REGION`. Active, but without a license there is no right to use or modify it; not used.                                                                            |
| donpham7/edstem_mcp                                             | Python     | none              | Needs a Python environment; no license; inactive since 2026-02.                                                                                                                                   |
| others (eliemada, 1jehuang, karkir0003, wondermuttt, TuuHub)    | mixed      | MIT / Apache      | Python (needs a Python env), unmaintained since 2025 (wondermuttt), or an older copy of the same code (TuuHub/edstem-cli).                                                                        |

Pinned commit: **`50570fb8577577d9f73dd556f05dfbbf0e906ecd`** (tag `v0.7.2`,
"chore(release): prepare v0.7.2", 2026-09-23). The mapping records `testedVersion: 0.7.2`; the
server reports its version in `unicontext sources` (column バージョン) so an upgrade is visible.

### What UniContext calls

Five tools, all `readOnlyHint: true` in the server (`src/mcp/server.ts`):

| Tool           | Arguments                            | Returns (one JSON text block)                                                                                                                                            |
| -------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_courses` | `{includeArchived: false}`           | `[{id, code, name, year?, session?, status?, role?}]` from Ed's `/api/user` enrolments                                                                                   |
| `list_threads` | `{courseId, limit: 50, sort: "new"}` | `[{id, number, title, type, category, courseId, subcategory?, createdAt?, updatedAt?, metrics?, flags?}]`; no body, no author                                            |
| `get_thread`   | `{threadId}`                         | summary + `{userId, document, endorsement?, users: {"<id>": {id, name, courseRole?}}, answers?, comments?}`; replies nest under `comments` at any depth                  |
| `list_lessons` | `{courseId}`                         | `[{id, courseId, moduleId, title, moduleName?, kind?, state?, status?, availableAt?, dueAt?}]`; `status` is the student's progress (unattempted / attempted / completed) |
| `get_lesson`   | `{lessonId}`                         | summary + `{outline?, lockedAt?, createdAt?, slides: [{id, title?, type?, content? (Ed document XML)}]}`                                                                 |

`get_thread` runs for announcements and for threads created or updated in the last 30 days (one
call each, `minIntervalMs` apart). The server also exposes write tools (`create_thread`,
`reply_thread`, `submit_slide`, `submit_slide_answer`, `mark_lessons_read`); the mapping never
names them (adapter-mcp only calls tools the mapping names, §50) and the source config does not set
`EDSTEM_ALLOW_POSTING`, so the two posting tools refuse even if something asked. The adapter test
`EdStem through edstem-mcp` asserts that a full sync calls exactly the five read tools.

## Install (once, outside the repo)

```powershell
mkdir $env:USERPROFILE\mcp -Force
cd $env:USERPROFILE\mcp
git clone https://github.com/bunizao/edstem-cli.git
cd edstem-cli
git checkout 50570fb8577577d9f73dd556f05dfbbf0e906ecd
npm ci
npm run build:local          # tsup → dist\edstem-mcp.js (keeps node_modules for runtime deps)
node dist\edstem-mcp.js --version   # 0.7.2
```

Only `build:local` is needed (the remote / Cloudflare Worker builds are for the hosted variant).

## Config

```yaml
# %LOCALAPPDATA%\unicontext\config.yaml
sources:
  edstem:
    enabled: true
    adapter: mcp
    command: C:\Program Files\nodejs\node.exe
    args: ['C:\Users\<you>\mcp\edstem-cli\dist\edstem-mcp.js']
    env:
      EDSTEM_BASE_URL: https://edstem.org/api/ # AU region; US accounts: https://us.edstem.org/api/
      EDSTEM_WIDGETS: '0' # text-only tools, no MCP Apps views
    envSecrets:
      - { name: EDSTEM_TOKEN, secret: ed-token } # keychain entry edstem/ed-token
    mapping: edstem-mcp
    mappingVars: { region: au } # web links https://edstem.org/au/...; `us` for a US account
    timeoutMs: 60000
    minIntervalMs: 500
    schedule: 30m
```

- The key `edstem` matches the profile's `discussion` role by product, so the profile defaults
  (connector, mapping) merge underneath.
- The child process gets only `PATH`, `USERPROFILE`, ... plus `env` and `envSecrets` (never the rest
  of your environment). The server reads `EDSTEM_TOKEN` first; its own token file
  (`~/.config/edstem-cli/token`) is only a fallback and is not used here.
- Region: an Ed account lives in one region, and the API host and the web links must both match it.

  | Region | `EDSTEM_BASE_URL`            | `mappingVars.region` | Web links                   |
  | ------ | ---------------------------- | -------------------- | --------------------------- |
  | AU     | `https://edstem.org/api/`    | `au` (default)       | `https://edstem.org/au/...` |
  | US     | `https://us.edstem.org/api/` | `us`                 | `https://edstem.org/us/...` |

  The Shizuoka student's account is **AU** (`https://edstem.org/api/`, the server's default). How
  to tell: the address bar after signing in to Ed reads `https://edstem.org/<region>/dashboard`, and
  the API tokens page is `https://edstem.org/<region>/settings/api-tokens`. With the wrong host the
  first sync fails as `要ログイン` (Ed answers 401 for a token of another region); with the right
  host but the wrong `mappingVars.region` the sync works but the cited links open the wrong region.
  AU timestamps also come back with Sydney offsets (`+10:00` / `+11:00`). `mappingVars` may only name
  vars the mapping declares (a typo is a config error); changing it re-normalizes the stored items.

- Restart the daemon after editing config.yaml (`unicontext daemon stop`, then start it again or
  sign in again; the Startup launcher starts it at login).

## Enter the token

The token never goes into config.yaml or onto the command line:

```powershell
node C:\Users\<you>\workspace\unicontext\apps\cli\dist\bin.js login edstem
# (or, in the repo: pnpm unicontext login edstem)
```

It prints `EDSTEM_TOKEN（ed-token）を貼り付けてEnter（入力は表示されません）:`. Paste the token and
press Enter; nothing is echoed. The value is stored in the OS keychain (Windows Credential Manager)
as the UniContext entry `edstem/ed-token`. `login` then starts the server, checks that it
answers, and asks the running daemon to sync `edstem` at once.

- Replace a wrong or expired token: `unicontext secrets set edstem` (same hidden prompt).
- Check without revealing it: `unicontext secrets list edstem` (保存済み / 未設定).
- Remove it: `unicontext secrets delete edstem`; revoke it on Ed's API tokens page as well.

## First sync and verification

1. The sync started by `login` prints `デーモンで同期を実行しました（成功）` or the error. To run it
   again: `unicontext sync edstem`.
2. `unicontext sources`: `edstem` should be 正常 with バージョン `0.7.2` and a 最終成功 time.
   `要ログイン` with "reports rejected credentials" means Ed refused the token (wrong region or
   revoked token): fix `EDSTEM_BASE_URL` or run `unicontext secrets set edstem`.
3. Look at the data: `unicontext today` / `unicontext changes --since 1h` (new announcements and
   posts), `unicontext search "<word from a thread>"`; through MCP, `get_announcements` /
   `search` cite "Ed Discussion".
4. `unicontext doctor` lists the source health; the daemon log
   (`%LOCALAPPDATA%\unicontext\logs`) has the per-sync report.

The token is checked lazily by the server: `login` succeeding only proves that the server starts.
The first sync is what talks to Ed; a rejected token shows up there as `auth_required`.

## Lessons and deadlines

Ed lessons that are work to hand in (title with 課題 / レポート / 宿題 / 提出 / テスト / quiz /
assignment / homework / report, or an Ed due date) become **assignments** whose submission system
is Ed (authority `submission-system`): link `https://edstem.org/<region>/courses/<course>/lessons/<lesson>`.

- Due date, in order: Ed's own `dueAt` (an absolute timestamp from the API; AU offsets such as
  `+11:00` are kept as the same instant), else the deadline written in the lesson text, else the
  lesson's `lockedAt` (hard close). Without any of them the assignment has no due date (期限不明)
  and is kept, never dropped.
- The Shizuoka DB course writes the deadline only into a slide: 「提出期限: 10月6日 17:00PM」. The
  mapping fetches `get_lesson` for unfinished assignment lessons and `$extractDeadline` (the rule
  based extractor of §20, now in `@unicontext/core`) turns the sentence into an `assignment_due`
  fact, origin `extracted`, the sentence as evidence. Clock times in text are wall-clock times of
  the university (JST), never of the AU server: `10月6日 17:00PM` = 2026-10-06 17:00 JST
  (08:00Z). A redundant `PM` on a 24-hour time is ignored; `5:00 PM` is 17:00.
- The lesson's progress is the submission state: `completed` → submitted, otherwise
  not_submitted (authority `submission-system`, so the task engine treats it like a submission
  system's status).
- Lecture material lessons (「当日の講義資料」) are not assignments.

## Mapping summary

Courses: Ed's `year` is the academic year, and `session` is free text typed by the course admin.
The mapping turns it into the university's term name through the profile's academic calendar
(`$profileTerm`: "Semester 2" / "S2" / 第2学期 → 後期, "Spring" → 前期, "Fall" → 後期, also for a
year the calendar does not list). A session that is not a term stays unknown rather than a wrong
literal; the observed case is `"session": "X"` on the 2025 course `db2025` (a placeholder, its
threads ran Oct 2025 – Feb 2026). The raw value is kept in `extra.session`.

Identity (§14): Ed course codes (`db2026`) are Ed's own labels, not 学務 codes, so a different code
is not evidence against a match, and an Ed course counts as a title-only source. An exact title in
the same academic year and a compatible term links it to the LiveCampusU / syllabus offering
automatically (`identity_links`, method `course-offering-matcher`); when several same-titled
offerings qualify, the one the student is enrolled in wins and the rest become candidates in
`unicontext confirm --list`. A different academic year never links (the 2025 Ed course stays a
separate past offering), and `get_course` by title prefers the enrolled, current-term course over a
same-titled past or catalog one.

See [adapter-mcp.md](adapter-mcp.md#raw-types-and-mapping-tables). Announcements become
`announcement` (authority `instructor-announcement`, importance `high` when pinned); other threads
become `thread` plus the opening post and every answer / comment / nested reply as `message`.
Posts by course staff (Ed course roles admin, staff, ta, tutor) carry `instructor-announcement`,
everything else `discussion`. Archived courses and threads that fall off the newest 50 are kept,
never marked deleted.

## Limits

- Every sync relists 50 newest threads per active course; there is no incremental cursor.
- Threads older than 30 days whose details were never fetched (e.g. before the first sync) appear
  as titles only.
- Ed lessons, quizzes and files are not mapped (the server has read tools for them; not needed yet).
- Anonymous posts have no author name.
