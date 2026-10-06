# UniContext architecture (foundation layer)

This document describes the packages that exist today and the exact APIs other lanes build on:
connectors and adapters (lane a) and apps + notifications (lane b). Everything here is checked
against the code; if the two disagree, the code wins and this file should be fixed.

Spec references (§n) point to `docs/SPEC.md`.

## 1. Data flow

```
SourceAdapter.sync()            (connector, §5)
  └─ SyncResult { items: RawItem[], deletions, cursor, hasMore, complete, productVersion }
       │
       ▼
RawStore (raw_sources / raw_items / raw_blobs, §6)
  content-hash dedupe · soft deletes · "pending" = new/changed/deleted since last normalization
       │
       ▼
Normalizer.normalize(RawItemView, NormalizeContext)           (connector)
  └─ NormalizeOutput { entities: NormalizedEntity[], facts: FactInput[], drift, warnings }
       │
       ▼
SyncEngine.applyOutput  (one SQLite transaction per raw item)
  · EntityStore.upsert (zod-validated, FTS kept in sync) → field diff → ChangeEvent (§13)
  · SourceReference per entity / per explicit fact (§10)
  · auto-facts from DEFAULT_FACT_FIELDS + explicit facts → FactStore (§9, §11)
  · facts the raw item no longer supports are retracted; orphaned entities soft-deleted
       │
       ▼
post-processors (wired by createUniContext):
  IdentityResolver.resolveCourseOfferings (§14)
  → ConflictResolver.detectConflicts (§12) → conflict ChangeEvents
  → TaskEngine.derive (§19, §20: deadline extraction from announcements/messages)
       │
       ▼
ContextEngine views (§17, §18) · SearchService (§15) · event bus (notifications, §46)
```

Normalization reads only the raw store, so `SyncEngine.reprocess()` re-runs it after a normalizer
fix without contacting any university system (§6).

## 2. Workspace

| Path                                                                                                 | Package                                    | Status                                      |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------- |
| packages/core                                                                                        | `@unicontext/core`                         | implemented                                 |
| packages/canonical-model                                                                             | `@unicontext/canonical-model`              | implemented                                 |
| packages/database                                                                                    | `@unicontext/database`                     | implemented                                 |
| packages/connector-sdk                                                                               | `@unicontext/connector-sdk` (+ `/testing`) | implemented                                 |
| packages/auth                                                                                        | `@unicontext/auth`                         | implemented                                 |
| packages/provenance                                                                                  | `@unicontext/provenance`                   | implemented                                 |
| packages/identity                                                                                    | `@unicontext/identity`                     | implemented (new package, §14)              |
| packages/search                                                                                      | `@unicontext/search`                       | implemented                                 |
| packages/sync-engine                                                                                 | `@unicontext/sync-engine`                  | implemented                                 |
| packages/task-engine                                                                                 | `@unicontext/task-engine`                  | implemented                                 |
| packages/context-engine                                                                              | `@unicontext/context-engine`               | implemented (includes `createUniContext`)   |
| packages/adapter-{mcp,cli,rest,browser}                                                              | `@unicontext/adapter-*`                    | implemented (docs/connectors/)              |
| packages/mapping                                                                                     | `@unicontext/mapping`                      | implemented (YAML mapping for MCP/CLI/REST) |
| packages/notifications                                                                               | `@unicontext/notifications`                | implemented (§3.12)                         |
| apps/{daemon,cli,web,mcp}                                                                            | `@unicontext/{daemon,cli,web,mcp}`         | implemented (§3.12)                         |
| connectors/{microsoft365,livecampusu,local-files,syllabus,chatgpt-record,wordpress-portal,teams-web} | `@unicontext/<dir>`                        | implemented (docs/connectors/)              |
| profiles/shizuoka-university                                                                         | profile.yaml                               | settings only (§54)                         |
| tests/                                                                                               | `@unicontext/tests` (private)              | cross-package integration tests             |

Commands (from the repo root):

```
pnpm install
pnpm build        # tsc -b over all project references (dist/ per package), then the Web UI (Vite -> apps/web/dist)
pnpm test         # vitest run (resolves @unicontext/* to src/, no build needed)
pnpm typecheck    # build + type-check test files (tsconfig.test.json)
pnpm lint         # eslint
pnpm check        # build + test typecheck + lint + test
```

Conventions every package follows (new packages should too):

- ESM only, `"type": "module"`, TypeScript `module/moduleResolution: NodeNext`, strict,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Relative imports end in `.js`.
- `src/` compiles to `dist/`; package `exports` points at `dist`. Tests live in `<pkg>/test/*.test.ts`
  and are excluded from the build. Root `vitest.config.ts` aliases `@unicontext/<dir>` (and
  `@unicontext/<dir>/<sub>`) to `<group>/<dir>/src/...`, so tests never need a build.
- A new package: copy an existing `package.json`/`tsconfig.json`, add `references` for each
  workspace dependency and add the package to the root `tsconfig.json` references. (The one-off
  scaffolding script that generated the first package stubs was removed after the packages became
  real; rerunning it would have overwritten them.)
- No `any` in public APIs. Validation with zod 4. Times are ISO-8601 strings; "local date" means
  `YYYY-MM-DD` in the profile timezone (default `Asia/Tokyo`).
- Logs go to stderr as JSON lines (stdout is free for MCP stdio).

## 3. Package APIs

### 3.1 `@unicontext/core`

No I/O beyond reading config/profile files.

- Errors: `UniContextError(code, message, {cause, details})` and subclasses `ConfigError`,
  `ValidationError`, `NotFoundError`, `AuthRequiredError`, `RateLimitedError({retryAfterMs})`,
  `OfflineError`, `PolicyViolationError`, `MigrationError`, `ConnectorError`. The sync engine maps
  `AuthRequiredError → auth_required`, `RateLimitedError → rate_limited`, `OfflineError → offline`.
  Connectors must throw these (or use `createHttpClient`, which does).
- Clock: `interface Clock { now(); setTimeout(fn, ms); clearTimeout(h); sleep(ms, signal?) }`,
  `systemClock`, `ManualClock` (tests: `set()`, `await advance(ms)` fires timers in order).
- Dates (Intl-based, any IANA zone, default `DEFAULT_TIMEZONE = 'Asia/Tokyo'`): `zonedParts`,
  `zonedTime({year,month,day,hour?,minute?})`, `startOfZonedDay`, `endOfZonedDay`, `addZonedDays`,
  `startOfZonedWeek` (Monday), `zonedDayRange`, `zonedDateString`, `parseZonedDate`, `toZonedIso`,
  `formatShortJa` ("10/1 09:42"), `formatDateJa` ("10月1日(木)"), `WEEKDAYS_JA`, `tzOffsetMinutes`.
- Logger (§60): `createLogger({level, sink, fields, redaction})`, `silentLogger`,
  `createMemoryLogger()`, `redact(value, options)`. Keys matching `DEFAULT_SENSITIVE_KEY_PATTERN`
  (password, token, cookie, authorization, api key, session id, student id, 学籍番号…) and values
  matching `DEFAULT_SENSITIVE_VALUE_PATTERNS` (Bearer/Basic, JWT, `code=`/`token=` query params,
  `Cookie:` headers, `学籍番号: …`) become `[REDACTED]`. Pass the profile's
  `privacy.studentIdPattern` as `extraValuePatterns`.
- `EventBus<Events>`: `on/once/off/emit`; listener errors are isolated (reported via the ctor callback).
- Hashing: `stableStringify`, `contentHash`, `sha256`, `stableUuid(...parts)`, `newUuid`.
- `parseDuration("15m" | "1h" | "1d" | ms)`.
- Paths (§52): `resolveDataPaths({platform, env, homedir})` → `DataPaths {root, database, raw,
blobs, cache, logs, backups, configDir, configFile}`; `dataPathsFromRoot(root)`,
  `ensureDataDirs(paths)`, `expandHome`. Linux: `$XDG_DATA_HOME/unicontext` (default
  `~/.local/share/unicontext`), config `$XDG_CONFIG_HOME/unicontext`; macOS: `~/Library/Application
Support/unicontext`, config `~/.config/unicontext`; Windows: `%LOCALAPPDATA%\unicontext` for both.
  `UNICONTEXT_DATA_DIR` / `UNICONTEXT_CONFIG_DIR` override.
- Config (§53): `loadConfig(file)` (missing file → defaults), `parseConfig(yaml)`, `defaultConfig()`,
  `ConfigSchema`. Shape: `{profile?, timezone?, sources: Record<id, SourceConfig>, sync: {background,
defaultInterval, schedules}, ai: {provider, model?, baseUrl?, apiKeyRef?}, embeddings: {…same},
logging: {level}, telemetry: {enabled: false}}`. `SourceConfig` = `{enabled (default true),
connector?, adapter?: native|mcp|cli|rest|browser|filesystem, schedule?, command?, args?, url?,
roots?}` plus any connector-specific keys (passthrough). `~` in `roots` is expanded. Keys that
  look like inline secrets (`password`, `token`, `secret`, `cookie`, `apiKey` with a value) are
  rejected — secrets go to the SecretStore; config only names them (`apiKeyRef`).
- Profile (§54): `loadProfile(id, {searchPaths})` looks for `<dir>/<id>/profile.yaml` in
  searchPaths then the repo `profiles/`; `parseProfile`, `findPeriod(profile, n)`. Shape:
  `{id, name?, locale, academicCalendar: {timezone, periods: [{period, start, end}], terms,
noClassDays, substituteDays, source?}, sources: Record<role, {product}>, products: Record<product,
settings>, authorityRules?, privacy: {studentIdPattern?}}`. A term is `{id, name, year, termCode?
(前期/後期, matches CourseOffering.term), start, end (学年暦), classes?: {start, end} (授業開始 … last
regular class), exams?: {start, end} (定期試験 incl. 予備日), parts?: [{half: 前半|後半, name (後期前半),
start, end, weekdays?: {"1".."5": {start, end}}}]}` — the half-terms (about 8 class weeks each);
  `weekdays` holds each timetable weekday's own first/last class day of the half, because holidays
  shift the boundary per weekday (Shizuoka: from the 行事予定表 class counters, 第1–8回 = 前半).
  `noClassDays: [{date, note, campus?,
faculty?, fromPeriod?}]` are weekdays without regular classes (holidays, 大学祭, 補講日 …; `campus` /
  `faculty` limit them to students whose config names that campus/faculty, `fromPeriod` makes them
  partial); `substituteDays: [{date, dayOfWeek, note?}]` follow another weekday's timetable (月曜授業).
  Connectors read their deployment settings from `profile.products[<product>]` (e.g.
  `livecampusu.auth = entra`). Config `student: {campus?, faculty?}` names the student's own
  campus/faculty for the scoped exceptions.
- Academic calendar (`academic-calendar.ts`, pure, local `YYYY-MM-DD` dates): `termForDate(cal,
date)`, `findTerm(cal, year, label)` (id, termCode, name or a label containing the termCode, e.g.
  前学期), `classWindow(term)`, `classDay(cal, date, {holidays?, student?}) → {dayOfWeek (after
substitution), noClasses?, cancelledFrom?, note?, scopedNotes}`, `expandWeeklySlots(slots, window,
{from, to}, cal, {holidays?, student?, exams?})`, `dayOfWeekOfDate`, `addLocalDays`;
  half-terms: `termHalfOf(term, date, timetableWeekday?)` (Saturday follows the Friday before,
  Sunday the Monday after), `termPart(term, half)`, `inHalfSwitchover(term, date)`,
  `halvesWindow(term, halves)`.
- Half-term text (`term-parts.ts`): `TERM_HALVES`, `parseTermPartLabel('後期前半')`,
  `parseTermSpan('後期前半　～　後期後半') → [前半, 後半]` (undefined when the text names no half),
  `termPartLabel(term, halves)` (後期後半 / 後期（前半・後半）), `isWholeTerm`, `normalizeHalves`.
- Notice importance (`importance.ts`): `classifyNoticeImportance({title, body?, kind?, courseLinked?,
flaggedImportant?}) → {importance, rule}`. Rule-based, no AI: class changes (休講・補講・教室変更・
  試験), course-linked notices, reminders and personal procedures (履修登録, 学生証, 授業料納付 …)
  are `high`; career/marketing campaigns (就活, メルマガ …) and general invitations (調査, 説明会,
  イベント …) are `low`; optional applications (奨学金, 授業料免除, 単位互換 …) and everything else
  `normal`; 【重要】 is `high`. Used by the LiveCampusU and portal normalizers.
