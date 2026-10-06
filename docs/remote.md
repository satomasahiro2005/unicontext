# Using UniContext from ChatGPT and claude.ai (remote MCP)

UniContext normally answers only on `127.0.0.1`. ChatGPT on the web and claude.ai cannot reach
that, so the daemon can run a second listener that a Cloudflare named tunnel publishes at a public
https hostname (for example `https://uc.nemut.ai`). It is read-only unless you grant a client the
`unicontext.write` scope, which adds only the record tools that write into UniContext's own
database (see [Registering deadlines, to-dos and notes from ChatGPT](#registering-deadlines-to-dos-and-notes-from-chatgpt-unicontextwrite)).
Research behind the design: [research/chatgpt-connector.md](research/chatgpt-connector.md).

```
ChatGPT / claude.ai ──https──▶ Cloudflare ──tunnel──▶ cloudflared (this PC)
                                                         │
                                                         ▼
                              unicontextd remote listener 127.0.0.1:17879
                              ├─ /.well-known/*  OAuth metadata (RFC 9728, RFC 8414)
                              ├─ /register /authorize /token /revoke   OAuth 2.1 AS
                              ├─ /mcp            MCP (streamable HTTP): read tools,
                              │                  + record tools with unicontext.write
                              └─ /files/<token>  10-minute links to downloaded class files

unicontextd local listener 127.0.0.1:17878 (REST, Web UI, full MCP) — never in the tunnel
```

## What is exposed, and what is not

- **Tools**: the read tools (`get_today`, `get_week`, `get_course`, `get_deadlines`,
  `get_assignments`, `get_tasks`, `get_notes`, `search`, `get_source`, `get_conflicts`,
  `prepare_for_class`, `review_class`, `get_recent_changes`, `get_announcements`,
  `get_announcement`, `search_syllabus`, `get_syllabus`, `get_credit_summary`, …), each with
  `readOnlyHint: true` and an output schema. Results are kept small for ChatGPT (see
  [Result size](#result-size)).
  With the `unicontext.write` scope only, also the record tools `ingest_lecture`,
  `record_lecture`, `add_deadline`, `add_note`, `add_task`, `list_my_additions` and
  `retract_addition` (`readOnlyHint: false`,
  `destructiveHint` only on `retract_addition`), and `open_announcement` (fetches the body of
  LiveCampusU notices that are unread there; this marks them read in LiveCampusU and cannot be
  undone, so it is `destructiveHint: true`, `openWorldHint: true` and ChatGPT asks first).
  `download_course_file` (read-only) fetches a class file from Teams/SharePoint into the local cache
  and returns its extracted text (truncated at `maxChars`, with `[p.N]` / `[スライド N]` markers),
  never a local path. With `link: true` it also returns a link `https://<host>/files/<token>` to the
  cached file: a random 256-bit token, valid about 10 minutes, kept in memory only (a restart drops
  it), bound to the calling OAuth client — a request that carries another client's bearer token is
  refused (403); the link itself is the capability, since ChatGPT or the user's browser fetch it
  without the MCP token. Minting (`file_link`) and every fetch (`file_fetch`, ok/status, bytes) are
  audited with a hash tag of the token, never the token. `open_link` (read-only) opens a
  SharePoint / OneDrive link from an email or a message through the Teams session and answers like
  `download_course_file` (text, optional `link`) for a file, or with the files (document ids) and
  subfolders of a folder; a link it cannot open returns `status` and `reason`. The propose-only tools (`correct_fact`,
  `propose_pace_slot`) are **never registered** on this surface, so a call to them fails as an
  unknown tool. `get_source` returns the citation and the facts it supports, but no raw source
  payloads.
- **Not exposed**: the REST admin API, the Web UI, proposals/confirmation, task status changes, sync,
  login, settings. They live on the local listener (`daemon.port`), which the tunnel config never
  maps.
- **Who can connect**: a client must finish OAuth 2.1, and every authorization shows a page on
  `uc.nemut.ai/authorize` that only proceeds after you type **your UniContext passphrase**.
  Five wrong passphrases lock approvals for 15 minutes (doubling up to 24 hours); the lock is stored
  on disk and applies to every address. Bursts are also rate limited per client address.
- **Tokens**: access tokens live 1 hour, refresh tokens 30 days (renewed on use, rotated every
  time; replaying an old refresh token revokes the whole grant). Tokens and client secrets are
  stored only as SHA-256 hashes; the passphrase as scrypt. Tokens are bound to the resource
  `https://<host>/mcp` (RFC 8707) and checked on every request.
- **Audit log**: every remote tool call (time, client id and name, tool, ok/error, duration,
  client address — never arguments or results; for record tools also `write` (created/updated/…),
  `additionId` and the ids of the entities and facts written, never their text) and every OAuth
  event (register, authorize with the granted scope, token, refresh, revoke, failed unlock,
  lockout) is appended to `<data dir>/logs/remote-audit.jsonl`.

## 1. Configure UniContext

Add to `config.yaml` (Windows: `%LOCALAPPDATA%\unicontext\config.yaml`):

```yaml
remote:
  enabled: true
  publicUrl: https://uc.nemut.ai # the public origin, no path
  # port: 17879                  # remote listener, 127.0.0.1 only
  # accessTokenTtl: 1h
  # refreshTokenTtl: 30d
  # trustedProxies: ['127.0.0.1', '::1', '::ffff:127.0.0.1'] # whose X-Forwarded-* are believed
  # extraRedirectUris: []        # e.g. http://localhost:6274/oauth/callback for MCP Inspector
```

Set the passphrase you will type when approving a connection (at least 12 characters; it is
asked twice and not echoed):

```
unicontext remote set-passphrase
```

Restart the daemon (`unicontext daemon stop` then `unicontext daemon start`, or restart the
service) and check:

```
unicontext remote status
```

The issuer, metadata URLs and the token audience always come from `remote.publicUrl`. Requests
are accepted only when their Host is that hostname and, for an https `publicUrl`, when the trusted
tunnel says the client used https (`X-Forwarded-Proto: https`). `X-Forwarded-*` and
`CF-Connecting-IP` are believed only from `trustedProxies` (the local cloudflared); anything else
gets a 421/403.

### Course planning (syllabus catalog)

`search_syllabus` / `get_syllabus` search the public syllabus of whole faculties, not only your
own courses, once the syllabus source has a `catalog` (details:
[connectors/syllabus.md](connectors/syllabus.md)):

```yaml
sources:
  syllabus:
    catalog:
      faculties: [IN-B] # 情報学部; its campus 全学教育科目（浜松） LA-H is added automatically
      terms: [year, next] # default; on 2026-10-01: 2026 前期 + 後期, and 2027 前期 once published
      detailsPerRun: 30 # detail pages opened per daily run; the rest stay list-only until later runs
```

It runs daily, one request per second at most. `get_credit_summary` uses the LiveCampusU data you
already sync (enrolments and grades) plus the term cap from the profile (`registration.creditCap`).

## 2. Create the Cloudflare tunnel

Needs a Cloudflare account with the zone (`nemut.ai`) and
[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).

```
cloudflared tunnel login                        # once, opens the browser
cloudflared tunnel create unicontext            # prints the tunnel UUID and writes ~/.cloudflared/<UUID>.json
cloudflared tunnel route dns unicontext uc.nemut.ai
unicontext remote tunnel-config --tunnel unicontext \
  --credentials-file ~/.cloudflared/<UUID>.json --write ~/.cloudflared/unicontext.yml
cloudflared tunnel --config ~/.cloudflared/unicontext.yml run unicontext
```

`unicontext remote tunnel-config` without `--write` prints the config. It maps only
`uc.nemut.ai → http://127.0.0.1:<remote.port>` and ends with a catch-all `http_status:404`; the
local admin port is never part of it. To run the tunnel in the background on Windows,
`cloudflared service install` uses `%USERPROFILE%\.cloudflared\config.yml`, so write the config
there instead (`--write %USERPROFILE%\.cloudflared\config.yml`).

Do **not** put Cloudflare Access, a WAF managed challenge or Bot Fight Mode in front of this
hostname: ChatGPT and claude.ai call `/.well-known/*`, `/register`, `/token` and `/mcp` from
their servers and cannot solve challenges. The OAuth layer above is the access control.

Check from anywhere:

```
curl https://uc.nemut.ai/.well-known/oauth-protected-resource
curl -i https://uc.nemut.ai/mcp -X POST     # 401 with WWW-Authenticate: Bearer resource_metadata="..."
```

Optional: test with MCP Inspector (`npx @modelcontextprotocol/inspector`), adding its callback
(`http://localhost:6274/oauth/callback`) to `remote.extraRedirectUris` while you test and removing
it afterwards.

## 3. Add it to ChatGPT (developer mode)

Needs Plus, Pro, Business, Enterprise or Edu on the web (Business/Enterprise: an admin must allow
developer mode).

1. Settings → Security and login → **Developer mode** on (https://chatgpt.com/settings/security).
2. Open https://chatgpt.com/plugins → **+** → **Create MCP App**.
3. URL: `https://uc.nemut.ai/mcp`. Authentication: **OAuth**. Leave client ID/secret empty —
   ChatGPT registers itself (Client ID Metadata Document or Dynamic Client Registration).
4. ChatGPT opens `uc.nemut.ai/authorize`: check the client name. Leave
   「締切・やること・メモ・講義の記録をUniContextに登録することも許可する」 ticked if ChatGPT should be
   able to register deadlines, to-dos and notes (next section), untick it for a read-only
   connection. Type your passphrase, press **許可**.
5. The app appears under Drafts. Start a **new** chat and enable it there. Read tools need no
   confirmation; ChatGPT may ask before calling a record tool.

After a UniContext update that changes tools, press **Refresh** on the app page and start a new
chat (ChatGPT caches tool metadata).

## Registering deadlines, to-dos and notes from ChatGPT (`unicontext.write`)

With the write scope, **every** ChatGPT conversation can register what you tell it, so all your
other ChatGPT chats, claude.ai and the local clients see the same deadlines and to-dos:

- `add_deadline`: a report / assignment deadline, a quiz or exam date, or something to prepare for
  a class. Say for example 「レポートの締切10/20って登録しといて」 or 「来週の金曜に小テストがある」. The
  course is optional (奨学金の手続き or 就活 deadlines have none). Only a stated date is registered
  (「次回までに」 counts). When a deadline is unknown, UniContext gives an early estimate instead
  (`estimatedDue`, labelled 「推定」 with its basis and where to confirm); clients plan with it but
  never state or register it as the deadline.
- `add_task`: something to do, with or without a due date — what you say you have to do, or the
  study plan you work out with ChatGPT (「毎日TOEICの単語を30分」).
- `add_note`: a memo, about a course or personal (「覚えておいて: ESは12月に3社」).
- `ingest_lecture`: a whole lecture recording or transcript (ChatGPT Record) in one call — see
  [Lecture recordings](#lecture-recordings-ingest_lecture).
- `record_lecture`: only the summary and key points of a lecture (to redo the lecture alone, or
  when you tell ChatGPT about a lecture in the chat).

### Lecture recordings (`ingest_lecture`)

When ChatGPT (or any client with the write scope) is given a lecture recording or transcript and
can reasonably tell the course and date, it calls `ingest_lecture` **without being asked**, in
addition to answering whatever you asked. The tool description and the server instructions say
so in Japanese and English: it does not ask whether to save, and does not ask again for a
course, date or period that the conversation, the recording or the timetable tells. Safety comes
from how it is stored, not from asking: everything is unconfirmed 「録音から」 and never changes
what LiveCampusU or the LMS say.

One call stores:

- the lecture (`record_lecture` semantics): a summary and key points cut down to what is needed
  to search and review later (not the transcript), and only the important timestamped segments;
  chatter and conversations between other students are left out;
- `deadlines[]`: only deadlines, exams, quizzes and preparation the lecturer actually stated
  (「次回までに〜」 counts; merely having a next class does not);
- `tasks[]`: what the student has to do;
- `notes[]`: information that is not a deadline but is needed later (classroom operations,
  attendance and submission procedure, grouping, special procedures, important warnings).

Each part carries a verbatim `evidence` quote and its `recordingTimestamp`, and goes through the
same path as `add_deadline` / `add_task` / `add_note` with `via: recording` (relative dates such
as 次回 resolved from the lecture date, the timetable and the academic calendar; dedupe; conflicts
with LiveCampusU; limits). `course` may be omitted: the class of the timetable at `lectureDate`
(default today) and `period` is used. `period` may be omitted when the course has one class, or
one continuous block (実験 5・6限), that day; separate classes of the same course on one day need
the period, so they never overwrite each other.

The result reports every part (`created`, `updated`, `duplicate`, `replayed`, `skipped`,
`failed` with an error code) with the resolved dates and any conflicts; one bad part never drops
the others (`outcome: partial`).

**Re-running is safe.** Every part gets a deterministic idempotency key:

| part     | key                                                           |
| -------- | ------------------------------------------------------------- |
| lecture  | `<base>:lecture`                                              |
| deadline | `<base>:deadline:<key>` (default `<normalized title>:<kind>`) |
| to-do    | `<base>:task:<key>` (default the normalized title)            |
| note     | `<base>:note:<key>` (default the normalized title)            |

`<base>` is the client-supplied `recordingRef` when the AI knows an id for the recording or the
conversation (convention: `chatgpt-record:<conversation-id>`), otherwise a hash of course +
lecture date + period. `<key>` is the item's optional stable name (`report-2`, `quiz-uml`). The
same key with the same content is a replay; with changed content it updates that same addition;
so sending the whole call again after 2 of 3 deadlines were stored adds only the third. All
parts of one recording carry the same `ingestionId` (per client and base), which
`list_my_additions` takes as a filter.

### Where items come from

Where an item came from is kept: told or planned **in a chat** (`via: chat`, the default) is shown
as 「チャットで登録」 with source 「ChatGPTとの会話」; **heard in a lecture recording** (`via:
recording`, or whenever a `recordingTimestamp` is given) is shown as 「録音から」 with source
"ChatGPT Record" and the position in the recording. The quoted words are kept as evidence.

Every client then reads them through the normal read tools, whichever client wrote them:
`get_today` / `get_tomorrow` / `get_week` (deadlines, tasks), `get_deadlines`, `get_tasks`,
`get_course` (that course's deadlines), `get_notes` (notes and lecture summaries; `course`,
`personal`, `query`, or `id` for the full text) and `search`. A read-only client such as claude.ai
sees them too.

- It is stored **only in UniContext's database on this PC**. Nothing is sent to LiveCampusU or any
  other university system.
- Items are `origin: extracted` until you confirm them, but they are shown, shared and notified at
  once; you do not have to confirm anything for other chats to see them. A chat item is your own
  statement, so it carries the authority `student-statement`; it still **never changes what
  LiveCampusU, the LMS or the syllabus say**: if a registered date differs from theirs (same
  course and title), UniContext shows a conflict with both values. Confirming
  (`unicontext additions confirm <id>`) turns it into your own fact, which then wins.
- Relative dates (来週の金曜, 10月20日17時, 次回) are resolved with the day it was said, your timetable
  and the academic calendar, and ChatGPT is told the resolved date. 次回 needs a course.
- Review: `unicontext additions` (list), `unicontext additions confirm <id>`,
  `unicontext additions reject <id>` (removed), or Web UI → Settings → AIが追加した内容. ChatGPT
  can list and withdraw only its own unconfirmed additions (`list_my_additions`,
  `retract_addition`).
- The same deadline told twice (same course, title, due date within 36 h) is one item; a retried
  call with the same `idempotencyKey` is not stored again.
- Limits per client: 30 creates/updates per 10 minutes and 300 per 24 hours, plus a burst limit
  of 30 calls per minute (counting duplicates, replays and retractions too). One `ingest_lecture`
  call counts once against the burst limit and each part it creates or updates once against the
  write limits; it takes at most 10 deadlines, 10 to-dos and 10 notes, 20 together, besides the
  lecture (at most 21 writes). Parts beyond the remaining budget come back as `failed`
  (`rate_limited`) while the others are stored; with no budget left the call fails as a whole.
- Every write is in the audit log (ids only, never text).
- The tools cannot submit anything, mark tasks submitted/completed, or touch grades or enrolment.

### Re-authorizing an existing ChatGPT connection to get the write scope

A grant keeps the scope it was approved with (refreshing never widens it), so an app connected
before this feature, or approved with the box unticked, stays read-only until it is authorized
again:

1. Optional but tidy: `unicontext remote clients`, then `unicontext remote revoke <clientId>` for
   the old ChatGPT client (or skip this; the new grant replaces it in practice).
2. In ChatGPT open https://chatgpt.com/plugins → your UniContext app → **Disconnect** (or remove
   the app and create it again with the same URL `https://uc.nemut.ai/mcp`), then **Connect**.
   ChatGPT asks for `unicontext.read unicontext.write` because the server advertises both.
3. On `uc.nemut.ai/authorize` keep 「締切・やること・メモ・講義の記録をUniContextに登録することも許可する」 ticked,
   type the passphrase, **許可**. `unicontext remote clients` then shows 範囲 「読み取り＋追加」
   (`--json`: `scopes`), and the `authorize` line in `logs/remote-audit.jsonl` has
   `"scope":"unicontext.read unicontext.write …"`.
4. Press **Refresh** on the app page and start a **new** chat so ChatGPT loads the new tools.

To go back to read-only, revoke the client and authorize again with the box unticked.

## Result size

ChatGPT cannot use multi-megabyte tool results, so what the tools return is compact (measured on a
real database after the first sync of a term: `get_week` went from about 2.9 MB to about 43 KB):

- Changes (`get_today`, `get_tomorrow`, `get_week`, `get_course`, `get_recent_changes`): one item
  per entity, decisive ones first (conflicts, class / assignment / exam changes, 休講), at most 30 for
  a day, 25 for the week, 20 for a course and 50 (up to `limit` 200) for `get_recent_changes`;
  `changesTotal` / `changesOmitted` say how many there were. Summaries are cut to 200 characters,
  `before` / `after` keep only short values (dates, rooms, states), and index entries, catalogue
  courses and notice bodies fetched later are not listed. Today and the week only list changes and
  conflicts of the current term's courses (and university-wide notices); `get_recent_changes` with
  `since` / `courseOfferingId` gives the rest.
- Citations: `{sourceReferenceId, label, url}` (the url only where a source first appears;
  `get_source` has the details), at most 20 at the top level.
- `get_course` lists the newest 10 materials, 20 files and 10 posts (`materialsTotal`,
  `filesTotal`, `discussionTotal`); `list_course_files` and `get_teams_activity` have the rest.

## 4. Add it to claude.ai

1. Settings → Connectors → **Add custom connector**.
2. URL: `https://uc.nemut.ai/mcp`. Leave the OAuth client ID/secret under Advanced empty (claude.ai
   uses Dynamic Client Registration; its callback `https://claude.ai/api/mcp/auth_callback` is on
   the allowlist).
3. **Connect** → the same passphrase page → **許可**.

## 5. Revoke access

```
unicontext remote clients                 # registered clients, last use, active grants
unicontext remote revoke <clientId>       # that client's tokens stop working immediately
unicontext remote revoke --all --yes      # everyone
```

Revocation works while the daemon is running (it re-reads its state file on the next request).
The app has to be authorized again (with the passphrase) to reconnect. To switch the endpoint off
completely, stop cloudflared and/or set `remote.enabled: false` and restart the daemon. Changing the
passphrase (`unicontext remote set-passphrase`) does not revoke existing grants; run
`remote revoke --all` too if you think the passphrase leaked.

## Allowed redirect URIs

- `https://chatgpt.com/connector_platform_oauth_redirect`
- `https://chatgpt.com/connector/oauth/<callback id>`
- `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`
- anything listed in `remote.extraRedirectUris` (exact match)

Client ID Metadata Documents (an https `client_id`) are fetched only from
`remote.clientMetadataHosts` (default `chatgpt.com`, `openai.com`, `claude.ai`, `claude.com`,
`anthropic.com` and their subdomains), without following redirects, 5 s timeout, 64 KiB max.
Such clients may use `none` or `private_key_jwt` (verified against the document's `jwks`/`jwks_uri`).

## Endpoints and protocol details

| Endpoint                                                              | Notes                                                                                                          |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `GET /.well-known/oauth-protected-resource[/mcp]`                     | `resource`, `authorization_servers`, `scopes_supported: [unicontext.read, unicontext.write, offline_access]`   |
| `GET /.well-known/oauth-authorization-server`, `openid-configuration` | S256 only, `authorization_response_iss_parameter_supported`, `client_id_metadata_document_supported`           |
| `POST /register`                                                      | RFC 7591; `none`, `client_secret_post`, `client_secret_basic`; at most 100 clients                             |
| `GET/POST /authorize`                                                 | consent page with passphrase and the write checkbox; responses carry `iss` (RFC 9207)                          |
| `POST /token`                                                         | `authorization_code` (PKCE S256, `resource` must match) and `refresh_token` (rotating)                         |
| `POST /revoke`                                                        | RFC 7009                                                                                                       |
| `POST /mcp`                                                           | Bearer token; 401 + `WWW-Authenticate: Bearer resource_metadata="…", scope="unicontext.read unicontext.write"` |

Unknown requested scopes are ignored. The grant is always `unicontext.read`, plus
`unicontext.write` only when the owner leaves the consent checkbox ticked (it starts ticked when the
client asked for it, unticked otherwise), plus `offline_access` if asked. Refresh tokens are issued even without `offline_access`, because ChatGPT's refresh
behaviour is undocumented.

## Troubleshooting

- **421 misdirected_request**: the Host is not the `publicUrl` hostname (typo in `publicUrl`, or a
  tunnel `httpHostHeader` override).
- **403 https_required**: the request did not come through the tunnel (or `trustedProxies` does not
  include the address cloudflared connects from).
- **ChatGPT "Connector is not safe" / timeout**: see the research notes; check that the metadata URLs
  above answer over https and that no Cloudflare challenge is in front.
- **Locked**: wait until the time shown on the page (`unicontext remote status` shows it too).
