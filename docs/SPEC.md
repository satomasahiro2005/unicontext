# UniContext v1.0 仕様（原文の要約・全項目）

> UniContext is a local-first context layer for university life. It connects student portals, LMSs, Microsoft 365, discussion platforms, lecture transcripts, and local files, then exposes one unified academic context to AI agents.

MVP ではなく v1.0 の完成形を作る。§77 の全範囲が完成条件。

```
Sources → Source Adapters → Raw Store → Normalization → Canonical Model
        → (Search | Event Log | Task Engine) → Context Engine → (MCP | REST | CLI) → AI
```

## 1. 基本思想
LMS クライアントではない。分断された大学情報を「一人の学生の統一された大学生活コンテキスト」に変換する。canvas-mcp / edstem-cli 等の既存ツールは入力源として吸収する（敵にしない）。

## 2. 技術スタック
TypeScript + Node.js LTS / pnpm monorepo / SQLite（FTS5 で全文検索）/ Drizzle ORM / Fastify / Playwright / Web UI は React + Vite + TanStack Router（localhost、Electron にしない）。

## 3. Monorepo 構成
```
apps/{daemon,cli,web,mcp}
packages/{core,database,canonical-model,connector-sdk,adapter-mcp,adapter-cli,adapter-rest,auth,search,context-engine,task-engine,sync-engine,provenance,notifications}
connectors/{microsoft365,livecampusu,local-files,syllabus,chatgpt-record}
profiles/shizuoka-university
docs/ examples/ tests/
```
（Browser adapter も必要。packages/adapter-browser を追加してよい。）

## 4. Adapter と Connector の分離
Adapter = どう接続するか（MCP / CLI / HTTP-REST / Native API / Browser / Filesystem）。Connector = 何のサービスか（Canvas, LiveCampusU, EdStem, M365, Moodle, manaba, WebClass, OSIRIS, Brightspace …）。Canvas→MCP Adapter→canvas-mcp も、LiveCampusU→Native HTTP→内部 Web API も可能。

## 5. SourceAdapter interface
```ts
interface SourceAdapter {
  id: string; version: string;
  capabilities(): Promise<Capability[]>;
  authenticate(): Promise<AuthResult>;
  sync(input: SyncInput): Promise<SyncResult>;
  health(): Promise<HealthStatus>;
  dispose(): Promise<void>;
}
type Capability = "courses"|"enrollments"|"assignments"|"submissions"|"grades"|"announcements"|"messages"|"materials"|"calendar"|"timetable"|"rooms"|"exams"|"lectures"|"files";
```

## 6. Raw data layer
いきなり共通モデルに変換せず、必ず raw として保存（raw_sources / raw_items / raw_blobs）。raw_items: id, sourceId, sourceType, externalId, payloadJson, fetchedAt, sourceUpdatedAt, contentHash, deletedAt。Normalizer のバグ時に再取得なしで再処理できること。

## 7. Canonical Data Model
University, Campus, AcademicTerm, Person, Course, CourseOffering, Enrollment, Assignment, Submission, Exam, Announcement, Message, Thread, Material, Document, DocumentChunk, Lecture, LectureTranscript, LectureSegment, CalendarEvent, ClassSession, Location, Grade, Task, SourceReference, Fact, Conflict, ChangeEvent。

## 8. Course と CourseOffering は必ず分離（年度・担当・曜限が違う）。

## 9. Fact モデル
`{subject:"courseOffering:123", predicate:"room", value:"情報学部2号館21教室", origin:"authoritative", confidence:1.0, observedAt, validFrom, validUntil}`。矛盾する値（学務は A 教室、Teams は B 教室）を両方保持できる。

## 10. Provenance
全 Fact に SourceReference: sourceSystem, sourceItemId, url, retrievedAt, rawItemId, location?{page?, timestamp?, messageId?}。講義録音の 00:42:18 まで辿れる。

## 11. Origin
authoritative（外部システムが直接示す）/ user（本人入力）/ extracted（LLM 等で文章から抽出）/ inferred（複数情報から推論）。inferred が authoritative に勝手に昇格しない。

## 12. Conflict resolution
predicate 単位の authority ルール（YAML）。例: room: [academic-system, instructor-announcement, syllabus] / grade: [academic-system] / assignment_due: [submission-system, instructor-announcement, syllabus]。日時も加味（学務 9/1 より Teams 教員投稿 10/2 が新しい変更の可能性）。解決不能なら Conflict を生成し、AI へ「競合している」とそのまま渡す。

## 13. Event sourcing
ChangeEvent {entityId, type, before, after, source, occurredAt, observedAt}。「昨日から何が変わった？」に正確に答える。

## 14. Identity Resolution
LCU「データベースシステム論」/ Teams「2026 DB Systems」/ EdStem「DBSys」/ ローカル DB/ を同一 CourseOffering に。course code, title similarity, teacher, term, schedule, user confirmation を組み合わせ、確定 mapping は identity_links に保存。LLM を毎回呼ばない。

