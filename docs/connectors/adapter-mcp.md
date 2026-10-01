# adapter-mcp (`@unicontext/adapter-mcp`)

Connects to an **external MCP server** (SPEC §28) with the official `@modelcontextprotocol/sdk`
client and turns tool results into canonical entities through a YAML [mapping](mapping.md):
tool discovery → external schema → mapping → canonical model. Typical use: Canvas MCP, an EdStem
MCP, or any community server that wraps an LMS. GPL-licensed servers run out-of-process and are
never vendored (§56-58).

Stability: `apiStability: experimental`, `risk: experimental` (the server and its tool names are
not ours). Default schedule `15m`, product and capabilities come from the mapping.

## Setup

1. Install the MCP server you want to use (for example with `npx`). It is started on demand.
2. Pick or write a mapping. Shipped mappings live in `packages/adapter-mcp/mappings/`:
   `canvas-mcp.yaml`, `edstem-mcp.yaml`. Community servers differ in tool names and result
   shapes. Each YAML documents its assumptions at the top: adapt `call.tool`, `call.args` and
   `select` to the real catalog (see **Discovery**).
3. Store credentials in the SecretStore under `<sourceId>/<secretName>` (`secretKey('canvas',
'canvas-token')` = `canvas/canvas-token`; the keychain, never config.yaml). Config only names
   the secret.
4. Add the source and run `unicontext sync canvas`.

```yaml
# config.yaml
sources:
  canvas:
    adapter: mcp
    command: npx
    args: [-y, canvas-mcp]
    env: [CANVAS_BASE_URL] # inherit these names from the host environment ...
    # env: { CANVAS_BASE_URL: https://canvas.example.ac.jp }   # ... or give non-secret literals
    envSecrets: # name → SecretStore entry "<sourceId>/<secret>"
      - { name: CANVAS_API_TOKEN, secret: canvas-token }
    cwd: ~/mcp # optional
    mapping: canvas-mcp # shipped name | path to a YAML | inline object
    timeoutMs: 60000 # connect and per-call timeout
    minIntervalMs: 250 # optional pause between tool calls
    schedule: 15m
  ed:
    adapter: mcp
    url: https://mcp.example.org/mcp # streamable HTTP instead of stdio
    headerSecrets:
      - { name: Authorization, secret: ed-token, prefix: 'Bearer ' }
    mapping: ./mappings/my-ed.yaml
```

## Config keys

