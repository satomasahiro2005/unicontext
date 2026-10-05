# UniContext as a ChatGPT plugin, with scheduled checks

Goal: ChatGPT looks after a student who never checks anything. It checks UniContext without
being asked, puts what is urgent first, saves lecture transcripts, and twice a day or more
it checks on its own and sends a push notification only when something needs action.
UniContext never starts ChatGPT; ChatGPT's scheduled tasks call UniContext.
When ChatGPT's Google Calendar and Gmail connectors are available the tasks read those too,
read-only (see §3.1).

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
│   ├── morning.ja.txt          07:30 今日の生活ブリーフ
│   ├── watcher.ja.txt          hourly 今やることウォッチ
│   ├── evening.ja.txt          20:00 明日の生活準備
│   └── weekly.ja.txt           Sunday 21:00 週間レビュー
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
   Plus, so this is what makes the behaviour rules reliable. Ordinary chats use UniContext only when
   the student talks about university life; proactive alerts come from the scheduled tasks.

After a UniContext update that changes tools: Plugins → UniContext → **Refresh**, then a new
chat. After changing skills: rebuild the ZIP and upload it again, or ask Plugin Creator via
**Edit Plugin**.

## 3. Create the scheduled tasks

The tasks look after the student's whole life, not only university: ChatGPT is the
orchestrator and UniContext is one source next to Google Calendar, Gmail, ChatGPT's own memory
of what the student decided, and (when it matters) the web for weather and transport.
UniContext's instructions stay out of unrelated chats; being proactive is the tasks' job.

Tasks are split by moment of the day, not by source. Plus allows 5 active tasks with an hourly
minimum; these use four. Create them in **Work** on the web (documented to use plugins in
scheduled runs), or in the mobile app if you want phone pushes (the help center says mobile push
needs the task to be created in a supported mobile app, with notification permission granted).
Settings → Notifications → tasks: **Push** on (email optional).

For each task: start a new Work chat, select UniContext with `@`, and send the line below plus
the full text of the file:

| Task               | Schedule      | What to send                                                                      |
| ------------------ | ------------- | --------------------------------------------------------------------------------- |
| 今日の生活ブリーフ | daily 07:30   | 「次の内容を毎日7:30に実行する定期タスクを作って。」 + `tasks/morning.ja.txt`     |
| 今やることウォッチ | hourly        | 「次の内容を毎時0分に実行する定期タスクを作って。」 + `tasks/watcher.ja.txt`      |
| 明日の生活準備     | daily 20:00   | 「次の内容を毎日20:00に実行する定期タスクを作って。」 + `tasks/evening.ja.txt`    |
| 週間レビュー       | Sundays 21:00 | 「次の内容を毎週日曜21:00に実行する定期タスクを作って。」 + `tasks/weekly.ja.txt` |

If you already created the older university-only tasks, edit them in **Scheduled** and replace
their prompts (大学生活 朝ブリーフ → 今日の生活ブリーフ, 重要変更ウォッチ → 今やることウォッチ,
明日の準備 → 明日の生活準備), then add 週間レビュー. Check each task's schedule, time zone
(Asia/Tokyo) and that the prompt was kept in full. If the task's model is GPT-5.5, switch it
(GPT-5.5 leaves ChatGPT on 2026-10-14).

All four prompts:

- are read-only everywhere: no UniContext write tools (a write waits for approval and pauses the
  task), and Gmail / Calendar are only read, never marked read, answered, changed, or stored in
  UniContext (see §3.1);
- use UniContext's effectiveSchedule (the student's group, dropped courses) and never invent
  deadlines; on conflicts they show both values with sources; they tell 「情報がない」 from
  「取得できていない」.

Per task:

- **今日の生活ブリーフ** merges classes, appointments, mail and the student's own plans into one
  time-ordered flow for the day (例: 10:20 DB → 資料確認 → 14:00 面談 → 23:59 課題 → 帰りに買い物),
  one immediate action on the first line, then 「まず今やること」 / 「時間が決まっている今日の予定」 /
  「今日中に終えること」 / 「近いうちに注意すること」; 「通知なし」 only on a day with nothing at all.
- **今やることウォッチ** judges not only new information but known items that became urgent with
  time (a 23:59 assignment still open at 22:00), always checks unfinished same-day deadlines in
  the 23:00 run, stays quiet 0:00-7:59 except for deadlines within 3 hours and same-day
  休講/教室変更, merges one event seen in several sources, re-notifies only on escalation or a new
  stage, and outputs nothing at all when nothing would hurt by waiting.
- **明日の生活準備** closes the day: unfinished same-day deadlines first, then what to do tonight,
  then tomorrow's flow (classes, part-time work, interviews, what to bring, when to leave).