## 15. Search
Structured (SQLite) / Lexical (FTS5) / Semantic (Embeddings)。router が質問を分類（「明日締切」→structured、「ERモデルの説明どこ？」→FTS+semantic、「先生は試験について何て言った？」→transcript search）。

## 16. Embedding は任意依存。provider abstraction（none / OpenAI / local / Ollama / Voyage）。デフォルトは FTS5 だけで動く。

## 17. Context Engine
AI が DB を直接漁らず、目的別 bundle を生成。getTodayContext() → {classes, changes, deadlines, tasks, importantAnnouncements, preparation, conflicts}。

## 18. Built-in Context Views
today, tomorrow, week, course, deadline, changes, class-preparation, class-review, exam-preparation, admin。MCP resource（context://today 等）としても公開。

## 19. Task Engine
Task {id, title, courseOfferingId?, sourceFactIds[], dueAt?, status, createdBy}。status: pending/in_progress/submitted/completed/cancelled/unknown。**AI が勝手に submitted にしない**。提出システムで確認できたときだけ自動更新。

## 20. 自然言語の締切抽出
「来週まで」「次回まで」「金曜日中」「10月15日23時59分まで」→ origin=extracted、根拠文を保持。

## 21. Lecture model
Lecture に calendar session, slides, transcript, recording, professor announcements, questions, extracted facts を束ねる（例: 2026-10-01 DBシステム論）。

## 22. ChatGPT Record
公開 API を前提にしない。manual import / filesystem watch / export import を正式経路。内部は TranscriptImporter として一般化（Zoom transcript 等も同じ入口）。

## 23. Local files
~/University/ 等を watch。hash, mtime, size で差分判定。PDF, PPTX, DOCX, TXT, Markdown, HTML, source code, image metadata。

## 24. Microsoft 365
Graph API 第一選択。Teams, Outlook, Calendar, OneDrive, SharePoint。可能な resource で delta query。可能なら change notification 併用（notification → delta sync）。

## 25. Microsoft 認証
Native app として Authorization Code + PKCE、外部ブラウザで Entra ID ログイン（RFC 8252）。

## 26. LiveCampusU / LCU-Web
first-class connector（connectors/livecampusu）。product logic / deployment profile / authentication strategy を分離。auth: entra / saml / local。profiles/shizuoka。静大固有 endpoint を core に直書きしない。

## 27. Unofficial API policy
非公開 API connector は許可。ガイドライン: 自分に認可されたデータのみ / 過剰 request をしない / 認証回避をしない / 他人のデータを取らない / vendor code をコピーしない。metadata に {apiStability:"unofficial", risk:"unsupported", testedVersion}。

## 28. External MCP adapter
`sources.canvas: {adapter: mcp, command: npx, args: [canvas-mcp]}`。tool discovery → external schema → mapping → canonical model。

## 29. External CLI adapter
`{adapter: cli, command: example-cli}`。JSON 出力があれば直接 normalize。

## 30. REST adapter
OpenAPI があるサービス用 RESTSourceAdapter。OpenAPI から tool 候補を自動生成してよい。

## 31. Browser adapter
最後の逃げ道。Playwright で既存認証済みセッションを使う。ログイン自動入力より「人間がログイン → session persistence」を優先。

## 32. Credential storage
トークン・cookie を DB に平文保存しない。macOS Keychain / Windows Credential Manager / Linux Secret Service。

## 33. DB 暗号化
デフォルトは非暗号化（秘密は Keychain、ディスク暗号化に任せる）。optional で SQLCipher backend を差せる設計。

## 34. Daemon
unicontextd。macOS は launchd 登録可。sync, filesystem watch, change detection, notification, MCP server, REST server。

## 35. Sync Engine
connector ごとに initial / incremental / full refresh。状態: sync_cursor, etag, delta_token, last_modified 等。

## 36. Sync schedule
例: Graph push+delta / LCU-Web 15分 / EdStem 5分 / Local files fs event / Syllabus daily。設定可能。

## 37. Rate limiting
connector SDK に共通 RateLimiter: token bucket, retry-after, exponential backoff, jitter。

## 38. Connector health
healthy / degraded / auth_required / rate_limited / offline / failed。Web UI に一覧表示。

## 39. MCP interface
UniContext 自身が MCP server。高レベル tool 中心: get_today, get_week, get_course, get_assignments, get_deadlines, get_recent_changes, prepare_for_class, review_class, search, get_source, get_conflicts。

## 40. MCP resources
unicontext://today, unicontext://week, unicontext://course/{id}, unicontext://lecture/{id}, unicontext://document/{id}。

## 41. REST API
localhost 限定。GET /api/v1/today, /courses, /assignments, /changes, /search。write endpoint は CSRF / auth token 必須。

## 42. CLI
status, sync, login microsoft365, login livecampusu, today, week, courses, assignments, deadlines, changes, search "正規化", doctor（doctor は重要）。

## 43. Web UI 画面
Today, Courses, Assignments, Calendar, Changes, Search, Sources, Conflicts, Settings。

## 44. Today 画面（最重要）
今日の授業 / 重要な変更 / 締切 / 未提出 / 授業準備 / 大学からのお知らせ。

