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

| Tool                 | Arguments                                                                                                                                                                                                                                                                                                                                | Returns                                                                                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_today`          | none                                                                                                                                                                                                                                                                                                                                     | `today` view: classes (resolved room/status), changes, deadlines, tasks, important announcements, preparation, conflicts                                                                                                            |
| `get_tomorrow`       | none                                                                                                                                                                                                                                                                                                                                     | `tomorrow` view                                                                                                                                                                                                                     |
| `get_week`           | none                                                                                                                                                                                                                                                                                                                                     | `week` view                                                                                                                                                                                                                         |
| `get_course`         | `courseOfferingId`                                                                                                                                                                                                                                                                                                                       | `course` view across all sources                                                                                                                                                                                                    |
| `get_assignments`    | `courseOfferingId?`, `status?` (one or many), `includeCompleted?`, `includePast?`                                                                                                                                                                                                                                                        | `{assignments: AssignmentItem[]}`, open tasks by default; `includePast` adds unfinished work of ended terms (`expired_past_term`)                                                                                                   |
| `get_tasks`          | `status?`, `courseOfferingId?`                                                                                                                                                                                                                                                                                                           | `{tasks: AssignmentItem[]}`, everything except cancelled by default                                                                                                                                                                 |
| `get_deadlines`      | `days?`, `courseOfferingId?`                                                                                                                                                                                                                                                                                                             | `deadline` view (overdue + upcoming)                                                                                                                                                                                                |
| `get_recent_changes` | `since?` (ISO or `YYYY-MM-DD`), `courseOfferingId?`, `limit?` (default 50, max 200)                                                                                                                                                                                                                                                      | `changes` view (compact: one item per entity, decisive first, `changesTotal` / `changesOmitted`)                                                                                                                                    |
| `get_notes`          | `course?`, `personal?`, `query?`, `id?`, `limit?`                                                                                                                                                                                                                                                                                        | `{notes: NoteItem[], total}`: notes (`add_note`) and lecture summaries (`record_lecture`) of every client, newest first, text cut to 500 characters unless one `id` is asked for                                                    |
| `get_announcements`  | `since?`, `unreadOnly?`, `courseOfferingId?`, `limit?` (max 100)                                                                                                                                                                                                                                                                         | `{announcements: AnnouncementItem[]}` newest first: read state, `bodyStatus`, category, attachments, body excerpt (400 chars). Unread LiveCampusU notices may have no body (`bodyStatus: notOpened`)                                |
| `get_announcement`   | `id` (`announcement:...`, e.g. from `get_announcements` or `search`)                                                                                                                                                                                                                                                                     | `{announcement: AnnouncementDetail}`: full body, sender, category, attachments, links, target courses, target date, read state                                                                                                      |
| `prepare_for_class`  | `sessionId?` or `courseOfferingId?`                                                                                                                                                                                                                                                                                                      | `class-preparation` view                                                                                                                                                                                                            |
| `review_class`       | `lectureId?`, `sessionId?`, `courseOfferingId?`, `date?`                                                                                                                                                                                                                                                                                 | `class-review` view (lecture bundle with transcript timestamps)                                                                                                                                                                     |
| `search`             | `query`, `limit?`, `courseOfferingId?`                                                                                                                                                                                                                                                                                                   | `SearchResponse` (hits carry citations)                                                                                                                                                                                             |
| `get_source`         | `sourceReferenceId` (alias `citationId`) or `rawItemId`                                                                                                                                                                                                                                                                                  | source reference, citation, related references, facts, and a raw payload summary (secrets redacted with core `redact()`, truncated to 4000 characters) plus the optional `sourcesInfo` hook                                         |
| `get_conflicts`      | none                                                                                                                                                                                                                                                                                                                                     | open conflicts (`ConflictItem[]`)                                                                                                                                                                                                   |
| `correct_fact`       | `subject` (entity id or course title), `predicate`, `value`, `note?`                                                                                                                                                                                                                                                                     | `{proposalId, status: 'pending', preview, howToConfirm, expiresAt, applied: false, current}`                                                                                                                                        |
| `ingest_lecture`     | `course?`, `lectureDate?`, `period?`, `title?`, `summary`, `keyPoints?`, `segments?`, `recordingRef?`, `source?`, `deadlines?[{key?, title, dueAt, kind, evidence, recordingTimestamp?, notes?}]`, `tasks?[{key?, title, dueAt?, evidence, recordingTimestamp?, notes?}]`, `notes?[{key?, title?, text, evidence, recordingTimestamp?}]` | One lecture recording at once: the lecture plus its deadlines, to-dos and notes (via=recording); per-part results, `ingestionId`                                                                                                    |
| `record_lecture`     | `course`, `date`, `period?`, `title?`, `summary`, `keyPoints?`, `transcriptExcerpt?`, `segments?[{at?, text, speaker?}]`, `recordingTimestamp?`, `source?`, `idempotencyKey?`                                                                                                                                                            | Lecture (+ summary Document, LectureTranscript, LectureSegments) linked to that day's ClassSession                                                                                                                                  |
| `add_deadline`       | `course?`, `title`, `dueAt` (ISO or 10月20日17時 / 来週の金曜 / 次回 …), `kind` (assignment/report/quiz/exam/prep), `evidence`, `via?` (chat/recording), `recordingTimestamp?`, `lectureDate?`, `notes?`, `source?`, `idempotencyKey?`                                                                                                   | extracted `assignment_due` / `exam_at` fact (own Assignment/Exam or attached to the system's), or a `todo` fact → Task                                                                                                              |
| `add_note`           | `course?`, `text`, `title?`, `evidence?`, `via?`, `lectureDate?`, …                                                                                                                                                                                                                                                                      | Document (searchable, `get_notes`), linked to the lecture of `lectureDate`; without a course a personal note                                                                                                                        |
| `add_task`           | `course?`, `title`, `dueAt?`, `notes?`, `evidence?`, `via?`, …                                                                                                                                                                                                                                                                           | `todo` fact → Task (without a course on the student's own subject)                                                                                                                                                                  |
| `list_my_additions`  | `status?`, `limit?`, `ingestionId?`                                                                                                                                                                                                                                                                                                      | the calling client's additions                                                                                                                                                                                                      |
| `open_announcement`  | `ids` (1–10 `announcement:…`)                                                                                                                                                                                                                                                                                                            | fetches the bodies of unread LiveCampusU notices through the daemon (`McpDeps.openAnnouncements`); marks them read in LiveCampusU (irreversible: `destructiveHint`, `openWorldHint`); UniContext keeps them unread until read there |
| `retract_addition`   | `additionId`                                                                                                                                                                                                                                                                                                                             | removes one of the client's own unconfirmed additions                                                                                                                                                                               |

### Deadline coverage

`get_deadlines`, `get_today`, `get_week` and `get_course` return `coverage`: the sources the
deadlines come from (`sources[]`: label, what each feeds — 課題, 試験, 予定, お知らせ／投稿の文中の締切
— and its health `ok` / `auth_required` / `stale` / `failing` / `never_synced`), the known `gaps`
(a deadline source that is down or stale; a course that also lives on a platform whose assignments
are not synced, e.g. Microsoft 365; open assignments without a due date, 期限不明) and `complete`.
A source is stale after three missed scheduled runs (at least 6 h; 24 h without a schedule). For
`get_course` only the course's own sources count. When `complete` is false the answer hint spells
out the gaps. The server instructions (local, remote read-only and remote write) tell the AI that a
deadline missing from UniContext is not "no deadline": say when coverage is incomplete, treat
unknown deadlines as possibly imminent, name where to check, and never claim 「期限はない」「余裕
がある」 without complete coverage.

### Record tools (§11, §19–22, §47–49, §74)

`ingest_lecture`, `record_lecture`, `add_deadline`, `add_note`, `add_task`, `list_my_additions` and
`retract_addition` (`src/additions.ts`, backed by `AdditionsService` in the context engine) store
deadlines, to-dos, notes and lecture summaries that the student states or plans in any chat
(`via: chat`, the default) or that a client heard in a lecture recording (`via: recording`, the
default when `recordingTimestamp` is given), so every other session and client reads them through
the read tools. Annotations: `readOnlyHint: false`,
`destructiveHint` only on `retract_addition`, `idempotentHint: true`, `openWorldHint: false`. Each
has an output schema; `structuredContent` is `{status: created|updated|duplicate|replayed|retracted,
addition: {id, kind, status, via, label, title, course, dueAt, dueText, dueResolution, evidence,
recordingTimestamp, source, stored, attachedTo?, conflicts}, answerHint}`.

- Everything is `origin=extracted` with a SourceReference `{sourceSystem: "ChatGPT Record" /
"ChatGPTとの会話" / "Claudeとの会話" (or the client name / `source`), authority `transcript`(recording) or`student-statement` (chat), sourceItemId: "<client id>#<addition id>", retrievedAt,
location.timestamp}` and the quoted evidence on the fact. Source id `mcp-additions`. Views mark such
  items with `recorded: {label: 「録音から」|「チャットで登録」, via, source, evidence, …}`
  (`DeadlineItem`, `TaskItem`, `AssignmentItem`).
- `course` is optional for `add_deadline`, `add_task` and `add_note`: personal items have no course
  (to-dos hang on a fixed `person:` subject). 次回 needs a course.
- `add_deadline` attaches the date to an existing assignment/exam of the course when the title
  matches (a different date opens a Conflict with LiveCampusU/the LMS; the system's value stays what
  tasks show), otherwise it creates its own Assignment/Exam. `prep` and `add_task` become tasks
  through `todo` facts (multi-valued, never a Conflict).
- Course names resolve like the read tools, preferring courses the student takes.
- Dedupe: same course + kind group + normalized title with a due date within 36 h updates the
  client's own unconfirmed item (another client's or a confirmed one is reported as `duplicate`).
  `idempotencyKey` (or a hash of the arguments) makes a retry a `replayed` no-op.
- Limits: field sizes in the input schemas (`ADDITION_LIMITS`), 30 creates/updates per 10 minutes
  and 300 per 24 hours per client, and 30 calls per minute per client and process (duplicates,
  replays and retractions count too).
- The client is `McpDeps.client` (remote: the OAuth client) or `local:<MCP client name>`.
  `onToolCall` receives `write: {status, additionId, entityIds, factIds}` — ids only.
- `list_my_additions` items carry `ingestionId` when `ingest_lecture` stored them, and take it as a
  filter.

### `ingest_lecture`: a lecture recording in one call

The description (and `RECORDING_INSTRUCTION_JA` / `_EN` in the local and remote-write server
instructions) tells the AI: when a lecture recording or transcript is given as input and the
course and date can reasonably be determined, **call `ingest_lecture` even without a request to
save**, in addition to answering; do not ask whether to save, do not ask again for a course,
date or period the conversation, recording or timetable tells; keep summary and key points to
what is needed to search and review (not the transcript), keep only important timestamped
segments, leave out chatter and other students' conversations; deadlines only when actually stated
(「次回までに〜」 is evidence, merely having a next class is not); tasks = what the student must
do; notes = non-deadline information needed later. Recording-derived parts are stored at once as
unconfirmed 「録音から」. The descriptions of `record_lecture`, `add_deadline`, `add_task` and
`add_note` point recordings at `ingest_lecture`; their chat behaviour is unchanged.

`AdditionsService.ingestLecture` writes the lecture, then each deadline, to-do and note, through
the same write path as the single tools (`via: recording`, same dedupe, conflicts, relative-date
resolution, budget), and runs the pipeline once at the end. Annotations are those of the other
record tools (`readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`).

- `course` omitted: the one class of the timetable on `lectureDate` (default today) and `period`.
  `period` omitted: the course's only class that day, or the first period of one continuous block;
  separate classes of the course that day need it (they never overwrite each other).
- Idempotency: `<base>:lecture`, `<base>:deadline:<key>`, `<base>:task:<key>`, `<base>:note:<key>`
  with `base` = `recordingRef` (convention `chatgpt-record:<conversation-id>`) or a hash of course +
  date + period, and `key` = the item's `key` or its normalized title (+ `:<kind>` for deadlines);
  hashed when longer than 128. Same key and content → `replayed`; changed content → that addition
  is updated. Re-sending a call after a partial failure stores only what is missing.
- `ingestionId` = hash of client + base, on every addition of the call (`data.ingestionId`).
- Bounds (`INGEST_LIMITS`): at most 10 deadlines, 10 tasks, 10 notes, 20 together; note text up to
  4000 characters. The call counts once against the burst limit, each created/updated part once
  against the write budget (at most 21 writes). Parts over the remaining budget fail with
  `rate_limited`; an exhausted budget fails the whole call.
- `structuredContent`: `{outcome: stored|unchanged|partial|failed, ingestionId, course,
lectureDate, period?, recordingRef?, counts: {created, updated, unchanged, failed}, lecture,
items: [{type, index, title, key, status: created|updated|duplicate|replayed|skipped|failed,
additionId?, dueAt?, dueText?, dueInput?, attachedTo?, conflicts?, reason?, error?: {code,
message}}], answerHint}`. The audit event has `write.status` = the outcome and the union of ids.

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