- **週間レビュー** finds next week's risky days (deadlines piling up, no free time, an exam with
  another deadline the day before) and assigns big work to free slots.

### 3.1 Gmail and Google Calendar (read-only)

In the same Work chat, connect Gmail and Google Calendar in ChatGPT (its app/connector
settings) if you want them used. The prompts and the `student-briefing` skill use them when
available and say 「取得できていない」 for a source that is not connected.

- **Strictly read-only.** Never mark mail as read, reply, send, draft, label, archive or
  trash; never create or change a calendar event.
- **Nothing is stored.** What is found in mail or calendar is only shown in that run's answer.
  No `add_note` / `add_deadline` / `add_task` from it: that is out of scope until a future
  `ingest_external_signal` (see [ARCHITECTURE.md](ARCHITECTURE.md), "Future:
  `ingest_external_signal`").
- **Calendar = time facts**: appointments that are not classes (interviews, travel). An entry
  with the same time and title as a UniContext class is the same class and is shown once.
- **Gmail = new information**, judged by sender, subject and content, not by labels or
  categories. Taken: the university or teachers (休講, 教室変更, 締切変更, 課題), hiring
  (interview or schedule changes), urgent security notices (account compromise, suspicious
  login). Ignored: ads, newsletters, campus-wide general notices, routine GitHub notifications.
- **「情報がない」 vs 「取得できていない」**: the first means the source was read and has nothing;
  the second means it could not be read (connector unavailable, error, UniContext coverage gap
  or unhealthy `sourceHealth`). They are never mixed.

### 3.2 Effective schedule and personal conditions

UniContext returns, for class items, `effectiveSchedule.status` (`attending` / `not_attending`
/ `unknown`) with `effectiveSchedule.reason`, and `rawSchedule` (what the academic system
timetable says). Day views put sessions that do not apply in `notAttending` (「Aグループの日な
ので本人(B)は授業なし」).

- A `not_attending` class is never shown as today's class and never notified.
- `unknown` (depends on the group, group not known): the answer says it depends on the group;
  the morning run asks once which group the student is in.
- A `rawSchedule` that differs from the effective value is the student's group applied, not a
  conflict. When `effectiveSchedule.conflicts` is present (sources disagree about the group or
  the date), both are shown with their sources; one
  side is never adopted.
- In a normal chat, when the student says their group/班, or a group schedule document or post
  appears, ChatGPT calls `set_course_condition` (for example group B, with the evidence) and
  `add_session_rule` (dates and periods per group, with the source document). Scheduled tasks
  never call them.

### 3.3 Attention fields (`get_attention_required`)

Each item carries `attentionId` (stable id), `severity`, `firstSeenAt`, `lastChangedAt`,
`nextEscalationAt`, `recommendedAction` and `sourceHealth` (health of the sources the item
relies on). The watcher uses:

- `attentionId` to recognise the same item across runs;
- `severity` and `nextEscalationAt` to decide whether to notify again (only on escalation,
  change, or a still-not-acted stage);
- `recommendedAction` for the 「今やること」 part of the message;
- `sourceHealth` to say 「取得できていない」 when a source is unhealthy.

## 4. Verify

1. In a new chat: 「今日何する？」 → UniContext tools are called without a question, the answer
   is an ordered action list with sources.
2. In an unrelated chat (e.g. 「Swiftで配列をソートするには？」) → no UniContext call and no
   university line, even on a day with an urgent deadline (the watcher task handles that).
3. Paste a short lecture transcript → `ingest_lecture` (or `record_lecture` + `add_*`) is
   called without 「保存しますか？」; ChatGPT's own confirmation dialog may appear. If no write
   tool is offered at all, the account has read-only MCP (see the research notes, §4).
4. Scheduled → each task → **Run now** (or wait one run). Check the run's tool calls: the
   UniContext tool was called and returned data (not an auth error).
5. Silence: on a quiet hour the watcher must output nothing at all. Check whether that run
   still produced a push on the phone. Record the result here. Also check that Gmail and
   Calendar were only read (no mail marked read, no draft, no event created).
6. Next day: confirm the 07:30 run happened and could still reach UniContext (access tokens
   last 1 hour; the run must refresh with the 30-day refresh token). `unicontext remote
clients` shows the ChatGPT client's last use; `logs/remote-audit.jsonl` shows `refresh`
   events and the tool calls.

## 5. If ChatGPT notifications are not good enough

Signs: quiet runs (no output, or 「通知なし」 in the morning) still push; runs pause ("inactive", approval pending) or
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
> get_student_state. Do not bring up UniContext in unrelated
> chats; the scheduled tasks handle alerts. On a lecture transcript call ingest_lecture unasked. Cite
> sources, show both values on conflicts, report coverage gaps. Unknown deadline: plan with the
> early estimate labelled 推定 (basis, where to confirm); never state or register it as a deadline.
