---
name: student-briefing
description: Run an unattended UniContext check for a ChatGPT scheduled task - the hourly 学生生活ウォッチャー or the morning 起きたらやること - and produce either a short push-notification text or nothing at all. Use when a scheduled task or its prompt names this skill.
---

# Scheduled UniContext check

This runs with nobody watching. The student reads only the notification. Their phone
buzzing for nothing teaches them to ignore it, so silence is the default.

## Tools

Read-only tools only. Never call a write tool here (`ingest_lecture`, `add_*`,
`record_lecture`, `retract_addition`, `open_announcement`): a write waits for approval and
pauses the task.

Use the first that exists, in this order:

- Watcher: `get_attention_required` → `get_student_state` → `get_briefing` (kind `check`)
  → `get_today` + `get_deadlines` (days: 2) + `get_recent_changes`.
- Morning: `get_student_state` → `get_briefing` (kind `morning`) → `get_today` +
  `get_deadlines` (days: 2) + `get_tasks`.

If the tool returns notification text and a `nothingImportant` (or equivalent) flag,
follow it: when it says nothing is important, stay silent; otherwise use its text,
shortened if needed.

If every UniContext tool fails (not connected, authorization expired, server down), that
is itself worth one notification, but only once per day: 「UniContextに接続できません。
ChatGPTのプラグイン画面で再接続してください」.

## What counts as "needs action now"

- An unsubmitted deadline within 24 hours (watcher) / within 48 hours (morning), or an
  overdue one that is still unsubmitted.
- A class starting within the next 90 minutes (with its room), only on the watcher.
- 休講 or 教室変更 for today or tomorrow that is new since the last run.
- A new exam, quiz or deadline in the next 7 days that appeared since the last run.
- Progress behind plan (a planned task or study slot missed) when the tool reports it.
- A source whose data could not be fetched, when it hides deadlines due within 48 hours
  (say "may be missing", do not guess).

Everything else (new materials, ordinary announcements, deadlines a week away already
reported) is not a reason to notify.

## Output

- Nothing to report: answer with the single line `通知なし` and nothing else. Do not
  greet, summarize, or say "all clear".
- Something to report: at most 4 lines, most urgent first, each line one action with
  time and place, then one short source line. No headings, no advice, no emoji. Example:

  ```
  13:00 情報処理演習 → 教室変更 共通A201（根拠: 学務情報システム 10/5 11:02取得）
  今日23:59 データベース第3回レポート 未提出
  ```

- Do not repeat an item already notified in an earlier run of this task unless it got
  more urgent (for example from "today" to "under 3 hours") or changed.
- Never invent a deadline or a time. If two sources disagree, show both values.
