# adapter-cli (`@unicontext/adapter-cli`)

Runs an **external command line tool** that prints JSON (SPEC §29) and maps the output to canonical
entities with a YAML [mapping](mapping.md). The tool is a separate process, so GPL or otherwise
incompatible tools can be used without being vendored (§56-58).

Stability: `apiStability: experimental`, `risk: experimental`. Default schedule `15m`; product and
capabilities come from the mapping.

## Setup

1. Install the tool and make sure it prints JSON (`--json`, `-o json`, ...).
2. Choose a mapping: `packages/adapter-cli/mappings/edstem-cli.yaml` is a template for an
   EdStem wrapper CLI (its assumptions about the output are documented at the top). Adapt
   `call.args` and the field paths to your tool.
3. Store credentials in the SecretStore (`<sourceId>/<secretName>`); they are passed to the
   child as environment variables only.
4. Add the source.

```yaml
# config.yaml
sources:
  edstem:
    adapter: cli
    command: edstem # no shell: use the real executable
    args: [] # put in front of every call's own args
    cwd: ~/edstem
    env: [HOME] # inherit by name, or { NAME: literal }
    envSecrets:
      - { name: ED_API_TOKEN, secret: edstem-token }
    healthArgs: [--version] # health probe + version detection
    timeoutMs: 60000
    maxOutputBytes: 10485760
    minIntervalMs: 0
    authErrorPattern: 'not logged in|token expired' # stderr marking auth_required (default: common phrases)
    mapping: edstem-cli # shipped name | file path | inline object
    schedule: 15m
```

## Config keys

| Key                        | Meaning                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `command`                  | Executable, spawned with `shell: false`. On Windows this must be an `.exe` (or `node script.js`): `.cmd`/`.bat` shims need a shell and are not started.                                                                                                                                                                                                                        |
| `args`                     | Arguments placed before every resource's `call.args`.                                                                                                                                                                                                                                                                                                                          |
| `cwd`, `env`, `envSecrets` | Working directory; environment. The child receives only a minimal safe environment (`PATH`, `HOME`, `SYSTEMROOT`, ...) plus `env` and `envSecrets`; nothing else leaks from the host. Credential-looking names in `env` are rejected; use the list form `[{name, secret, prefix?}]` for names ending in `TOKEN`/`SECRET`/`KEY` (config.yaml loading rejects such record keys). |
| `timeoutMs`                | Per invocation (default 60000). The process is killed (`SIGKILL`) when it expires.                                                                                                                                                                                                                                                                                             |
| `maxOutputBytes`           | stdout cap (default 10 MiB); exceeding it kills the process and fails the call.                                                                                                                                                                                                                                                                                                |
| `minIntervalMs`            | Minimum pause between invocations.                                                                                                                                                                                                                                                                                                                                             |
| `healthArgs`               | Harmless invocation for `health()`; the first version-looking token of its output is the detected version (§72).                                                                                                                                                                                                                                                               |
| `authErrorPattern`         | Regex on stderr that turns a failure into `auth_required`.                                                                                                                                                                                                                                                                                                                     |
| `mapping`                  | Shipped mapping name, path, inline YAML text or object.                                                                                                                                                                                                                                                                                                                        |

Resource `call` block:

```yaml
call:
  args: [threads, '{{course.id}}', --json, --limit, '100'] # every element is one argv entry
  stdin: 'plain text' # optional; objects are sent as JSON
  format: json # json (default) | jsonl
  okExitCodes: [0] # default [0]
  paginate: { cursorArg: --cursor, nextCursor: 'meta.next' } # JSONata on the parsed output
```

## Safety

- `shell: false`: template values are separate argv entries, so quoting characters, `$()`, `;`, `*`
  and spaces are passed literally.
- A whole-argument placeholder (`"{{course.id}}"`) whose value starts with `-` is refused so remote
  data cannot be turned into an option.
- Credentials are never put in arguments by the adapter (use `envSecrets`); stderr shown in errors
  is redacted (`core.redact`) and limited to the last 400 characters.

## Errors and health

| Situation                                                                                          | Result                                                   |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| command not installed / not executable                                                             | `OfflineError`; `health()` = `offline`                   |
| non-zero exit (not in `okExitCodes`)                                                               | `ConnectorError` with exit code and redacted stderr tail |
| stderr matches `authErrorPattern` (default: "not logged in", "unauthorized", "token expired", ...) | `AuthRequiredError` → `auth_required`                    |
| timeout / output over `maxOutputBytes`                                                             | `ConnectorError` (process killed)                        |
| output is not valid JSON/JSONL, or empty                                                           | `ConnectorError`                                         |
| named secret missing                                                                               | `auth_required`                                          |
| `healthArgs` exits non-zero                                                                        | `degraded`                                               |

`dispose()` kills running children.

## Raw types and mapping table (`edstem-cli.yaml`)

Product `edstem`, default authority `discussion`, capabilities courses, announcements, messages.

| Raw type                              | Command                                         | → Canonical                                                     | Authority                                                   |
| ------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| `edstem.course`                       | `courses --json`                                | `courseOffering`                                                | `discussion`                                                |
| `edstem.thread` (type `announcement`) | `threads <course> --json --limit 100`           | `announcement`                                                  | `instructor-announcement`                                   |
| `edstem.thread` (other)               | same                                            | `thread` + opening post `message` (`isQuestion` for `question`) | `discussion`; staff/admin: `instructor-announcement`        |
| `edstem.thread_detail`                | `thread <id> --json`, only threads with replies | `message` per answer / comment                                  | staff/admin: `instructor-announcement`, others `discussion` |

## Schedule and limits

- `15m` default; every sync is a full relist (`complete: true` on courses).
- The tool must be non-interactive: no prompts, no pager. stdin is closed after writing.
- Output is held in memory (cap above); use `jsonl` for long listings.
- One process per call; large fan-outs are paged with `nextPageToken` (25 calls per page).
- Read-only by design: map only commands that read (§50).
