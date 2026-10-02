# UniContext

> UniContext is a local-first context layer for university life. It connects student portals, LMSs, Microsoft 365, discussion platforms, lecture transcripts, and local files, then exposes one unified academic context to AI agents.

UniContext is not an LMS client. It rebuilds one student's university life from many systems (timetable, assignments, announcements, Teams, lecture recordings, local notes) into a single, source-attributed model, then lets an AI agent ask "What changed since yesterday?" and get an answer that points back to where each fact came from.

```
Sources -> Source Adapters -> Raw Store -> Normalization -> Canonical Model
        -> (Search | Event Log | Task Engine) -> Context Engine -> (MCP | REST | CLI | Web UI) -> AI
```

- Local first. Everything lives in a SQLite file on your machine. Tokens and cookies go to the OS keychain, never to the database or `config.yaml`.
- Honest about conflicts. When the academic system says room 21 and a teacher's Teams post says room 11, UniContext keeps both, says they conflict, and cites each source.
- Read-only by default. Anything that writes goes propose -> confirm -> execute. AI clients can propose a correction; only you can confirm it.
- No telemetry. Off, with no opt-in code path in v1.0.

Specification: [docs/SPEC.md](docs/SPEC.md). Architecture and APIs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quickstart

Requirements: Node.js 22.12 or newer and pnpm 11.

```sh
git clone <this repository> unicontext
cd unicontext
pnpm install
pnpm build
```

The CLI is `unicontext` (`apps/cli`). From the repository root it is available as `pnpm unicontext <command>`; to put it on your PATH run `pnpm link --global` inside `apps/cli`.

### 1. Check the setup

```sh
pnpm unicontext doctor
```

`doctor` checks the config file, the data directory, database migrations, every configured connector (installed? healthy? logged in?), keychain availability, whether the daemon is running, and whether Playwright is present. Each line says what is wrong and how to fix it.

### 2. Configure sources

Create the config file (path per OS: Linux `~/.config/unicontext/config.yaml`, macOS `~/.config/unicontext/config.yaml`, Windows `%LOCALAPPDATA%\unicontext\config.yaml`; `UNICONTEXT_CONFIG_DIR` overrides):

```yaml
profile: shizuoka-university
student: { campus: 浜松, faculty: 情報学部 } # optional: campus/faculty-only 休講日 in the 学年暦
sources:
  livecampusu: { enabled: true }
  microsoft365: { enabled: true }
  edstem: { adapter: mcp, command: npx, args: [edstem-mcp] }
  files: { roots: [~/University] }
sync: { background: true }
```

Connectors are loaded by package name on start (`livecampusu` loads `@unicontext/livecampusu`, `adapter: mcp` loads `@unicontext/adapter-mcp`). A missing or broken connector marks only that source as failed; the daemon keeps running. Secrets are rejected in `config.yaml` by design.

### 3. Log in and sync

```sh
pnpm unicontext login livecampusu
pnpm unicontext login microsoft365      # opens your browser (OAuth 2.0 + PKCE)
pnpm unicontext sync
pnpm unicontext today
pnpm unicontext changes --since yesterday
pnpm unicontext conflicts
```

`today` / `week` list the classes of the courses you registered for the current term, generated from the timetable and the profile's academic calendar (授業期間, 祝日, 振替授業日) with stored changes (休講・教室変更) applied; `courses` shows the current term (`--term 2026-1` / `--term 前期` for another one, `--all` for everything) with 時間割外・集中講義 listed separately.

Every command accepts `--json`. Try it without any university access: `pnpm unicontext --dev today` runs against synthetic seed data.

### 4. Run the daemon (optional but recommended)

```sh
pnpm unicontext daemon start            # unicontextd on http://127.0.0.1:17878
pnpm unicontext service install         # start at login (launchd / Startup folder / systemd --user)
```

The daemon syncs in the background, sends notifications (room change, cancelled class, new assignment, deadline changed or approaching, exam announced, important announcement, auth expired, sync failure), serves the Web UI at <http://127.0.0.1:17878/>, the REST API at `/api/v1/*`, and MCP over streamable HTTP at `/mcp`. It binds to `127.0.0.1` only and rejects requests whose `Host` or `Origin` is not loopback.

Service management: `unicontext service install|uninstall|status`. macOS installs a launchd LaunchAgent, Windows puts a hidden wscript launcher in the Startup folder (not Task Scheduler), Linux installs a `systemd --user` unit.

## Connect an AI client (MCP)

UniContext is an MCP server with high-level tools (`get_today`, `get_week`, `get_course`, `get_assignments`, `get_deadlines`, `get_recent_changes`, `prepare_for_class`, `review_class`, `search`, `get_source`, `get_conflicts`, `get_tasks`) and resources (`unicontext://today`, `unicontext://week`, `unicontext://course/{id}`, `unicontext://lecture/{id}`, `unicontext://document/{id}`). Every answer carries citations and conflict notices, so the model can reply like: "Tomorrow's 2nd period is Database Systems, room 21. Source: Academic system, fetched 10/1 09:42."