- Secrets contract: `interface SecretStore {backend; get(key); set(key, value); delete(key)}`,
  `secretKey(sourceId, name)` → `"<sourceId>/<name>"`.
- AI (§47, §48): `AiProvider {id, available, complete({task, instructions, input, maxTokens?})}`,
  `createAiProvider({provider: none|openai|anthropic|ollama, model, baseUrl?, apiKey?, fetch?})`
  (minimal fetch clients; `model` is required for real providers), `noneAiProvider` (default,
  `available=false`). `AI_TASKS` lists the only allowed jobs; anything else throws
  `PolicyViolationError`. `assertAiOrigin(origin)` enforces that AI output is stored only as
  `extracted`/`inferred`; `FactSchema` enforces the same for `producer.type === 'ai'`.

### 3.2 `@unicontext/canonical-model`

- IDs: `"<kind>:<uuid>"`. `ENTITY_KINDS` (23 kinds: university, campus, academicTerm, person,
  course, courseOffering, enrollment, assignment, submission, exam, announcement, message, thread,
  material, document, documentChunk, lecture, lectureTranscript, lectureSegment, calendarEvent,
  classSession, location, grade) and `RECORD_KINDS` (task, sourceReference, fact, conflict,
  changeEvent, identityLink). `makeId(kind)` (random), `stableId(kind, ...parts)` (deterministic,
  use for everything derived from source data), `parseId`, `kindOf`, `isIdOf`, `idSchema(kind)`,
  `EntityIdSchema`, types `Id<K>`, `EntityId`.
- Entities: one zod schema per kind in `ENTITY_SCHEMAS`, each `{id, kind, extra?, …}`;
  `CanonicalEntitySchema` (discriminated on `kind`), `parseEntity`, `parseEntityOfKind`,
  `entityLabel`. Types: `CanonicalEntity` (output, defaults applied), `CanonicalEntityInput`
  (defaults optional), `EntityOfKind[K]`, `EntityInputOfKind[K]`, and named types (`CourseOffering`,
  `ClassSession`, …). Course vs CourseOffering are separate (§8): `Course {courseCode?, title,
department?}`; `CourseOffering {courseId?, termId?, academicYear?, term?, title, courseCode?,
instructorIds, instructorNames, schedule: ScheduleSlot[], scheduleType?, termParts?: (前半|後半)[],
room?, url?}` (`termParts` = the halves of the term it meets in as the source states it; absent =
  not stated, treated as the whole term; `ScheduleSlot.termParts` overrides it per slot). Fact
  predicate `TERM_SLOTS_PREDICATE` (`term_slots`, value `TermSlotsValue {slots: [{half, dayOfWeek,
period?}]}`) carries the academic system's per-slot halves (「前期前半/金5・6, 前期後半/金5・6」,
  emitted by the LiveCampusU normalizer from notice/assignment subjects). Notable fields:
  `ClassSession {courseOfferingId, date, period?, startsAt?, endsAt?, room?, status:
scheduled|cancelled|makeup|online|changed}`, `Announcement {importance, scope:
university|faculty|course|other}`, `Message {isQuestion?, lectureId?}`, `Material {materialKind,
documentId?, lectureId?}`, `LectureSegment {transcriptId, ordinal, startMs, text}`.
- Provenance: `FactOrigin = authoritative|user|extracted|inferred` (§11). `SourceReference {id,
sourceSystem, sourceId?, sourceLabel?, authority, sourceItemId, url?, retrievedAt, rawItemId?,
location?: {page?, timestamp?, timestampMs?, messageId?, line?, selector?}, entityId?}`.
  `Fact {id, subject, predicate, value: JsonValue, origin, confidence, observedAt, validFrom?,
validUntil?, sourceReferenceId, producer: {type: connector|user|ai|rule, id}, evidence?,
retractedAt?}` — refinement: AI producers only extracted/inferred; origin `user` ⇔ producer `user`.
  `Conflict {id, subject, predicate, status: open|resolved|dismissed, candidates[≥2], detectedAt,
resolvedAt?, resolution?: {factId?, method}, reason?}`. `KNOWN_AUTHORITIES` lists the authority
  strings used by the default rules.
- Records: `ChangeEvent {id, entityId, entityKind, type: created|updated|deleted|restored|
conflict_detected|conflict_resolved, changedFields, before, after, source: {sourceId?,
sourceSystem?, rawItemId?}, occurredAt, observedAt, courseOfferingId?, summary?}`.
  `Task {id, title, courseOfferingId?, assignmentId?, examId?, sourceFactIds, dueAt?, status:
pending|in_progress|submitted|completed|cancelled|unknown, createdBy: system|user|extractor,
taskKind: assignment|exam_preparation|extracted|manual, origin, statusSetBy:
system|user|submission-system, statusEvidenceFactId?, evidence?, notes?, createdAt, updatedAt}`.
  `IdentityLink {id, entityKind, leftId, rightId, status: auto|suggested|confirmed|rejected, score,
method, evidence[], decidedBy: system|user, …}`.
- Connector-facing enums: `CAPABILITIES`/`Capability` (§5), `HEALTH_STATES`/`HealthState`,
  `HealthStatus {state, checkedAt, message?, detectedVersion?, retryAfter?, lastSuccessAt?,
consecutiveFailures?}` (§38).
- `DEFAULT_FACT_FIELDS`: entity fields mirrored as facts automatically by the sync engine:
  `courseOffering.room→room`, `classSession.room→room`, `classSession.status→class_status`,
  `classSession.startsAt→starts_at`, `assignment.dueAt→assignment_due`, `exam.startsAt→exam_at`,
  `exam.room→room`, `submission.status→submission_status`, `grade.score→grade`,
  `grade.letter→grade_letter`.

### 3.3 `@unicontext/database`

better-sqlite3 + Drizzle ORM. Secrets are never stored here (§32).

- `openDatabase({path = ':memory:', blobsDir?, readonly?, migrate = true, cipher?, cipherKey?})` →
  `UniContextDatabase {sqlite, orm, path, blobsDir, migration, transaction(fn), close()}`. File DBs
  use WAL, `foreign_keys=ON`, `busy_timeout=5000`. `DatabaseCipher {name, apply(sqlite, key)}` is the
  SQLCipher seam (§33): interface only, no implementation ships.