## 45. Changes 画面
Yesterday → Today の差分だけ（例: 課題1 deadline 10/08→10/10、Lecture 3.pdf added、Room changed）。

## 46. Notification Engine
対象: room change, cancelled class, new assignment, deadline changed, deadline approaching, exam announced, important announcement, auth expired, sync failure。priority: critical / high / normal / low。

## 47. AI extraction layer
provider pluggable（OpenAI / Anthropic / local / none）。用途は deadline extraction, course matching, announcement classification, task extraction, lecture topic extraction だけ。AI なしでも基本機能は動く。

## 48. AI never owns truth
LLM ≠ database。LLM 生成情報は extracted / inferred としてしか保存できない。

## 49. Auditability
AI の結論から必ず source（例: Teams message 3812, 2026-10-01 14:23）へ戻れる。

## 50. Read-only default
書き込みは propose → confirm → execute 必須。

## 51. Dangerous operations
履修登録・削除、課題提出、成績に関わる操作は high-risk write。自動実行禁止。

## 52. File layout
~/.local/share/unicontext/{unicontext.db, raw/, blobs/, cache/, logs/}。macOS は Application Support（Windows は %LOCALAPPDATA% 等）へ mapping 可。

## 53. Config
~/.config/unicontext/config.yaml
```yaml
profile: shizuoka-university
sources:
  microsoft365: { enabled: true }
  livecampusu: { enabled: true }
  edstem: { adapter: mcp }
  files: { roots: [~/University] }
sync: { background: true }
```

## 54. University profile
profiles/shizuoka-university は設定だけ:
```yaml
id: shizuoka-university
academicCalendar: { timezone: Asia/Tokyo }
sources:
  academic: { product: livecampusu }
  collaboration: { product: microsoft365 }
  discussion: { product: edstem }
```
コードは製品 connector 側に置く。

## 55. Connector package metadata
`{name:"@unicontext/livecampusu", product:"LiveCampusU", license:"MIT", capabilities:[...], apiStability:"unofficial"}`

## 56–58. ライセンス
Core と公式 connector は MIT。第三者 connector は作者のライセンスを許容。GPL 等は別 process（MCP / HTTP / CLI）で接続し本体に vendor しない。THIRD_PARTY_NOTICES.md, SECURITY.md, CONTRIBUTING.md, CONNECTOR_POLICY.md を置く。

## 59. Security policy
UniContext / connector / 第三者サービスの脆弱性を区別。大学サービスで見つけた脆弱性を GitHub Issue に公開しないよう明示。

## 60. Logging
access token, cookie, password, authorization header, student ID を出さない。structured logging 時に redaction。

## 61. Telemetry
OFF by default。crash report も opt-in。

## 62. Backup
`unicontext backup` で DB, metadata, mappings を export。秘密は含めない。

## 63. Data deletion
`unicontext purge source edstem` で source 単位削除。

## 64–66. Tests
unit / connector fixture / normalizer / migration / integration / MCP contract / browser。CI から実大学にアクセスしない。sanitize 済み fixture（fixtures/livecampusu/ 等）。`testConnectorCompliance(adapter)` の共通 contract test suite。

## 67. Migrations は version 管理（001_initial, 002_fact_model, 003_change_events …）。

## 68. Canonical Data Model を JSONL で import/export。

## 69. 将来の connector registry（`unicontext connector install @unicontext/moodle`）を見越した構造。

## 70–71. パッケージ @unicontext/core, @unicontext/mcp, @unicontext/microsoft365, @unicontext/livecampusu …。Core は SemVer、connector は独立 version。

## 72. 非公開 API connector は detected product version を保存。未知 version は degraded として警告。

## 73. Schema drift detection
API response の unknown field / missing field を記録。黙って壊れない。

## 74. Human correction
AI の course mapping や締切抽出をユーザーが修正でき、user fact として保存。

## 75. Explainability
回答例:「明日の2限はDBシステム論です。教室は21教室です。根拠: 学務情報システム 10/1 09:42取得」。AI に根拠を渡す前提。

## 76. Reference deployment
静岡大学: LiveCampusU, Microsoft 365, EdStem, Local Files, ChatGPT Record, Syllabus。

## 77. v1.0 完成条件
Core, Canonical model, SQLite, FTS, Sync engine, Event history, Provenance, Conflict resolver, Task engine, Context engine / MCP, CLI, Web UI / MCP adapter, CLI adapter, REST adapter, Browser adapter / Microsoft 365, LiveCampusU, Local Files, Syllabus connectors, Transcript importer / Shizuoka University profile / Notifications, Auth, Keychain, Testing, Docs。

## 78. 実装順序（依存順）
Canonical Model → Database → Connector SDK → Raw ingestion → Normalizer → Sync engine → Microsoft / LCU / Files connectors → Identity resolution → Search → Fact / Conflict / Provenance → Task engine → Context engine → MCP / REST / CLI → Web UI → Notifications → External MCP adapter → Hardening / Tests。

## 80. 最重要点
「LMS を AI につなぐ」ではなく「一人の学生の大学生活という entity を複数システムから再構成する」。大学ごとの違いは「製品 connector + deployment profile」に分解する。