`correct_fact` is propose-only. It creates a pending proposal; you approve it with `unicontext confirm <id>` or in the Web UI (Settings). There is no tool for submitting assignments, changing enrolment or touching grades.

Record tools let an AI client write what it heard in a lecture recording (ChatGPT Record) into UniContext's own database, never to a university system:

| Tool                | What it stores                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `record_lecture`    | Summary, key points and an optional timestamped transcript excerpt, linked to that day's class (Lecture, LectureTranscript, LectureSegments)                                            |
| `add_deadline`      | An assignment, report, quiz, exam or preparation item. `dueAt` is ISO-8601 or Japanese as heard (`来週の金曜`, `次回`), resolved with the lecture date, timetable and academic calendar |
| `add_note`          | A note on the course (searchable)                                                                                                                                                       |
| `add_task`          | A to-do, with or without a due date                                                                                                                                                     |
| `list_my_additions` | The calling client's own additions and their status                                                                                                                                     |
| `retract_addition`  | Withdraws one of the calling client's own unconfirmed additions                                                                                                                         |

Everything they write is `origin=extracted`, cites the recording (client, time, recording timestamp, quoted evidence), shows as 「録音から」 on Today and in the deadlines, gets deadline notifications for courses you take, and never overrides LiveCampusU or the syllabus: a different date becomes a conflict. You confirm (it becomes your own fact) or reject each one with `unicontext additions` (`confirm <id>`, `reject <id>`) or in the Web UI (Settings). The same item said twice is updated, not duplicated, and each call can carry an `idempotencyKey`. Writes are rate limited per client and cannot change task status, submissions or grades.

Replace `/abs/path/to/unicontext` below with your checkout.

### Claude Code

stdio (starts a server per session, no daemon needed):

```sh
claude mcp add unicontext -- node /abs/path/to/unicontext/apps/cli/dist/bin.js mcp
```

or through the running daemon:

```sh
claude mcp add --transport http unicontext http://127.0.0.1:17878/mcp
```

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "unicontext": {
      "command": "node",
      "args": ["/abs/path/to/unicontext/apps/cli/dist/bin.js", "mcp"]
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.unicontext]
command = "node"
args = ["/abs/path/to/unicontext/apps/cli/dist/bin.js", "mcp"]
```

Codex versions that support streamable HTTP servers can use the daemon instead: `url = "http://127.0.0.1:17878/mcp"`.

### ChatGPT

ChatGPT on the web (developer-mode MCP app) and claude.ai connect to remote MCP servers over public HTTPS. UniContext listens on loopback only by default. If you want it there, enable the optional **remote endpoint**: a separate listener with the read tools, published through a Cloudflare named tunnel and protected by OAuth 2.1 plus an owner passphrase on every authorization. The record tools above are added only for clients you grant the `unicontext.write` scope on the approval page. It never exposes the REST API, the Web UI or the propose-only tools, and every remote tool call is audit-logged. Setup and revocation: [docs/remote.md](docs/remote.md) (`unicontext remote set-passphrase | tunnel-config | clients | revoke`).

## Web UI

`pnpm build` also builds the Web UI (`apps/web`, React + Vite + TanStack Router). The daemon serves it. Screens: Today, Courses, Assignments, Calendar, Changes, Search, Sources (health per connector, sync, login hint), Conflicts (resolve with a correction), Settings. Every item can open the source it came from. For development: `pnpm --filter @unicontext/web dev` (proxies `/api` and `/mcp` to the daemon).

## REST API

`GET /api/v1/today | tomorrow | week | courses[?term=<id|前期|all>] | courses/:id | assignments | deadlines | changes | search?q= | conflicts | sources`, and writes `POST /api/v1/sources/:id/sync | facts/:id/correct | identity/confirm | tasks/:id/status`. Writes need `Authorization: Bearer <token>` (the token lives in the OS keychain under `daemon/api-token`; with no keychain it is a 0600 file `daemon.token` in the data directory) or, for the Web UI, a CSRF token plus a same-origin `Origin`.

## Backup, export, delete

```sh
unicontext backup                       # DB + mappings + metadata, no secrets
unicontext export backup.jsonl          # canonical model as JSONL
unicontext import backup.jsonl
unicontext purge source edstem          # delete one source's data
```

## Development

```sh
pnpm install
pnpm build        # tsc -b for all packages, then the Web UI
pnpm test         # vitest, no network, no real university access
pnpm lint
pnpm check        # build + type-check tests + lint + test
```

Layout: `packages/*` (core, canonical-model, database, connector-sdk, auth, provenance, identity, search, sync-engine, task-engine, context-engine, notifications, adapters), `connectors/*`, `apps/{daemon,cli,mcp,web}`, `profiles/*`. See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT. See [LICENSE](LICENSE).