- Migrations (§67): `MIGRATIONS` = `001_initial` (raw layer, sync_state, connector_health, all
  entity tables, source_references), `002_fact_model` (facts, conflicts), `003_change_events`,
  `004_identity_links`, `005_tasks`, `006_search` (FTS5 + embeddings), `007_source_monitoring`
  (schema_drift, product_versions), `008_additions` (ledger of MCP record-tool writes),
  `009_read_marks` (UniContext's own read/unread flag per announcement, `ReadMarkStore`). `migrate(sqlite, {targetVersion?})`, `getAppliedMigrations`,
  `currentSchemaVersion`, `migrationChecksum`. Applied migrations are checksummed; editing one or
  opening a newer DB throws `MigrationError`. Each migration runs in a transaction. Add a migration
  by appending `008_<name>.ts` to `src/migrations/` and to `MIGRATIONS`; never edit old ones. The
  drizzle schema (`src/schema/*`) must match the SQL — a test compares every column.
- Tables: entity tables share an envelope `(id, data JSON, source_id, created_at, updated_at,
deleted_at)` plus typed columns named after entity fields (e.g. `assignments.due_at`,
  `class_sessions.date/period/room/status`). `ENTITY_TABLES[kind]` gives the drizzle table.
  FTS5 tables (`fts_documents`, `fts_document_chunks`, `fts_announcements`, `fts_messages`,
  `fts_lecture_segments`; columns `entity_id, course_offering_id, title, body`) use the
  **trigram** tokenizer, kept in sync by `EntityStore` (`FTS_TABLES`).
- Stores (`createStores(db, clock)` returns all of them):
  - `RawStore`: `ensureSource({id, connector, adapter?, displayName?})`, `getSource`,
    `listSources`, `touchSourceSync`, `upsertItem(sourceId, {sourceType, externalId, payload,
sourceUpdatedAt?, fetchedAt?}) → {status: inserted|updated|unchanged|restored, item}`,
    `markDeleted`, `markMissingDeleted(sourceId, types, seenIds)`, `list({sourceId?, pendingOnly?,
includeDeleted?, sourceTypes?})`, `markNormalized(id, {version, error?})`,
    `resetNormalization(sourceId?)`, `putBlob({sourceId, rawItemId?, data, mimeType?})`,
    `readBlob(id)`, `deleteBlobsBySource`. `rawItemId(sourceId, type, externalId)` is deterministic
    (`raw:<uuid>`).
  - `EntityStore`: `upsert(entityInput, {sourceId?, at?}) → {status:
created|updated|unchanged|restored, entity, previous, changedFields}` (validates with zod),
    `get(id, {includeDeleted?})`, `getOfKind(kind, id)`, `getMany(ids)`, `meta(id)`,
    `list(kind, {where: {field: value | value[]}, sourceId?, orderBy?, limit?, includeDeleted?})`
    (`where`/`orderBy` use typed columns only), `listInRange(kind, field, fromIso, toIso)` (instant
    columns, offset-safe via `julianday`), `listByDateRange(kind, field, fromDate, toDate)`,
    `softDelete`, `hardDelete`, `idsBySource`, `counts`, `rebuildFts`. `diffEntities(a, b)`.
  - `SourceReferenceStore`: `upsert`, `get`, `getMany`, `forEntity`, `forEntities`, `byRawItem`,
    `bySource`, `deleteBySource`.
  - `ChangeEventStore`: `append(event)`, `list({since?, until?, entityIds?, courseOfferingIds?,
types?, sourceId?, limit?})` (oldest first), `deleteBySource`.
  - `SyncStateStore`: `get(sourceId, scope = '')`, `set(sourceId, {cursor?, etag?, deltaToken?,
lastModified?, extra?}, {scope?, mode?, fullSync?})`, `clear`. `scope` allows several cursors per
    source (e.g. one delta token per Graph resource).
  - `AdditionStore` (`additions` table): `save`, `get`, `byIdempotencyKey(clientId, key)`,
    `byDedupeKey(key, statuses)`, `list({clientId?, statuses?, courseOfferingIds?, limit?})`,
    `countWritesSince(clientId, iso)`. `purgeSource(db, 'mcp-additions')` also clears it.
  - `HealthStore`: `get`, `list`, `set`, `delete`. `SchemaDriftStore`: `record(sourceId, type,
findings, rawItemId?) → new findings`, `list({sourceId?, unresolvedOnly?})`, `resolve(id)`.
    `ProductVersionStore`: `record(sourceId, product, version, known)`, `latest`, `list`.
  - Row mappers shared by other packages: `factToRow/rowToFact`, `conflictToRow/rowToConflict`,
    `taskToRow/rowToTask`, `linkToRow/rowToLink`.
- Maintenance (library functions for CLI commands):
  - JSONL (§68): `exportJsonl(db, {includeDeleted?})` generator (header line then `entity`,
    `sourceReference`, `fact`, `conflict`, `changeEvent`, `identityLink`, `task` lines; raw
    payloads are not exported), `exportJsonlToFile(db, file)`, `importJsonl(db, lines, {strict?})`
    (merge by id; returns `{imported, errors}`), `importJsonlFile`.
  - Backup (§62): `await backupDatabase(db, dir, {now?})` → `unicontext-backup-YYYYMMDD-HHMMSS/`
    with `unicontext.db` (online backup), `mappings.json` (identity links), `metadata.json`.
  - Purge (§63): `purgeSource(db, sourceId) → PurgeReport` deletes raw items/blobs, source refs,
    facts, entities owned by the source, dependent tasks/conflicts/identity links/change events/
    embeddings, sync state, health, drift and versions.
- Re-exports `resolveDataPaths`, `dataPathsFromRoot`, `ensureDataDirs`, `loadConfig`, `parseConfig`,
  `loadProfile`, `parseProfile` from core.

### 3.4 `@unicontext/connector-sdk`

- `SourceAdapter` exactly as §5: `{id, version, capabilities(), authenticate(), sync(input),
health(), dispose()}`. `AuthResult {status: authenticated|not_required|auth_required|failed,
account?, expiresAt?, message?}`. Optional `VersionAwareAdapter.detectProductVersion()` (§72).
- `SyncInput {mode: initial|incremental|full, cursor?: SyncCursor, pageToken?, capabilities?,
signal?}`; `SyncCursor {cursor?, etag?, deltaToken?, lastModified?, extra?}`.
- `SyncResult {items: RawItem[], deletions?: RawDeletion[], cursor?, hasMore?, nextPageToken?,
complete?: {sourceTypes}, productVersion?: {product, version}, warnings?}`.
  `RawItem {sourceType, externalId, payload, sourceUpdatedAt?, blobs?: {data, mimeType?}[],
backfill?}`. `backfill: true` marks old content seen for the first time after the source's
  initial run (a connector that spreads its first import over several runs): it is stored and
  normalized as usual, but its new entities produce no `created` ChangeEvents.
  Semantics: return pages with `hasMore` + `nextPageToken`; the engine calls `sync` again with
  `pageToken` and the same cursor; the last page's `cursor` is persisted. Set `complete` on full
  listings without a delete feed — anything of those types not returned in the run is marked
  deleted. Use `deletions` for explicit delete feeds (Graph `@removed`).
- `Normalizer {id, version, sourceTypes ('*' = all), normalize(item: RawItemView, ctx)}` →
  `NormalizeOutput {entities: NormalizedEntity[], facts?: FactInput[], drift?, warnings?}`.
  - `NormalizedEntity {entity: CanonicalEntityInput, ref?: SourceRefSpec, origin?, deriveFacts?}`.
  - `FactInput {subject, predicate, value, origin: authoritative|extracted|inferred, confidence?,
observedAt?, validFrom?, validUntil?, evidence?, ref?, producer?}` (origin `user` is rejected).
  - `SourceRefSpec {authority?, url?, location?, sourceItemId?, sourceLabel?}`; the engine fills
    the rest (system = metadata.product, retrievedAt = fetch time, rawItemId).
  - `NormalizeContext {sourceId, sourceSystem, sourceLabel, defaultAuthority, timezone, profile,
now, logger, id(kind, ...parts), lookup(id)}`. **Always** build ids with `ctx.id(kind, …)` —
    it is `stableId(kind, sourceId, …)`, so reprocessing updates instead of duplicating, and
    references between items of the same source line up (`ctx.id('courseOffering', courseExtId)`).
  - `createNormalizeContext(init)` builds one (used by the engine and by connector tests).
- Metadata (§55, §27): `defineMetadata({name, product, version, license, capabilities, adapter,
apiStability: official|unofficial|experimental, risk, testedVersion?, testedVersions?,
defaultAuthority, sourceLabel?, defaultSchedule ('15m' | 'push' | 'event' | 'manual'), rawTypes,
description?, homepage?})`. Unofficial APIs must declare `risk` ≠ supported and a
  `testedVersion`. `evaluateProductVersion(metadata, version)` → `{known, state, message}` (unknown
  version ⇒ degraded, §72; `3.x` wildcards allowed).
- `ConnectorModule<TConfig> {metadata, configSchema?, createAdapter(ctx), createNormalizer(ctx)}`,
  `defineConnector(module)`. `ConnectorContext {sourceId, config, secrets, logger, clock,
rateLimiter, profile, cacheDir, fetch}`. `instantiateConnector(module, {sourceId, config,
secrets, logger?, clock?, rateLimiter?, rateLimit?, profile?, cacheDir?, fetch?})` validates
  config and returns `{sourceId, metadata, adapter, normalizer, context}` — pass it to
  `SyncEngine.register`.
- `RateLimiter({capacity=5, refillPerSecond=1, maxRetries=4, baseDelayMs=500, maxDelayMs=60000,
jitter='full', clock, random})` (§37): `acquire(cost, signal)`, `pauseUntil(time)`,
  `backoffDelay(n)`, `schedule(fn, {cost, signal, retryOn})` — retries `RateLimitedError` after
  `retryAfterMs` (pausing the whole bucket), `OfflineError`/`retryOn` with exponential backoff +
  jitter, never retries `AuthRequiredError`. `parseRetryAfter(header, now)`.
- `createHttpClient({baseUrl?, fetch?, rateLimiter?, headers?: () => headers, userAgent?, clock?})`
  → `{request(pathOrUrl, init), json<T>(pathOrUrl, init)}`; maps 401 → `AuthRequiredError`, 429/503
  → `RateLimitedError` (Retry-After), network errors → `OfflineError`, retries 5xx (`HttpError`).
- Schema drift (§73): `detectSchemaDrift(payload, zodSchema, {arraySample?, maxDepth?})` →
  `DriftFinding[] {path ("a.b[].c"), kind: unknown|missing|type_mismatch}`. Return the findings in
  `NormalizeOutput.drift`; the engine records them and degrades health for missing/mismatched fields.
- Fake connector (tests, demos, worked example): `createFakeConnector(options) → {metadata, adapter:
FakeSourceAdapter, normalizer, module}`; raw types `fake.course|session|assignment|announcement|
message|exam|submission|document|transcript` (`FakePayloadSchemas`). Tests mutate
  `adapter.dataset`, set `adapter.failNext`, inspect `adapter.syncCalls`.
- Seed (§ task 14): `createShizuokaSeed()` → four fake sources (`lcu` academic-system, `teams`,
  `lms` submission-system, `record` transcript) and `applySeedDay2(adapters)` for the second day
  (deadline change, new slides, room change post). Constants `SEED_TODAY`, `SEED_DAY1_SYNC_AT`,
  `SEED_DAY2_SYNC_AT`. All data is synthetic.
- Optional adapter extensions (detect with the guards): `InteractiveAuthAdapter` (`login(options)`,
  `logout()`; `supportsInteractiveLogin`) for human-in-the-loop auth — `authenticate()` stays
  non-interactive; `WatchableAdapter` (`watch(listener) → {close()}`; `isWatchable`) for event-driven
  sources — feed each `listener.onResult(result)` to `SyncEngine.ingest`.
- Package entries: a connector/adapter package exports a `ConnectorModule` or a
  `ConnectorFactory` (`({sourceId, config, profile}) => Promise<ConnectorModule>`) as `default` and
  named `connector`; `resolveConnectorExport(entry, input)` turns either into a module.
- `@unicontext/connector-sdk/testing`: `testConnectorCompliance(name, {createAdapter, metadata,
normalizer?, rawFixtures?, profile?, sourceId?, maxPages?, skipAuthenticate?})` — the shared
  contract suite (§66), call it at the top level of a vitest file. It checks metadata, capability
  list, AuthResult/HealthStatus shape, pagination termination, duplicate keys, no credentials in
  payloads, cursor serializability, incremental sync with the returned cursor, canonical validity
  and determinism of normalizer output, and `dispose()`.

### 3.5 `@unicontext/auth`

- `MemorySecretStore`, `KeyringSecretStore.create(service = 'unicontext')` (@napi-rs/keyring:
  Windows Credential Manager, macOS Keychain, Linux Secret Service), `createSecretStore({backend:
auto|keyring|memory, service?, onFallback?})` (`auto` falls back to memory when the native module
  is unavailable). Keys: `secretKey(sourceId, name)`.
- OAuth 2.0 Authorization Code + PKCE for native apps (RFC 7636, RFC 8252, §25):
  `generatePkce()`, `pkceChallenge(verifier)`, `generateState()`,
  `buildAuthorizationUrl(config, {redirectUri, state, codeChallenge, loginHint?})`,
  `startLoopbackListener({path = '/callback', timeoutMs})` → `{redirectUri
(http://127.0.0.1:<random>/callback), waitForCode(state), close()}`, `exchangeCode(config,
{code, verifier, redirectUri, fetch?})`, `refreshAccessToken(config, refreshToken)`,
  `openSystemBrowser(url)` (no shell), and the one-call flow
  `authorizeWithPkce(config, {openBrowser?, fetch?, clock?, timeoutMs?, loginHint?})` → `TokenSet
{accessToken, tokenType, refreshToken?, idToken?, scope?, expiresAt?}`. `OAuthClientConfig
{authorizationEndpoint, tokenEndpoint, clientId, scopes, extraAuthParams?}`.
- `OAuthTokenStore(secrets, key, clock)`: `load()`, `save(tokens)`, `clear()`,
  `getAccessToken(config, {fetch?, skewMs?})` refreshes when expired and throws
  `AuthRequiredError` when the user must log in again.

### 3.6 `@unicontext/provenance`

- Rules (§12): `packages/provenance/default-rules.yaml` (shipped), `loadDefaultAuthorityRules()`,
  `parseAuthorityRules(yaml)`, `mergeAuthorityRules(base, {predicates})`, `authorityOrder(rules,
predicate)`. Rule file: `{userOverrides, recencyOverride: conflict|recency|authority,
minConfidence, predicates: {room: [academic-system, instructor-announcement, syllabus], grade:
[academic-system], assignment_due: [submission-system, instructor-announcement, syllabus], …},
default: [...]}`.
- `FactStore(db, clock)`: `put(fact)` (throws `PolicyViolationError` for AI facts claiming
  authority), `get`, `getMany`, `history(subject, predicate?)`, `active({subjects, predicate?,
at?})`, `activePairs()`, `withSources(facts)`, `retract(ids)`, `activeIdsForRawItem`. `factId(refId,
subject, predicate, value)` is the deterministic fact id.
- `ConflictResolver(db, {rules?, clock?, expandSubject?, canonicalSubject?})`:
  - `resolve(subjects, predicate, {at?}) → Resolution {status: resolved|conflict|none, value,
winner, origin, method: single|agreement|user|authority|recency|only_inferred, candidates}`.
    Algorithm: newest user fact wins (§74); inferred facts only count when nothing else exists and
    keep origin `inferred` (§11); otherwise rank by authority list position, then origin
    (authoritative before extracted), confidence, recency. If a **different** value comes from a
    listed (or same-level) source and is **newer** than the best-authority value, the policy
    decides — default `conflict` (e.g. 学務 9/1 says 21教室, Teams 教員投稿 10/1 says 11教室).
    Facts with `validFrom/validUntil` only apply inside their window (`at`).
  - `detectConflicts() → {opened, resolved}` persists one Conflict row per (canonical subject,
    predicate); `listConflicts({status?, subjects?})`, `getConflict`, `dismissConflict`.
  - `correct({subject, predicate, value, note?, userId?})` stores an origin=`user` fact with its own
    SourceReference (`sourceSystem 'user'`) and resolves the open conflict (§74).
- Citations (§49, §75): `Citation {sourceReferenceId, sourceSystem, sourceLabel, authority,
sourceItemId, retrievedAt, url, location, rawItemId, label}`; `toCitation(ref, tz)` builds `label`
  such as `学務情報システム 10/1 09:42取得` or `ChatGPT Record 00:42:18 10/1 15:00取得`;
  `uniqueCitations`, `formatCitationLabel`.

### 3.7 `@unicontext/identity`

- Normalization: `normalizeText` (NFKC, lowercase), `normalizeCourseTitle(title, {glossary?})`
  (strips years like `2026`/`2026年度`, term words, timetable brackets, applies `DEFAULT_GLOSSARY`
  JA/EN abbreviations; `データベースシステム論`, `2026 DB Systems`, `DBSys` → `dbsys`),
  `titleSimilarity` (bigram Dice + containment), `extractYear`, `normalizeTerm`,
  `normalizePersonName`, `personNamesMatch` (honorifics, surname-only), `normalizeCourseCode`.
- `scoreOfferingMatch(a, b, {thresholds?}) → {score, decision: link|suggest|none, evidence, veto}`
  with `toCandidate(offering, sourceId)`. Weights: code 0.4, title 0.5×similarity, teacher 0.2,
  timetable 0.15, year/term 0.05 each; year or term mismatch vetoes. `DEFAULT_THRESHOLDS = {link:
0.75, suggest: 0.5}`.
  A title-only candidate (no code, teacher or timetable — course folders, transcript hints, Teams
  team names) with an exact normalized title (similarity ≥ 0.95) in the same academic year gets
  +0.2, so it can reach the link threshold on its own.
- `IdentityResolver(db, {clock?, thresholds?, sourcePriority?})`: `resolveCourseOfferings()`
  (pairs across different sources; never overrides user decisions), `link`, `confirm(a, b)`,
  `reject(a, b)`, `getLink`, `listLinks({status?, entityId?})`, `expand(id)` (connected component
  over auto+confirmed links, canonical first), `canonical(id)`, `invalidate()`. Links are persisted
  in `identity_links` (§14); no LLM involved.

### 3.8 `@unicontext/search`

- `routeQuery(q) → RoutedQuery {route: structured|lexical|transcript, intent?:
deadlines|classes|exams|changes|conflicts|announcements, range?:
today|tomorrow|yesterday|this_week|next_week|upcoming, terms, semantic}` (§15). Examples:
  「明日締切」→ structured/deadlines/tomorrow, 「ERモデルの説明どこ？」→ lexical (terms
  `ERモデル`), 「先生は試験について何て言った？」→ transcript (terms `試験`). `extractTerms(q)`.
- `lexicalSearch(db, terms, {kinds?, courseOfferingIds?, limit?, mode?})` over the trigram FTS
  tables. Terms ≥ 3 characters use `MATCH` (bm25 + `snippet`), shorter ones (`試験`, `ER`) use
  `LIKE`. Default: all terms, falling back to any.
- `SearchService({db, clock?, timezone?, embeddings?, expandCourse?})`: `search(q, {limit?,
courseOfferingId?, kinds?, route?}) → {query, hits: SearchHit[]}`, `lexical(terms, opts)`,
  `structured(intent, range, opts)`. `SearchHit {id, kind, title, snippet, score, at,
courseOfferingId, citations, via}`.
- Semantic (§16, optional): `createEmbeddingProvider({provider: none|openai|voyage|ollama|local,
model, apiKey?, baseUrl?, embedFn?})` (`none` → `undefined`), `EmbeddingIndex(db,
provider).refresh()` / `.search(q)` (vectors in `embeddings`, brute-force cosine). Pass the index
  to `SearchService` to blend semantic hits into lexical/transcript routes.

### 3.9 `@unicontext/sync-engine`

- `SyncEngine({db, clock?, logger?, profile?, timezone?, bus?, postProcessors?,
fullRefreshIntervalMs = 7d, maxPages = 500})`:
  - `register({sourceId, adapter, normalizer, metadata, sourceLabel?})`, `unregister`, `sources()`,
    `getSource`, `addPostProcessor({name, run({sourceId, changedEntityIds})})`.
  - `sync(sourceId, {mode?, signal?}) → SyncRunReport {ok, error, mode, pages, raw: {inserted,
updated, unchanged, restored, deleted}, normalized: NormalizeReport, health}`. Never throws
    for adapter errors; concurrent calls for one source share one run. Mode defaults to
    `initial` (never synced), `full` (last full refresh older than `fullRefreshIntervalMs`), else
    `incremental` (§35). `authenticate()` runs first; `auth_required` aborts the run.
  - `ingest(sourceId, SyncResult)` for pushed data (file watchers §23, manual transcript import
    §22) — stores raw items and normalizes immediately.
  - `reprocess(sourceId?)` re-normalizes from raw (§6). `normalizePending(sourceId)` also picks up
    live raw items last normalized by a different `normalizer.version`, so bumping a normalizer's
    version re-normalizes its existing data on the next sync without refetching. Such a
    reinterpretation of unchanged raw content emits no `updated` ChangeEvents (the source did not
    change); `reprocess()` still does.
  - `checkHealth(sourceId)` (adapter.health()), `health(sourceId)`, `healthAll()`, `nextMode`,
    `isRunning`, `dispose()`; `stores` (database stores) and `facts` (FactStore) are exposed.
  - Health (§38): success → `healthy` (or `degraded` for an untested product version or
    missing/mismatched fields); failure → `auth_required` / `rate_limited` (+`retryAfter`) /
    `offline`, otherwise `degraded` for the first two failures then `failed`.
  - ChangeEvents (§13): `updated` (only changed fields in before/after), `deleted`, `restored`,
    and `created` except during a source's very first sync (an initial import is not a "change").
    Summaries are Japanese, e.g. `課題「課題1」の締切: 10/8 23:59 → 10/10 23:59`.
- `SyncScheduler(engine, {clock?, schedules?, defaultInterval?, jitterRatio = 0.1, random?,
initialDelayMs?})` (§36): `start()`, `stop()`, `trigger(sourceId)`, `status()`. Schedule per
  source = `schedules[sourceId]` ?? `metadata.defaultSchedule`; intervals (`15m`, `1d`…) run
  periodically, `push` / `event` / `manual` only via `trigger()` (Graph change notification →
  `trigger`, fs event → `trigger` or `ingest`). Failures back off (×2^n, capped), Retry-After and
  `auth_required` (6 h) are honoured.
- Event bus `SyncEngineEvents` (subscribe with `engine.bus.on(name, fn)`; notifications lane §46):
  `change` (ChangeEvent), `conflict` ({type: opened|resolved, conflict}), `health` ({sourceId,
  previous, current}), `sync:started`, `sync:completed` (SyncRunReport), `sync:failed` ({sourceId,
  error, health}), `drift` ({sourceId, findings}).
  Mapping for §46: room change / deadline changed / new assignment / exam announced → `change`
  (`entityKind` + `changedFields`) and `conflict`; cancelled class → `change` on classSession
  `status`; auth expired → `health` with `current.state === 'auth_required'`; sync failure →
  `sync:failed`; deadline approaching → poll `context.deadline()` on a timer.
- Helpers: `buildChangeEvent`, `summarizeChange`, `KIND_LABELS_JA`, `createSyncEventBus`.

### 3.10 `@unicontext/task-engine`

- `extractDeadlines(text, {reference, timezone?, nextClassAt?, defaultTime?})` →
  `ExtractedDeadline[] {dueAt, phrase, evidence (sentence), rule, confidence, timeAssumed}` (§20).
  Handles `10月15日23時59分まで`, `10/20(火) 17:00締切`, `金曜日中`, `来週金曜日まで`, `明日の17時まで`,
  `今日中`, `今週中`, `今月中`, `来週まで` (next class if it is next week, else +7 days),
  `次回まで` (start of next class), `3日以内`, 午前/午後/正午/半, full-width digits, year rollover.
- `TaskEngine({db, clock?, timezone?, resolver?, expandCourse?, submissionAuthority =
'submission-system'})`:
  - `derive() → {created, updated, cancelled, extractedFacts}`: tasks from assignments (due date via
    the resolver), exams (`試験準備: …`, origin inferred) and extracted `deadline` facts; runs
    `extractDeadlineFacts()` over announcements/messages first (origin `extracted`, producer
    `rule:ja-deadline-rules`, evidence = sentence). Extracted deadlines that restate an assignment
    due date are merged into that task. Derived tasks whose origin disappeared become `cancelled`.
  - Status rules (§19): `submitted` is set automatically only when an authoritative
    `submission_status` fact from the `submission-system` authority says
    submitted/late/graded/returned. `setStatus(id, status, {actor: user|ai|system, note?})` —
    `ai` cannot set `submitted`/`completed`, `system` cannot set `submitted`
    (`PolicyViolationError`). User-set statuses survive `derive()`.
  - Notice-derived deadlines are classified by `deadlineActionability(subject, value)`:
    `personal` (course-linked, a message, or the academic system's personal deadline widget —
    announcement category `期限`) → a task that stays and shows overdue; `general` (a
    university-wide notice asking every student to act: 履修登録, 申請, 提出 …) → a task only while
    the deadline is ahead (afterwards it is withdrawn, not shown as 期限切れ); `informational`
    (importance `low` or no action word) → no task, the fact stays searchable. Tasks the user
    already touched are kept either way.
  - `list({statuses?, dueFrom?, dueTo?, courseOfferingId?, includeUndated?})`, `get`,
    `createManualTask({title, dueAt?, courseOfferingId?, notes?})`, `nextClassAt(courseId, after)`
    (stored and generated classes, self-study excluded).
  - `schedule: ClassSchedule` (`class-schedule.ts`; options `profile`, `student`, `canonicalCourse`
    on TaskEngine): class sessions of the student's own offerings (an active student `enrollment`,
    identity-collapsed) = stored ClassSessions (休講・補講・教室変更 from notices) merged over sessions
    **generated** (not stored) from the offering's weekly `schedule`, its term's class weeks and the
    academic calendar (profile `noClassDays`/`substituteDays`, all-day calendar events of category
    `Holiday`, the exam period). Generated ids are `stableId('classSession', 'timetable', offering,
date, period)`. A stored session with a period replaces the generated one; one without a
    period/time (e.g. a room change "on 7/24") is applied to every generated class of that course
    that day. Offerings whose `scheduleType` is `unscheduled` (時間割外) or `intensive` (集中講義) —
    on any linked offering, so a syllabus timetable of the regular class does not count — get no
    class sessions; the student's own weekly slots (user fact `pace_slots`, value `{slots:
[{dayOfWeek, startTime?, endTime?, period?}]}`) add `sessionKind: 'self_study'` sessions.
    `sessionsOn(date)`, `sessionsBetween(from, to, courseIds?)`, `generated(…)`,
    `enrolledOfferings()` (each with `termParts`), `scheduleTypeOf(ids)`, `termOf(offering)`,
    `currentTerm(date?)`, `paceSlots(ids)`, `noClassesReason(date)` (学期外 / nothing registered
    for the term / nothing registered in this half / exam period / outside the class weeks / the
    no-class day's note). Half-terms: `termPartsOf(ids)` → `{halves, slots, evidenceId, via}`
    (latest `term_slots` fact first, then a linked offering's `termParts`, e.g. the syllabus
    開講時期), `currentHalf(date?)` → `{term, half, label, switchover}`, `runsOn(e, date)`,
    `termPartLabelOf(e)`, `timetableDayOf(date)`. Generated classes, self-study sessions and weekly
    「今週分」 tasks of a half-term course stay inside its half (per slot and per weekday).

### 3.11 `@unicontext/context-engine`

- `createUniContext({db? | dataDir?, clock?, logger?, profile? (object or id), timezone?,
authorityRules?, embeddings?, schedules?, student?}) → UniContext {db, clock, profile, timezone, sync,
scheduler, bus, identity, resolver, tasks, search, context, runPipeline(), close()}`. It wires
  identity-aware conflict resolution, the task engine, search and the post-sync pipeline
  (identity → conflicts (+ `conflict_detected`/`conflict_resolved` ChangeEvents and `conflict`
  events) → tasks). `dataDir` opens `<dataDir>/unicontext.db` with blobs in `<dataDir>/blobs`.
- `ContextEngine` views (§17, §18) — all return plain JSON-serializable objects with `view`,
  `generatedAt`, `timezone`, and items that each carry `citations: Citation[]`:
  - `term` of today/tomorrow/week is `TermOfDate {id, name, part? (後期前半), partNote? (week
containing the per-weekday switch-over)}`; `ClassItem.termPart` is the course's halves
    (後期後半 / 後期（前半・後半）, per slot when the source says so) and a half-only course's summary
    says 「［後期後半のみ］」.
  - `today()` / `tomorrow()` → `{date, term?, classes, noClassesReason?, changes, deadlines, tasks,
importantAnnouncements, preparation, conflicts}` (classes from `TaskEngine.schedule`; changes =
    since start of yesterday; deadlines = overdue ≤7 days and due in the next 15 days; important =
    critical/high, or university scope unless importance `low`, last 3 days).
  - `week()` → `{from, to, term?, days: [{date, classes, noClassesReason?}], deadlines, exams,
changes, conflicts}`.
  - `course(courseOfferingId)` (identity-expanded) → instructors, schedule (empty unless
    `scheduleType` is regular; per-slot `termPart` when slots differ), `scheduleType`,
    `academicYear`, `term`, `termId`, `termPart?`, `termPartCitations?`, `enrolled`,
    `retake`, resolved room,
    per-source ids, upcoming classes, recent lectures, deadlines, announcements, materials,
    changes, conflicts, `pendingLinks` (suggested identity links to confirm).
    Thread-based platforms (Teams) fill `discussion: DiscussionItem[]` (newest 20 announcements and
    messages whose `extra.platform` is set or that sit in a thread), `files: CourseFileItem[]`
    (documents of the course by folder then title, at most 200, `filesTotal` is the full count) and
    `assignments: CourseAssignmentItem[]` (all assignments, newest due first, `status` from the
    submission entity). The views are source-neutral; they only read `extra.platform`,
    `extra.channelName`, `extra.folder`, `extra.modifiedBy`, `extra.attachments`.
  - `teamsActivity({since?, courseOfferingId?, limit?})` → `{since, posts, files, assignments, conflicts}`
    (view `teams-activity`; entities whose `extra.platform` starts with `teams`; default since =
    7 days ago) and `courseFiles({courseOfferingId, path?})` → `{course, path, folders, files}` (view
    `course-files`; `folders` are the immediate subfolders with their file counts). MCP tools
    `get_teams_activity` / `list_course_files`, REST `GET /api/v1/teams-activity?since=&course=` and
    `GET /api/v1/courses/:id/files?path=`.
  - `deadline({days?, courseOfferingId?})` → `{overdue, upcoming}`.
  - `changesSince({since?, courseOfferingId?})` → `{since, changes, conflicts}`.
  - `classPreparation({sessionId? | courseOfferingId?})` → `{session, preparation,
previousLecture}`.
  - `classReview({lectureId? | sessionId? | courseOfferingId?, date?})` → `{lecture, nextDeadlines}`.
  - `lecture({lectureId? | sessionId? | courseOfferingId + date})` → `LectureBundle` (§21: session,
    slides, recordings, transcript segments with `HH:MM:SS` timestamps, announcements, questions,
    facts).
  - `examPreparation({examId? | courseOfferingId?})` → exams with resolved room, scope, days left,
    related announcements, transcript mentions of 試験, materials.
  - `admin()` → university/faculty announcements (14 days), source status (health, last sync,
    detected version, open drift), open conflicts, pending identity links.
  - Item shapes: `ClassItem {sessionId, course: CourseRef, date, period, startsAt, endsAt, room:
ResolvedValue, status: ResolvedValue, cancelled, summary}`; `ResolvedValue {value, status:
resolved|conflict|none, origin, method, candidates: [{value, origin, authority, source,
observedAt, citation}]}` — when `status === 'conflict'`, tell the user the sources disagree
    instead of picking one; `DeadlineItem {taskId, kind, title, course, dueAt, status, origin,
overdue, hoursLeft, evidence, summary}`; `ConflictItem {subject, subjectLabel, predicate,
candidates, note}`; plus `ChangeItem`, `AnnouncementItem`, `MaterialItem`, `TaskItem`,
    `PreparationItem`, `SegmentItem`, `QuestionItem`, `FactItem`. `summary` strings embed the
    first citation (`…（根拠: 学務情報システム 10/1 09:42取得）`, §75).
- AI additions (`additions.ts`, `uc.additions: AdditionsService`): deadlines, to-dos, notes and
  lectures that the student states or plans with an MCP client in any chat (`via: chat`, authority
  `student-statement`, label 「チャットで登録」) or that the client heard in a lecture recording
  (`via: recording`, authority `transcript`, label 「録音から」), stored only in UniContext under
  source id `mcp-additions` and read by every client through the views (§11, §19–22, §47–49, §74).
  The course is optional for deadlines, to-dos and notes (personal to-dos are `todo` facts on
  `PERSONAL_TODO_SUBJECT`); `notes()` lists notes and lecture summaries of every client (MCP
  `get_notes`). `recordLecture` (Lecture linked to the day's ClassSession, a 講義メモ Document,
  LectureTranscript + LectureSegments with per-segment timestamped references), `addDeadline`
  (`kind` assignment/report → Assignment, quiz/exam → Exam, prep → `todo` fact; a title match on
  the course's existing assignment/exam attaches an extracted `assignment_due`/`exam_at` fact to it
  instead, so a different date becomes a Conflict), `addNote` (Document), `addTask` (`todo` fact),
  `listFor`/`retract` (the client's own, unconfirmed), and for the owner `list`/`get`/`confirm`
  (claims become origin=user facts via `resolver.correct`, todos are re-put as user facts) /
  `reject` (facts retracted, own entities soft-deleted). Every fact is origin `extracted`, producer
  `ai`, with one SourceReference per addition (`sourceSystem` "ChatGPT Record" / "ChatGPTとの会話"
  or the client name, `sourceItemId` `<client id>#<addition id>`, `location.timestamp`) and the
  quoted evidence.
  `resolveDue(course, expr, lectureDate?)` resolves ISO or Japanese (来週の金曜, 次回) against the
  class start of the lecture date and `TaskEngine.nextClassAt` (timetable + academic calendar).
  Dedupe by course + kind group + normalized title within 36 h; idempotency key per client; write
  budget per client. Writes run `runPipeline()`. Views: `DeadlineItem.recorded` / `TaskItem.recorded`
  (「録音から」 / 「チャットで登録」, `via`, evidence, timestamp) when a task rests only on
  unconfirmed additions; `LectureBundle.notes` (summaries and notes).
