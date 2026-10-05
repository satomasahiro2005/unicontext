# UniContext as a ChatGPT plugin, with scheduled checks

Goal: ChatGPT looks after a student who never checks anything. It checks UniContext without
being asked, puts what is urgent first, saves lecture transcripts, and twice a day or more
it checks on its own and sends a push notification only when something needs action.
UniContext never starts ChatGPT; ChatGPT's scheduled tasks call UniContext.

Background and sources: [research/chatgpt-plugin-tasks.md](research/chatgpt-plugin-tasks.md)
(2026-10-05). The remote MCP endpoint itself is set up in [remote.md](remote.md).

```
integrations/chatgpt/
├── plugin/unicontext/          the plugin package (ZIP root)
│   ├── plugin.json             Agent Plugins manifest + extensions.com.openai listing
│   ├── mcp.json                MCP server: streamable-http https://uc.nemut.ai
│   ├── skills/
│   │   ├── student-support/    always-on behaviour (check without asking, urgent first, …)
│   │   ├── lecture-ingest/     save a lecture recording/transcript without being asked
│   │   └── student-briefing/   what a scheduled run does and when it stays silent
│   └── assets/                 logo.png (512), icon.svg, icon-dark.svg (from assets/brand)
├── tasks/
│   ├── watcher.ja.txt          hourly 学生生活ウォッチャー prompt
│   └── morning.ja.txt          07:30 起きたらやること prompt
├── custom-instructions.ja.txt  the same rules for ChatGPT's custom instructions (≤1500 chars)
└── scripts/plugin.mjs          check / pack (no dependencies)
```

## 0. Prerequisites