| Key                            | Meaning                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`, `args`, `cwd`       | stdio transport. The command is spawned **without a shell**; the child gets a minimal environment (`PATH`, `HOME`, ... but nothing else from the host) plus `env` and `envSecrets`.                                                                                                                                                           |
| `url`                          | Streamable HTTP transport. Exactly one of `command` / `url`.                                                                                                                                                                                                                                                                                  |
| `env`                          | List of variable names to inherit, or `{NAME: literal}` for non-secret values. Names that look like credentials are rejected here.                                                                                                                                                                                                            |
| `envSecrets` / `headerSecrets` | `{ENV_NAME: secretName}` or a list of `{name, secret, prefix?}`. Values are read from `ctx.secrets` when the process is spawned / the connection is opened, never stored in config, raw payloads or logs. Use the **list form** for names ending in `TOKEN`/`SECRET`/`KEY`: `config.yaml` loading rejects such record keys as inline secrets. |
| `headers`                      | Literal non-secret headers (credential headers are rejected: use `headerSecrets`).                                                                                                                                                                                                                                                            |
| `mapping`                      | Shipped mapping name, file path (relative to the working directory), inline YAML text or an inline object.                                                                                                                                                                                                                                    |
| `timeoutMs`                    | Connect timeout and per-call timeout (default 60000).                                                                                                                                                                                                                                                                                         |
| `minIntervalMs`                | Minimum pause between tool calls (default 0).                                                                                                                                                                                                                                                                                                 |

Resource `call` block: `{tool, args?, paginate?}`. `args` is templated (`{{course.id}}`).
`paginate: {cursorArg: cursor, nextCursor: "meta.next"}` repeats the call with the cursor taken
from the result (JSONata) until it is empty.

## Auth

Credentials only via `ctx.secrets`. Missing secrets give `auth_required` (`authenticate()`,
`health()`, sync). An HTTP 401/403 or SDK `UnauthorizedError` while connecting is also
`auth_required`. The OAuth flow of the SDK is not wired in: for HTTP servers use `headerSecrets`
with a token. `authenticate()` returns `authenticated` when secrets are configured and the server
connects, otherwise `not_required`; a server that cannot start is `failed`.

## Discovery and health

```ts
const adapter = createMcpConnector(spec).createAdapter(ctx) as McpSourceAdapter;
await adapter.discover(); // [{name, description, inputSchema, outputSchema?}] from tools/list
adapter.mappedTools(); // tool names the mapping calls
```

| Health          | When                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `healthy`       | the server starts, `tools/list` works and every mapped tool exists (`detectedVersion` = server version) |
| `degraded`      | a mapped tool is missing from the catalog (message lists them) or `tools/list` failed                   |
| `offline`       | the server cannot be started / connected                                                                |
| `auth_required` | a named secret is missing or the server rejects the credentials                                         |

A sync that needs a tool the server does not offer fails with a `ConnectorError` that lists the
available tools.

## Tool results

`structuredContent` is preferred; otherwise JSON in the text content (one block, the concatenation
of several, or one JSON value per block); otherwise `{text}`. `isError` results become
`ConnectorError` (message redacted). `McpError` timeouts are `ConnectorError`, a closed connection
is `OfflineError` (the next call reconnects).

## Raw types and mapping tables

`canvas-mcp.yaml` (product `canvas`, default authority `lms`; capabilities courses, assignments,
announcements, submissions):

| Raw type              | Tool                            | → Canonical                                                                                            | Authority                 |
| --------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------- |
| `canvas.course`       | `list_courses`                  | `courseOffering` (title, courseCode, academicYear from `term.name`, term, instructorNames, url)        | `lms`                     |
| `canvas.assignment`   | `list_assignments` per course   | `assignment` (dueAt, availableFrom, points, submissionType, url; fact `assignment_due` via auto-facts) | `submission-system`       |
| `canvas.announcement` | `list_announcements` per course | `announcement` (body without HTML, publishedAt, authorName, scope `course`)                            | `instructor-announcement` |
| `canvas.submission`   | `list_submissions` per course   | `submission` (status graded / late / submitted / not_submitted; fact `submission_status`)              | `submission-system`       |

`edstem-mcp.yaml` (product `edstem`, default authority `discussion`; capabilities courses,
announcements, messages):

| Raw type                              | Tool                                        | → Canonical                                                                                         | Authority                                                           |
| ------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `edstem.course`                       | `list_courses`                              | `courseOffering`                                                                                    | `discussion`                                                        |
| `edstem.thread` (type `announcement`) | `list_threads` per course                   | `announcement` (importance `high` when pinned)                                                      | `instructor-announcement`                                           |
| `edstem.thread` (other types)         | same                                        | `thread` + the opening post as `message` (`isQuestion` for `question`; authorRole from the Ed role) | `discussion`; `instructor-announcement` when written by admin/staff |
| `edstem.thread_detail`                | `get_thread`, only for threads with replies | `message` per answer and per comment                                                                | staff/admin: `instructor-announcement`, others `discussion`         |

## Schedule

`15m` by default (`defaultSchedule`). Every sync is a full relist (`complete: true` resources mark
vanished items as deleted). `SyncEngine` pages large fan-outs through `nextPageToken` (25 tool
calls per page by default).

## Limits and known issues

- Tool names and result shapes of community servers vary: the shipped mappings are templates.
- No push / change notifications; no incremental cursor (full relist each run).
- No rate limiter beyond `minIntervalMs`; EdStem details cost one call per thread with replies.
- The SDK OAuth flow and server-initiated requests (sampling, elicitation) are not supported.
- Only tools are used (no resources/prompts). Tools are called with the arguments the mapping
  gives; write-capable tools must simply not be mapped (§50).
- A server's stderr is drained to the debug log (redacted) and its last lines appear in the
  `offline` message when startup fails.
