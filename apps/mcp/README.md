# @unicontext/mcp

UniContext as an MCP server (spec §39, §40, §50, §75). It exposes the context engine, search and
source provenance to AI clients through high-level tools and resources. Corrections are
propose-only; the record tools write what a client heard in a lecture into UniContext's own
database as unconfirmed, extracted data.

## How it is launched

| Transport       | Launched by                                                                                      | Notes                                                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stdio           | `unicontext mcp` (CLI) calling `runStdioServer(deps)`                                            | stdout carries only the protocol; logs are JSON lines on stderr. Resolves when the client disconnects.                                                                                                                                                          |
| streamable HTTP | the daemon at `http://127.0.0.1:17878/mcp`, calling `handleMcpHttp(deps, req, res, parsedBody?)` | Stateless: a new `McpServer` + `StreamableHTTPServerTransport` per request, closed when the response closes. `POST` only (`GET`/`DELETE` get 405). Replies are plain JSON (`enableJsonResponse`). Loopback binding and Host/Origin checks are the caller's job. |

Example client configuration (stdio):

```json
{ "mcpServers": { "unicontext": { "command": "unicontext", "args": ["mcp"] } } }
```

## Public API

```ts
import {
  createMcpServer,
  runStdioServer,
  handleMcpHttp,
  ProposalStore,
  applyProposal,
  buildAssignments,
} from '@unicontext/mcp';

interface McpDeps {
  uc: UniContext; // @unicontext/context-engine
  proposals: ProposalStore;
  logger?: Logger;
  version?: string;
  sourcesInfo?: () => unknown; // optional extra info added (redacted) to get_source
}
```

- `createMcpServer(deps)` returns an `McpServer` with every tool and resource registered.
- `ProposalStore(dir, {clock?, ttlMs?})` keeps one JSON file per proposal under `dir` (atomic
  temp-file + rename), so the stdio MCP process and the daemon/CLI can share it. Proposals expire
  after 24 h by default; expiry is applied lazily on read.
- `applyProposal(uc, store, id)` is the user-initiated execution step (CLI `unicontext confirm <id>`,
  Web UI). It checks the proposal is pending and unexpired, calls `uc.resolver.correct(...)`
  (stored as an `origin=user` fact, §74) and marks it confirmed.
