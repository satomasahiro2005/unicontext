# ChatGPT Plugins and Scheduled Tasks for UniContext (as of 2026-10-05)

Method: fetched the Markdown twins of developers.openai.com and learn.chatgpt.com pages with curl,
the help.openai.com articles as HTML (they answered 200 this time), and the `openai/plugins`
GitHub repo via `gh api`. Page dates: help articles show "Updated: N days ago" relative to
2026-10-05; developer docs carry no dates (screenshots in the submission page are named
`...-20260927.webp`). Claims from community posts or third-party blogs are marked
**[community]**. Follow-up to [chatgpt-connector.md](chatgpt-connector.md) (2026-10-01).

## 1. What a plugin is now

- ChatGPT replaced the App Directory with the **Plugin Directory** when ChatGPT Work launched;
  "existing app connections are unaffected". A plugin packages **skills**, **apps** (MCP
  servers / connectors), app templates, and optionally lifecycle hooks and UI extensions.
  ChatGPT and Codex share one directory.
  [Release notes](https://help.openai.com/en/articles/6825453-chatgpt-rate-limits) ·
  [Plugin architecture](https://developers.openai.com/plugins/concepts/plugins) ·
  [Plugins in ChatGPT (help, updated 2026-10-04)](https://help.openai.com/en/articles/20001256)
- An **app** connects to a service; a **plugin** bundles apps and skills for a workflow.
  "ChatGPT automatically uses your installed plugins when they're relevant to your request",
  or the user picks one with `@`. (help 20001256)
- Custom GPTs are being retired with a migration path to plugins (release notes, 2026-09-11).

## 2. Package format

Source: [Package your plugin](https://developers.openai.com/plugins/build/plugins) and
[Upload and submit](https://developers.openai.com/plugins/deploy/submission) (field
reference under "Automatically provide submission and review information").

- **Portable "Agent Plugins" layout (recommended for new packages)**: root `plugin.json` with
  `"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"`, `name`
  (kebab-case, ≤64), `version`, `description` (≤4000), optional `author`, `homepage`,
  `repository`, `license`, `keywords`. Skills are discovered from `skills/<name>/SKILL.md`;
  MCP servers from root `mcp.json`
  (`"$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"`,
  `mcpServers.<id> = { "type": "streamable-http", "url": "https://…" }`).
- **OpenAI-specific metadata** goes in `extensions.com.openai`: `interface` (listing),
  `onboardingSkill`, `review` (5 positive + 3 negative test cases, demo video; only for public
  review), `publication` (`countries`, `release_notes`, `translations.<locale>.subtitle/description`),
  `apps` (path to `.app.json`), `hooks`. If this object exists, `.codex-plugin/plugin.json` is
  ignored (not merged).
- **Codex compatibility layout** (what `@plugin-creator` still scaffolds): `.codex-plugin/plugin.json`
  with `interface` at the root, `skills: "./skills/"`, `mcpServers: "./.mcp.json"`,
  `apps: "./.app.json"`. OpenAI's own published plugins use this, e.g. Notion:
  `.mcp.json` = `{"mcpServers":{"notion":{"type":"http","url":"https://mcp.notion.com/mcp","oauth_resource":"https://mcp.notion.com"}}}`
  and `.app.json` = `{"apps":{"figma":{"id":"connector_68df…"}}}`
  ([openai/plugins](https://github.com/openai/plugins/tree/main/plugins/notion), last commit
  2026-09-28).
- **`.app.json`** maps the plugin to an MCP app already registered in ChatGPT (developer-mode
  apps have IDs starting `plugin_asdk_app`, copied from the browser URL). Public ZIP submission
  **rejects** `.app.json`/`apps` and hooks: "Declare MCP server URLs in your MCP configuration
  and complete setup in the dashboard."
- **Listing fields** (`interface`, limits for public submission): `displayName` ≤30,
  `shortDescription` ≤30, `longDescription` ≤4000, `developerName` ≤80 (required; for public
  listings the directory name comes from the verified developer identity), `category` (e.g.
  Productivity), `capabilities` (≤20 labels), `websiteURL`, `supportURL`, `privacyPolicyURL`,
  `termsOfServiceURL` (all four required only for public MCP review), `defaultPrompt` (≤3,
  ≤128 chars), `brandColor`/`brandColorDark` (#RRGGBB, ≥2:1 contrast against white / #212121),
  `composerIcon`, `logo` (+ `…Dark`), `screenshots` (only when the plugin has UI).
- **Icons**: PNG, JPEG, WebP or SVG, ≤5 MiB, square, ≥48×48; SVG needs a square `viewBox`.
  Paths start with `./`, stay inside the plugin root, preferably under `assets/`.
- **Skills**: `SKILL.md` with YAML front matter `name` + `description`. "The model first sees
  skill metadata… It loads the complete instructions when the user's request matches the skill
  or the user invokes it directly." Skills can declare MCP dependencies in
  `agents/openai.yaml`; skills can also be imported from the MCP server
  (`io.modelcontextprotocol/skills`) as a snapshot at submission time.
  [Build skills](https://developers.openai.com/plugins/build/skills) ·
  [Skills](https://developers.openai.com/plugins/concepts/skills)
- **MCP server `instructions`**: "ChatGPT and Codex use these instructions alongside tool
  metadata… Keep the most important details in the first 512 characters." Refresh in
  developer mode pulls "new tools, descriptions, and server instructions".
  [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server) ·
  [Developer mode](https://developers.openai.com/api/docs/guides/developer-mode)

## 3. Ways to install (create vs upload)

| Route | Who | Notes |
| --- | --- | --- |
| Developer-mode MCP app: Plugins → **+** (after Settings → Security and login → Developer mode) | Plus, Pro, Business, Enterprise, Edu on the web | Creates a personal app/plugin under Personal/Drafts. Quickstart: open [your personal plugins](https://chatgpt.com/plugins?view=personal), install it, use it with `@` (the quickstart uses Work). [Quickstart](https://developers.openai.com/plugins/quickstart) |
| **Plugin Creator** (`@plugin-creator` in Chat or Work) | any plan where plugin creation is enabled | Wraps an existing `plugin_asdk_app…` ID plus skills into a plugin; "Local plugins install automatically". Edit later via Plugins → plugin → **Edit Plugin**. [Build plugins](https://learn.chatgpt.com/docs/build-plugins) · help 20001256 |
| **Upload plugin** (ZIP) in ChatGPT | help: workspace owners/admins via Admin Console → Plugins → Add → Upload plugin | **[community]** personal Plus/Pro accounts see "Create plugin" / "Upload plugin" in the Plugins **+** menu ([forum, 2026-09](https://community.openai.com/t/create-mcp-app-missing-from-plugins-menu-on-personal-chatgpt-accounts/1401436)). Not documented for personal accounts. |
| Local marketplace (`~/.agents/plugins/marketplace.json`, `source.path` → plugin folder) | ChatGPT desktop app / Codex | Restart the desktop app; installs into `~/.codex/plugins/cache/…/local/`. Desktop-only for local sources. |
| Public directory | [platform.openai.com/plugins](https://platform.openai.com/plugins): **Create plugin → With MCP**, ZIP upload, domain verification (`/.well-known/openai-apps-challenge`), identity verification, review | Not needed for personal use. One MCP server per plugin; after publication OpenAI rescans the server daily. |

Caveats found:

- help 20001256 FAQ: "Personal Skills are generally available to ChatGPT Business, Enterprise,
  Healthcare, and Edu users." Whether a plugin's bundled skills load in **Chat** on a personal
  Plus account is not stated. Skills are documented for Work and Codex. Put the important rules
  in ChatGPT's custom instructions and in the MCP server `instructions` as well.
- "If you plan to use it in both Chat and Work, test it in each. Available tools and apps can
  differ." (Build plugins)

## 4. Developer mode and write actions

- developers.openai.com (undated): developer mode is "available to Pro, Plus, Business,
  Enterprise, and Education accounts on the web" with "full MCP client support for all tools,
  both read and write". "Write actions by default require confirmation"; the user can remember
  approve/deny per tool **for that conversation only**; tools without `readOnlyHint` are
  treated as writes. [Developer mode](https://developers.openai.com/api/docs/guides/developer-mode)
- help.openai.com (updated 2026-10-04) **contradicts** this: "Full MCP … including
  modify/write actions, is rolling out in beta to ChatGPT Business, Enterprise, and Edu" and
  "Full MCP is only available to Business and Enterprise/Edu users, currently. Pro users can
  connect MCPs with read/fetch permissions in developer mode." It also says MCP apps are
  "web only" (not mobile), "Agent mode will not use custom apps", and deep research uses them
  read-only. [Developer mode and MCP apps](https://help.openai.com/en/articles/12584461)
  **Unresolved: verify on the student's account whether `ingest_lecture`/`add_*` are offered.**
- Same article: issue refresh tokens / advertise `offline_access`; otherwise "ChatGPT may lose
  access after the original authorization expires". UniContext already advertises
  `offline_access` and issues 30-day rotating refresh tokens ([../remote.md](../remote.md)).
- Health release note (2026-09-14) shows a global per-user plugin permission default "Allow
  low-risk actions" (Settings → Plugins). Whether it applies to developer-mode apps is not
  stated.

## 5. Scheduled tasks

Primary: [Scheduled tasks in ChatGPT (help, updated 2026-10-02)](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt),
[Scheduled tasks (learn.chatgpt.com)](https://learn.chatgpt.com/docs/automations),
[Notifications](https://learn.chatgpt.com/docs/notifications).

- **Limits**: active tasks "3 for Free and Go, **5 for Plus**, 10 for Business and Edu, and 15
  for Pro and Enterprise". "Eligible paid plans support recurring tasks **up to once per
  hour** and exact delivery times." Free: once a day, flexible windows. Not supported in voice
  chats or GPTs.
- **Pausing**: "Inactive tasks may pause automatically"; a task pauses if it "requires
  additional action" or its chat is deleted. "Actions that require approval may pause the
  task." "An action that sends a message or changes external data may require approval. If
  approval is required, the task pauses until you review it." ⇒ scheduled prompts must call
  read-only tools only.
- **Using plugins / apps**: "Scheduled tasks on the web can use uploaded files, connected tools,
  skills, and plugins available to that chat." "Scheduled tasks created with ChatGPT Work on
  the web … can use plugins. Scheduled tasks can also use skills… Select or invoke a specific
  skill in the task prompt when the workflow shouldn't rely on automatic tool selection."
  The help FAQ only names "supported apps, including Gmail, Slack, and GitHub". **Nothing
  official says a developer-mode custom MCP app works in an unattended run.**
  **[community]** a developer-mode MCP "can succeed on the first scheduled run while later runs
  lose access" and long chats hit "FORBIDDEN: This conversation does not support developer
  MCPs" ([HF forum, 2026-09-10..16](https://discuss.huggingface.co/t/chatgpt-developer-mcp-works-initially-then-becomes-unavailable-in-long-running-conversation/180207));
  for stale OAuth: disconnect, reconnect, test in a new chat, recreate the task
  ([usecarly, 2026-08-10, unsourced](https://www.usecarly.com/blog/chatgpt-scheduled-task-connector-unavailable/)).
- **Standalone vs in-chat**: standalone tasks start a new chat per run from the saved prompt;
  tasks inside a chat return to that chat with its context and "can use minute-based
  intervals… or daily and weekly schedules". Make the prompt durable: "what ChatGPT should do
  on each scheduled run, how to decide whether there is anything important to report, and when
  to stop".
- **Monitoring / staying quiet**: "Monitoring tasks check for changes and send a notification
  when a relevant update occurs. They can use information from previous runs" (help FAQ).
  OpenAI's launch statement (June 2026): "Monitoring tasks can search the web and check
  connected apps for changes and notify users only when there is something worth reporting"
  (quoted by [9to5Mac, 2026-06-17](https://9to5mac.com/2026/06/17/openai-launches-scheduled-tasks-in-chatgpt-details-here/)).
  There is **no documented flag or output format** that suppresses a push; whether a plain
  scheduled task that answers 「通知なし」 still pushes is **unverified**. Design for it in the
  prompt and verify on the device.
- **Notifications**: Settings → Notifications → Push, Email, or both (SMS on some accounts).
  Browser notifications need permission; "To receive mobile push notifications, create a task
  in a supported ChatGPT mobile app. Grant notification permission when prompted." Desktop app
  has an Activity view; **Scheduled** acts as an inbox.
- **Event-triggered tasks** (Work, Plus and up; Gmail / Slack / GitHub only; ≤30 runs/hour,
  ≤720/day) and **MCP Events** (plugins whose MCP 2.0 server implements `events/subscribe` with
  webhook delivery; Work chats and dots) exist
  ([MCP Events](https://developers.openai.com/plugins/build/mcp-events)). Both mean the server
  pushes into ChatGPT, which the project decided against: UniContext must not start ChatGPT.
- Model note: GPT-5.5 retires from ChatGPT on 2026-10-14; tasks pinned to it must be switched
  (learn.chatgpt.com automations).

## 6. Consequences for UniContext

1. Package as a portable plugin (`plugin.json` + `mcp.json` + `skills/` + `assets/`), and
   for personal installs map it to the existing developer-mode app with `.app.json` (or let
   Plugin Creator do that). Done in `integrations/chatgpt/`.
2. Behaviour rules live in three places because no single one is guaranteed to load in Chat:
   plugin skills, ChatGPT custom instructions, and the MCP server `instructions` (first 512
   characters).
3. With 5 tasks on Plus and an hourly floor, use two tasks: an hourly watcher and a 07:30
   morning task, both read-only, both answering 「通知なし」 when nothing needs action.
4. Before relying on it: verify on the student's account that (a) write tools are offered,
   (b) a scheduled run can call UniContext a day later (refresh token path), (c) 「通知なし」
   runs do not push. If (b) or (c) fails, move notifications to Discord/LINE/ntfy (step 5).
