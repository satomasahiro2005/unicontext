# @unicontext/cli

The `unicontext` command (spec §42, §62, §63, §68). It reads the local SQLite database directly
(WAL allows reading while the daemon runs), talks to a running daemon for syncs and corrections
when one is reachable, and otherwise does the work in-process. Human output is Japanese; every
command accepts `--json` for a stable machine-readable form.

```
pnpm build
node apps/cli/dist/bin.js --help      # or: pnpm unicontext --help
node apps/cli/dist/bin.js --dev today # synthetic Shizuoka seed data, nothing touches the real data dir
```

## Global options

| Option             | Meaning                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `--json`           | Machine output: the same shapes as the REST API (`apps/daemon/src/api-types.ts`).                |
| `--data-dir <dir>` | Data directory (default: per-OS location, `UNICONTEXT_DATA_DIR`). `config.yaml` is read from it. |
| `--config <file>`  | Config file (default: `<config dir>/config.yaml`).                                               |
| `--dev`            | Run on the synthetic seed (`createRuntime({dev: true})`, "now" is 2026-10-01 09:30 JST).         |
| `--no-keychain`    | Keep secrets in memory only (nothing is stored; logins are lost when the command ends).          |
| `--verbose`        | Runtime logs on stderr and a stack trace for errors.                                             |

Exit codes: `0` ok, `1` failure, `2` usage error (unknown command or option, bad value, or a
confirmation that needs `--yes` when there is no terminal). Errors are printed to stderr as a
Japanese one-liner plus a `ヒント:` line; core errors have specific hints (an expired login points
at `unicontext login <source>`). No stack trace without `--verbose`. Secrets and token-like values
are redacted (`redact()` from core) in errors, JSON and printed source text; control characters in
source text are stripped so nothing can inject terminal escapes.

Colours are used only when stdout is a TTY and `NO_COLOR` is not set. There is no emoji and no
telemetry (§61).

## Commands

| Command                                                | What it does                                                                                                                                                                                                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                                               | Daemon (url, pid, version), per-source health table, open conflicts, pending proposals and suggested links.                                                                                                                                                                |
| `sync [source]`                                        | Sync one source or every enabled one, sequentially. Through the daemon (`POST /api/v1/sources/:id/sync`) when reachable, else in-process. Exit 1 if any source failed.                                                                                                     |
| `login <source>`                                       | In-process `adapter.authenticate()`; prints the AuthResult. After success a running daemon is asked to sync.                                                                                                                                                               |
| `today`, `tomorrow`, `week`                            | Context views: classes, changes, deadlines, announcements, preparation, conflicts.                                                                                                                                                                                         |
| `courses`                                              | Identity-resolved courses with timetable, resolved room and open conflicts.                                                                                                                                                                                                |
| `assignments [--course c] [--all]`                     | Open tasks by default; `--all` adds submitted/completed/cancelled. `--course` takes an id, a course code or part of a title.                                                                                                                                               |
| `deadlines [--days n] [--course c]`                    | Overdue and upcoming deadlines.                                                                                                                                                                                                                                            |
| `changes [--since t]`                                  | Changes since yesterday, or since `t` (ISO time, `30m`, `2h`, `1d`, `1w`, `today`, `yesterday`).                                                                                                                                                                           |
| `search "<q>" [--limit n] [--course c]`                | Routed search (structured / lexical / transcript) with citations.                                                                                                                                                                                                          |
| `conflicts`                                            | Open conflicts with every candidate value, its source and its origin.                                                                                                                                                                                                      |
| `sources`                                              | Sources with state, last sync, detected version, schema drift and connector.                                                                                                                                                                                               |
| `correct <id> <value> [--note t]`                      | Store a user correction (origin `user`, §74) for a fact or conflict id; resolves the conflict. Prefers `POST /api/v1/facts/:id/correct` when a daemon runs.                                                                                                                |
| `correct --subject <entityId> --predicate <p> <value>` | Same, addressed by entity and predicate. In-process.                                                                                                                                                                                                                       |
| `confirm <proposalId> [--yes]`                         | Show an AI proposal (§50), ask `y/N`, then apply it. Without a terminal `--yes` is required (exit 2).                                                                                                                                                                      |
| `confirm --list`                                       | Pending proposals and suggested identity links.                                                                                                                                                                                                                            |
| `confirm link <l> <r>` / `confirm unlink <l> <r>`      | Confirm or reject an identity link (§14).                                                                                                                                                                                                                                  |
| `confirm reject <proposalId>`                          | Reject an AI proposal.                                                                                                                                                                                                                                                     |
| `doctor`                                               | Diagnose the environment (below). Exit 1 when any check is NG.                                                                                                                                                                                                             |
| `backup [--dir d]`                                     | Database snapshot, identity mappings and metadata. Never contains secrets.                                                                                                                                                                                                 |
| `export [file\|-]`                                     | Canonical model as JSONL (§68). No file or `-` streams to stdout; with `--json` and a file prints a summary.                                                                                                                                                               |
| `import <file> [--strict]`                             | Merge a JSONL export by id. Invalid lines are reported (exit 1); `--strict` aborts on the first.                                                                                                                                                                           |
| `purge source <id> [--yes]`                            | Delete everything that came from one source (§63). Asks `y/N`; without a terminal `--yes` is required.                                                                                                                                                                     |
| `mcp`                                                  | MCP server on stdio. stdout carries only the protocol; logs go to stderr. `--dev` is allowed.                                                                                                                                                                              |
| `service install\|uninstall\|status`                   | Start the daemon at login: launchd (macOS), Startup-folder wscript launcher (Windows, no Task Scheduler), systemd user unit (Linux).                                                                                                                                       |
| `daemon start\|stop\|status`                           | `start` spawns the daemon detached and waits up to 10 s for `/api/v1/health` (`--foreground` runs it in this terminal, `--port n`); `stop` posts `/api/v1/daemon/stop` with the bearer token and falls back to the pid in the lock file; `status` shows url, pid, version. |