- Change digest (`change-digest.ts`): views never pass the raw change log through. Index entries
  (document chunks, transcript segments), catalogue courses and bookkeeping updates (a notice body
  fetched later, `extra`) are hidden; the rest is folded to one item per entity, ranked (conflicts,
  class / assignment / exam changes and important notices first) and capped (`CHANGE_LIMITS`: day
  30, week 25, course 20, `changesSince` 50 or `limit` ≤ 200) with `changesTotal` /
  `changesOmitted`; `ChangeItem.before/after` keep only short scalar values of the changed fields
  and `summary` is cut to 200 characters. Today/tomorrow/week keep changes and conflicts of the
  current term's courses (grades: any enrolled course) and important or new university-wide
  notices; conflicts whose dates are all past are left to `get_conflicts`. The MCP layer then
  compacts every tool result (`compactEnvelope`: citations `{sourceReferenceId, label, url}` with
  the url once, settled values without candidates, ≤ 20 top-level citations) and trims `get_course`
  for AI clients (`trimCourseForAi`).
- Announcement bodies on request (`announcement-open.ts`): `openAnnouncements(uc, ids)` sends the
  ids' raw items to their adapter's `openAnnouncements()` (SDK extension `OpenAnnouncementsAdapter`,
  implemented by LiveCampusU and serialized there with `sync()`), ingests the returned items and
  sets UniContext's own read mark to unread; `AnnouncementItem.unread` is that mark, else the
  source's `read === false`. `context.setAnnouncementRead(id, read)` changes only UniContext's
  flag; `context.unopenedAnnouncements()` lists notices without a fetched body.
- `CONTEXT_VIEWS` (name, `context://<name>` URI, description), `ContextViewParams` (zod schemas per
  view, usable as MCP tool input schemas), `getView(engine, name, params)` (validated dispatcher),
  `isContextViewName`.

### 3.13 Next action, student state and attention (`next-action.ts`, `attention.ts`)

The student does not prioritise; UniContext decides. Everything here is deterministic (no LLM)
and read-only over tasks, assignments, submissions, exams, classes and source health.

- `context.nextActions({count?, effortMinutes?, courseOfferingId?})` → `NextActionsContext {top,
next, urgent, line, dueSoon, coverage: {trusted, gaps}, considered}` (view `next-action`).
  Each `NextAction` has `what` (a step startable in about 5 minutes, e.g.
  「小レポート1: 課題文を開いて設問を読む（10分）」), `why` (≤ 3 fragments: 締切まで27時間・未提出・配点10点),
  `dueAt`/`dueText`, `effort {stepMinutes, remainingMinutes, totalMinutes, basis}`, `steps`,
  `freeHoursBeforeDue`, `link {url, label}` (assignment URL, else the first citation URL;
  redacted), `course`, `score`, `reasons`, citations, and `estimatedDue` when the due date is
  unknown (below). `urgent` = an unsubmitted assignment is due (or estimated due) within 48 h. `today()` / `week()` carry `next: NextActionSummary {line, urgent, top, then,
coverageTrusted}`. `nextActionHost()` is the read model shared by the engine and the views below.
- Candidates: open tasks (`pending`/`in_progress`/`unknown`; submitted, completed, cancelled and
  `expired_past_term` never appear; an assignment whose latest Submission says
  submitted/late/graded/returned is skipped too), classes starting within 45 min (「…に出る」),
  preparation for today's later and tomorrow's classes when there are materials or notices (one
  per course) and coverage gaps. Tasks of courses the student does not take (catalog-only, or only
  a `dropped` enrollment) are left out; overdue work of a 前半-only course is left out once 後半
  has started.
- Effort: `classifyWork` by task kind and title (a notice deadline asking to hand in work is 課題; 小テスト 20, 小レポート 60, レポート 180, 実験レポート 360,
  課題 60, 試験勉強 480, 小テスト対策 30, 今週分 90, 授業準備 15, やること 30 minutes;
  `DEFAULT_EFFORT_MINUTES`). Overrides: `options.effortMinutes[kind]`, else
  `assignment.extra.estimatedMinutes`. Each kind has fixed first steps (`stepsFor`); the largest
  step absorbs an override; the steps the student said they did (below) are dropped, and with no record all steps stay.
- Free time (`freeMinutes`): awake hours 08:00–24:00 local from now to the deadline, minus the
  student's class times (cancelled classes and self-study slots do not count); half of it is
  assumed usable for one item.
- Score (higher first; ties: earlier due, then id):
  - dated and ahead: `(1000 / (1 + h/6) + 300·min(remaining / usable, 2)) × kindFactor`
    (1; 小テスト対策 0.9; 今週分 and やること 0.8; 授業準備 0.6); `cannot_finish` when remaining ≥ usable;
  - unknown due (work with a deadline, `hasDeadline`: assignments, exams, notice / chat items
    classified as 課題・レポート・小テスト…): ranked against its estimate (`estimatedDue.at`, the
    earliest plausible time, below) with the same formula plus 20 — an estimate already past
    counts as 3 h ahead with no effort pressure — kind `check_deadline`, the step
    「<確認先>で締切と内容を確認する（5分）」, `dueText` 「締切不明（推定10/8 10:20）」, why
    「締切不明・推定10/8 10:20（あと2日）」; estimates within 72 h join `dueSoon` with `estimated`
    and dueText 「推定…」. Never pushed down for being unknown;
  - overdue assignment: 「遅れて提出できるか確認する（5分）」, 180 decaying over 10 days (40 after 7
    days); an `extra.lateDueAt|lateDue|cutoffAt|closesAt` still ahead becomes the deadline;
  - +50 unsubmitted assignment, +min(points, 50), +150 midterm/final in its last week (+50 before), +30 quiz, +250 for 今週分
    while its self-study slot is on;
  - attend 700 (≤ 20 min) / 500 (≤ 45 min); prep `1000/(1+h/6) × 0.6`;
  - coverage gaps from `deadlineCoverage()` (coverage.ts; undated work is an action of its own;
    its `unknown_due` gap lists the items with their estimates, earliest first): a deadline source that needs login, fails or never synced 320, a stale one 230 —
    「EdStemの課題一覧を開いて、締切が漏れていないか確認する（5分）」 with the platform origin as link;
    a course on a platform whose assignments are not synced 150 — 「EdStemで「…」の課題と締切を確認する（5分）」.
    `coverage.trusted` is false when such a gap exists.
- `studentState(uc)` (MCP `get_student_state`): current / next class, today's and tomorrow's
  classes (room, disagreeing rooms, 休講), open assignments (undated with `estimatedDue`, overdue
  ≤ 14 d, due ≤ 45 d; sorted by due date or estimate) with effort, submission and link, exams ≤ 60 d, other tasks (≤ 20), changes, important notices,
  pacing, the student's notes (`additions.notes`, 10), conflicts, coverage and the ranked next
  actions as `suggestion` (the AI may re-rank).
