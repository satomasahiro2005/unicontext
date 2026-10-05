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
  sync engine can never delete unseen items either. A lost session aborts the run with
  `auth_required` and makes no changes at all.
- **Polite & incremental.** One request at a time with a pause (≈3 s + jitter) and exponential
  backoff; `maxFoldersPerRun` (default 60) per run; the walk resumes from where it stopped via the
  cursor, re-lists stale folders, and re-seeds the whole tree every `rewalkAfterHours` (72 h).
  Schedule is daily; keep it off known maintenance windows.
- **Own browser profile.** Not shared with LiveCampusU/Teams (different host and session system).

## Enabling it and signing in

1. In `config.yaml`, list the source so the (profile-disabled) entry turns on:

   ```yaml
   sources:
     shizuoka-vpn-files: { enabled: true }
   ```

2. Sign in once (the human does the password/MFA; UniContext never types credentials):

   ```
   unicontext login shizuoka-vpn-files
   ```

   A browser window opens on the portal. After sign-in, background syncs reuse that session
   headlessly. When the session is gone, a sync stops with `auth_required` — run `login` again.

Optional config (all under `sources.shizuoka-vpn-files`): `roots.disable` / `roots.include`,
`courseMap` (`[{ path, root?, course }]`), `prefetch` (path prefixes to pre-download small files),
`walk.*` (caps and intervals), `files.*` (download/extract limits), `mirror.*` (opt-in local copy).

## Exploring from the AI (local index, read-only)

MCP tools (local and the remote read-only surface):

- `browse_vpn_files { root?, path?, limit?, offset? }` — a folder's subfolders (each with its last
  successful listing time and status) and files. No `root` → the share roots.
- `search_vpn_files { query, year?, course?, root? }` — name/path substring across the whole index.
- `list_recent_vpn_files { since?, root? }` — recently added/updated files, newest first.
- `download_course_file { file }` — download one file's bytes/text on request (pass a `document:…`
  id from the tools above). Downloaded files are cached locally, so later reads never touch the
  portal; retries use backoff.

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