- `buildAssignments(uc, filter)` returns `AssignmentItem[]` (shared with the daemon's REST twin).

## Result envelope

Every tool result and every resource body is the same JSON object, returned as `structuredContent`
and as JSON text content:

```jsonc
{
  "data": {/* the view / list / record */},
  "citations": [/* Citation[], de-duplicated across the whole result */],
  "conflicts": [
    "「データベースシステム論」の教室: 情報学部2号館21教室（学務情報システム）と情報学部2号館11教室（Microsoft Teams）が食い違っています。どちらが正しいか断定せず両方を伝えてください",
  ],
  "answerHint": "回答には根拠を添えてください（例: 根拠: 学務情報システム 10/1 09:42取得）。…",
}
```

`citations` and `conflicts` are collected by walking `data`: every citation object anywhere, and
every `ResolvedValue` with `status: 'conflict'` or `ConflictItem`. Citation URLs are scrubbed of
tokens. Errors (`NotFoundError`, `ValidationError`, invalid arguments, unknown ids) come back as
`isError: true` with a short message, never as a crash.

## Tools

All read tools carry `readOnlyHint: true`. Course arguments accept a course offering id or a fuzzy
title / course code (resolved through identity links to the canonical course).

| Tool                 | Arguments                                                                                                                                                                                     | Returns                                                                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_today`          | none                                                                                                                                                                                          | `today` view: classes (resolved room/status), changes, deadlines, tasks, important announcements, preparation, conflicts                                                                    |
| `get_tomorrow`       | none                                                                                                                                                                                          | `tomorrow` view                                                                                                                                                                             |
| `get_week`           | none                                                                                                                                                                                          | `week` view                                                                                                                                                                                 |
| `get_course`         | `courseOfferingId`                                                                                                                                                                            | `course` view across all sources                                                                                                                                                            |
| `get_assignments`    | `courseOfferingId?`, `status?` (one or many), `includeCompleted?`                                                                                                                             | `{assignments: AssignmentItem[]}`, open tasks by default                                                                                                                                    |
| `get_tasks`          | `status?`, `courseOfferingId?`                                                                                                                                                                | `{tasks: AssignmentItem[]}`, everything except cancelled by default                                                                                                                         |
| `get_deadlines`      | `days?`, `courseOfferingId?`                                                                                                                                                                  | `deadline` view (overdue + upcoming)                                                                                                                                                        |
| `get_recent_changes` | `since?` (ISO or `YYYY-MM-DD`), `courseOfferingId?`                                                                                                                                           | `changes` view                                                                                                                                                                              |
| `prepare_for_class`  | `sessionId?` or `courseOfferingId?`                                                                                                                                                           | `class-preparation` view                                                                                                                                                                    |
| `review_class`       | `lectureId?`, `sessionId?`, `courseOfferingId?`, `date?`                                                                                                                                      | `class-review` view (lecture bundle with transcript timestamps)                                                                                                                             |
| `search`             | `query`, `limit?`, `courseOfferingId?`                                                                                                                                                        | `SearchResponse` (hits carry citations)                                                                                                                                                     |
| `get_source`         | `sourceReferenceId` (alias `citationId`) or `rawItemId`                                                                                                                                       | source reference, citation, related references, facts, and a raw payload summary (secrets redacted with core `redact()`, truncated to 4000 characters) plus the optional `sourcesInfo` hook |
| `get_conflicts`      | none                                                                                                                                                                                          | open conflicts (`ConflictItem[]`)                                                                                                                                                           |
| `correct_fact`       | `subject` (entity id or course title), `predicate`, `value`, `note?`                                                                                                                          | `{proposalId, status: 'pending', preview, howToConfirm, expiresAt, applied: false, current}`                                                                                                |
| `record_lecture`     | `course`, `date`, `period?`, `title?`, `summary`, `keyPoints?`, `transcriptExcerpt?`, `segments?[{at?, text, speaker?}]`, `recordingTimestamp?`, `source?`, `idempotencyKey?`                 | Lecture (+ summary Document, LectureTranscript, LectureSegments) linked to that day's ClassSession                                                                                          |
| `add_deadline`       | `course`, `title`, `dueAt` (ISO or 来週の金曜 / 次回 …), `kind` (assignment/report/quiz/exam/prep), `evidence`, `recordingTimestamp?`, `lectureDate?`, `notes?`, `source?`, `idempotencyKey?` | extracted `assignment_due` / `exam_at` fact (own Assignment/Exam or attached to the system's), or a `todo` fact → Task                                                                      |
| `add_note`           | `course`, `text`, `title?`, `evidence?`, `lectureDate?`, …                                                                                                                                    | Document (searchable), linked to the lecture of `lectureDate`                                                                                                                               |
| `add_task`           | `course`, `title`, `dueAt?`, `notes?`, `evidence?`, …                                                                                                                                         | `todo` fact → Task                                                                                                                                                                          |
| `list_my_additions`  | `status?`, `limit?`                                                                                                                                                                           | the calling client's additions                                                                                                                                                              |
| `retract_addition`   | `additionId`                                                                                                                                                                                  | removes one of the client's own unconfirmed additions                                                                                                                                       |

### Record tools (§11, §19–22, §47–49, §74)

`record_lecture`, `add_deadline`, `add_note`, `add_task`, `list_my_additions` and
`retract_addition` (`src/additions.ts`, backed by `AdditionsService` in the context engine) store
what a client heard in a lecture recording. Annotations: `readOnlyHint: false`,
`destructiveHint` only on `retract_addition`, `idempotentHint: true`, `openWorldHint: false`. Each
has an output schema; `structuredContent` is `{status: created|updated|duplicate|replayed|retracted,
addition: {id, kind, status, title, course, dueAt, dueText, dueResolution, evidence,
recordingTimestamp, source, stored, attachedTo?, conflicts}, answerHint}`.

- Everything is `origin=extracted` with a SourceReference `{sourceSystem: "ChatGPT Record" (or the
client name / `source`), sourceItemId: "<client id>#<addition id>", retrievedAt,
location.timestamp}` and the quoted evidence on the fact. Source id `mcp-additions`.
- `add_deadline` attaches the date to an existing assignment/exam of the course when the title
  matches (a different date opens a Conflict with LiveCampusU/the LMS; the system's value stays what
  tasks show), otherwise it creates its own Assignment/Exam. `prep` and `add_task` become tasks
  through `todo` facts (multi-valued, never a Conflict).
- Course names resolve like the read tools, preferring courses the student takes.
- Dedupe: same course + kind group + normalized title with a due date within 36 h updates the
  client's own unconfirmed item (another client's or a confirmed one is reported as `duplicate`).
  `idempotencyKey` (or a hash of the arguments) makes a retry a `replayed` no-op.
- Limits: field sizes in the input schemas (`ADDITION_LIMITS`), 30 writes per 10 minutes and 300 per
  day per client, 30 calls per minute per process.
- The client is `McpDeps.client` (remote: the OAuth client) or `local:<MCP client name>`.
  `onToolCall` receives `write: {status, additionId, entityIds, factIds}` — ids only.

### Corrections are propose-only (§50, §51)

`correct_fact` never writes a fact. It stores a `Proposal` and tells the model to hand the id to the
user, who confirms with `unicontext confirm <id>` or in the Web UI. Only then does
`applyProposal` store an `origin=user` fact that wins over the sources (§74). Predicates starting
with `grade`, `submission` or `enrol` are refused. There are no tools for submitting assignments,
enrolment changes or grades; a task's `submitted` status can only come from the submission system.

### Remote surface (ChatGPT / claude.ai)

`createMcpServer({ ..., surface: 'remote', onToolCall })` (used by the daemon's tunnelled listener,
see [docs/remote.md](../../docs/remote.md)) registers the read tools, plus the record tools when
`allowWrite` is set (the grant has `unicontext.write`): `correct_fact` and `propose_pace_slot` never
exist there. It uses `REMOTE_SERVER_INSTRUCTIONS` (`REMOTE_WRITE_SERVER_INSTRUCTIONS` with write),
returns compact JSON
text next to `structuredContent`, leaves raw payloads and `sourcesInfo` out of `get_source`, and
calls `onToolCall({tool, ok, ms})` after every call (never with arguments) for the audit log.
Tool descriptions avoid wording ChatGPT's connector scanner flags (tests check this).

## Resources (§40)

All resources are `application/json` and use the same envelope.

- Fixed: `unicontext://today`, `unicontext://week`, `unicontext://tomorrow`,
  `unicontext://deadline`, `unicontext://changes`, `unicontext://admin`.
- Templates: `unicontext://course/{id}`, `unicontext://lecture/{id}` (lecture or classSession id),
  `unicontext://document/{id}` (metadata, an excerpt of up to 8000 characters from the chunks, and
  citations). Listing enumerates courses, lectures and documents.

## Tests

`npx vitest run apps/mcp` (from the repository root). The contract tests link an SDK `Client` to
`createMcpServer` over `InMemoryTransport` on an in-memory `UniContext` populated from the
synthetic seed; the HTTP tests run `handleMcpHttp` on a loopback `node:http` server with the SDK's
`StreamableHTTPClientTransport`. No network access is needed.