- `attentionRequired(uc, clientId, {dryRun?, scope?})` (MCP `get_attention_required`): alerts that
  are true now — unsubmitted assignments due ≤ 24 h, by stage (`notifyStage`, below), and work with an
  unknown due date whose estimate is ≤ 24 h away, at the same stages, or already past (key
  `deadline-estimate:<task>:<estimate>:<stage>`, line 「【締切不明・推定】…推定10/8 10:20…で確認」), a class within
  60 min with its room (warning when sources disagree), 休講 today/tomorrow, room changes and
  high/critical notices in the change log since the client's last call (first call: 24 h back),
  pace behind, sources with an expired login or failing sync — each with a ready-to-send `line`.
  Per client (the OAuth client id on the remote surface, `local:<client name>` locally) the table
  `client_marks` (created on first use, outside the migrations) keeps the last call and the
  severity already told per alert key; an alert repeats only when its severity rises, a deadline
  when its stage advances (the mark keeps the highest stage rank told under `<key without stage>#stage`).
  `nothingImportant` = nothing new; `text` ≤ about 300 characters. Every item also carries
  `attentionId` (stable per thing — task, class meeting, notice, source, course — across calls,
  clients and changes of its due date or severity), `firstSeenAt` / `lastChangedAt` (per client,
  kept in the marks), `nextEscalationAt` (deadline: the next stage boundary; tomorrow's
  休講 / unknown group: the start of that day; a room change: the day before; pace: next week),
  `recommendedAction` (one concrete step) and `sourceHealth` (health of the sources behind its
  citations, from the deadline coverage; `unknown` when unmatched). A class whose meeting depends
  on a group the student has not registered gives one `group_unknown` item per course.

  *Stages.* A deadline (stated or estimated) has `notifyStage`: `24h` (≤ 24 h left, warning), `6h`
  (≤ 6 h, critical), `final` (critical; the last 2 h before the deadline. The other trigger, the deadline's own day after
  22:00 local, never comes earlier: such a deadline is at most 23:59. So the 23時台 rule is this stage; `1h` is reserved in the list and
  never produced, the last two hours being `final`) and `overdue` (critical; the due time passed, the
  assignment is still open and unsubmitted, its source does not say late work is refused
  (`allowLateSubmissions: false`, `isCompleted`) and no later cut-off (`lateDueAt` …) is ahead; flagged for 7 days after the due
  time, then left to the next actions). The stage is part of the key, so each stage change is told
  exactly once per client and the same stage is not repeated. `nextEscalationAt` is the next
  boundary (24h: 6 h before; 6h: 2 h before; final: the due time; overdue: none). Estimates read
  「【締切不明・推定】」 / 「推定間近」 / 「推定直前」 / 「推定を過ぎた可能性」.
  `AttentionContext.pending` lists, at most 20, the alerts still true but already told at their stage
  (`attentionId`, `key`, `notifyStage`, `severity`, `nextEscalationAt`, `line`), so the watcher sees
  what it is holding back and when it returns; `alreadyTold` stays the count. Items carry
  `quietUntil` (08:00 local) when it is 0:00-7:59 local and the item is not within 3 h of its time:
  the night rule stays the client's. Such an item is not marked as told (the client's mark and
  `since` stay put): it comes back in `items` on every call until 08:00, and from 08:00 without
  `quietUntil`, when the client sends it once.
- `briefing(uc, clientId, {kind?, dryRun?})` (MCP `get_briefing`): thin wrapper over the two —
  morning (< 11:00) / evening (≥ 17:00) / check by local time; classes of the day, top action,
  must-do, unsubmitted ≤ 72 h, unknown due dates estimated ≤ 72 h (「締切不明（早めの推定）: …」), news since the client's last briefing (its own `briefing` scope of
  the marks), coverage gaps, `text`, `nothingImportant`.
- MCP `get_next_action {count?, course?}`, `get_student_state {}`, `get_attention_required
{dryRun?}`, `get_briefing {kind?, dryRun?}` (apps/mcp `next-action.ts`) — all `readOnlyHint: true`
  and on the remote surface, so scheduled ChatGPT tasks never wait for approval. The server
  instructions (local and remote) tell the AI to call `get_next_action` for 何すればいい／暇／やること,
  never to make the student choose, to open a conversation with the top action in one line when
  `urgent`, and to stay silent in scheduled tasks when `nothingImportant`. CLI
  `unicontext next [--count n] [--course c]` (`--json` = the context); `unicontext today` prints
  `next.line` first. REST `GET /api/v1/next`; the Web UI Today page shows the top card.
- Notifications (internal: log + console/desktop sinks): `NotificationService` options
  `morningDigestAt` ('HH:MM', once a day until noon, kind `next_action_digest`; `morningDigest()`
  builds the object without sending) and `escalationLeadTimes` (kind `deadline_escalation` for
  unsubmitted assignments per window, priority normal / high ≤ 24 h / critical ≤ 6 h, with the
  first step; those assignments get no `deadline_approaching`; an estimated one is titled
  「締切不明・推定まであと約…」 with the basis and where to confirm). Both are off unless passed; the
  daemon passes config `notifications.morningDigestAt` (default '08:00', '' = off) and
  `notifications.escalationLeadTimes` (default 72h / 24h / 6h).

#### Estimated deadlines (`estimate.ts`)

The student: 「推測しなきゃわからない場合は？」「期限がわからない時にAIが楽観視するのも問題」. Policy:
never present a guess as a fact and never store one as a deadline (`add_deadline` still takes
only a stated date — 「次回までに」 from a recording is stated; university data is never
overridden), but never leave an unknown deadline blank either: it gets the **earliest plausible**
time, labelled 「推定」 with its basis, a range and where to confirm, and plans and alerts run
against it. Estimates are computed on read; nothing is stored.

- `context.dueEstimator()` → `(task) => EstimatedDue | undefined` (one per request; meetings and
  dated items cached). Undefined when the task has a due date or is not work with a deadline
  (`hasDeadline`: the student's own `manual` to-dos and 今週分 are not estimated).
  `EstimatedDue {label: '推定', at, earliest, latest?, method: series | relative_rule |
next_class | default, basis, confidence: medium | low, text, checkWhere, checkUrl?, passed}`.
- Appeared at: the earliest of `assignment.availableFrom` and the task's `createdAt`. Meetings:
  the student's effective sessions of the course (personal schedule: groups; the academic
  calendar: half-terms, holidays; cancelled ones and other groups' days left out), one per day.
- Candidates (all must be at or after the appearance; the earliest wins, the latest is the range):
  - (a) `series` (medium): items of the same course and series (same text before the first number,
    or the same title with the number replaced: 小レポート1/2…, 第N回小テスト, Lesson N) with a
    stated due date, from tasks of any status and assignments. Each sibling's offset = its due
    minus the latest meeting before it (≤ 8 days back). Two or more numbered siblings: the
    nearest sibling's due + the median interval per number × the number difference (interval
    1–31 days). One: the meeting `n − k` meetings after the sibling's class + its offset. Also the
    meeting before the item appeared (else the next) + the shortest offset.
  - (b) `relative_rule` (medium) in the item's title / evidence / description / notes:
    「次回(の授業)まで・次回の開始・次回に提出」 → the next meeting after it appeared; 「N週間以内 /
    N日以内」 → appeared + N; 「今日中・本日中・当日中」 → 23:59 that day; 「今週中」 → Sunday 23:59.
  - (c) `next_class` (low, only without (a)/(b)): the first meeting after it appeared; the range
    ends at the meeting after that.
  - (d) `default` (low): 7 days after it appeared, 23:59 (range 14 days).
- `checkWhere`: 「<source>の課題ページ」 when there is a link, else the source's notice, else
  「<course>の先生・LMS」.
- Views: `DeadlineContext.estimated: EstimatedDeadlineItem[]` (MCP `get_deadlines`, CLI
  `deadlines` section 「締切不明（推定・要確認）」) apart from stated deadlines, earliest estimate
  first; `AssignmentItem.estimatedDue` (`get_assignments`, CLI `assignments`); `TaskItem
.estimatedDue` in today / tomorrow; `BriefWork.estimatedDue` (student state, briefing);
  `NextAction.estimatedDue`; coverage `unknown_due` items. MCP answer hints and server
  instructions (local and remote) say: plan with the early estimate, say 「推定」 with the basis
  and where to confirm, never state or register it as the deadline.
- `candidate` (medium): a to-do that may be an assignment UniContext already knows (below) is
  never estimated while that assignment has a known due date: its due date is used, with the
  assignment named in the basis and 「同じものか要確認」.

#### Recorded work that already exists (`task-engine/assignment-match.ts`)

2026-10: the student told ChatGPT 「レポート1：レンタル店のER図を作成する（提出期限は現時点で未確認）」
(add_task via chat, lecture 10/1) while Ed already had 「当日課題 (小レポート1)」 due 10/6 17:00 in
the linked offering. Kept apart, the to-do was estimated at the next class (10/8 10:20) and the
chat said the deadline was unknown.

- Every to-do fact (add_task, add_deadline kind prep, ingest_lecture tasks) is matched against the
  assignments of its course (every linked offering), deterministically: title (the same numbered
  item across spellings — レポート1 ~ 小レポート1 ~ Report 1 — or close titles, 0.6; another number
  of the same kind rules it out; the same kind of work or a loosely similar title, 0.3), content
  words shared with the assignment's title / description (+0.1 / +0.3), timing against the
  lecture date (`TodoValue.lectureDate`, else when it was written): the assignment appeared within
  a week (`availableFrom`, the LMS lesson date 「(10/1)」) or is due within 4 weeks after it
  (+0.25), closed more than 2 days before it (−0.4).
- `linked` (≥ 0.8 with a same-item title and a 0.2 lead over the next): stored on the fact
  (`TodoValue.assignmentId`) when known at write time; `derive()` re-checks on every run, so an
  assignment synced later links it then. The to-do has no task of its own: its fact joins the
  assignment task's `sourceFactIds`, its notes become a block 「〔チャットで登録「<title>」〕…」 in
  that task's notes (sentences saying the deadline is unknown dropped; rebuilt every run), the
  student's own progress on the old to-do task carries over and that task row is removed. Due
  date and status come from the source; `recordedMarker` does not mark a task that also rests on
  a system's facts. The addition shows `attachedTo` and `stored.taskId` of the assignment task.
  Deadline items and `get_assignments` items carry those blocks as `details`.
- `candidate` (≥ 0.5): both stay; the addition shows `possibleSameAs` and the estimator uses the
  candidate's due date (above).
- `add_task.assignmentId` links explicitly. `add_deadline` (assignment / report) also attaches to
  the same numbered item. MCP tool descriptions and server instructions (`EXISTING_ITEM_RULE_*`):
  look the course's deadlines / assignments up before registering, use the existing item, and
  check the course's assignments first when the item says its deadline is unknown.

#### Effective schedule and personal conditions (`personal-schedule.ts`, `group-schedule.ts`)

The timetable of the academic system lists a group-taught course on one weekday for everybody
(情報科学実験B: Monday 3–5), while the distributed 実施スケジュール puts group A on Mondays in C&C
and group B on Fridays in 科学実験室. The views therefore show the student's **effective** schedule
and keep the **raw** one visible.

- Personal conditions: single-valued fact `condition:group` on the course offering (value "B",
  `normalizeGroupLabel`: Ｂ / B班 / Bグループ / グループB → B). Authority list in
  `default-rules.yaml`: the university and instructors above a chat or a recording, so a chat
  never outranks them and a newer, different value opens a Conflict. Provenance shown as
  `university | document | chat | recording | student` (`student` = confirmed by the owner).