- UniContext remote access works: `https://uc.nemut.ai` answers, and you can connect from
  ChatGPT with your passphrase ([remote.md §1–3](remote.md#1-configure-unicontext)).
- ChatGPT Plus or Pro (Business/Enterprise/Edu need an admin to allow developer mode and
  plugin creation). On the web: Settings → Security and login → **Developer mode** on.

## 1. Build the package

```
node integrations/chatgpt/scripts/plugin.mjs check
node integrations/chatgpt/scripts/plugin.mjs pack
```

`pack` writes `integrations/chatgpt/dist/unicontext-<version>.zip` (the ZIP root is the plugin
root). To map the plugin to the UniContext app you already created in developer mode, copy its
ID from the browser URL on chatgpt.com/plugins (it starts with `plugin_asdk_app`) and pack with
it; this adds `.app.json` and `"apps": "./.app.json"`:

```
node integrations/chatgpt/scripts/plugin.mjs pack --app-id plugin_asdk_app_xxxxxxxx
```

Keep the plain ZIP (without `.app.json`) for anything public: public submission rejects
`.app.json`.

## 2. Install the plugin

Pick the first route your account offers. All of them need the UniContext MCP app connected
once (OAuth with your passphrase).

1. **Connect the MCP app** (skip if done): chatgpt.com/plugins → **+** → MCP server URL
   `https://uc.nemut.ai`, authentication OAuth, client ID/secret empty → on
   `uc.nemut.ai/authorize` keep
   「締切・やること・メモ・講義の記録をUniContextに登録することも許可する」 ticked (this is the
   `unicontext.write` scope; see
   [remote.md](remote.md#re-authorizing-an-existing-chatgpt-connection-to-get-the-write-scope)
   to add it to an older read-only connection), type the passphrase, **許可**.
   If ChatGPT refuses the bare host, use `https://uc.nemut.ai/mcp`.
2. **Add the skills to it**, either:
   - **Upload plugin** (if the Plugins **+** menu shows it): upload the ZIP built with
     `--app-id`. Then open Plugins → Personal → UniContext → install.
   - **Plugin Creator** (always available where plugin creation is on): start a chat, type
     `@Plugin Creator`, attach the ZIP (or the three `SKILL.md` files) and send:
     「plugin_asdk_app_xxxxxxxx のMCPアプリを使う UniContext というプラグインを作って。添付の
     skills（student-support・lecture-ingest・student-briefing）をそのまま入れて、名前・説明・
     アイコンは添付の plugin.json と assets を使って。」 Review the result and install it.
   - **ChatGPT desktop app**: copy `plugin/unicontext` to `~/.codex/plugins/unicontext`, add
     an entry to `~/.agents/plugins/marketplace.json`
     (`{"name":"personal","plugins":[{"name":"unicontext","source":{"source":"local","path":"./.codex/plugins/unicontext"},"policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"},"category":"Productivity"}]}`),
     restart the app, install from the Plugins directory. Local sources work in the desktop app
     only.
3. **Custom instructions** (do this regardless of route): Settings → Personalization →
   Custom instructions → paste `integrations/chatgpt/custom-instructions.ja.txt`. Skills are
   loaded only when a request matches them, and personal skills in Chat are not documented for
   Plus, so this is what makes the 「関係ない会話でも重大なことを1行」 rule reliable.

After a UniContext update that changes tools: Plugins → UniContext → **Refresh**, then a new
chat. After changing skills: rebuild the ZIP and upload it again, or ask Plugin Creator via
**Edit Plugin**.

## 3. Create the scheduled tasks

Plus allows 5 active tasks with an hourly minimum, so UniContext uses two. Create them in
**Work** on the web (documented to use plugins in scheduled runs), or in the mobile app if you
want phone pushes (the help center says mobile push needs the task to be created in a supported
mobile app, with notification permission granted). Settings → Notifications → tasks: **Push**
on (email optional).

For each task: start a new Work chat, select UniContext with `@`, and send:

| Task                 | What to send                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 学生生活ウォッチャー | 「次の内容を毎時（毎時0分）に実行する定期タスクを作って。毎回新しいチャットで実行して。」 + the full text of `tasks/watcher.ja.txt` |
| 起きたらやること     | 「次の内容を毎日7:30に実行する定期タスクを作って。毎回新しいチャットで実行して。」 + the full text of `tasks/morning.ja.txt`        |

Open **Scheduled** and check each task's schedule, time zone (Asia/Tokyo) and that the prompt
was kept in full. If the task's model is GPT-5.5, switch it (GPT-5.5 leaves ChatGPT on
2026-10-14).

Both prompts:

- call `get_attention_required` / `get_student_state` first, fall back to `get_briefing` and
  then to `get_today` / `get_deadlines` / `get_recent_changes` / `get_tasks`, so they work
  before and after the new tools land;
- use read-only tools only (a write waits for approval and pauses the task);
- answer exactly 「通知なし」 when nothing needs action, and at most 4 (watcher) or 6
  (morning) short lines otherwise;
- do not repeat an item already notified unless it became more urgent;
- the watcher stays quiet 0:00–6:59 except for a deadline within 3 hours or a same-day
  休講/教室変更.

## 4. Verify

1. In a new chat: 「今日何する？」 → UniContext tools are called without a question, the answer
   is an ordered action list with sources.
2. In an unrelated chat (e.g. 「Swiftで配列をソートするには？」) on a day with an unsubmitted
   deadline within 48 hours → one 【至急】 line first, then the normal answer.
3. Paste a short lecture transcript → `ingest_lecture` (or `record_lecture` + `add_*`) is
   called without 「保存しますか？」; ChatGPT's own confirmation dialog may appear. If no write
   tool is offered at all, the account has read-only MCP (see the research notes, §4).
4. Scheduled → each task → **Run now** (or wait one run). Check the run's tool calls: the
   UniContext tool was called and returned data (not an auth error).
5. Silence: on a quiet hour the watcher must answer 「通知なし」. Check whether that run still
   produced a push on the phone. Record the result here.
6. Next day: confirm the 07:30 run happened and could still reach UniContext (access tokens
   last 1 hour; the run must refresh with the 30-day refresh token). `unicontext remote
clients` shows the ChatGPT client's last use; `logs/remote-audit.jsonl` shows `refresh`
   events and the tool calls.

## 5. If ChatGPT notifications are not good enough

Signs: runs that answer 「通知なし」 still push; runs pause ("inactive", approval pending) or
lose the developer-mode app after the first run; pushes arrive late or not at all on the phone.

Then:

1. Keep the plugin and the skills (the in-chat behaviour does not depend on tasks).
2. Pause the watcher task (keep the morning task if it works).
3. Move push delivery to UniContext's own notifier (Discord / LINE / ntfy), the project's step 5. That runs on this PC from the same attention data and needs no ChatGPT run at all.

## MCP server instructions (for `apps/mcp` maintainers)

ChatGPT reads the MCP `instructions` field alongside tool metadata and refreshes it with the
app ("keep the most important details in the first 512 characters"). Suggested first
paragraph, so the rules hold even when no skill is loaded:

> UniContext is the student's university data. The student never checks anything themselves:
> call the tools without asking 「確認しますか？」. For 「今日何する？」 call get_next_action /
> get_student_state. In unrelated chats, call get_attention_required once and, if something is
> serious today, put one line first. On a lecture transcript call ingest_lecture unasked. Cite
> sources, show both values on conflicts, never infer deadlines, report coverage gaps.