Every command has `--help` with a one-line Japanese and English description. Conflicts are never
resolved silently: wherever sources disagree the CLI prints `競合` with all candidate values and
their citations. Every list shows its source (`根拠`, the citation label, §49/§75).

### `--json` shapes

`today`/`tomorrow`/`week`/`deadlines`/`changes` print the context bundle unchanged. `courses` is
`{courses}`, `assignments` `{assignments}`, `conflicts` `{conflicts}`, `sources` `{sources}`,
`search` the `SearchResponse`, `confirm --list` `{proposals, suggestedLinks}`, `sync`
`{via, reports, skipped}`, `status` the status report, `doctor` an array of checks.

### `doctor`

Each check is `{id, title, status, label, message, fix?}` with `status` `ok`/`warn`/`ng` shown as
`OK` / `警告` / `NG` and a `fix:` line for everything that is not OK. Checks: Node.js >= 22.12,
config file (the `ConfigError` message is shown verbatim), profile, data dir (exists, writable),
data dir permissions (POSIX: `chmod 700` hint; Windows: informational), database and migrations
(`MigrationError` message verbatim), every configured source (connector loadable, `checkHealth`
with a timeout; `auth_required` points at `unicontext login <id>`; disabled sources are skipped),
OS keychain round trip, daemon reachability, write token (never printed), Playwright (only matters
for `adapter: browser` sources), desktop notifications module, telemetry off. The environment
probes are injected (`CliDeps.probes`) so tests never touch the real keychain.

## Layout

```
src/bin.ts            shebang entry, thin
src/main.ts           buildProgram(deps), run(argv, deps)
src/deps.ts           CliDeps (writers, env, isTTY, now, createRuntime, daemonClient, secretStore, probes...)
src/context.ts        per-invocation context: lazy runtime, secrets and daemon client
src/commands/*.ts     one file per command family
src/format/*.ts       table renderer (East Asian width aware), colours, human views
test/*.test.ts        vitest; no network, no real keychain, daemons only on 127.0.0.1 in a temp dir
```

`run(argv, deps)` returns the exit code and never calls `process.exit`, so tests drive the whole CLI
with injected dependencies.