- Session rules: multi-valued fact `session_rule` (`SessionRuleValue`: date, group, held /
  no_class, periods?, start/end?, room?, number?, topic?, note?, documentTitle?), one per table row.
  - From synced data: `extractSessionRuleFacts` (task-engine `session-rules.ts`, run in
    `derive()`) parses every document (all chunks), notice and post that mentions 班 / グループ
    with `parseGroupScheduleTable` — rows of date + weekday (checked against the date, year from the
    academic year, month carried over) + one group token, in either layout seen (date, group, room,
    #nn / no., date, topic, group); at least 4 group rows over 2 groups. `courseOfTable` assigns
    the table to the course named in its heading or non-row lines (a 実験C table in the 実験B team
    goes to 実験C), else the document's course. Facts are origin extracted, cited to the document,
    the row as evidence; rows that vanish are retracted. Notes written by AI clients are never
    parsed.
  - From a chat: MCP `set_course_condition {course, value, evidence, condition?=group}` and
    `add_session_rule {course, sessions[], evidence, sourceDocument?}` (write scope; additions of
    kind `condition` / `session_rule`, unconfirmed, retractable; confirm turns them into user
    facts). Descriptions tell the AI to call them as soon as the student names a group or a group
    table appears.
- `PersonalSchedule.apply(date, raw)` (context-engine) gives each meeting `effectiveSchedule`
  `{status: attending | not_attending | unknown, reason, room, group, sessionGroups, number,
topic, rule {provenance, confirmed, source, documentTitle, evidence}, conflicts, citations}` and
  `rawSchedule` (as the timetable says; absent for meetings only the group table lists, which are
  generated with the timetable's periods). Per date, rows from the best-ranked source decide
  (student > university > document > chat / recording); lower-ranked rows that disagree are listed
  in `conflicts`. Group unknown → `unknown` (never dropped); another group's day or a 休講 row →
  `not_attending`; inside the table's span but not listed for a known group → `not_attending`;
  outside it → the timetable as is.
- Views: `get_today` / `get_tomorrow` / `get_week` days put `not_attending` meetings in
  `notAttending` (with the reason) and the rest in `classes`; `noClassesReason` says so when only
  another group's meetings exist. `get_course.upcomingClasses`, the next-action engine
  (`host.classes`), the student state (`today.notAttending`, `effectiveSchedule` on each class,
  `rawSchedule` when it differs), attention, class preparation and the course inference of
  `ingest_lecture` / `record_lecture` all use the effective schedule.
- Deadlines extracted from notices (task-engine `deadline-context.ts`): a sentence addressed only
  to another group (「A班は…」, while the student's group is known) gives no task; 「A班の皆様も」
  addresses everyone. A done marker next to the date (「(済)」「【提出済み】」) makes the task
  `completed` with the fact as `statusEvidenceFactId`. The title is shortened (「登録は…」 + notice
  「teams 登録について」 → 「teams 登録」, 「履修登録期限(一般): …」 → its label); the sentence stays in
  `evidence`.

#### Whether the student takes a course (`condition:enrollment`, task-engine `enrollment-declaration.ts`)

Registration outcomes at Shizuoka (履修の許可・不許可, 抽選の結果, 取消) reach the student **by
email only**; LiveCampusU keeps listing a rejected course as 履修中 on every screen the connector
reads (時間割, スケジュール, 成績 includingInProgress, 卒業要件), and the 履修登録 screen itself sits
behind a write gate (`SC_05002B00_04/update`, docs/research/lcu-registration.md). The student's own
word is therefore the path, not connector parsing; a future `ingest_external_signal(gmail)` could
feed the same condition from the outcome email (unconfirmed, cited to the message).

- Fact: single-valued `condition:enrollment` on the course offering, value `not_taking` |
  `taking` (`normalizeEnrollmentDeclaration` also reads dropped / rejected / 履修拒否 / 取り消した /
  落選 and taking / 履修中). Written by MCP `set_course_condition {condition: 'enrollment', value,
evidence}` (addition kind `condition`, unconfirmed, retractable; `unicontext additions confirm`
  turns it into a user fact). The tool description tells the AI to call it right away whenever the
  student says a course was dropped / rejected / not taken, even if the system still lists it.
- Decision (newest confirmed declaration, else the newest unconfirmed one) is applied in
  `ClassSchedule.enrolledOfferings()` and `ContextEngine.selfEnrollments()`, so every view of the
  student's own schedule and work follows it: today / tomorrow / week classes (no generated or
  stored meetings), deadlines and tasks of the views, next actions and attention (`host.notTaken`),
  deadline coverage, pace, notifications (`enrollmentOf().enrolled` is false) and conflicts of
  current courses. `taking` brings back a course the system marks `dropped`.
- **Confirmed vs unconfirmed.** Both decide what the views show: the student knows their own
  registration better than a stale system, and an unconfirmed declaration that hid nothing would
  keep showing a class the student told us they do not attend. The difference is visibility of
  the disagreement: while unconfirmed, today / tomorrow / week carry `enrollmentNotes` with one
  line per course (「情報科学実験C: 学務では履修中、本人は履修していないと登録（チャットで登録・
  未確認）。表示から外しています」, cited to the chat); confirmed, the note goes away.
- Nothing is deleted: the enrollment record, its sessions, assignments and tasks stay; the course
  view (`get_course`) keeps the course with `enrolled` (what the views use) and `enrollment
{academic: active | dropped | none, declaration {value, confirmed, provenance, evidence, source,
declaredAt}, taken}`, and a course-scoped `get_deadlines` still lists its deadlines. Reading
  synced documents (`extractSessionRuleFacts`) uses the raw list (`enrolledOfferings({raw: true})`)
  so a table of a dropped course is never attributed to another course.
- Precedence among declarations: a confirmed one wins over a newer unconfirmed one (as for the
  group); the AI can retract its own unconfirmed one.

#### Future: `ingest_external_signal`

Gmail and Google Calendar findings are currently only read by the ChatGPT scheduled tasks
(read-only) and are never stored in UniContext. A future write tool
`ingest_external_signal(source = gmail | calendar, ...)` could store them like the other chat
additions: unconfirmed, cited (message or event reference) and non-authoritative, so they never
override the university's data and a conflict shows both values. Until then the tasks and skills
must not write anything found in mail or calendar into UniContext.

#### Task progress (`task-progress.ts`, task-engine `progress.ts`)

The student says 「始めた」「ここまで終わった」「終わった」; UniContext holds it so the AI never asks again
and the next actions stop proposing what is done. MCP `record_task_progress {task, course?, status?,
steps?, doneSteps?, statement}` (write tool; remote only with `unicontext.write`): `task` is a `task:` /
`assignment:` id or a title (with `course`); `statement` is the student's own words, verbatim (required);
the description tells the AI to call it without asking whenever the student says so and never from its
own inference. Output `{taskId, title, previousStatus, status, steps, percent?, additionId}`.

- Storage (no migration): a fact `task:progress` with value `{status, steps?: [{label, done}], percent?,
  statement, statedAt}` and the quote as `evidence`. Tasks are records, not entities, so the fact hangs
  on a pseudo person derived from the task id (`taskProgressSubject`), one slot per task; the newest
  `statedAt` wins (`latestTaskProgress`). The fact is `extracted` (an AI produced it: FactSchema §48 allows
  no AI-made `user` fact); the status it sets is the student's own (`statusSetBy: 'user'`).
- Status goes through `TaskEngine.setStatus` with the new actor `student-statement`: it may set pending /
  in_progress / completed / cancelled, never `submitted` (submission systems only) and never
  `expired_past_term` (or `unknown`); `statusSetBy` becomes `user` and `statusEvidenceFactId` points at the
  fact (kept through `derive()`). The plain `ai` actor is unchanged (no completed / submitted). A task the
  submission system reports as submitted keeps that status; only the steps are recorded. A status that
  only rests on such a statement (open: pending / in_progress, evidence = a `task:progress` fact) gives way
  later: submission evidence turns the task `submitted` (`submission-system`) and the end of the term makes
  it `expired_past_term` in `derive()`; completed / cancelled and the owner's own status do not (an owner
  `setStatus` drops the statement as evidence). Status omitted:
  done steps on a pending task make it `in_progress`; nothing implies `completed`.
- It is an addition (tool `record_task_progress`, kind `progress`): stored unconfirmed but applied at
  once like `set_course_condition`, visible in `list_my_additions`, retractable with `retract_addition`
  (the owner's reject too): the fact is retracted and the status fields saved with the addition are
  restored, unless a later statement has taken the status over. `AdditionsService.recordTaskProgress`
  prepares it (`prepareTaskProgress`, validation before any write) and `undo` calls `undoTaskProgress`.
  The tool takes `idempotencyKey` like the other write tools (a retry with the same key is replayed, not
  stored twice). Nothing derived depends on the statement (the status is applied directly, next actions
  read the fact live), so neither the write nor its retract / reject runs the pipeline.
- Steps: `steps` replaces the list; `doneSteps` marks steps done (a label that matches no step is added
  as a step the student did); both start from the plan of that kind of work (`stepsFor`). Labels match
  after dropping 「（10分）」, width and spaces (`stepsMatch`). The next-action engine drops the done steps
  of its plan (`host.progress`, `remainingSteps`) instead of guessing from `in_progress`; with no record all
  steps stay, and with everything done on a task still open the last step remains.

## 3.12 Apps and notifications (lane b)

- `@unicontext/notifications`: `NotificationService({uc, sinks, logFile?, minPriority?, deadlineLeadTimes?})`
  subscribes to the bus (`change`, `conflict`, `health`, `sync:failed`, `drift`) and polls
  `context.deadline()` for approaching deadlines. Notifications are deduped by `dedupeKey` in a JSONL log; sinks are
  console (stderr), desktop (optional `node-notifier`) and webhook (off by default, HMAC signed).
  `createSinksFromConfig(config.notifications, {secrets})` builds them from config.
- `@unicontext/mcp` (apps/mcp): `createMcpServer(deps)`, `runStdioServer`, `handleMcpHttp` (stateless streamable
  HTTP), the file-backed `ProposalStore` + `applyProposal` (propose -> confirm -> execute, §50) and `buildAssignments`.
  Every tool result is an envelope `{data, citations, conflicts, answerHint}`. `get_assignment`
  (`assignment-detail.ts`) takes an assignment / task id (get_assignments items carry `assignmentId`) or the
  `document:` of an Ed lesson, re-reads it through `fetchDetailsOnRequest` (the source's `DetailFetchAdapter`; for
  mapped adapters the mapping's `details` rule), and returns the deadline/status plus, for an Ed lesson, every slide
  with its text, quiz questions (prompt, choices, the student's saved answer) and files; never answer keys.
- `@unicontext/daemon` (apps/daemon): `createRuntime` (config + profile + dynamic connector loading + secrets, shared by
  the CLI and MCP stdio), `startDaemon` (lock file, scheduler, notifications, Fastify on 127.0.0.1: REST `/api/v1`, Web
  UI static files, `/mcp`), `DaemonClient`, service install helpers and `api-types` (wire types, type-only subpath).
  Sources: `effectiveSources(config.sources, profile)` — every profile source (keyed by its product name, e.g.
  `livecampusu`, `lcu-public-cancellations`) plus every config.yaml source; a config entry named like a profile role
  or product is merged over that profile entry (so it keeps `connector`/`module`/`mapping`), `enabled: false` turns
  a profile source off, and listing a profile source that is off (EdStem) turns it on.
  Connector packages are resolved by name in `src/registry.ts`: the source key or `connector:` gives
  `@unicontext/<name>`, `adapter: mcp|cli|rest|browser` gives `@unicontext/adapter-<kind>`. The package entry
  (`default`, else `connector`) goes through the SDK's `resolveConnectorExport` — a `ConnectorModule` or a
  `ConnectorFactory` that receives the effective source config. A missing package marks only that source `failed`.
  Every connector/adapter package is an optional dependency of the daemon.
  `src/wiring.ts`: `wireCourseProviders` feeds LiveCampusU's enrolled CourseOfferings (current academic year) to the
  public 休講 module (`courseProvider`, so own-course 休講 become cancelled class sessions on Today) and to the
  syllabus module (`targetProvider`), and gives the syllabus catalog the student's detail priorities
  (`priorityProvider` <- context-engine `syllabusDetailPriorities`: registrations, courses still needed for
  graduation, the department's electives; docs/connectors/syllabus.md); `startWatchers` runs `watch()` of WatchableAdapters (local-files,
  chatgpt-record) into `SyncEngine.ingest` while the scheduler runs. `unicontext login` calls `authenticate()` and,
  when that is not enough, the adapter's interactive `login()` (InteractiveAuthAdapter).
- Remote endpoint (apps/daemon `src/remote/`, [docs/remote.md](remote.md)). Scopes: `unicontext.read` always,
  `unicontext.write` only when the owner leaves the consent-page checkbox ticked (`OAuthServer.approve(..., {write})`);
  with it, `/mcp` passes `allowWrite` and the OAuth client to `createMcpServer`, which then also registers the record
  tools; the audit log gets the written ids. When `config.remote.enabled`,
  `startDaemon` starts a **second** Fastify instance on `127.0.0.1:remote.port` (default 17879) that a cloudflared
  named tunnel publishes at `remote.publicUrl`. It has no REST/Web UI routes, only an OAuth 2.1 authorization server
  (`OAuthServer`: RFC 9728/8414 metadata, PKCE S256 only, RFC 8707 resource binding, RFC 9207 `iss`, DCR and Client ID
  Metadata Documents incl. `private_key_jwt`, redirect allowlist for ChatGPT/claude.ai, owner passphrase with
  persistent lockout) and `/mcp` served by `handleMcpHttp` with `surface: 'remote'`. `createMcpServer({surface:
'remote'})` skips every tool whose `readOnly` is false (the propose-only writes), uses `REMOTE_SERVER_INSTRUCTIONS`,
  returns compact text, drops raw payloads from `get_source`, and reports every call to `onToolCall` (audit log
  `logs/remote-audit.jsonl`). State (clients, grants, hashed tokens, scrypt passphrase) is a JSON file
  `remote/oauth-state.json` written atomically by both the daemon and `unicontext remote …`; readers reload on mtime
  change, so `remote revoke` applies on the next request. `X-Forwarded-*`/`CF-Connecting-IP` are trusted only from
  `remote.trustedProxies`; the issuer and token audience always come from `remote.publicUrl`.
- `@unicontext/cli` (apps/cli, bin `unicontext`) and `@unicontext/web` (apps/web: React, Vite, TanStack Router, built
  to `apps/web/dist` and served by the daemon).
- Config additions in core (`ConfigSchema`): `daemon.port` (default 17878), `notifications` (enabled, minPriority,
  deadlineLeadTimes, sinks.console/desktop/webhook) and `remote` (enabled=false, port 17879, publicUrl,
  trustedProxies, accessTokenTtl 1h, refreshTokenTtl 30d, extraRedirectUris, clientMetadataHosts). Config keys that are not in the schema are dropped on load.
- Dev mode (`unicontextd --dev`, `unicontext --dev <cmd>`): the Shizuoka seed through the fake connector with the clock
  anchored at 2026-10-01 09:30 JST. Nothing contacts a university.

## 4. Writing a connector (lane a)

1. Create `connectors/<name>/` (the stub already has `package.json`, `tsconfig.json`,
   `src/index.ts`). Add dependencies you need (`@unicontext/auth` for OAuth/secrets, `zod`) and the
   matching `references` in `tsconfig.json`.
2. Decide raw item types (`<product>.<thing>`, e.g. `lcu.course`, `graph.message`) and write a zod
   schema per payload type — used for drift detection, not to reject data.
3. Write metadata:
   ```ts
   export const metadata = defineMetadata({
     name: '@unicontext/livecampusu',
     product: 'livecampusu',
     version: '1.0.0',
     license: 'MIT',
     capabilities: ['courses', 'timetable', 'rooms', 'exams', 'announcements'],
     adapter: 'native',
     apiStability: 'unofficial',
     risk: 'unsupported',
     testedVersion: '…',
     defaultAuthority: 'academic-system',
     sourceLabel: '学務情報システム',
     defaultSchedule: '15m',
     rawTypes: ['lcu.course', 'lcu.session'],
   });
   ```
4. Implement `SourceAdapter`. Fetch with `createHttpClient({rateLimiter: ctx.rateLimiter, headers:
async () => ({authorization: \`Bearer ${await tokens.getAccessToken(oauth)}\`})})`; return raw
payloads unmodified as `RawItem`s; page with `hasMore/nextPageToken`; return a `cursor`(delta
token / etag / lastModified); report deletions or set`complete`. Report product versions via
`SyncResult.productVersion`or`detectProductVersion()`. Store credentials only through
`ctx.secrets` (`secretKey(sourceId, 'oauth')`, `OAuthTokenStore`). Throw `AuthRequiredError`
   when login is needed. Never put tokens/cookies into payloads (the compliance suite checks).
5. Implement the `Normalizer`: map each raw type to canonical entities using `ctx.id(kind,
externalId)`; set `ref.url`/`ref.location` (page, `timestamp` for recordings, `messageId`) for
   precise citations; set `ref.authority` when one item has a different authority than the source
   default (an instructor post in Teams → `instructor-announcement`); emit `facts` for claims that
   are not entity fields (e.g. room changes found in text, with `origin: 'extracted'`, `evidence`,
   and `validFrom/validUntil` for one-off changes); call `detectSchemaDrift(payload, schema)` and
   return `drift`. Use `ctx.profile` (periods → start/end times) and `ctx.timezone`. LLM output must
   use `producer: {type: 'ai', id}` and origin `extracted`/`inferred`.
6. Export the module: `export default defineConnector({metadata, configSchema, createAdapter,
createNormalizer})`. Product logic stays in the connector; university-specific values come from
   `profile.products[product]` (§26, §54).
7. Tests: sanitized fixtures under `connectors/<name>/test/fixtures/`, a mocked transport (inject
   `fetch`), and `testConnectorCompliance('<name>', {...})` from `@unicontext/connector-sdk/testing`.
   CI must never contact a real university (§65). The fake connector in
   `packages/connector-sdk/src/fake.ts` is a complete worked example.

Adapters (`adapter-mcp`, `adapter-cli`, `adapter-rest`, `adapter-browser`) implement
`SourceAdapter` generically (tool discovery / CLI JSON / OpenAPI / Playwright session) and pair
with a per-service `Normalizer`; they plug into the engine the same way. Mapped adapters
(`@unicontext/mapping`) also get `forEach.expand` (fan out over parts of a parent, e.g. quiz
slides), `forEach.refreshAfter`/`always` (skip a detail call made recently in this process) and,
with a mapping `details` section, `fetchDetails` (`onRequest` resources run only when the user asks;
docs/connectors/mapping.md).

## 5. Using the foundation from apps (lane b)

```ts
import { createUniContext, getView } from '@unicontext/context-engine';
import { instantiateConnector } from '@unicontext/connector-sdk';
import { createSecretStore } from '@unicontext/auth';
import { createLogger, loadConfig, loadProfile, resolveDataPaths } from '@unicontext/core';

const paths = resolveDataPaths();
const config = loadConfig(paths.configFile);
const profile = config.profile ? loadProfile(config.profile) : undefined;
const logger = createLogger({ level: config.logging.level });
const uc = createUniContext({
  dataDir: paths.root,
  profile,
  logger,
  schedules: config.sync.schedules,
});
const secrets = await createSecretStore();

for (const [sourceId, src] of Object.entries(config.sources)) {
  if (!src.enabled) continue;
  const module = await loadConnectorModule(src.connector ?? sourceId); // app-specific registry
  uc.sync.register(
    instantiateConnector(module, { sourceId, config: src, secrets, logger, profile }),
  );
}
uc.bus.on('change', (e) => notifications.onChange(e)); // §46
uc.bus.on('health', (h) => notifications.onHealth(h));
if (config.sync.background) uc.scheduler.start(); // daemon (§34)

getView(uc.context, 'today', {}); // MCP get_today / context://today, REST /api/v1/today
await uc.search.search('正規化'); // MCP search, REST /api/v1/search
uc.context.changesSince({}); // get_recent_changes
uc.resolver.listConflicts({ status: 'open' }); // get_conflicts
uc.resolver.correct({ subject, predicate: 'room', value }); // user correction (§74)
uc.identity.confirm(a, b); // confirm a course mapping (§14)
uc.tasks.setStatus(taskId, 'completed', { actor: 'user' }); // AI callers must pass actor 'ai'
uc.sync.healthAll();
uc.sync.stores.drift.list({}); // doctor / Sources screen
await uc.sync.sync('livecampusu'); // CLI `sync`
await uc.sync.reprocess(); // after a normalizer fix
```

Maintenance commands map to `exportJsonlToFile`, `importJsonlFile`, `backupDatabase(uc.db,
paths.backups)` and `purgeSource(uc.db, sourceId)` from `@unicontext/database`. Every context item
already carries citations; `get_source` can be served from
`uc.sync.stores.sourceRefs.get(id)` / `uc.sync.stores.raw.get(rawItemId)`.

Write operations to university systems (§50, §51) are not part of this layer; any future write
path must go through propose → confirm → execute in the apps.

## 6. Reference: identifiers, predicates, authorities

- Entity ids from connectors: `stableId(kind, sourceId, ...externalParts)` (via `ctx.id`).
  SourceReference ids: `stableId('sourceReference', rawItemId, 'entity', entityId)` or
  `(rawItemId, 'fact', subject, predicate)`. Fact ids: `factId(refId, subject, predicate, value)`.
  Conflict ids: `stableId('conflict', canonicalSubject, predicate)`. Task ids:
  `stableId('task', 'assignment' | 'exam' | 'extracted', originId)`.
- Predicates in use: `room`, `class_status`, `starts_at`, `assignment_due`, `exam_at`,
  `submission_status`, `grade`, `grade_letter` (auto), `deadline` (task-engine extractor), `todo`
  (things to do an AI client heard in a lecture; multi-valued, never a Conflict — rules
  `multiValued`), `condition:group`, `condition:enrollment` (the student's own conditions in a
  course), `session_rule` (multi-valued). Rules `compareFields` name the fields of an object value
  that decide agreement: `deadline: [dueAt, courseOfferingId]`, so two phrasings of one due date
  (「12:00まで」 / 「12:00が締め切り」) never conflict; the extractor also keeps one fact per instant
  per text and drops a date-only match when the text gives a time on that day
  (`withoutRestatedDays`). Conflicts whose dated values are all more than a day past, or about a
  course outside the current term, stay out of today / week (still in `get_conflicts`). New
  predicates need no schema change; add them to the rules YAML when authority matters.
- Authorities: `academic-system`, `submission-system`, `instructor-announcement`, `syllabus`,
  `lms`, `calendar`, `collaboration`, `discussion`, `transcript`, `local-file`, `user`.
  `assignment_due` lists `academic-system` then `transcript` last and `exam_at` ends with
  `transcript`, so a newer, different date heard in a lecture opens a Conflict with the system that
  states it and never outranks it.

## 7. Decisions and deviations

- **Build:** TypeScript project references (`tsc -b`), no bundler. TypeScript 6.0.x (7.0 is the
  native compiler and typescript-eslint supports < 6.1). Vitest 4.1 (5.x was younger than pnpm's
  minimum release age).
- **Config/paths/profile live in `@unicontext/core`** (re-exported by `@unicontext/database`) so the
  CLI can read config without opening a DB.
- **Windows config** sits next to the data: `%LOCALAPPDATA%\unicontext\config.yaml`.
- **Entity storage:** one table per entity kind with a JSON `data` column plus typed index columns,
  instead of fully normalized columns; the canonical zod schemas remain the source of truth.
- **Migrations** are hand-frozen SQL in TS modules (generated once from the Drizzle schema), with
  checksums and a schema-parity test, rather than drizzle-kit output.
- **Identity resolution** is a separate package `@unicontext/identity`.
- **Japanese FTS** uses the FTS5 trigram tokenizer; terms shorter than three characters fall back to
  `LIKE` (correct but unindexed). No morphological analyzer dependency.
- **Semantic search** stores vectors in SQLite and does brute-force cosine; fine at single-student
  scale, replaceable behind `EmbeddingIndex`.
- **Auto-facts:** entity fields in `DEFAULT_FACT_FIELDS` become facts automatically so every
  connector participates in conflict resolution without extra code.
- **Initial sync** does not emit `created` ChangeEvents (keeps "what changed since yesterday"
  meaningful). Conflict ChangeEvents are emitted by the runtime pipeline, not by sync-engine.
- **Conflict policy:** a newer, different value from a listed lower-authority source produces a
  Conflict by default (`recencyOverride: conflict`); configurable per rules file.
- **Tasks:** besides `submitted`, AI also may not set `completed`.
- **`admin` view** is interpreted as administrative context: university/faculty notices, source
  health, and items awaiting the user's confirmation.
- **SQLCipher** (§33): interface (`DatabaseCipher`) only.
- **AI providers** are thin fetch clients; no default model ids are baked in (`ai.model` required).
- **Seed data** lives in `@unicontext/connector-sdk` (`createShizuokaSeed`) on top of the fake
  connector; it is synthetic. Shizuoka period times in the profile are the commonly published
  timetable and should be verified.
- **Keychain test** is opt-in (`UNICONTEXT_TEST_KEYRING=1`) so CI does not touch the OS keychain.
